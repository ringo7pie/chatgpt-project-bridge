/*
  2.6.0 で追加したソース読み取りツールの読み取り層。MCP サーバー（server.mjs）が、公開境界の検査（リンク・境界・権限・fd の固定）を
  済ませた boundary を渡して使う。応答の形は bridge-tools-common.mjs の makeEnvelope に従う。
  - ファイルシステムには直接触れない。ファイル・ディレクトリは boundary（openWalk・withFile・classifyPath など）だけを通す。
    外部コマンドも使わない（子プロセスを起動する部品を読み込まない）。ファイルは読むだけで、書き込み・削除・作成をしない。
  - 本文は 64KiB のチャンクで読み、行ごとに秘密値をマスクしてから照合・返却する（マスク後の行を照合するので、検索で秘密値を探る使い方はできない）。
  - 取得したソース・コメント・文字列・ログの文章はただのデータで、命令として扱わない。

  各ツールの facts の形（README の元）。日時は ISO 8601。ページングは cursor（page.nextCursor を次の呼び出しの cursor に渡す）。

  list_source_files（ページング対象: files）
    scope, startPath, files[]: { path, size, modified, language, submodule（サブモジュールの中のときだけ） }
    skipped: { notStandardType, filtered, binary }（ファイルの除外件数）、excluded: { directories, names[] }（降りなかった生成物・依存のディレクトリ）、
    walk: { links, hardlinks, hidden, unreadable }（数えただけで中身を出さないもの）

  search_code（ページング対象: matches）
    query, mode, scope, matches[]: { path, line, column, text, before[], after[], submodule }
    summary: { filesScanned, filesWithMatches, filesCappedPerFile, bytesScanned }、skipped: { notStandardType, filtered, binary, undecodable, secretFile, tooLarge, unreadable }
    truncatedBy: 'limit' | 'time' | 'bytes' | 'entries' | null

  read_source
    path, size, modified, encoding: { name, bom, detected }, lineEnding, startLine, endLine, returnedLines, totalLines（数えられないときは null）,
    hasMore, text（行番号 + タブ + 本文。改行を除く）、submodule

  find_references（ページング対象: definitions と usages の合計）
    symbol, kind, analysis: { provider: 'text', exact: false }, definitions[]・usages[]: { path, line, column, text, before[], after[], classification, language, submodule }

  get_git_diff は bridge-git.mjs にある。

  read_test_log
    action ごとに: directories[]: { path, recursive, status } / files[]: { path, size, modified } / read: read_source と同じ形 + order / search: matches[] + summary
*/
import crypto from 'node:crypto';
import {
  BridgeToolError, DEFAULT_MAX_RESPONSE_BYTES, ERROR_CLASS, SOURCE_KIND, clampInteger, describeSource, fitToBudget, makeEnvelope, requireString,
} from './bridge-tools-common.mjs';
import {
  CHUNK_BYTES, MAX_DISPLAY_LINE_CHARS, MAX_MATCH_LINE_CHARS, SECRET_SCAN_BYTES,
  chooseEncoding, classifySourceName, clipLine, compileGlobs, createDecoder, createLineMasker, createMatcher, decodeCursor, detectSecretContent, encodeCursor, excerptAround,
  extensionOf, inspectHead, readLines, resolveRequestedEncoding,
} from './bridge-source-io.mjs';

const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024; // 検索で 1 ファイルから読む上限（ソース）。これより大きいファイルは数えてスキップする。
const LOG_MAX_FILE_BYTES = 64 * 1024 * 1024; // ログ 1 ファイルの上限（検索・範囲読み取り）。
const READ_MAX_FILE_BYTES = 32 * 1024 * 1024; // read_source で、先頭から行を数えて読める 1 ファイルの上限。
const SCAN_MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 検索 1 回で読む合計の上限。
const BATCH_LINES = 500; // 照合をまとめて行う行数（時間の確認もこの単位）。
const LIST_TIME_BUDGET_MS = 15000; // 一覧・ログの一覧の走査に使う時間の上限。
const DEFAULT_TIME_BUDGET_MS = 10000; // 検索の時間の既定。
const MAX_TIME_BUDGET_MS = 30000; // 検索の時間の上限。
const READ_RESPONSE_MAX_BYTES = 160000; // read_source・read_test_log(read) で 1 回に返す本文の最大バイト数（応答全体の 256KiB に収めるため）。
const CONTEXT_LINE_CHARS = 400; // 前後の行に載せる 1 行の最大文字数。
const COUNT_LINES_MAX_BYTES = 16 * 1024 * 1024; // 範囲の後ろの総行数を数えるために読む、残りの最大バイト数。
const MAX_LOG_FILES_LISTED = 200000; // ログの一覧のために集めるファイルの最大数（走査のエントリー数の上限と同じ桁）。
const MAX_INSPECTED_OTHER_FILES = 500; // 一覧で、標準外の拡張子のファイルの本文を検査する 1 回あたりの最大件数。
const SYMBOL_PATTERN = /^[^\s\p{Cc}]{1,128}$/u; // find_references の symbol（空白・制御文字なし）。
const SEVERITY_PATTERNS = Object.freeze({
  error: /\b(?:error|fatal|critical|exception|panic|traceback|segfault|assertion failed)\b/i,
  fail: /\b(?:fail|failed|failure|failures|not ok)\b/i,
  warning: /\b(?:warn|warning|warnings)\b/i,
}); // read_test_log の重大度の語。単語の途中（error_count など）には当てない。
const QUOTED_ONLY_LANGUAGES = new Set([
  'GDScript', 'シェーダー', 'C', 'C/C++ ヘッダー', 'C++', 'C#', 'Python', 'JavaScript', 'TypeScript', 'Lua', 'Java', 'Kotlin', 'Go', 'Rust', 'Ruby', 'PHP', 'Swift', 'SQL',
]); // 秘密ファイルの本文判定で、値が引用符で囲まれた代入だけを数える言語（変数名に token・password を含む通常のコードを、秘密ファイルと誤判定しないため）。
const LINE_COMMENT_MARKERS = new Map([
  ['GDScript', ['#']], ['Python', ['#']], ['Shell', ['#']], ['PowerShell', ['#']], ['YAML', ['#']], ['TOML', ['#']], ['ビルド定義', ['#']],
  ['C', ['//']], ['C/C++ ヘッダー', ['//']], ['C++', ['//']], ['C#', ['//']], ['JavaScript', ['//']], ['TypeScript', ['//']], ['Java', ['//']], ['Kotlin', ['//']],
  ['Go', ['//']], ['Rust', ['//']], ['Swift', ['//']], ['PHP', ['//', '#']], ['シェーダー', ['//']], ['Lua', ['--']], ['SQL', ['--']], ['Batch', ['REM ', '::']],
]); // 言語ごとの行コメントの印。ここに無い言語は、コメント・文字列の判定をしない（unknown）。

// 真偽値の引数を検証する。未指定は fallback。真偽値以外は invalid_argument。
function readBoolean(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は true か false で指定してください。`);
  return value;
}

// 列挙の引数を検証する。未指定は fallback。
function readEnum(value, name, allowed, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は ${allowed.join(' / ')} のどれかで指定してください。`);
  return value;
}

