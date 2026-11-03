/*
  2.6.0 で追加したソース読み取りツール（list_source_files・search_code・read_source・find_references・read_test_log）の部品。
  このモジュールはファイルにも Git にも触れない。バイト列・文字列・コールバック（readAt）だけを扱う純粋な部品で、
  公開境界の検査（リンク・境界・権限・fd の固定）は server.mjs の境界関数が済ませてから、読み取りの関数だけを渡す。
  - テキスト判定（本文の検査）、文字コードの判定と復号、行単位のストリーム読み取り（行ごとのバイト位置つき）
  - 秘密値のマスク（行番号を変えない行単位。PEM 秘密鍵ブロックは状態を持って行ごとに置換）、秘密ファイルの本文判定、個人情報の簡易マスク
  - 続きの取得に使う cursor の符号化と検証、glob の照合、正規表現の安全な実行（vm の時間制限）
  書き込み・削除・外部コマンドの部品は読み込まない（node:vm だけを使う）。
*/
import vm from 'node:vm';
import { BridgeToolError, ERROR_CLASS } from './bridge-tools-common.mjs';

export const CHUNK_BYTES = 65536; // ファイルから 1 回に読むバイト数。メモリはこの大きさで固定する。
export const MAX_DISPLAY_LINE_CHARS = 2000; // 応答に載せる 1 行の最大文字数。超えた分は印を付けて切る。
export const MAX_MATCH_LINE_CHARS = 20000; // 検索で照合する 1 行の最大文字数。これより後ろの一致は見つけない。
export const MAX_LINE_BYTES = 262144; // 1 行として溜めるバイト数の上限。超えた行は後ろを捨てて「行が長すぎる」印を付ける。
export const EXCERPT_CHARS = 400; // 検索結果に載せる 1 行の抜粋の最大文字数（一致の周り）。
const HEAD_INSPECT_BYTES = 8192; // テキストかを調べるために先頭から見るバイト数。
export const SECRET_SCAN_BYTES = 65536; // 秘密ファイルの本文判定のために先頭から見るバイト数。
const MAX_CURSOR_CHARS = 2048; // cursor の最大文字数。
const MAX_GLOB_PATTERNS = 8; // glob の最大本数。
const MAX_GLOB_CHARS = 256; // glob 1 本の最大文字数。
export const MAX_REGEX_CHARS = 512; // 検索パターン（正規表現・固定文字列）の最大文字数。
const BINARY_CONTROL_RATIO = 0.02; // 先頭に制御文字がこの割合を超えて含まれるものはバイナリとみなす。

/*
  拡張子 → 言語の表。標準の対象（拡張子の面）はこの表にあるものと SOURCE_FILE_NAMES のものだけ。
  本文の検査（inspectHead）は拡張子にかかわらず必ず行う。.uid・.import・.md5 などの付随ファイルは雑音になるため標準の対象に入れない
  （includeOtherText: true で本文検査つきで対象にできる）。
*/
const SOURCE_LANGUAGE_TABLE = [
  ['GDScript', ['.gd']],
  ['Godot シーン・リソース', ['.tscn', '.tres', '.godot', '.gdextension']],
  ['シェーダー', ['.gdshader', '.gdshaderinc', '.hlsl', '.glsl', '.shader', '.wgsl', '.frag', '.vert', '.compute', '.usf', '.ush']],
  ['C', ['.c']],
  ['C/C++ ヘッダー', ['.h']],
  ['C++', ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.inl', '.ipp', '.inc']],
  ['C#', ['.cs']],
  ['Python', ['.py', '.pyw', '.pyi']],
  ['JavaScript', ['.js', '.mjs', '.cjs', '.jsx']],
  ['TypeScript', ['.ts', '.tsx', '.mts', '.cts']],
  ['PowerShell', ['.ps1', '.psm1', '.psd1']],
  ['Lua', ['.lua']],
  ['Shell', ['.sh', '.bash', '.zsh', '.fish']],
  ['Batch', ['.bat', '.cmd']],
  ['Java', ['.java']],
  ['Kotlin', ['.kt', '.kts']],
  ['Go', ['.go']],
  ['Rust', ['.rs']],
  ['Ruby', ['.rb']],
  ['PHP', ['.php']],
  ['Swift', ['.swift']],
  ['SQL', ['.sql']],
  ['JSON', ['.json', '.jsonc', '.json5', '.jsonl', '.ndjson']],
  ['YAML', ['.yml', '.yaml']],
  ['TOML', ['.toml']],
  ['XML', ['.xml', '.xaml', '.xsd', '.plist', '.ui', '.qrc']],
  ['INI・設定', ['.ini', '.cfg', '.conf', '.properties', '.editorconfig']],
  ['CSV', ['.csv', '.tsv']],
  ['HTML', ['.html', '.htm']],
  ['CSS', ['.css', '.scss', '.sass', '.less']],
  ['ビルド定義', ['.cmake', '.scons', '.sln', '.csproj', '.vcxproj', '.fsproj', '.props', '.targets', '.pro', '.pri', '.gradle']],
  ['Markdown', ['.md', '.markdown', '.mdx']],
  ['reStructuredText', ['.rst']],
  ['テキスト', ['.txt', '.adoc']],
  ['ログ・テスト結果', ['.log', '.out', '.err', '.tap', '.trx']],
];
const LANGUAGE_BY_SOURCE_EXTENSION = new Map(); // 拡張子 → 言語。
for (const [language, extensions] of SOURCE_LANGUAGE_TABLE) {
  for (const extension of extensions) LANGUAGE_BY_SOURCE_EXTENSION.set(extension, language);
}
const SOURCE_FILE_NAMES = new Map([
  ['makefile', 'ビルド定義'], ['gnumakefile', 'ビルド定義'], ['cmakelists.txt', 'ビルド定義'], ['sconstruct', 'ビルド定義'], ['sconscript', 'ビルド定義'],
  ['scsub', 'ビルド定義'], ['dockerfile', 'ビルド定義'], ['containerfile', 'ビルド定義'], ['jenkinsfile', 'ビルド定義'], ['gemfile', 'ビルド定義'], ['rakefile', 'ビルド定義'],
  ['.gitignore', '設定'], ['.gitattributes', '設定'], ['.gitmodules', '設定'], ['.editorconfig', '設定'], ['.clang-format', '設定'], ['.clang-tidy', '設定'],
  ['license', 'テキスト'], ['readme', 'テキスト'], ['changelog', 'テキスト'],
]); // 拡張子では決まらない、名前で決まるファイル（小文字で引く）。

// ファイル名から拡張子（小文字。先頭のドットだけの名前は拡張子なし）を返す。
export function extensionOf(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

/*
  ファイル名から、標準の対象（拡張子の面）に当たるかと言語を返す。
  戻り値: { standard: boolean, language: string }。standard が false のものは includeOtherText: true のときだけ本文検査つきで対象になる。
*/
export function classifySourceName(fileName) {
  const lower = fileName.toLowerCase();
  const byName = SOURCE_FILE_NAMES.get(lower); // 名前で決まるファイル。
  if (byName) return { standard: true, language: byName };
  const byExtension = LANGUAGE_BY_SOURCE_EXTENSION.get(extensionOf(fileName)); // 拡張子で決まる言語。
  if (byExtension) return { standard: true, language: byExtension };
  return { standard: false, language: 'その他' };
}

// ---------- テキスト判定と文字コード ----------

const BINARY_SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0xff, 0xd8, 0xff], // JPEG
  [0x50, 0x4b, 0x03, 0x04], // ZIP・docx・jar など
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x4d, 0x5a], // 実行ファイル（MZ）
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x1f, 0x8b], // gzip
  [0x52, 0x49, 0x46, 0x46], // RIFF（wav・webp・avi）
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x4f, 0x67, 0x67, 0x53], // Ogg
  [0x49, 0x44, 0x33], // MP3（ID3）
  [0x77, 0x4f, 0x46, 0x46], // woff
  [0x00, 0x61, 0x73, 0x6d], // wasm
  [0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52], // .blend
  [0x47, 0x44, 0x53, 0x43], // Godot の圧縮リソース（GDSC）
  [0x47, 0x44, 0x50, 0x43], // Godot のパック（GDPC）
  [0x52, 0x53, 0x52, 0x43], // Godot のバイナリリソース（RSRC）
]; // 先頭のバイト列でバイナリと分かる形式。

// バッファが指定のバイト列で始まるか。
function startsWithBytes(buffer, signature) {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}