// 文字列の配列の引数を検証する。未指定は空の配列。
function readStringList(value, name, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || item.trim() === '' || item.length > 260)) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は空でない文字列の配列（最大 ${maxItems} 件）で指定してください。`);
  }
  return value;
}

// 引数の拡張子の一覧を整える（小文字・先頭のドット）。指定が無ければ null。
function normalizeExtensions(value) {
  const list = readStringList(value, 'extensions', 20); // 指定された拡張子。
  if (list.length === 0) return null;
  return new Set(list.map(item => {
    const extension = (item.trim().startsWith('.') ? item.trim() : `.${item.trim()}`).toLowerCase(); // 先頭にドットを付けた拡張子。
    if (!/^\.[a-z0-9_+-]{1,16}$/.test(extension)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `extensions に使えない値です: ${item}`);
    return extension;
  }));
}

// 検索条件の指紋。cursor が別の条件のものでないことの確認に使う（位置の情報は権限の検査を通すので、これは取り違え防止）。
function fingerprintOf(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// イベントループへ戻る（重い走査の途中で、標準入出力の読み取りなどを進める）。
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

// 行番号つきの本文にする。番号は右揃えで、タブで本文と区切る。
function numberLines(rows) {
  if (rows.length === 0) return '';
  const width = String(rows[rows.length - 1].line).length; // 番号の桁数。
  return rows.map(row => `${String(row.line).padStart(width, ' ')}\t${row.text}`).join('\n');
}

// 1 つの前後の行を "行番号: 本文" の文字列にする。
function contextText(row) {
  return `${row.line}: ${clipLine(row.text, CONTEXT_LINE_CHARS).text}`;
}

export function createSourceReader(options) {
  const boundary = options.boundary; // 公開境界を検査済みの関数群。
  const redact = typeof options.redact === 'function' ? options.redact : value => value; // 秘密値のマスク。
  const ignoreCase = boundary.pathsAreCaseInsensitive === true; // glob を大文字小文字を区別せずに照合するか（Windows）。
  let submoduleCache = null; // 呼び出しの中でキャッシュする、サブモジュールのパス（長い順）。

  // 結果に付けるサブモジュール名。そのパスがサブモジュールの中ならそのパス、外なら null。
  function submoduleOf(filePath) {
    if (submoduleCache === null) submoduleCache = [...boundary.readSubmodulePaths()].sort((left, right) => right.length - left.length);
    const key = ignoreCase ? filePath.toLowerCase() : filePath; // 比較用のパス。
    for (const submodule of submoduleCache) {
      const prefix = ignoreCase ? submodule.toLowerCase() : submodule; // 比較用のサブモジュールのパス。
      if (key === prefix || key.startsWith(`${prefix}/`)) return submodule;
    }
    return null;
  }

  // 呼び出し 1 回の状態を作る。
  function newCall(tool) {
    submoduleCache = null;
    return { tool, collectedAt: new Date().toISOString(), warnings: [], startedAt: Date.now() };
  }

  /*
    ファイルの絞り込み（glob・拡張子・標準の種類）を作る。
    引数: input、explicitFile（path が 1 ファイルを直接指しているか。その場合は標準の種類の絞り込みをしない）
    戻り値: { check(entry) → 'ok' | 'filtered' | 'notStandardType', needsTextInspection(entry) }
  */
  function buildFilter(input, explicitFile) {
    const matchGlob = compileGlobs(input.glob, { ignoreCase }); // glob の判定。
    const extensions = normalizeExtensions(input.extensions); // 拡張子の絞り込み。
    const includeOtherText = readBoolean(input.includeOtherText, 'includeOtherText', false); // 標準外の拡張子も対象にするか。
    return {
      check(entry) {
        if (matchGlob && !matchGlob(entry.path)) return 'filtered';
        if (extensions) return extensions.has(extensionOf(entry.name)) ? 'ok' : 'filtered';
        if (explicitFile || includeOtherText) return 'ok';
        return classifySourceName(entry.name).standard ? 'ok' : 'notStandardType';
      },
      isOtherType(entry) {
        return !classifySourceName(entry.name).standard;
      },
    };
  }

  // scope 引数を検証する。
  function readScope(input) {
    return readEnum(input.scope, 'scope', ['standard', 'extended'], 'standard');
  }

  // 走査の打ち切りの理由（time・entries）を、走査の統計から返す。無ければ null。
  function walkStopReason(stats) {
    if (stats.timedOut) return 'time';
    if (stats.truncatedByEntries) return 'entries';
    return null;
  }

  // 走査の統計から、数えただけで中身を出さない項目を応答用に整える。
  function describeWalk(walker) {
    const { links, hardlinks, hidden, unreadable, excludedDirectories } = walker.stats;
    return { walk: { links, hardlinks, hidden, unreadable }, excluded: { directories: excludedDirectories, names: walker.excludedDirectoryNames() } };
  }

  /*
    ファイルを開いて、テキストとして読める状態かを調べる。
    戻り値: { problem: null | 'binary' | 'secret', encoding, reason }。バイナリ・秘密ファイル・復号の問題は、読み取りの前にここで見分ける。
    先頭 64KiB を、秘密ファイルの本文判定（PEM 秘密鍵・秘密らしい代入の多いファイル）にも使う。
  */
  function prepareText(handle, requestedEncoding) {
    const headLength = Math.min(handle.size, SECRET_SCAN_BYTES); // 先頭から読むバイト数。
    const headBuffer = Buffer.alloc(headLength); // 先頭のバイト列。
    const got = headLength > 0 ? handle.readAt(headBuffer, headLength, 0) : 0; // 実際に読めたバイト数。
    const head = headBuffer.subarray(0, got);
    const inspected = inspectHead(head); // 先頭の判定（バイナリ・BOM）。
    if (inspected.kind === 'binary') return { problem: 'binary', reason: inspected.reason };
    const encoding = chooseEncoding(inspected, requestedEncoding); // 読み取りに使う文字コード。
    const language = classifySourceName(handle.relative.slice(handle.relative.lastIndexOf('/') + 1)).language; // ファイルの言語。
    const secret = detectSecretContent(createDecoder(encoding.name, false).decode(head.subarray(encoding.bomBytes)), { quotedOnly: QUOTED_ONLY_LANGUAGES.has(language) }); // 先頭の本文から見た秘密ファイルの判定。
    if (secret) return { problem: 'secret', reason: secret, encoding };
    return { problem: null, encoding, reason: inspected.reason };
  }

  // prepareText の問題を、分類付きの例外にする（本文は返さない）。
  function throwTextProblem(prepared) {
    if (prepared.problem === 'binary') throw new BridgeToolError(ERROR_CLASS.BINARY_FILE, 'バイナリファイルのため、本文を返しません。');
    throw new BridgeToolError(ERROR_CLASS.PERMISSION_DENIED, '秘密値を含むファイルと判定したため、本文を返しません。', { hidden: ['secretFile'] });
  }

  // handle から先頭付きで readLines を呼ぶ（読み取り関数を渡すだけの薄い呼び出し）。
  function linesOf(handle, encoding, extra = {}) {
    return readLines({ readAt: handle.readAt, size: handle.size, encoding, ...extra });
  }

  // ---------- 検索（search_code・find_references・read_test_log の search で共通） ----------

  /*
    前後の行つきで一致を集める入れ物を作る。
    引数: before・after（前後の行数）、maxMatches（この入れ物が受け取る一致の上限）、inspect（一致の採否と付加情報。(row, column, length) → null（採らない）か追加のフィールド）
    feed(rows, hits) に、行の配列と照合の結果（[行の添字, 位置, 長さ]）を順に渡す。
  */
  function createCollector({ before, after, maxMatches, maxPerFile, inspect }) {
    const matches = []; // 集めた一致。
    let history = []; // 直前の行（before 件まで）。
    let open = []; // 後ろの行をまだ集めている一致。
    let capped = null; // 上限に達した理由。'global'（maxMatches）か 'perFile'。
    return {
      matches,
      get capped() { return capped; },
      get lastMatchLine() { return matches.length > 0 ? matches[matches.length - 1].line : null; },
      get needsMoreContext() { return open.length > 0; },
      feed(rows, hits) {
        let hitPosition = 0; // hits の次の位置。
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]; // 今の行。
          for (const match of open) match.after.push(contextText(row));
          open = open.filter(match => match.after.length < after);
          if (hitPosition < hits.length && hits[hitPosition][0] === index) {
            const [, column, length] = hits[hitPosition]; // 一致の位置と長さ。
            hitPosition += 1;
            if (capped === null) {
              const extra = inspect ? inspect(row, column, length) : {}; // 一致の採否と付加情報。
              if (extra !== null) {
                if (matches.length >= maxMatches) {
                  capped = 'global';
                } else {
                  const excerpt = excerptAround(row.text, column, length); // 一致の周りの抜粋。
                  const match = { line: row.line, column: column + 1, text: excerpt.text, ...extra, before: history.map(contextText), after: [] };
                  matches.push(match);
                  if (after > 0) open.push(match);
                  if (maxPerFile < maxMatches && matches.length >= maxPerFile) capped = 'perFile'; // 結果全体の上限（global）以上の値なら、1 ファイルあたりの上限は使わない（同じ値だと続きが抜ける）。
                }
              }
            }
          }
          if (before > 0) {
            history.push(row);
            if (history.length > before) history.shift();
          }
        }
        history = before > 0 ? history : [];
      },
    };
  }

  /*
    1 つのファイルを検索する。
    戻り値: { status: 'ok' | 'binary' | 'undecodable' | 'secret' | 'tooLarge' | 'unreadable', matches, capped, resumeLine, bytes }
    resumeLine は、上限・時間で途中で止まったときの、次に調べる行（最後の一致の次の行、または未処理の最初の行）。最後まで読んだら null。
  */
  async function searchOneFile(entry, { kind, matcher, before, after, maxMatches, maxPerFile, startLine, deadline, maxFileBytes, inspect }) {
    let outcome; // ファイル 1 件の結果。
    try {
      outcome = await boundary.withFile(entry.path, { kind, scope: 'extended' }, async handle => {
        if (handle.size > maxFileBytes) return { status: 'tooLarge', matches: [], capped: null, resumeLine: null, bytes: 0 };
        const prepared = prepareText(handle, null); // テキストとして読めるかの判定。
        if (prepared.problem === 'binary') return { status: 'binary', matches: [], capped: null, resumeLine: null, bytes: 0 };
        if (prepared.problem === 'secret') return { status: 'secretFile', matches: [], capped: null, resumeLine: null, bytes: 0 };
        // 固定文字列の検索は、その語を含まないファイルを生のバイトの検索だけで除く（行の復号・マスクを省く。必要条件なので、結果は変わらない）。
        if (matcher.prefilter && handle.size > 0 && !matcher.prefilter.contains(handle.readAt, handle.size, prepared.encoding.name)) {
          return { status: 'ok', matches: [], capped: null, resumeLine: null, regexTimedOut: false, bytes: handle.size };
        }
        const masker = createLineMasker(redact); // 行ごとのマスク（ファイルごとに PEM の状態を持つ）。
        const collector = createCollector({ before, after, maxMatches, maxPerFile, inspect: inspect ? (row, column, length) => inspect(row, column, length, entry) : null }); // 一致の入れ物。
        let batch = []; // 照合を待つ行。
        let resumeLine = null; // 途中で止まったときの再開行。
        let regexTimedOut = false; // 正規表現の評価が時間内に終わらなかったか。
        let afterBudget = null; // 上限に達したあと、直前の一致の後ろの行として読む残りの行数。
        // 溜めた行を照合して入れ物へ渡す。正規表現の評価が時間切れなら true。
        const flush = () => {
          if (batch.length === 0) return false;
          const result = matcher.scan(batch.map(row => row.text), Math.max(deadline - Date.now(), 500)); // 照合の結果。
          if (result.timedOut) return true;
          collector.feed(batch, result.hits);
          batch = [];
          return false;
        };
        try {
          for (const line of linesOf(handle, prepared.encoding, { startLine: 1 })) {
            let text = line.text; // 本文。
            if (text.includes('\0')) return { status: 'binary', matches: [], capped: null, resumeLine: null, bytes: 0 };
            if (line.line < startLine) {
              if (text.includes('-----')) masker.mask(text); // 再開位置より前の行は照合しないが、PEM の状態だけは進める。
              continue;
            }
            if (text.length > MAX_MATCH_LINE_CHARS) text = text.slice(0, MAX_MATCH_LINE_CHARS);
            batch.push({ line: line.line, text: masker.mask(text) });
            if (afterBudget !== null) {
              afterBudget -= 1;
              if (afterBudget <= 0) break;
              continue;
            }
            if (batch.length >= BATCH_LINES) {
              if (flush()) { regexTimedOut = true; break; }
              if (collector.capped !== null) {
                if (!collector.needsMoreContext) break;
                afterBudget = after; // 後ろの行を読み足してから止める。
                continue;
              }
              if (Date.now() > deadline) { resumeLine = line.line + 1; break; }
            }
          }
        } catch (error) {
          if (error instanceof BridgeToolError && error.errorClass === ERROR_CLASS.UNSUPPORTED_ENCODING) return { status: 'undecodable', matches: [], capped: null, resumeLine: null, bytes: 0 };
          throw error;
        }
        if (!regexTimedOut && flush()) regexTimedOut = true;
        if (collector.capped === 'global') {
          const last = collector.lastMatchLine; // 最後に受け取った一致の行。これより後ろの一致は次回に回す。
          resumeLine = last === null ? 1 : last + 1;
        }        return { status: 'ok', matches: collector.matches, capped: collector.capped, resumeLine, regexTimedOut, bytes: handle.size };
      });
    } catch (error) {
      if (error instanceof BridgeToolError && (error.errorClass === ERROR_CLASS.PERMISSION_DENIED || error.errorClass === ERROR_CLASS.NOT_FOUND || error.errorClass === ERROR_CLASS.INVALID_ARGUMENT)) {
        return { status: 'unreadable', matches: [], capped: null, resumeLine: null, bytes: 0 };
      }
      throw error;
    }
    return outcome;
  }

  /*
    ファイルの列を順に検索して、一致を集める。search_code・find_references・read_test_log の search が共通で使う。
    引数: params（tool、kind、startPath、scope、filter、matcher、before、after、maxResults、maxPerFile、timeBudgetMs、cursor（デコード済み）、fingerprint、
          maxFileBytes、inspect、explicitFile、files（検索するファイルの一覧を直接渡すとき。走査をしない））
    戻り値: { matches, summary, skipped, truncatedBy, nextCursor, walker（統計用）, warnings }
  */
  async function runSearch(params) {
    const deadline = Date.now() + params.timeBudgetMs; // 時間の上限。
    const skipped = { notStandardType: 0, filtered: 0, binary: 0, undecodable: 0, secretFile: 0, tooLarge: 0, unreadable: 0 }; // スキップした件数。（secret というキー名は、サーバーの最終マスクが値を伏せて JSON を壊すため使わない）
    const matches = []; // 集めた一致（ファイルの項目を付けたもの）。
    let filesScanned = 0; // 読んだファイル数。
    let filesWithMatches = 0; // 一致のあったファイル数。
    let filesCappedPerFile = 0; // 1 ファイルあたりの上限で、一致を省いたファイル数。
    let bytesScanned = 0; // 読んだ合計バイト数。
    let truncatedBy = null; // 打ち切りの理由。
    let nextCursor = null; // 続きの cursor。
    let lastPath = null; // 最後に処理を終えたファイル。
    const cursor = params.cursor; // 再開位置 { p, l }（l が 0 ならその次のファイルから、0 より大きければそのファイルの l 行目から）。
    let walker = null; // 走査（files を直接渡したときは無い）。
    let fileList = null; // files を直接渡したときの一覧。
    let fileIndex = 0; // fileList の位置。
    if (params.files) {
      fileList = params.files;
      if (cursor) {
        const position = fileList.findIndex(entry => entry.path === cursor.p); // 再開位置のファイルの位置。
        if (position < 0) throw new BridgeToolError(ERROR_CLASS.STALE_CURSOR);
        fileIndex = cursor.l > 0 ? position : position + 1;
      }
    } else {
      walker = boundary.openWalk({ startRelative: params.startPath, kind: params.kind, scope: params.scope, afterPath: cursor ? cursor.p : null, inclusive: cursor ? cursor.l > 0 : false, deadlineMs: deadline });
    }
    try {
      let resumeFile = cursor && cursor.l > 0 ? cursor.p : null; // 途中から読み直すファイル。
      for (;;) {
        const entry = fileList ? (fileIndex < fileList.length ? fileList[fileIndex++] : null) : walker.next(); // 次のファイル。
        if (!entry) break;
        const verdict = params.filter.check(entry); // 絞り込みの判定。
        if (verdict !== 'ok') { skipped[verdict] += 1; lastPath = entry.path; continue; }
        if (bytesScanned >= SCAN_MAX_TOTAL_BYTES) { truncatedBy = 'bytes'; nextCursor = encodeCursor(params.cursorKind, { p: entry.path, l: 1, f: params.fingerprint }); break; }
        if (filesScanned > 0 && Date.now() > deadline) { truncatedBy = 'time'; nextCursor = encodeCursor(params.cursorKind, { p: entry.path, l: 1, f: params.fingerprint }); break; }
        const startLine = resumeFile === entry.path ? cursor.l : 1; // このファイルを読み始める行。
        resumeFile = null;
        const outcome = await searchOneFile(entry, {
          kind: params.kind, matcher: params.matcher, before: params.before, after: params.after, maxMatches: params.maxResults - matches.length, maxPerFile: params.maxPerFile,
          startLine, deadline, maxFileBytes: params.maxFileBytes, inspect: params.inspect,
        }); // このファイルの結果。
        if (outcome.status !== 'ok') { skipped[outcome.status] += 1; lastPath = entry.path; continue; }
        filesScanned += 1;
        bytesScanned += outcome.bytes;
        lastPath = entry.path;
        if (outcome.matches.length > 0) filesWithMatches += 1;
        if (outcome.capped === 'perFile') filesCappedPerFile += 1;
        const submodule = submoduleOf(entry.path); // サブモジュールの中なら、その名前。
        for (const match of outcome.matches) matches.push({ path: entry.path, ...match, ...(submodule ? { submodule } : {}) });
        if (outcome.regexTimedOut) {
          truncatedBy = 'regexTimeout'; // 同じ位置で止まり続けないよう、続きの cursor は付けない。
          break;
        }
        if (outcome.resumeLine !== null && (outcome.capped === 'global' || matches.length >= params.maxResults)) {
          truncatedBy = 'limit';
          nextCursor = encodeCursor(params.cursorKind, { p: entry.path, l: outcome.resumeLine, f: params.fingerprint });
          break;
        }
        if (outcome.resumeLine !== null) {
          truncatedBy = 'time';
          nextCursor = encodeCursor(params.cursorKind, { p: entry.path, l: outcome.resumeLine, f: params.fingerprint });
          break;
        }
        if (matches.length >= params.maxResults) {
          truncatedBy = 'limit';
          nextCursor = encodeCursor(params.cursorKind, { p: entry.path, l: 0, f: params.fingerprint });
          break;
        }
        await yieldToEventLoop();
      }
      if (truncatedBy === null && walker) {
        const reason = walkStopReason(walker.stats); // 走査の打ち切り。
        if (reason) {
          truncatedBy = reason;
          nextCursor = lastPath ? encodeCursor(params.cursorKind, { p: lastPath, l: 0, f: params.fingerprint }) : (cursor ? encodeCursor(params.cursorKind, cursor) : null);
        }
      }
      return { matches, summary: { filesScanned, filesWithMatches, filesCappedPerFile, bytesScanned }, skipped, truncatedBy, nextCursor, walkInfo: walker ? describeWalk(walker) : null };
    } finally {
      if (walker) walker.close();
    }
  }

  // cursor を読み、検索条件の指紋が合うか確認する。無ければ null。
  function readSearchCursor(input, kind, fingerprint) {
    if (input.cursor === undefined || input.cursor === null) return null;
    const payload = decodeCursor(input.cursor, kind); // 読んだ位置の情報。
    if (typeof payload.p !== 'string' || !Number.isInteger(payload.l) || payload.l < 0 || payload.f !== fingerprint) {
      throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor がこの検索条件のものではありません。前回と同じ引数に cursor だけを足して呼び出してください。');
    }
    return payload;
  }

  /*
    応答が大きすぎるとき、配列の後ろを削って収める。cursor 方式のページングでは、削った分を次回に回すため、
    cursor を「残した最後の要素の位置」へ戻す（fitToBudget のように黙って削ると、削った分が続きの取得から抜け落ちる）。
    引数: items（応答に載せる配列）、build(kept, cutCursor, cut) → 応答（cut が true のとき cutCursor が続きの cursor）、cursorFor(最後に残した要素) → cursor
  */
  function fitWithCursor(items, build, cursorFor) {
    let kept = items; // 残す要素。
    for (;;) {
      const cut = kept.length < items.length; // 削ったか。
      const envelope = build(kept, cut ? cursorFor(kept[kept.length - 1]) : undefined, cut);
      if (Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8') <= DEFAULT_MAX_RESPONSE_BYTES || kept.length <= 1) return envelope;
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.75)));
    }
  }

  // 検索の結果を応答にする。
  function buildSearchEnvelope(call, { facts, searchResult, extraWarnings = [], sourceKind = SOURCE_KIND.STATIC_ANALYSIS, limits }) {
    const warnings = [...call.warnings, ...extraWarnings]; // 注意事項。
    if (searchResult.truncatedBy === 'size') warnings.push('応答の大きさの上限のため、後ろの結果を省きました。page.nextCursor で続きを取得してください（省いた分も続きに含まれます）。');
    if (searchResult.truncatedBy === 'regexTimeout') warnings.push('正規表現の評価が時間内に終わりませんでした（パターンが重い可能性があります）。パターンを具体的にするか、固定文字列検索（mode: literal）や path・glob での絞り込みを使ってください。この条件では続きの cursor はありません。');
    if (searchResult.truncatedBy === 'time') warnings.push('時間の上限に達したため、途中までの結果です。page.nextCursor で続きを取得してください。');
    if (searchResult.truncatedBy === 'limit') warnings.push('結果の件数の上限に達しました。page.nextCursor で続きを取得してください。');
    if (searchResult.truncatedBy === 'bytes') warnings.push('読み取った合計の大きさの上限に達したため、途中までの結果です。path や glob で範囲を絞るか、page.nextCursor で続きを取得してください。');
    if (searchResult.truncatedBy === 'entries') warnings.push('走査するファイル数の上限に達したため、途中までの結果です。path や glob で範囲を絞ってください。');
    if (searchResult.summary.filesCappedPerFile > 0) warnings.push(`${searchResult.summary.filesCappedPerFile} 件のファイルで、1 ファイルあたりの件数の上限（maxMatchesPerFile）のため一致を省きました。path でそのファイルを指定するか、上限を上げてください。`);
    if (searchResult.skipped.undecodable > 0) warnings.push(`UTF-8・BOM 付き UTF-16 として復号できないファイルが ${searchResult.skipped.undecodable} 件あり、検索していません（read_source の encoding で個別に読めます）。`);
    if (searchResult.skipped.secretFile > 0) warnings.push(`秘密値を含むと判定したファイルが ${searchResult.skipped.secretFile} 件あり、検索していません。`);
    return makeEnvelope({
      tool: call.tool,
      collectedAt: call.collectedAt,
      sources: [describeSource(sourceKind, call.collectedAt)],
      facts: { ...facts, summary: searchResult.summary, skipped: searchResult.skipped, truncatedBy: searchResult.truncatedBy, ...(searchResult.walkInfo || {}) },
      page: { returned: searchResult.matches.length, nextCursor: searchResult.nextCursor },
      warnings,
      truncated: searchResult.truncatedBy !== null && searchResult.nextCursor === null,
      limits,
    });
  }

  // ---------- list_source_files ----------

  async function listSourceFiles(input = {}) {
    boundary.assertSourceExposure();
    const call = newCall('list_source_files'); // 呼び出しの状態。
    const scope = readScope(input); // 標準か拡張か。
    const recursive = readBoolean(input.recursive, 'recursive', true); // 配下も対象にするか。
    const limit = clampInteger(input.limit, 'limit', { min: 1, max: 500, fallback: 100 }); // 返す最大件数。
    const startPath = boundary.normalizePath(input.path); // 起点（プロジェクト相対）。
    const start = boundary.classifyPath(startPath, { kind: 'source', scope }); // 起点の種類（権限の検査つき）。
    const filter = buildFilter(input, start.kind === 'file'); // 絞り込み。
    const fingerprint = fingerprintOf(['list', startPath, recursive, scope, input.glob ?? null, input.extensions ?? null, input.includeOtherText ?? false]); // cursor の取り違え防止。
    const cursor = readSearchCursor(input, 'list', fingerprint); // 再開位置。
    const deadline = Date.now() + LIST_TIME_BUDGET_MS; // 時間の上限。
    const walker = boundary.openWalk({ startRelative: startPath, kind: 'source', scope, afterPath: cursor ? cursor.p : null, recursive, deadlineMs: deadline }); // 走査。
    const files = []; // 返すファイル。
    const skipped = { notStandardType: 0, filtered: 0, binary: 0 }; // 除外した件数。
    let inspected = 0; // 本文を検査した標準外のファイルの数。
    let more = false; // 続きがあるか。
    let lastPath = cursor ? cursor.p : null; // 最後に処理したファイル。
    let truncatedBy = null; // 打ち切りの理由。
    try {
      for (;;) {
        const entry = walker.next(); // 次のファイル。
        if (!entry) break;
        const verdict = filter.check(entry); // 絞り込みの判定。
        if (verdict !== 'ok') { skipped[verdict] += 1; lastPath = entry.path; continue; }
        if (filter.isOtherType(entry) && start.kind !== 'file' && inspected < MAX_INSPECTED_OTHER_FILES) {
          inspected += 1;
          const isText = await boundary.withFile(entry.path, { kind: 'source', scope: 'extended' }, async handle => { // 標準外の拡張子は本文がテキストか検査する。
            const head = Buffer.alloc(Math.min(handle.size, 8192));
            const got = head.length > 0 ? handle.readAt(head, head.length, 0) : 0;
            return inspectHead(head.subarray(0, got)).kind === 'text';
          }).catch(() => false);
          if (!isText) { skipped.binary += 1; lastPath = entry.path; continue; }
        }
        if (files.length >= limit) { more = true; break; }
        const submodule = submoduleOf(entry.path); // サブモジュールの中なら、その名前。
        files.push({ path: entry.path, size: entry.size, modified: new Date(entry.modifiedMs).toISOString(), language: classifySourceName(entry.name).language, ...(submodule ? { submodule } : {}) });
        lastPath = entry.path;
      }
      truncatedBy = more ? 'limit' : walkStopReason(walker.stats);
      const nextCursor = truncatedBy && lastPath ? encodeCursor('list', { p: lastPath, l: 0, f: fingerprint }) : null; // 続きの cursor。
      const warnings = [...call.warnings]; // 注意事項。
      if (truncatedBy === 'time') warnings.push('時間の上限に達したため、途中までの一覧です。page.nextCursor で続きを取得してください。');
      if (truncatedBy === 'entries') warnings.push('走査するファイル数の上限に達したため、途中までの一覧です。path や glob で範囲を絞ってください。');
      if (skipped.notStandardType > 0) warnings.push(`標準の種類（拡張子の表）にないファイルが ${skipped.notStandardType} 件あり、一覧に含めていません（includeOtherText: true で本文がテキストのものを含められます）。`);
      const walkInfo = describeWalk(walker); // 数えただけで中身を出さないもの。
      return fitWithCursor(files, (kept, cutCursor, cut) => makeEnvelope({
        tool: call.tool,
        collectedAt: call.collectedAt,
        sources: [describeSource(SOURCE_KIND.STATIC_ANALYSIS, call.collectedAt)],
        facts: { scope, startPath: startPath || '.', files: kept, skipped, truncatedBy: cut ? 'size' : truncatedBy, ...walkInfo },
        page: { limit, returned: kept.length, nextCursor: cut ? cutCursor : nextCursor },
        warnings: cut ? [...warnings, '応答の大きさの上限のため、後ろのファイルを省きました。page.nextCursor で続きを取得してください（省いた分も続きに含まれます）。'] : warnings,
        limits: { maxFilesPerPage: 500, timeBudgetMs: LIST_TIME_BUDGET_MS },
      }), file => encodeCursor('list', { p: file.path, l: 0, f: fingerprint }));
    } finally {
      walker.close();
    }
  }

  // ---------- search_code ----------

  async function searchCode(input = {}) {
    boundary.assertSourceExposure();
    const call = newCall('search_code'); // 呼び出しの状態。
    const mode = readEnum(input.mode, 'mode', ['literal', 'regex'], 'literal'); // 固定文字列か正規表現か。
    const caseSensitive = readBoolean(input.caseSensitive, 'caseSensitive', false); // 大文字小文字を区別するか。
    const wholeWord = readBoolean(input.wholeWord, 'wholeWord', false); // 単語単位か。
    const matcher = createMatcher({ query: input.query, mode, caseSensitive, wholeWord }); // 照合器。
    const scope = readScope(input); // 標準か拡張か。
    const before = clampInteger(input.contextBefore, 'contextBefore', { min: 0, max: 10, fallback: 0 }); // 前の行数。
    const after = clampInteger(input.contextAfter, 'contextAfter', { min: 0, max: 10, fallback: 0 }); // 後ろの行数。
    const maxResults = clampInteger(input.maxResults, 'maxResults', { min: 1, max: 200, fallback: 50 }); // 返す最大件数。
    const maxPerFile = clampInteger(input.maxMatchesPerFile, 'maxMatchesPerFile', { min: 1, max: 200, fallback: 20 }); // 1 ファイルあたりの最大件数。
    const timeBudgetMs = clampInteger(input.timeBudgetMs, 'timeBudgetMs', { min: 1000, max: MAX_TIME_BUDGET_MS, fallback: DEFAULT_TIME_BUDGET_MS }); // 時間の上限。
    const startPath = boundary.normalizePath(input.path); // 起点（プロジェクト相対）。
    const start = boundary.classifyPath(startPath, { kind: 'source', scope }); // 起点の種類（権限の検査つき）。
    const filter = buildFilter(input, start.kind === 'file'); // 絞り込み。
    const fingerprint = fingerprintOf(['search', input.query, mode, caseSensitive, wholeWord, startPath, scope, input.glob ?? null, input.extensions ?? null, input.includeOtherText ?? false, before, after, maxPerFile]); // cursor の取り違え防止。
    const cursor = readSearchCursor(input, 'search', fingerprint); // 再開位置。
    const searchResult = await runSearch({
      tool: call.tool, kind: 'source', startPath, scope, filter, matcher, before, after, maxResults, maxPerFile, timeBudgetMs, cursor, cursorKind: 'search', fingerprint,
      maxFileBytes: SEARCH_MAX_FILE_BYTES, inspect: null, explicitFile: start.kind === 'file',
    }); // 検索の結果。
    const warnings = ['1 行につき最初の一致だけを返します。']; // 注意事項。
    if (mode === 'regex' && searchResult.truncatedBy === 'time') warnings.push('正規表現の評価が重い場合も時間切れになります。パターンを具体的にするか、path・glob で範囲を絞ってください。');
    return fitWithCursor(searchResult.matches, (kept, cutCursor, cut) => buildSearchEnvelope(call, {
      facts: { query: input.query, mode, caseSensitive, wholeWord, scope, startPath: startPath || '.', matches: kept },
      searchResult: cut ? { ...searchResult, matches: kept, nextCursor: cutCursor, truncatedBy: 'size' } : searchResult,
      extraWarnings: warnings,
      limits: { maxResults: 200, maxFileBytes: SEARCH_MAX_FILE_BYTES, maxTotalBytes: SCAN_MAX_TOTAL_BYTES, maxTimeBudgetMs: MAX_TIME_BUDGET_MS, maxLineChars: MAX_MATCH_LINE_CHARS },
    }), match => encodeCursor('search', { p: match.path, l: match.line + 1, f: fingerprint }));
  }

  // ---------- find_references ----------

  // 正規表現の本体に使うため、記号を退避する（u フラグを使わない通常の正規表現用）。
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 言語ごとの、宣言（定義）らしい行の形。symbol を差し込んだ正規表現を返す。無い言語は null。
  function definitionPatternsFor(language, symbol) {
    const name = escapeRegExp(symbol); // 退避したシンボル。
    const boundaryAfter = '(?![\\w$])'; // 名前の直後の境界。
    switch (language) {
      case 'GDScript':
        return [new RegExp(`^\\s*(?:static\\s+)?func\\s+${name}${boundaryAfter}`), new RegExp(`^\\s*(?:class_name|class|signal|enum)\\s+${name}${boundaryAfter}`), new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:static\\s+)?(?:var|const)\\s+${name}${boundaryAfter}`)];
      case 'Python':
        return [new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}${boundaryAfter}`), new RegExp(`^\\s*class\\s+${name}${boundaryAfter}`), new RegExp(`^${name}\\s*(?::[^=]+)?=`)];
      case 'JavaScript':
      case 'TypeScript':
        return [new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s+${name}${boundaryAfter}`), new RegExp(`\\b(?:abstract\\s+)?(?:class|interface|enum|type|namespace)\\s+${name}${boundaryAfter}`), new RegExp(`\\b(?:const|let|var)\\s+${name}${boundaryAfter}`)];
      case 'PowerShell':
        return [new RegExp(`^\\s*function\\s+${name}${boundaryAfter}`, 'i')];
      case 'Lua':
        return [new RegExp(`\\bfunction\\s+(?:[\\w.]+[.:])?${name}${boundaryAfter}`), new RegExp(`\\blocal\\s+function\\s+${name}${boundaryAfter}`), new RegExp(`^\\s*(?:local\\s+)?${name}\\s*=`)];
      case 'Shell':
        return [new RegExp(`^\\s*(?:function\\s+)?${name}\\s*\\(\\)`), new RegExp(`^\\s*function\\s+${name}${boundaryAfter}`)];
      case 'C':
      case 'C/C++ ヘッダー':
      case 'C++':
        return [
          new RegExp(`\\b(?:class|struct|enum|union|namespace)\\s+(?:\\w+\\s+)*${name}${boundaryAfter}`),
          new RegExp(`^\\s*#\\s*define\\s+${name}${boundaryAfter}`),
          new RegExp(`^\\s*(?:template\\s*<[^>]*>\\s*)?[A-Za-z_][\\w:<>,*&\\s~]*[\\s*&]${name}\\s*\\([^;]*$`),
          new RegExp(`^\\s*[A-Za-z_][\\w:<>,*&\\s]*::${name}\\s*\\(`),
        ];
      case 'C#':
        return [new RegExp(`\\b(?:class|struct|interface|enum|record|delegate)\\s+(?:[\\w<>,\\s]+\\s+)?${name}${boundaryAfter}`), new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial)\\s+)+[\\w<>,\\[\\]?.\\s]+\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`)];
      case 'シェーダー':
        return [new RegExp(`^\\s*(?:shader_type|uniform|const|varying|void|float|int|vec[234]|mat[234]|bool|sampler\\w*)\\b[^;(]*\\b${name}${boundaryAfter}`)];
      default:
        return null;
    }
  }

  /*
    一致の位置が、行コメント・文字列・コードのどれにあるかの目安を返す（同じ行の中だけを見る。複数行のコメント・文字列は見ない）。
    言語が分からない・行コメントの印が無い言語は 'unknown'。
  */
  function classifyOccurrence(language, text, column) {
    const markers = LINE_COMMENT_MARKERS.get(language); // 言語の行コメントの印。
    if (!markers) return 'unknown';
    let quote = null; // 今いる文字列の引用符。
    let inBlock = false; // /* */ の中か。
    for (let index = 0; index < column; index += 1) {
      const character = text[index]; // 見ている文字。
      if (inBlock) {
        if (character === '*' && text[index + 1] === '/') { inBlock = false; index += 1; }
        continue;
      }
      if (quote) {
        if (character === '\\') { index += 1; continue; }
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || (character === '`' && (language === 'JavaScript' || language === 'TypeScript'))) { quote = character; continue; }
      if (markers.includes('//') && character === '/' && text[index + 1] === '*') { inBlock = true; index += 1; continue; }
      if (markers.some(marker => text.startsWith(marker, index))) return 'comment';
    }
    if (inBlock) return 'comment';
    return quote ? 'string' : 'code';
  }

  async function findReferences(input = {}) {
    boundary.assertSourceExposure();
    const call = newCall('find_references'); // 呼び出しの状態。
    const symbol = requireString(input.symbol, 'symbol', { maxLength: 128 }).trim(); // 探す名前。
    if (!SYMBOL_PATTERN.test(symbol)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'symbol に空白・制御文字は使えません。');
    const kind = readEnum(input.kind, 'kind', ['any', 'definition', 'usage'], 'any'); // 定義だけ・使用だけ・両方。
    const scope = readScope(input); // 標準か拡張か。
    const contextLines = clampInteger(input.contextLines, 'contextLines', { min: 0, max: 5, fallback: 1 }); // 前後の行数。
    const limit = clampInteger(input.limit, 'limit', { min: 1, max: 200, fallback: 60 }); // 返す最大件数。
    const timeBudgetMs = clampInteger(input.timeBudgetMs, 'timeBudgetMs', { min: 1000, max: MAX_TIME_BUDGET_MS, fallback: DEFAULT_TIME_BUDGET_MS }); // 時間の上限。
    const matcher = createMatcher({ query: symbol, mode: 'literal', caseSensitive: true, wholeWord: true }); // 単語単位の固定文字列。
    const startPath = boundary.normalizePath(input.path); // 起点（プロジェクト相対）。
    const start = boundary.classifyPath(startPath, { kind: 'source', scope }); // 起点の種類（権限の検査つき）。
    const filter = buildFilter(input, start.kind === 'file'); // 絞り込み。
    const fingerprint = fingerprintOf(['refs', symbol, kind, startPath, scope, input.glob ?? null, input.extensions ?? null, contextLines]); // cursor の取り違え防止。
    const cursor = readSearchCursor(input, 'refs', fingerprint); // 再開位置。
    const patternCache = new Map(); // 言語ごとの定義の形。
    // 一致を、定義の候補・使用の別と、コード・コメント・文字列の別で分類する。kind で採らないものは null。
    // wanted: 'definition'（定義の候補だけ）、'usage'（定義以外だけ）、'any'（両方）。
    const makeInspect = wanted => (row, column, length, entry) => {
      const language = classifySourceName(entry.name).language; // ファイルの言語。
      if (!patternCache.has(language)) patternCache.set(language, definitionPatternsFor(language, symbol));
      const patterns = patternCache.get(language); // 定義の形の一覧（無い言語は null）。
      const isDefinition = patterns ? patterns.some(pattern => pattern.test(row.text)) : false; // 宣言らしい行か。
      if (wanted === 'definition' && !isDefinition) return null;
      if (wanted === 'usage' && isDefinition) return null;
      const classification = classifyOccurrence(language, row.text, column); // コード・コメント・文字列の目安。
      return { language, role: isDefinition ? 'definition' : 'usage', classification: isDefinition && classification === 'code' ? 'code' : classification };
    };
    const searchArguments = { tool: call.tool, kind: 'source', startPath, scope, filter, matcher, before: contextLines, after: contextLines, maxPerFile: limit, cursorKind: 'refs', fingerprint, maxFileBytes: SEARCH_MAX_FILE_BYTES, explicitFile: start.kind === 'file' }; // 2 回の走査で共通の引数。
    // kind が any の最初のページでは、使用箇所で上限に達する前に定義を見つけられるよう、定義だけを探す走査を先に行う（語を含むファイルだけを読むので速い）。続きのページでは使用箇所だけを続ける。
    let definitionMatches = []; // 先に見つけた定義の候補。
    let definitionScanTruncated = false; // 定義の走査が上限・時間で途中になったか。
    if (kind === 'any' && !cursor) {
      const definitionScan = await runSearch({ ...searchArguments, maxResults: Math.min(limit, 30), timeBudgetMs: Math.min(Math.floor(timeBudgetMs / 2), 5000), cursor: null, inspect: makeInspect('definition') }); // 定義の走査の結果。
      definitionMatches = definitionScan.matches;
      definitionScanTruncated = definitionScan.truncatedBy !== null;
    }
    const mainWanted = kind === 'any' ? 'usage' : kind; // 使用箇所の走査で採るもの（any では定義は先の走査で返すので、ここでは定義を採らない）。
    const searchResult = await runSearch({ ...searchArguments, maxResults: Math.max(limit - definitionMatches.length, 1), timeBudgetMs, cursor, inspect: makeInspect(mainWanted) }); // 検索の結果。
    const warnings = [
      '文字列一致ベースの結果で、言語仕様上の厳密な参照解析ではありません。コメント・文字列・同名の別のシンボル・別のスコープの同名の変数も含みます（classification は同じ行の中だけを見た目安です）。',
      '定義の候補は、言語ごとの宣言の形（func・def・class など）に当てはまる行を推測したものです。',
    ]; // 注意事項。
    if (definitionScanTruncated) warnings.push('定義の候補の走査が上限（件数・時間）で途中になりました。kind: definition と path で範囲を絞ると、全部を探せます。');
    if (kind === 'any' && cursor) warnings.push('続きのページです。定義の候補は最初のページに含まれています。');
    return fitWithCursor(searchResult.matches, (kept, cutCursor, cut) => {
      const definitions = []; // 定義の候補。
      const usages = []; // 使用箇所。
      for (const match of [...definitionMatches, ...kept]) {
        const { role, ...rest } = match; // 役割を外した一致。
        (role === 'definition' ? definitions : usages).push(rest);
      }
      return buildSearchEnvelope(call, {
        facts: { symbol, kind, scope, analysis: { provider: 'text', exact: false }, definitions, usages },
        searchResult: cut ? { ...searchResult, matches: kept, nextCursor: cutCursor, truncatedBy: 'size' } : searchResult,
        extraWarnings: warnings,
        limits: { maxResults: 200, maxFileBytes: SEARCH_MAX_FILE_BYTES, maxTotalBytes: SCAN_MAX_TOTAL_BYTES, maxTimeBudgetMs: MAX_TIME_BUDGET_MS },
      });
    }, match => encodeCursor('refs', { p: match.path, l: match.line + 1, f: fingerprint }));
  }

  // ---------- read_source・read_test_log(read) ----------

  /*
    開いたファイルから、行の範囲を読む（read_source と read_test_log の read で共通）。
    引数: handle、params（requestedEncoding、startLine、lineCount、maxChars、tail（末尾から lineCount 行）、resume（cursor の { b, l, z, m, e }。位置が有効なら先頭から数えない）、maxFileBytes）
    戻り値: { rows, encoding, lineEnding, startLine, endLine, totalLines, hasMore, nextResume, clippedLines, truncatedByChars, warnings }
  */
  function readRange(handle, params) {
    const prepared = prepareText(handle, params.requestedEncoding); // テキストとして読めるかの判定。
    if (prepared.problem) throwTextProblem(prepared);
    const encoding = prepared.encoding; // 読み取りに使う文字コード。
    const warnings = []; // 注意事項。
    if (encoding.detected === 'explicit') warnings.push(`文字コードは指定の ${encoding.name} で読みました（自動判定ではありません）。内容が文字化けしていないか確認してください。`);
    const masker = createLineMasker(redact); // 行ごとのマスク。
    const rows = []; // 返す行。
    const counts = { lf: 0, crlf: 0 }; // 観測した行末。
    let clippedLines = 0; // 長すぎて切った行の数。
    let bytes = 0; // 返す本文のバイト数。
    let chars = 0; // 返す本文の文字数。
    let truncatedByChars = false; // 文字数・バイト数の上限で手前の行までにしたか。
    let hasMore = false; // 範囲の後ろにまだ行があるか。
    let lastLine = null; // 最後に読んだ行（範囲外を含む）。
    let nextResume = null; // 続きを読むための位置 { b, l }。
    let totalLines = null; // 総行数（数えられたときだけ）。
    const wantTail = params.tail === true; // 末尾の行を返すか。
    let startLine = params.startLine; // 読み始める行。
    let startByte = encoding.bomBytes; // 読み始める位置。
    let firstLineNumber = 1; // startByte の行番号。
    if (!wantTail && params.resume && params.resume.z === handle.size && params.resume.m === handle.modifiedMs && params.resume.e === encoding.name && Number.isInteger(params.resume.b) && Number.isInteger(params.resume.l) && params.resume.l === startLine) {
      startByte = params.resume.b; // ファイルが変わっていなければ、前回の続きの位置へ直接進む（先頭から数え直さない）。
      firstLineNumber = params.resume.l;
      masker.reset();
    } else if (!wantTail && handle.size > params.maxFileBytes && startLine > 1) {
      throw new BridgeToolError(ERROR_CLASS.FILE_TOO_LARGE, `ファイルが大きい（${handle.size} バイト）ため、行番号で途中から読むには先頭から数える必要があり、上限（${params.maxFileBytes} バイト）を超えます。startLine を 1 にするか、前回の応答の cursor で続けてください。`);
    }
    if (wantTail && handle.size > params.maxFileBytes) {
      throw new BridgeToolError(ERROR_CLASS.FILE_TOO_LARGE, `ファイルが大きい（${handle.size} バイト）ため、末尾の行を取得できません（上限 ${params.maxFileBytes} バイト）。`);
    }
    const tailRows = []; // 末尾読みのための、直近の行。
    const lineIterator = linesOf(handle, encoding, { startByte, startLine: firstLineNumber });
    let reachedEnd = true; // ファイルの最後まで読んだか。
    for (const line of lineIterator) {
      lastLine = line;
      if (line.text.includes('\0')) throw new BridgeToolError(ERROR_CLASS.BINARY_FILE, 'ファイルの途中にバイナリのデータを含むため、本文を返しません。');
      if (line.eol === '\n') counts.lf += 1; else if (line.eol === '\r\n') counts.crlf += 1;
      if (!wantTail && line.line < startLine) {
        if (line.text.includes('-----')) masker.mask(line.text); // 範囲より前の行は返さないが、PEM の状態だけは進める。
        continue;
      }
      let text = line.text; // 本文。
      if (text.length > MAX_MATCH_LINE_CHARS * 2) text = text.slice(0, MAX_MATCH_LINE_CHARS * 2);
      const masked = clipLine(masker.mask(text), MAX_DISPLAY_LINE_CHARS); // マスクして、長い行は切る。
      const row = { line: line.line, text: masked.text, clipped: masked.clipped || line.cut, byteEnd: line.byteEnd }; // 返す行の候補。
      if (wantTail) {
        tailRows.push(row);
        if (tailRows.length > params.lineCount) tailRows.shift();
        continue;
      }
      if (rows.length >= params.lineCount) { hasMore = true; reachedEnd = false; break; }
      const rowBytes = Buffer.byteLength(row.text, 'utf8') + 8; // この行の本文のバイト数（番号・区切りの分を含む）。
      if (rows.length > 0 && (bytes + rowBytes > READ_RESPONSE_MAX_BYTES || chars + row.text.length + 1 > params.maxChars)) {
        truncatedByChars = true; hasMore = true; reachedEnd = false; break;
      }
      rows.push(row);
      bytes += rowBytes;
      chars += row.text.length + 1;
      if (row.clipped) clippedLines += 1;
    }
    if (wantTail) {
      for (const row of tailRows) {
        rows.push(row);
        if (row.clipped) clippedLines += 1;
      }
      totalLines = lastLine ? lastLine.line : 0;
      startLine = rows.length > 0 ? rows[0].line : 1;
    } else if (reachedEnd) {
      totalLines = lastLine ? lastLine.line : 0;
    }
    const endLine = rows.length > 0 ? rows[rows.length - 1].line : null; // 返した最後の行。
    if (!wantTail && rows.length === 0) {
      if (startLine > 1 && (reachedEnd || lastLine === null)) throw new BridgeToolError(ERROR_CLASS.RANGE_OUT_OF_BOUNDS, `startLine（${startLine}）がファイルの行数（${totalLines ?? 0} 行）を超えています。`);
    }
    if (hasMore && endLine !== null) {
      const lastRow = rows[rows.length - 1]; // 返した最後の行。
      nextResume = { b: lastRow.byteEnd, l: endLine + 1 };
    }
    if (!wantTail && totalLines === null && handle.size - (nextResume ? nextResume.b : 0) <= COUNT_LINES_MAX_BYTES && nextResume) {
      totalLines = countLinesFrom(handle, encoding, nextResume.b, nextResume.l); // 範囲の後ろの行数を速く数える。
    }
    const lineEnding = counts.lf > 0 && counts.crlf > 0 ? 'mixed' : counts.crlf > 0 ? 'crlf' : counts.lf > 0 ? 'lf' : 'none'; // 観測した行末。
    return { rows, encoding, lineEnding, startLine, endLine, totalLines, hasMore, nextResume, clippedLines, truncatedByChars, warnings };
  }

  // fromByte（行 fromLine の先頭）から最後までの行数を、復号せずに改行を数えて求める。総行数を返す（最後の行が改行で終わらなければ 1 行足す）。
  function countLinesFrom(handle, encoding, fromByte, fromLine) {
    const wide = encoding.name === 'utf-16le' || encoding.name === 'utf-16be'; // 2 バイト単位か。
    const buffer = Buffer.alloc(CHUNK_BYTES); // 読み取りの作業用。
    let position = fromByte; // 読む位置。
    let newlines = 0; // 数えた改行の数。
    let lastWasNewline = true; // 直前の単位が改行か（最後の行が改行で終わるかの判定）。
    let odd = null; // 2 バイト単位の端数。
    while (position < handle.size) {
      const got = handle.readAt(buffer, Math.min(buffer.length, handle.size - position), position); // 読めたバイト数。
      if (got <= 0) break;
      position += got;
      let work = buffer.subarray(0, got); // 数える範囲。
      if (odd !== null) { work = Buffer.concat([odd, work]); odd = null; }
      if (!wide) {
        let index = work.indexOf(0x0a); // 改行の位置。
        while (index >= 0) { newlines += 1; index = work.indexOf(0x0a, index + 1); }
        lastWasNewline = work[work.length - 1] === 0x0a;
      } else {
        const limit = work.length - (work.length % 2); // 2 バイト単位の端数を除く。
        for (let probe = 0; probe + 1 < limit; probe += 2) {
          const isNewline = encoding.name === 'utf-16le' ? (work[probe] === 0x0a && work[probe + 1] === 0) : (work[probe] === 0 && work[probe + 1] === 0x0a); // 改行の単位か。
          if (isNewline) newlines += 1;
          lastWasNewline = isNewline;
        }
        if (limit < work.length) odd = Buffer.from(work.subarray(limit));
      }
    }
    return fromLine - 1 + newlines + (lastWasNewline ? 0 : 1);
  }

  // 範囲読み取りの結果を facts にする。
  function describeRange(relative, handle, range) {
    return {
      path: relative,
      size: handle.size,
      modified: handle.modified,
      encoding: { name: range.encoding.name, bom: range.encoding.bom !== null, detected: range.encoding.detected },
      lineEnding: range.lineEnding,
      startLine: range.startLine,
      endLine: range.endLine,
      returnedLines: range.rows.length,
      totalLines: range.totalLines,
      hasMore: range.hasMore,
      text: numberLines(range.rows),
    };
  }

  async function readSource(input = {}) {
    boundary.assertSourceExposure();
    const call = newCall('read_source'); // 呼び出しの状態。
    const requested = requireString(input.path, 'path', { maxLength: 1024 }); // 読むファイル。
    const relative = boundary.normalizePath(requested); // プロジェクト相対のパス。
    const startLine = clampInteger(input.startLine, 'startLine', { min: 1, max: 100000000, fallback: 1 }); // 読み始める行。
    const lineCount = clampInteger(input.lineCount, 'lineCount', { min: 1, max: 2000, fallback: 200 }); // 返す行数。
    const maxChars = clampInteger(input.maxChars, 'maxChars', { min: 1000, max: 200000, fallback: 60000 }); // 返す本文の最大文字数。
    const requestedEncoding = resolveRequestedEncoding(input.encoding); // 明示された文字コード。
    const info = boundary.classifyPath(relative, { kind: 'source', scope: 'extended' }); // 種類（権限の検査つき）。
    if (info.kind === 'missing') throw new BridgeToolError(ERROR_CLASS.NOT_FOUND, 'ファイルが存在しません。');
    if (info.kind !== 'file') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'ディレクトリです。list_source_files で一覧してください。');
    let resume = null; // cursor から読んだ位置。
    if (input.cursor !== undefined && input.cursor !== null) {
      const payload = decodeCursor(input.cursor, 'read'); // 読んだ位置の情報。
      if (payload.p !== info.relative) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor は別のファイルのものです。');
      resume = payload;
    }
    const effectiveStart = resume && Number.isInteger(resume.l) && input.startLine === undefined ? resume.l : startLine; // cursor があって startLine が無ければ cursor の行から。
    return boundary.withFile(info.relative, { kind: 'source', scope: 'extended' }, async handle => {
      const range = readRange(handle, { requestedEncoding, startLine: effectiveStart, lineCount, maxChars, tail: false, resume, maxFileBytes: READ_MAX_FILE_BYTES }); // 範囲の読み取り。
      const warnings = [...call.warnings, ...range.warnings]; // 注意事項。
      if (range.clippedLines > 0) warnings.push(`${range.clippedLines} 行は長すぎるため、${MAX_DISPLAY_LINE_CHARS} 文字で切りました。`);
      if (range.truncatedByChars) warnings.push('1 回の応答の大きさの上限のため、指定の行数より手前で切りました。page.nextCursor で続きを取得してください。');
      if (range.totalLines === null && range.hasMore) warnings.push('総行数は数えていません（大きなファイル）。');
      const submodule = submoduleOf(info.relative); // サブモジュールの中なら、その名前。
      const envelope = makeEnvelope({
        tool: call.tool,
        collectedAt: call.collectedAt,
        sources: [describeSource(SOURCE_KIND.STATIC_ANALYSIS, call.collectedAt, handle.modified)],
        facts: { ...describeRange(info.relative, handle, range), ...(submodule ? { submodule } : {}) },
        page: {
          returned: range.rows.length,
          nextStartLine: range.hasMore ? range.endLine + 1 : null,
          nextCursor: range.hasMore ? encodeCursor('read', { p: info.relative, l: range.nextResume.l, b: range.nextResume.b, z: handle.size, m: handle.modifiedMs, e: range.encoding.name }) : null,
        },
        warnings,
        truncated: range.truncatedByChars,
        limits: { maxLineCount: 2000, maxChars, maxResponseBytes: READ_RESPONSE_MAX_BYTES, maxLineChars: MAX_DISPLAY_LINE_CHARS, maxFileBytes: READ_MAX_FILE_BYTES },
      });
      return fitToBudget(envelope, DEFAULT_MAX_RESPONSE_BYTES, null);
    });
  }

  // ---------- read_test_log ----------

  /*
    ログの場所の下のファイルを集めて、更新が新しい順に並べる。
    戻り値: { files（{ path, size, modifiedMs, name }）、walkInfo, truncatedBy }
  */
  function collectLogFiles(directoryPath, matchGlob) {
    const deadline = Date.now() + LIST_TIME_BUDGET_MS; // 時間の上限。
    const walker = boundary.openWalk({ startRelative: directoryPath, kind: 'log', deadlineMs: deadline }); // 走査。
    const files = []; // 集めたログファイル。
    try {
      for (;;) {
        const entry = walker.next(); // 次のファイル。
        if (!entry) break;
        if (matchGlob && !matchGlob(entry.path)) continue;
        files.push(entry);
        if (files.length >= MAX_LOG_FILES_LISTED) break;
      }
      files.sort((left, right) => (right.modifiedMs - left.modifiedMs) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      return { files, walkInfo: describeWalk(walker), truncatedBy: walkStopReason(walker.stats) };
    } finally {
      walker.close();
    }
  }

  // ログの場所の引数を決める。省略したとき、設定が 1 か所ならそれ。
  function resolveLogDirectory(input) {
    const directories = boundary.describeLogDirectories(); // 設定したログの場所。
    if (input.directory === undefined || input.directory === null || input.directory === '') {
      const usable = directories.filter(item => item.status === 'ok'); // 使える場所。
      if (usable.length === 1) return usable[0].path;
      throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'directory を指定してください（action: directories で許可された場所を確認できます）。');
    }
    return boundary.normalizePath(input.directory);
  }

  async function readTestLog(input = {}) {
    boundary.assertLogExposure();
    const call = newCall('read_test_log'); // 呼び出しの状態。
    const action = readEnum(input.action, 'action', ['directories', 'files', 'read', 'search'], 'directories'); // 操作。
    const sources = [describeSource(SOURCE_KIND.TEST_LOG, call.collectedAt)]; // 情報源（過去に作られたログ）。
    if (action === 'directories') {
      const directories = boundary.describeLogDirectories(); // 設定したログの場所。
      return makeEnvelope({
        tool: call.tool,
        collectedAt: call.collectedAt,
        sources,
        facts: { directories, logExtensions: boundary.logExtensions },
        warnings: directories.some(item => item.status === 'denied') ? ['status が denied の場所は、denyDirectories などの設定により読めません（deny が優先されます）。'] : [],
        hidden: [],
      });
    }
    const matchGlob = compileGlobs(input.glob, { ignoreCase }); // glob の判定。
    if (action === 'files') {
      const directory = resolveLogDirectory(input); // ログの場所。
      const limit = clampInteger(input.limit, 'limit', { min: 1, max: 200, fallback: 50 }); // 返す最大件数。
      boundary.classifyPath(directory, { kind: 'log' });
      const fingerprint = fingerprintOf(['logfiles', directory, input.glob ?? null]); // cursor の取り違え防止。
      let cursor = null; // 再開位置。
      if (input.cursor !== undefined && input.cursor !== null) {
        cursor = decodeCursor(input.cursor, 'logfiles');
        if (cursor.f !== fingerprint || !Number.isFinite(cursor.t) || typeof cursor.p !== 'string') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor がこの条件のものではありません。');
      }
      const collected = collectLogFiles(directory, matchGlob); // 集めたログファイル（新しい順）。
      let rest = collected.files; // これから返す候補。
      if (cursor) rest = rest.filter(entry => entry.modifiedMs < cursor.t || (entry.modifiedMs === cursor.t && entry.path > cursor.p));
      const page = rest.slice(0, limit); // このページ。
      const last = page[page.length - 1]; // このページの最後。
      const nextCursor = rest.length > limit && last ? encodeCursor('logfiles', { t: last.modifiedMs, p: last.path, f: fingerprint }) : null; // 続きの cursor。
      const warnings = []; // 注意事項。
      if (collected.truncatedBy) warnings.push('走査の上限（時間またはファイル数）に達したため、一覧は途中までです。directory や glob で範囲を絞ってください。');
      const newest = collected.files.length > 0 ? new Date(collected.files[0].modifiedMs).toISOString() : null; // 最も新しいログの更新日時。
      return fitWithCursor(page, (kept, cutCursor, cut) => makeEnvelope({
        tool: call.tool,
        collectedAt: call.collectedAt,
        sources: [describeSource(SOURCE_KIND.TEST_LOG, call.collectedAt, newest)],
        facts: { action, directory, order: '更新が新しい順', matchedFiles: collected.files.length, files: kept.map(entry => ({ path: entry.path, size: entry.size, modified: new Date(entry.modifiedMs).toISOString() })), ...collected.walkInfo },
        page: { limit, returned: kept.length, nextCursor: cut ? cutCursor : nextCursor },
        warnings: cut ? [...warnings, '応答の大きさの上限のため、後ろのファイルを省きました。page.nextCursor で続きを取得してください。'] : warnings,
        truncated: collected.truncatedBy !== null,
        limits: { timeBudgetMs: LIST_TIME_BUDGET_MS, maxFilesPerPage: 200 },
      }), entry => encodeCursor('logfiles', { t: entry.modifiedMs, p: entry.path, f: fingerprint }));
    }
    if (action === 'read') {
      const requested = requireString(input.file, 'file', { maxLength: 1024 }); // 読むログ。
      const relative = boundary.normalizePath(requested); // プロジェクト相対のパス。
      const info = boundary.classifyPath(relative, { kind: 'log' }); // 種類（権限の検査つき）。
      if (info.kind === 'missing') throw new BridgeToolError(ERROR_CLASS.NOT_FOUND, 'ログファイルが存在しません。');
      if (info.kind !== 'file') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'ディレクトリです。action: files で一覧してください。');
      const fromEnd = readBoolean(input.fromEnd, 'fromEnd', false); // 末尾から読むか。
      const lineCount = clampInteger(input.lineCount, 'lineCount', { min: 1, max: 2000, fallback: 200 }); // 返す行数。
      const startLine = clampInteger(input.startLine, 'startLine', { min: 1, max: 100000000, fallback: 1 }); // 読み始める行。
      let resume = null; // cursor から読んだ位置。
      if (input.cursor !== undefined && input.cursor !== null) {
        const payload = decodeCursor(input.cursor, 'logread'); // 読んだ位置の情報。
        if (payload.p !== info.relative) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor は別のファイルのものです。');
        resume = payload;
      }
      const effectiveStart = resume && Number.isInteger(resume.l) && input.startLine === undefined ? resume.l : startLine; // cursor の行から。
      return boundary.withFile(info.relative, { kind: 'log', scope: 'extended' }, async handle => {
        const range = readRange(handle, { requestedEncoding: null, startLine: effectiveStart, lineCount, maxChars: 60000, tail: fromEnd, resume, maxFileBytes: LOG_MAX_FILE_BYTES }); // 範囲の読み取り。
        const warnings = [...call.warnings, ...range.warnings]; // 注意事項。
        if (range.clippedLines > 0) warnings.push(`${range.clippedLines} 行は長すぎるため、${MAX_DISPLAY_LINE_CHARS} 文字で切りました。`);
        if (range.truncatedByChars) warnings.push('1 回の応答の大きさの上限のため、指定の行数より手前で切りました。page.nextCursor で続きを取得してください。');
        if (fromEnd) warnings.push('末尾の行を返しています。ログが書き込み中なら、取得のたびに内容が変わります。');
        const envelope = makeEnvelope({
          tool: call.tool,
          collectedAt: call.collectedAt,
          sources: [describeSource(SOURCE_KIND.TEST_LOG, call.collectedAt, handle.modified)],
          facts: { action, ...describeRange(info.relative, handle, range), order: fromEnd ? 'fromEnd' : 'fromStart' },
          page: {
            returned: range.rows.length,
            nextStartLine: range.hasMore ? range.endLine + 1 : null,
            nextCursor: range.hasMore ? encodeCursor('logread', { p: info.relative, l: range.nextResume.l, b: range.nextResume.b, z: handle.size, m: handle.modifiedMs, e: range.encoding.name }) : null,
          },
          warnings,
          truncated: range.truncatedByChars,
          limits: { maxLineCount: 2000, maxResponseBytes: READ_RESPONSE_MAX_BYTES, maxFileBytes: LOG_MAX_FILE_BYTES },
        });
        return fitToBudget(envelope, DEFAULT_MAX_RESPONSE_BYTES, null);
      });
    }
    // action === 'search'
    const severities = readStringList(input.severity, 'severity', 3); // 重大度の指定。
    for (const severity of severities) {
      if (!Object.hasOwn(SEVERITY_PATTERNS, severity)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'severity は error / fail / warning のどれかで指定してください。');
    }
    const hasPattern = typeof input.pattern === 'string' && input.pattern !== ''; // 文字列の指定があるか。
    if (input.pattern !== undefined && input.pattern !== null && typeof input.pattern !== 'string') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'pattern は文字列で指定してください。');
    if (severities.length > 0 && hasPattern) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'severity と pattern は同時に指定できません。');
    const effectiveSeverities = severities.length > 0 ? severities : (hasPattern ? [] : ['error', 'fail']); // 何も指定が無ければ error と fail。
    const matcher = hasPattern
      ? createMatcher({ query: input.pattern, mode: 'literal', caseSensitive: false, wholeWord: false })
      : createMatcher({ query: effectiveSeverities.map(severity => SEVERITY_PATTERNS[severity].source).join('|'), mode: 'regex', caseSensitive: false, wholeWord: false }); // 照合器。
    const before = clampInteger(input.contextBefore, 'contextBefore', { min: 0, max: 10, fallback: 1 }); // 前の行数。
    const after = clampInteger(input.contextAfter, 'contextAfter', { min: 0, max: 10, fallback: 1 }); // 後ろの行数。
    const maxResults = clampInteger(input.maxResults, 'maxResults', { min: 1, max: 200, fallback: 50 }); // 返す最大件数。
    const timeBudgetMs = clampInteger(input.timeBudgetMs, 'timeBudgetMs', { min: 1000, max: MAX_TIME_BUDGET_MS, fallback: DEFAULT_TIME_BUDGET_MS }); // 時間の上限。
    const latest = clampInteger(input.latest, 'latest', { min: 1, max: 20, fallback: 1 }); // 対象にする新しいファイルの数。
    let targets; // 検索するログファイル。
    let target; // 検索の対象の説明。
    if (typeof input.file === 'string' && input.file !== '') {
      const relative = boundary.normalizePath(input.file); // プロジェクト相対のパス。
      const info = boundary.classifyPath(relative, { kind: 'log' }); // 種類（権限の検査つき）。
      if (info.kind !== 'file') throw new BridgeToolError(info.kind === 'missing' ? ERROR_CLASS.NOT_FOUND : ERROR_CLASS.INVALID_ARGUMENT, info.kind === 'missing' ? 'ログファイルが存在しません。' : 'file にはログファイルを指定してください。');
      targets = [{ path: info.relative, name: info.relative.slice(info.relative.lastIndexOf('/') + 1) }];
      target = { file: info.relative };
    } else {
      const directory = resolveLogDirectory(input); // ログの場所。
      boundary.classifyPath(directory, { kind: 'log' });
      const collected = collectLogFiles(directory, matchGlob); // 集めたログファイル（新しい順）。
      targets = collected.files.slice(0, latest);
      target = { directory, latest, matchedFiles: collected.files.length };
      if (collected.truncatedBy) call.warnings.push('走査の上限に達したため、「最新」の判定が途中までの一覧によるものです。directory や glob で範囲を絞ってください。');
    }
    const fingerprint = fingerprintOf(['logsearch', target, effectiveSeverities, hasPattern ? input.pattern : null, before, after, input.glob ?? null]); // cursor の取り違え防止。
    const cursor = readSearchCursor(input, 'logsearch', fingerprint); // 再開位置。
    const searchResult = await runSearch({
      tool: call.tool, kind: 'log', startPath: '', scope: 'extended', filter: { check: () => 'ok' }, matcher, before, after, maxResults, maxPerFile: maxResults, timeBudgetMs, cursor,
      cursorKind: 'logsearch', fingerprint, maxFileBytes: LOG_MAX_FILE_BYTES, files: targets,
      inspect: (row) => { // 一致した行の重大度の語を付ける。
        const labels = Object.keys(SEVERITY_PATTERNS).filter(severity => SEVERITY_PATTERNS[severity].test(row.text)); // 当てはまる重大度。
        return { severity: labels };
      },
      explicitFile: true,
    }); // 検索の結果。
    const summary = { error: 0, fail: 0, warning: 0 }; // 返した一致の重大度ごとの件数。
    for (const match of searchResult.matches) for (const label of match.severity || []) summary[label] += 1;
    return fitWithCursor(searchResult.matches, (kept, cutCursor, cut) => buildSearchEnvelope(call, {
      facts: { action, ...target, severity: effectiveSeverities, pattern: hasPattern ? input.pattern : null, matches: kept, severityCounts: summary },
      searchResult: cut ? { ...searchResult, matches: kept, nextCursor: cutCursor, truncatedBy: 'size' } : searchResult,
      extraWarnings: ['1 行につき最初の一致だけを返します。重大度の語はログの書式により異なるため、見つからないことが問題の無いことを意味するとは限りません。'],
      sourceKind: SOURCE_KIND.TEST_LOG,
      limits: { maxResults: 200, maxFileBytes: LOG_MAX_FILE_BYTES, maxTimeBudgetMs: MAX_TIME_BUDGET_MS },
    }), match => encodeCursor('logsearch', { p: match.path, l: match.line + 1, f: fingerprint }));
  }

  return { listSourceFiles, searchCode, readSource, findReferences, readTestLog };
}