/*
  ファイルの先頭から、テキストとして扱ってよいかと BOM を判定する。拡張子は見ない。
  戻り値: { kind: 'text' | 'binary', reason, bom: null | 'utf-8' | 'utf-16le' | 'utf-16be', bomBytes }
  - UTF-16 の BOM があれば NUL を含んでもテキスト（UTF-16）。UTF-32 の BOM はバイナリ扱い（未対応）。
  - BOM が無ければ、既知のバイナリ署名・NUL・制御文字の割合（2% 超）でバイナリとする。
*/
export function inspectHead(buffer) {
  const head = buffer.subarray(0, HEAD_INSPECT_BYTES); // 調べる範囲。
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { kind: 'text', reason: 'utf-8-bom', bom: 'utf-8', bomBytes: 3 };
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xfe && head[2] === 0 && head[3] === 0) return { kind: 'binary', reason: 'utf-32', bom: null, bomBytes: 0 };
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { kind: 'text', reason: 'utf-16le-bom', bom: 'utf-16le', bomBytes: 2 };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { kind: 'text', reason: 'utf-16be-bom', bom: 'utf-16be', bomBytes: 2 };
  if (BINARY_SIGNATURES.some(signature => startsWithBytes(head, signature))) return { kind: 'binary', reason: 'signature', bom: null, bomBytes: 0 };
  let controls = 0; // 制御文字（改行・タブ・ESC 以外）の数。
  for (const byte of head) {
    if (byte === 0) return { kind: 'binary', reason: 'nul', bom: null, bomBytes: 0 };
    if ((byte < 0x09) || (byte > 0x0d && byte < 0x1b) || (byte > 0x1b && byte < 0x20)) controls += 1;
  }
  if (head.length > 0 && controls / head.length > BINARY_CONTROL_RATIO) return { kind: 'binary', reason: 'control-characters', bom: null, bomBytes: 0 };
  return { kind: 'text', reason: 'text', bom: null, bomBytes: 0 };
}

const EXPLICIT_ENCODINGS = new Map([
  ['utf-8', 'utf-8'], ['utf8', 'utf-8'],
  ['utf-16le', 'utf-16le'], ['utf-16be', 'utf-16be'],
  ['shift_jis', 'shift_jis'], ['shift-jis', 'shift_jis'], ['sjis', 'shift_jis'], ['cp932', 'shift_jis'], ['windows-31j', 'shift_jis'],
  ['euc-jp', 'euc-jp'], ['eucjp', 'euc-jp'],
  ['windows-1252', 'windows-1252'], ['cp1252', 'windows-1252'],
]); // encoding 引数で明示できる文字コード（小文字で引く）。これ以外は受け付けない。
export const EXPLICIT_ENCODING_NAMES = Object.freeze(['utf-8', 'utf-16le', 'utf-16be', 'shift_jis', 'euc-jp', 'windows-1252']); // ツールの説明に出す許可リスト。

/*
  encoding 引数を正規の名前にする。'auto'・未指定は null（自動判定）。許可リストに無い名前は invalid_argument。
*/
export function resolveRequestedEncoding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'encoding は文字列で指定してください。');
  const lower = value.trim().toLowerCase(); // 比較用の小文字。
  if (lower === '' || lower === 'auto') return null;
  const name = EXPLICIT_ENCODINGS.get(lower); // 正規の名前。
  if (!name) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `encoding は auto または ${EXPLICIT_ENCODING_NAMES.join(' / ')} のどれかを指定してください。`);
  return name;
}

/*
  読み取りに使う文字コードを決める。
  引数: head（inspectHead の戻り値）、requested（resolveRequestedEncoding の戻り値）
  戻り値: { name, bom（BOM の種類か null）, bomBytes, detected: 'bom' | 'utf8-strict' | 'explicit' }
  - BOM があればそれに従う。BOM と明示が食い違うときは invalid_argument（黙って片方を選ばない）。
  - BOM が無ければ、明示が無い限り UTF-8（復号が失敗したら unsupported_encoding になる。推測はしない）。
*/
export function chooseEncoding(head, requested) {
  if (head.bom) {
    if (requested && requested !== head.bom) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `ファイルは ${head.bom} の BOM を持つため、encoding に ${requested} は指定できません。`);
    return { name: head.bom, bom: head.bom, bomBytes: head.bomBytes, detected: 'bom' };
  }
  if (requested) return { name: requested, bom: null, bomBytes: 0, detected: 'explicit' };
  return { name: 'utf-8', bom: null, bomBytes: 0, detected: 'utf8-strict' };
}

/*
  文字コード名から TextDecoder を作る。strict が true なら不正なバイトで例外、false なら U+FFFD にする。BOM は呼び出し側が先に除くので残す（ignoreBOM）。
  この環境の Node がその文字コードに対応していなければ（ICU が小さい場合など）、unsupported_encoding を投げる。
*/
export function createDecoder(name, strict) {
  try {
    return new TextDecoder(name, { fatal: strict, ignoreBOM: true });
  } catch {
    throw new BridgeToolError(ERROR_CLASS.UNSUPPORTED_ENCODING, `この環境の Node.js は文字コード ${name} に対応していません。`);
  }
}

/*
  readAt（fs.readSync に相当する同期の読み取り関数）から、行を 1 行ずつ返すジェネレーター。
  引数: readAt(buffer, length, position) → 読めたバイト数、size（ファイルの大きさ）、encoding（chooseEncoding の戻り値）、
        startByte（読み始める位置。行の先頭であること。既定は BOM の直後）、startLine（startByte の行番号。既定 1）、
        lossy（true なら復号の失敗を U+FFFD で通す。秘密ファイル判定の先頭だけに使う）
  各要素: { line, byteStart, byteEnd, text（改行を除いた本文）, eol（'\n' | '\r\n' | ''）, cut（行が長すぎて後ろを捨てたか） }
  byteStart・byteEnd はファイル上の位置（BOM を含む）で、byteEnd は次の行の先頭。長すぎる行（MAX_LINE_BYTES 超）も、位置は正確なまま
  後ろだけを捨てる。復号できない行があれば BridgeToolError(unsupported_encoding) を投げる（メッセージに行番号を含める）。
*/
export function* readLines({ readAt, size, encoding, startByte = encoding.bomBytes, startLine = 1, lossy = false }) {
  const wide = encoding.name === 'utf-16le' || encoding.name === 'utf-16be'; // 2 バイト単位か。
  const unit = wide ? 2 : 1; // 1 文字の最小単位のバイト数。
  const littleEndian = encoding.name !== 'utf-16be'; // UTF-16 のバイト順。
  const decoder = createDecoder(encoding.name, !lossy);
  const buffer = Buffer.alloc(CHUNK_BYTES); // 読み取りの作業用。
  let position = startByte; // 次に読むファイル上の位置。
  let lineNumber = startLine; // 次に返す行の番号。
  let lineStart = startByte; // 溜めている行の先頭のファイル上の位置。
  let pending = []; // 現在の行のうち、前のチャンクまでに読んだ部分（コピー）。
  let pendingBytes = 0; // pending の合計バイト数（MAX_LINE_BYTES まで）。
  let discarded = false; // 現在の行の後ろを MAX_LINE_BYTES を超えたため捨てたか。
  let oddByte = null; // 2 バイト単位のとき、チャンクの端に余った 1 バイト。

  // 溜めたバイト列と今回の断片をつなぎ、行の要素にする。bytes は改行を含まない本文、hasEol は行末の改行を持つか。
  const makeLine = (bytes, hasEol, byteStart, byteEnd, cut) => {
    let body = bytes; // 本文のバイト列。
    let eol = hasEol ? '\n' : ''; // 行末。
    if (hasEol && body.length >= unit) {
      const isCarriageReturn = wide
        ? (littleEndian ? body[body.length - 2] === 0x0d && body[body.length - 1] === 0 : body[body.length - 2] === 0 && body[body.length - 1] === 0x0d)
        : body[body.length - 1] === 0x0d; // 直前が CR か。
      if (isCarriageReturn) { body = body.subarray(0, body.length - unit); eol = '\r\n'; }
    }
    let text; // 復号した本文。
    try {
      text = decoder.decode(body);
    } catch {
      throw new BridgeToolError(ERROR_CLASS.UNSUPPORTED_ENCODING, `${lineNumber} 行目が ${encoding.name} として復号できません（文字コードが違う可能性があります。encoding を明示してください）。`);
    }
    return { line: lineNumber, byteStart, byteEnd, text, eol, cut };
  };

  // 現在の行の断片を pending へ足す（上限を超えた分は捨てて discarded を立てる）。
  const keep = fragment => {
    if (fragment.length === 0) return;
    const room = MAX_LINE_BYTES - pendingBytes; // あと何バイト溜められるか。
    if (room <= 0) { discarded = true; return; }
    const taken = fragment.length > room ? fragment.subarray(0, room - (room % unit)) : fragment; // 溜める部分。
    if (taken.length < fragment.length) discarded = true;
    pending.push(Buffer.from(taken)); // 作業用バッファは次の読み取りで上書きされるのでコピーする。
    pendingBytes += taken.length;
  };

  while (position < size) {
    const wanted = Math.min(buffer.length, size - position); // 今回読むバイト数。
    const got = readAt(buffer, wanted, position); // 実際に読めたバイト数。
    if (got <= 0) break;
    const chunkPosition = position; // このチャンクの先頭のファイル上の位置。
    position += got;
    let work = buffer.subarray(0, got); // 走査するバイト列。
    let workPosition = chunkPosition; // work の先頭のファイル上の位置。
    if (oddByte !== null) {
      work = Buffer.concat([oddByte, work]);
      workPosition -= 1;
      oddByte = null;
    }
    const limit = work.length - (work.length % unit); // 2 バイト単位の端数は次回へ回す。
    let segmentStart = 0; // 現在の行の、work 内での断片の先頭。
    let index = 0; // 改行を探す位置。
    while (index < limit) {
      let newlineAt = -1; // 改行の work 内の位置。
      if (!wide) {
        newlineAt = work.indexOf(0x0a, index);
        if (newlineAt >= limit) newlineAt = -1;
      } else {
        for (let probe = index; probe + 1 < limit; probe += 2) {
          if (littleEndian ? (work[probe] === 0x0a && work[probe + 1] === 0) : (work[probe] === 0 && work[probe + 1] === 0x0a)) { newlineAt = probe; break; }
        }
      }
      if (newlineAt < 0) break;
      const fragment = work.subarray(segmentStart, newlineAt); // 行末の改行の手前までの断片。
      let bytes; // 行のバイト列（改行を含む）。
      if (pendingBytes === 0 && !discarded && fragment.length <= MAX_LINE_BYTES) {
        bytes = fragment;
      } else {
        keep(fragment);
        bytes = Buffer.concat(pending);
      }
      const byteEnd = workPosition + newlineAt + unit; // 次の行の先頭のファイル上の位置。
      yield makeLine(bytes, true, lineStart, byteEnd, discarded);
      lineNumber += 1;
      lineStart = byteEnd;
      pending = [];
      pendingBytes = 0;
      discarded = false;
      segmentStart = newlineAt + unit;
      index = segmentStart;
    }
    keep(work.subarray(segmentStart, limit));
    if (limit < work.length) oddByte = Buffer.from(work.subarray(limit));
  }
  if (position >= size && (pendingBytes > 0 || oddByte !== null || lineStart < size)) {
    // 改行で終わらない最後の行（端数のバイトは捨てる）。
    yield makeLine(Buffer.concat(pending), false, lineStart, size, discarded);
  }
}
// 1 行を応答用に切る。maxChars を超えたら後ろを捨て、捨てた文字数を示す印を付ける。
export function clipLine(text, maxChars = MAX_DISPLAY_LINE_CHARS) {
  if (text.length <= maxChars) return { text, clipped: false };
  return { text: `${text.slice(0, maxChars)}…[+${text.length - maxChars}文字]`, clipped: true };
}

// 一致の周りを maxChars 文字ぐらいで切り出す。一致が先頭近くなら先頭から、長い行なら両端に省略の印を付ける。
export function excerptAround(text, index, length, maxChars = EXCERPT_CHARS) {
  if (text.length <= maxChars) return { text, clipped: false };
  const margin = Math.max(Math.floor((maxChars - Math.min(length, maxChars)) / 2), 0); // 一致の前後に残す文字数。
  const start = Math.max(Math.min(index - margin, text.length - maxChars), 0);
  const end = Math.min(start + maxChars, text.length);
  return { text: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, clipped: true, offset: start - (start > 0 ? 1 : 0) * -1 };
}

// ---------- 秘密値のマスク ----------

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/; // PEM 秘密鍵ブロックの開始行。
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/; // PEM 秘密鍵ブロックの終了行。
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g; // メールアドレス（簡易）。
const WINDOWS_PROFILE_PATTERN = /([A-Za-z]:[\\/]+Users[\\/]+)(?!(?:Public|Default|All Users|Default User|Shared)(?:[\\/]|$))([^\\/\s"'<>|:*?]+)/gi; // Windows のユーザーフォルダー。
const UNIX_PROFILE_PATTERN = /((?:^|[^A-Za-z0-9_.-])\/(?:home|Users)\/)(?!(?:shared|Shared|Public)(?:\/|$))([^/\s"'<>|:*?]+)/g; // Linux・macOS のユーザーフォルダー。

// メールアドレスと、ユーザーフォルダー名（C:\Users\<名前>、/home/<名前>）を伏せる。ヒューリスティックで、個人情報の漏えいを完全には防げない。
export function maskPersonalData(text) {
  return text
    .replace(EMAIL_PATTERN, '[EMAIL]')
    .replace(WINDOWS_PROFILE_PATTERN, '$1[USER]')
    .replace(UNIX_PROFILE_PATTERN, '$1[USER]');
}

/*
  行単位のマスク関数を作る。行番号が変わらないよう、1 行を必ず 1 行で返す。
  - PEM 秘密鍵ブロック: 開始行から終了行までを、状態を持って行ごとに置き換える（途中から読み始めても、ファイルの先頭から読む前提で正確）。
  - それ以外: 渡された redact（既存の秘密値のマスク）と、メール・ユーザーフォルダー名のマスク。
  引数: redact（文字列を受けて秘密値を伏せた文字列を返す関数）
  戻り値: { mask(text), reset() }
*/
export function createLineMasker(redact) {
  let insideKey = false; // PEM 秘密鍵ブロックの内側か。
  return {
    mask(text) {
      if (insideKey) {
        if (PRIVATE_KEY_END.test(text)) insideKey = false;
        return '[REDACTED PRIVATE KEY BLOCK]';
      }
      if (PRIVATE_KEY_BEGIN.test(text)) {
        if (!PRIVATE_KEY_END.test(text)) insideKey = true;
        return '[REDACTED PRIVATE KEY]';
      }
      return maskPersonalData(redact(text));
    },
    reset() {
      insideKey = false;
    },
  };
}

const SECRET_KEY_WORDS = '(?:api[_-]?key|secret|token|password|passwd|pwd|credential|private[_-]?key|access[_-]?key)'; // 秘密らしい値のキー名に含まれる語。
const SECRET_ASSIGNMENT_PATTERN = new RegExp(`^\\s*(?:export\\s+|set\\s+)?[A-Za-z0-9_.-]*${SECRET_KEY_WORDS}[A-Za-z0-9_.-]*\\s*[:=]\\s*["']?([^\\s"'<>$%{}()]{8,})`, 'i'); // KEY=値 形式で、値が 8 文字以上の秘密らしい行（.env・設定ファイル向け。値が引用符で囲まれていなくてもよい）。
const SECRET_QUOTED_ASSIGNMENT_PATTERN = new RegExp(`(?:^|[\\s,(\\[{])[A-Za-z0-9_.-]*${SECRET_KEY_WORDS}[A-Za-z0-9_.-]*(?:\\s*:\\s*[\\w<>\\[\\]?]+)?\\s*[:=]\\s*["']([^"'\\s<>$%{}()]{8,})["']`, 'i'); // プログラムのソース向け: 値が引用符で囲まれた文字列のものだけ（変数 _process_token = some_identifier のような代入は秘密とみなさない）。
const PLACEHOLDER_VALUE_PATTERN = /^(?:\.{3,}|\*{4,}|x{4,}|<.*|your[-_]|example|changeme|placeholder|todo|null|none|false|true|redacted)/i; // 見本・伏せ字の値。
const SECRET_FILE_MIN_ASSIGNMENTS = 3; // これ以上の秘密らしい行があれば、秘密ファイルとして本文を返さない。

/*
  先頭部分の本文から、明らかな秘密ファイル（本文の読み取り自体を拒否すべきもの）かを判定する。
  - PEM 秘密鍵ブロックがある
  - 「キー名 = 値」形式の秘密らしい行（値は 8 文字以上で見本・伏せ字でない）が 3 行以上ある。quotedOnly（プログラムのソース）のときは、値が引用符で囲まれた行だけを数える
  戻り値: 理由の文字列（'private-key' | 'secret-assignments'）か null。
*/
export function detectSecretContent(text, { quotedOnly = false } = {}) {
  if (PRIVATE_KEY_BEGIN.test(text)) return 'private-key';
  const pattern = quotedOnly ? SECRET_QUOTED_ASSIGNMENT_PATTERN : SECRET_ASSIGNMENT_PATTERN; // 秘密らしい行の判定（プログラムのソースは、値が引用符で囲まれたものだけ）。
  let assignments = 0; // 秘密らしい行の数。
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match && !PLACEHOLDER_VALUE_PATTERN.test(match[1])) {
      assignments += 1;
      if (assignments >= SECRET_FILE_MIN_ASSIGNMENTS) return 'secret-assignments';
    }
  }
  return null;
}

// ---------- cursor ----------

// 続きの取得に使う cursor（不透明な文字列）を作る。内容は種類（kind）と位置の情報だけ。
export function encodeCursor(kind, payload) {
  return Buffer.from(JSON.stringify({ k: kind, ...payload }), 'utf8').toString('base64url');
}

/*
  cursor を読む。種類が違う・壊れている・大きすぎるものは invalid_argument。
  読んだ内容は位置の情報にすぎず、使うときに必ず公開境界の検査を通す（cursor を信用して権限を省かない）。
*/
export function decodeCursor(text, kind) {
  if (typeof text !== 'string' || text === '' || text.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor が正しくありません。前回の応答の page.nextCursor をそのまま渡してください。');
  }
  let payload; // 読んだ内容。
  try {
    payload = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor が正しくありません。前回の応答の page.nextCursor をそのまま渡してください。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.k !== kind) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor がこのツールのものではありません。');
  }
  return payload;
}

// ---------- glob ----------

// glob 1 本を、プロジェクト相対パス（/ 区切り）に当てる正規表現にする。/ を含まない glob はどの階層のファイル名にも当てる。
function globToRegExp(pattern, ignoreCase) {
  let source = ''; // 作る正規表現の本体。
  let index = 0; // 読み位置。
  let braceDepth = 0; // { } の深さ（入れ子は受け付けない）。
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 3; } else { source += '.*'; index += 2; }
      } else { source += '[^/]*'; index += 1; }
    } else if (character === '?') {
      source += '[^/]'; index += 1;
    } else if (character === '[') {
      const close = pattern.indexOf(']', index + 2); // クラスの終わり。
      if (close < 0) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `glob の [ が閉じていません: ${pattern}`);
      let body = pattern.slice(index + 1, close); // クラスの中身。
      const negate = body.startsWith('!') || body.startsWith('^'); // 否定か。
      if (negate) body = body.slice(1);
      source += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      index = close + 1;
    } else if (character === '{') {
      if (braceDepth > 0) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `glob の { } は入れ子にできません: ${pattern}`);
      braceDepth += 1; source += '(?:'; index += 1;
    } else if (character === '}' && braceDepth > 0) {
      braceDepth -= 1; source += ')'; index += 1;
    } else if (character === ',' && braceDepth > 0) {
      source += '|'; index += 1;
    } else {
      source += character.replace(/[.+^${}()|[\]\\/]/g, '\\$&'); index += 1;
    }
  }
  if (braceDepth > 0) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `glob の { が閉じていません: ${pattern}`);
  const anchored = pattern.includes('/') ? `^${source}$` : `(?:^|/)${source}$`; // / を含まなければ、どの階層のファイル名にも当てる。
  try {
    return new RegExp(anchored, ignoreCase ? 'i' : '');
  } catch {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `glob を解釈できません: ${pattern}`);
  }
}

/*
  glob（文字列か文字列の配列）を、相対パスを受けて真偽を返す関数にする。いずれかに当たれば真。未指定は null（絞り込まない）。
  対応: * ? ** [abc] [!abc] {a,b}。ignoreCase は Windows のパス比較に合わせるときに使う。
*/
export function compileGlobs(value, { ignoreCase = false } = {}) {
  if (value === undefined || value === null) return null;
  const patterns = Array.isArray(value) ? value : [value]; // 指定された glob の一覧。
  if (patterns.length === 0) return null;
  if (patterns.length > MAX_GLOB_PATTERNS) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `glob は ${MAX_GLOB_PATTERNS} 本までです。`);
  const expressions = patterns.map(pattern => {
    if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.length > MAX_GLOB_CHARS) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `glob は空でない ${MAX_GLOB_CHARS} 文字以内の文字列で指定してください。`);
    return globToRegExp(pattern.trim().replace(/\\/g, '/').replace(/^\.\//, ''), ignoreCase);
  });
  return relative => expressions.some(expression => expression.test(relative));
}

// ---------- 検索（固定文字列・正規表現） ----------

const PREFILTER_CHUNK_BYTES = 1048576; // 先読みで 1 回に読むバイト数（1MiB）。

/*
  固定文字列の検索のための先読み。その語を含まないファイルを、行の復号・マスクをせずに、生のバイトの検索だけで除く（検索を大幅に速くする）。
  先読みが「含まない」と言ったファイルは、行ごとに調べても一致しない（必要条件）。使えない条件では null を返す:
  - 検索語が [ を含む、または REDACTED を含む（マスクが作る文字列に一致しうるため）
  - 大文字小文字を区別せず、検索語が ASCII 以外を含む（バイト列で大小を比べられないため）
  戻り値: null か { contains(readAt, size, encodingName) → boolean }。UTF-16 のファイルは判定せず true（調べる）を返す。読めなければ true。
*/
export function createLiteralPrefilter({ query, caseSensitive }) {
  if (query.includes('[') || /redacted/i.test(query)) return null;
  const ascii = /^[\x00-\x7f]*$/.test(query); // 検索語が ASCII だけか。
  if (!caseSensitive && !ascii) return null;
  const needleText = caseSensitive ? query : query.toLowerCase(); // 照合する語。
  const needleBytes = Buffer.from(needleText, 'utf8'); // 大小を区別するときに使うバイト列。
  const overlap = Math.max(needleBytes.length - 1, 0); // チャンクの境目をまたぐ一致を見逃さないための重なり。
  return {
    contains(readAt, size, encodingName) {
      if (encodingName === 'utf-16le' || encodingName === 'utf-16be') return true;
      const buffer = Buffer.alloc(PREFILTER_CHUNK_BYTES + overlap); // 読み取りの作業用（前のチャンクの末尾 overlap バイトを先頭に残す）。
      let carry = 0; // 先頭に残した前のチャンクのバイト数。
      let position = 0; // 次に読むファイル上の位置。
      while (position < size) {
        const wanted = Math.min(PREFILTER_CHUNK_BYTES, size - position); // 今回読むバイト数。
        const got = readAt(buffer.subarray(carry), wanted, position); // 実際に読めたバイト数。
        if (got <= 0) return true;
        position += got;
        const filled = buffer.subarray(0, carry + got); // 検索する範囲。
        const found = caseSensitive ? filled.includes(needleBytes) : filled.toString('latin1').toLowerCase().includes(needleText); // 語を含むか。
        if (found) return true;
        carry = Math.min(overlap, filled.length);
        if (carry > 0) filled.copy(buffer, 0, filled.length - carry, filled.length);
      }
      return false;
    },
  };
}

const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])'; // 単語の途中でないこと（直前）。
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])'; // 単語の途中でないこと（直後）。

// 固定文字列を正規表現の本体にするための退避（u フラグで有効な構文文字だけ）。
function escapeLiteral(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/*
  検索の照合器を作る。
  引数: query、mode（'literal' | 'regex'）、caseSensitive、wholeWord
  戻り値: { mode, scan(lines, timeoutMs) }。scan は文字列の配列を受け、[行の添字, 一致の位置, 一致の長さ] の配列と、時間切れかを返す。
  1 行につき最初の一致だけを返す。
  - 固定文字列は、退避した正規表現で照合する（パターンが固定なので ReDoS にならない）。
  - 正規表現は、node:vm の別コンテキストで評価し、timeout で打ち切る（破滅的なバックトラックでサーバーを止めない）。
    パターンは最大 512 文字。構文が不正なら invalid_pattern。評価が時間内に終わらなければ timedOut を返す。
*/
export function createMatcher({ query, mode, caseSensitive, wholeWord }) {
  if (typeof query !== 'string' || query === '') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'query は空でない文字列で指定してください。');
  if (query.length > MAX_REGEX_CHARS) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `query が長すぎます（最大 ${MAX_REGEX_CHARS} 文字）。`);
  if (/\p{Cc}/u.test(query.replace(/[\t]/g, ''))) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'query に制御文字は使えません。');
  const flagsForCase = caseSensitive ? '' : 'i'; // 大文字・小文字を区別しないときのフラグ。
  if (mode === 'regex') {
    const source = wholeWord ? `(?<![A-Za-z0-9_])(?:${query})(?![A-Za-z0-9_])` : query; // 評価する正規表現の本体。
    try {
      new RegExp(source, flagsForCase); // 構文の検査だけ（評価はしない）。
    } catch (error) {
      throw new BridgeToolError(ERROR_CLASS.INVALID_PATTERN, `正規表現を解釈できません: ${String(error.message).replace(/^Invalid regular expression:\s*/, '').slice(0, 120)}`);
    }
    const context = vm.createContext({ source, flags: flagsForCase, lines: [], regexp: null }, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext('regexp = new RegExp(source, flags);', context, { timeout: 1000 });
    const script = new vm.Script('(function () { const out = []; for (let i = 0; i < lines.length; i += 1) { regexp.lastIndex = 0; const hit = regexp.exec(lines[i]); if (hit) out.push(i, hit.index, hit[0].length); } return out; })()'); // 行の配列を走査する評価コード。
    return {
      mode,
      scan(lines, timeoutMs = 1000) {
        context.lines = lines;
        let flat; // 行の添字・位置・長さが 3 つずつ並んだ配列。
        try {
          flat = script.runInContext(context, { timeout: Number.isFinite(timeoutMs) ? Math.max(Math.trunc(timeoutMs), 1) : 1000 });
        } catch (error) {
          if (error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { hits: [], timedOut: true };
          throw new BridgeToolError(ERROR_CLASS.INVALID_PATTERN, '正規表現の評価に失敗しました。');
        } finally {
          context.lines = [];
        }
        const hits = []; // 一致の一覧。
        for (let index = 0; index < flat.length; index += 3) hits.push([flat[index], flat[index + 1], flat[index + 2]]);
        return { hits, timedOut: false };
      },
    };
  }
  const literal = escapeLiteral(query); // 退避した固定文字列。
  const expression = new RegExp(wholeWord ? `${WORD_BOUNDARY_BEFORE}${literal}${WORD_BOUNDARY_AFTER}` : literal, `${flagsForCase}u`); // 固定文字列の照合に使う正規表現。
  return {
    mode: 'literal',
    prefilter: createLiteralPrefilter({ query, caseSensitive }),
    scan(lines) {
      const hits = []; // 一致の一覧。
      for (let index = 0; index < lines.length; index += 1) {
        const hit = expression.exec(lines[index]);
        if (hit) hits.push([index, hit.index, hit[0].length]);
      }
      return { hits, timedOut: false };
    },
  };
}
