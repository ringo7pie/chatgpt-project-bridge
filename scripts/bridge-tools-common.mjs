/*
  2.5.0 で追加した読み取りツール（Git の詳細・プロジェクト分析・横断サマリー）が共通で使う部品。
  - 応答の共通形式（事実・推測・根拠の分離、取得日時・情報源・状態・失敗理由）
  - 引数の検証と件数の上限、ページング、応答サイズの上限
  - エラーの分類と、連続して失敗したときの再試行制限
  このモジュールはファイルも Git も触らない（純粋な関数とデータだけ）。Windows と Ubuntu で同じ形の応答を返すための共通部分。
*/

export const TOOL_SCHEMA_VERSION = 1; // 新ツールの応答形式の版。形式を変えるときに上げる。
export const DEFAULT_MAX_RESPONSE_BYTES = 262144; // 1 回の応答（JSON 文字列）の上限。256 KiB。
export const MAX_ITEMS_PER_PAGE = 500; // ページング対象の配列を 1 回で返す最大件数。

export const STATUS = Object.freeze({ OK: 'ok', PARTIAL: 'partial', UNAVAILABLE: 'unavailable' }); // 取得の状態。
export const SOURCE_KIND = Object.freeze({
  LIVE_GIT: 'liveGit', // 呼び出し時点の Git の実行結果。
  DOCUMENT: 'document', // 公開許可された保存文書の内容。
  STATIC_ANALYSIS: 'staticAnalysis', // 呼び出し時点のファイル構成・内容を読んだ静的な解析。
  TEST_LOG: 'testLog', // 過去に作られたテスト結果・ログ・CI 記録のファイル。
  CONFIG: 'config', // ビルド・テスト・CI の設定ファイル。
  CLAUDE_JOB: 'claudeJob', // 2.7.0: Claude Code のジョブの状態ファイルと出力の記録。
}); // 情報源の種類。
const LIVE_SOURCE_KINDS = new Set([SOURCE_KIND.LIVE_GIT, SOURCE_KIND.STATIC_ANALYSIS, SOURCE_KIND.CLAUDE_JOB]); // 呼び出し時点の実状態を反映する情報源。

export const ERROR_CLASS = Object.freeze({
  INVALID_ARGUMENT: 'invalid_argument', // 引数の型・範囲・形式が不正。
  PERMISSION_DENIED: 'permission_denied', // 公開権限が無い。
  NOT_FOUND: 'not_found', // 対象が無い。
  NOT_A_GIT_REPOSITORY: 'not_a_git_repository', // Git リポジトリのルートではない。
  GIT_UNAVAILABLE: 'git_unavailable', // Git の実行ファイルが使えない。
  UNSAFE_GIT_CONFIG: 'unsafe_git_config', // .git/config に実行を伴いうる設定がある。
  GIT_OWNERSHIP: 'git_ownership_rejected', // Git が、リポジトリの所有者が現在の利用者と違うこと（safe.directory）を理由に拒否した。
  REF_NOT_FOUND: 'ref_not_found', // 指定したブランチが実在しない。
  TIMEOUT: 'timeout', // 制限時間内に終わらなかった。
  OUTPUT_TOO_LARGE: 'output_too_large', // 出力が上限を超えた。
  TOO_MANY_FAILURES: 'too_many_failures', // 連続して失敗したため、一定時間は実行を見合わせている。
  GIT_ERROR: 'git_error', // 上のどれにも当てはまらない Git の失敗。原因は断定しない。
  INTERNAL: 'internal_error', // 想定外の内部エラー。原因は断定しない。
  BINARY_FILE: 'binary_file', // 2.6.0: バイナリファイル（本文を返さない）。
  UNSUPPORTED_ENCODING: 'unsupported_encoding', // 2.6.0: 文字コードを判定・復号できない（黙って文字化けを返さない）。
  RANGE_OUT_OF_BOUNDS: 'range_out_of_bounds', // 2.6.0: 指定した行の範囲がファイルの外。
  INVALID_PATTERN: 'invalid_pattern', // 2.6.0: 検索パターン（正規表現）が不正。
  FILE_TOO_LARGE: 'file_too_large', // 2.6.0: ファイルが読み取りの上限を超えている。
  STALE_CURSOR: 'stale_cursor', // 2.6.0: 続きの取得（cursor）の対象ファイルが前回から変わった。
  JOB_NOT_FOUND: 'job_not_found', // 2.7.0: 指定した Claude Code のジョブが無い。
  JOB_LIMIT: 'job_limit', // 2.7.0: 同時に動かせるジョブの上限に達している。
  CLAUDE_UNAVAILABLE: 'claude_unavailable', // 2.7.0: Claude Code の実行ファイルが見つからない・安全に起動できない。
  JOB_NOT_RUNNING: 'job_not_running', // 2.7.0: ジョブが実行中ではない（続きの依頼で、前のジョブが終わっていないときなど）。
}); // 失敗の分類。応答の meta.errorClass に入る。

// 分類ごとの「同じ呼び出しを繰り返す価値があるか」。timeout だけは一時的な負荷の可能性があるため再試行可（回数は失敗ガードで制限する）。
const RETRYABLE_BY_CLASS = Object.freeze({
  [ERROR_CLASS.TIMEOUT]: true,
  [ERROR_CLASS.TOO_MANY_FAILURES]: true,
  [ERROR_CLASS.GIT_ERROR]: false,
  [ERROR_CLASS.INTERNAL]: false,
});

// 分類ごとの既定の説明文。Git の標準エラー出力やパスは含めない（原因を断定せず、環境の情報も漏らさない）。
const DEFAULT_REASON_BY_CLASS = Object.freeze({
  [ERROR_CLASS.INVALID_ARGUMENT]: '引数が正しくありません。',
  [ERROR_CLASS.PERMISSION_DENIED]: 'この項目は公開が許可されていません。',
  [ERROR_CLASS.NOT_FOUND]: '対象が見つかりません。',
  [ERROR_CLASS.NOT_A_GIT_REPOSITORY]: 'このプロジェクトは Git リポジトリのルートではないため、Git の情報を取得しません。',
  [ERROR_CLASS.GIT_UNAVAILABLE]: 'Git を実行できませんでした。',
  [ERROR_CLASS.UNSAFE_GIT_CONFIG]: 'Git の情報を取得しません: .git/config に実行を伴いうる設定があります。',
  [ERROR_CLASS.GIT_OWNERSHIP]: 'Git が、リポジトリの所有者が現在の利用者と違うことを理由に拒否しました（safe.directory）。このサーバーは Git の設定を変えません。',
  [ERROR_CLASS.REF_NOT_FOUND]: '指定したブランチは存在しません。',
  [ERROR_CLASS.TIMEOUT]: '制限時間内に終わりませんでした。原因（負荷・巨大な履歴・ファイルシステムの遅延など）は特定できません。',
  [ERROR_CLASS.OUTPUT_TOO_LARGE]: '出力が上限を超えました。件数や期間を絞って再度呼び出してください。',
  [ERROR_CLASS.TOO_MANY_FAILURES]: '連続して失敗したため、しばらくこの取得を見合わせています。',
  [ERROR_CLASS.GIT_ERROR]: 'Git の実行に失敗しました。原因は特定できません。',
  [ERROR_CLASS.INTERNAL]: '内部エラーが起きました。原因は特定できません。',
  [ERROR_CLASS.BINARY_FILE]: 'バイナリファイルのため、本文を返しません。',
  [ERROR_CLASS.UNSUPPORTED_ENCODING]: '文字コードを判定・復号できませんでした。encoding を明示すると読める場合があります。',
  [ERROR_CLASS.RANGE_OUT_OF_BOUNDS]: '指定した行の範囲がファイルの外です。',
  [ERROR_CLASS.INVALID_PATTERN]: '検索パターンが正しくありません。',
  [ERROR_CLASS.FILE_TOO_LARGE]: 'ファイルが読み取りの上限を超えています。',
  [ERROR_CLASS.STALE_CURSOR]: '前回の取得からファイルが変わったため、cursor では続きを取得できません。最初から取得し直してください。',
  [ERROR_CLASS.JOB_NOT_FOUND]: '指定したジョブはありません。list_claude_jobs で jobId を確認してください。',
  [ERROR_CLASS.JOB_LIMIT]: '同時に動かせるジョブの上限に達しています。実行中のジョブが終わってから、もう一度開始してください。',
  [ERROR_CLASS.CLAUDE_UNAVAILABLE]: 'Claude Code を起動できません。この PC に Claude Code が導入されているかを確認してください。',
  [ERROR_CLASS.JOB_NOT_RUNNING]: 'ジョブの状態が、この操作に合いません。',
});

/*
  2.7.0: Claude Code のジョブで、設定の allowedCommands に書けないコマンドと、生成する settings で常に拒否する git の操作。
  - CLAUDE_FORBIDDEN_COMMAND_HEADS: 先頭の語がこれなら拒否する（シェル・中継・権限昇格・通信・Claude Code 自身）。どれも、続く引数で任意の処理を実行できる。
  - CLAUDE_GIT_WRITE_SUBCOMMANDS: git の書き込み系（利用者の決定で commit・push を禁止。履歴・作業ツリー・設定を変える操作も含める）。
  server.mjs（設定の検証）と bridge-claude-jobs.mjs（settings の deny）が同じ一覧を使う。
*/
export const CLAUDE_FORBIDDEN_COMMAND_HEADS = Object.freeze([
  'bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'wsl', 'env', 'sudo', 'su', 'doas', 'runas',
  'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget', 'nc', 'ncat', 'telnet', 'ftp', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'start-process', 'invoke-expression', 'iex',
  'claude', 'npx', 'xargs', 'eval', 'exec', 'source', '.', 'nohup', 'setsid', 'watch', 'timeout', 'time', 'nice', 'stdbuf',
]);
export const CLAUDE_GIT_WRITE_SUBCOMMANDS = Object.freeze([
  'commit', 'push', 'reset', 'checkout', 'switch', 'restore', 'clean', 'rebase', 'merge', 'stash', 'tag', 'branch', 'remote', 'config',
  'worktree', 'submodule', 'pull', 'fetch', 'am', 'apply', 'cherry-pick', 'revert', 'rm', 'mv', 'gc', 'prune', 'update-ref', 'filter-branch', 'notes', 'replace', 'init', 'clone',
]);

/*
  2.10.0: Claude Code のジョブのモデル（--model）と思考の深さ（--effort）。
  - CLAUDE_EFFORT_LEVELS: --effort に渡せる値（Claude Code 2.1.317 の --help と同じ）。設定の claudeCode.effort と、start_claude_job の effort で同じ。
  - CLAUDE_MODEL_PATTERN: 設定の claudeCode.model（利用者が PC で書き、承認の指紋に入る）に書ける広い形。先頭は英数字（--bare のようなフラグは通らない）。[1m] などの添え字も通る。
    ジョブが前のジョブから引き継ぐ値の再検査にも使う。
  - CLAUDE_MODEL_ALIASES・CLAUDE_MODEL_FULL_ID_PATTERN: start_claude_job の model（ChatGPT が渡す）に許す狭い形。小文字の別名か、claude-<系列>-<版> の正式名だけ。設定のキーは足さない。
*/
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$/;
export const CLAUDE_MODEL_ALIASES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);
export const CLAUDE_MODEL_FULL_ID_PATTERN = /^claude-(?:fable|opus|sonnet|haiku)-[0-9]+(?:-[0-9]+)*$/;

/*
  allowedCommands の 1 件（Claude Code の Bash・PowerShell の許可ルールの中身）を検証して正規化する。
  戻り値: 前後の空白を除き、連続する空白を 1 つにした文字列。拒否するときは理由つきの Error を投げる。
  - 1〜200 文字、改行・制御文字なし、括弧（ルールの区切り）なし
  - 「*」だけ、先頭の語が CLAUDE_FORBIDDEN_COMMAND_HEADS のもの（パス付きの指定 /bin/bash・C:\...\pwsh.exe も含む）、
    先頭が git でサブコマンドが CLAUDE_GIT_WRITE_SUBCOMMANDS のもの、git のサブコマンドが * のもの
*/
export function validateClaudeCommandPattern(value) {
  if (typeof value !== 'string') throw new Error('claudeCode.allowedCommands の各項目は文字列で指定してください。');
  // 改行・タブなどの制御文字は、空白へ整える前に拒否する（複数のコマンドを 1 件に詰められないように）。
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(value) || /[()]/.test(value)) throw new Error(`claudeCode.allowedCommands に使えない文字（改行・制御文字・括弧）が含まれています: ${JSON.stringify(value)}`);
  const normalized = value.trim().replace(/ +/g, ' '); // 正規化したパターン。
  if (normalized.length === 0 || normalized.length > 200) throw new Error('claudeCode.allowedCommands の各項目は 1〜200 文字で指定してください。');
  const words = normalized.split(' '); // 空白で区切った語。
  const head = words[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase(); // 先頭の語（パスと拡張子を除く）。
  if (/^[*?]+$/.test(head) || normalized === '*') throw new Error(`claudeCode.allowedCommands に、コマンド名をワイルドカードにした指定は使えません: ${normalized}`);
  if (CLAUDE_FORBIDDEN_COMMAND_HEADS.includes(head)) throw new Error(`claudeCode.allowedCommands に、任意の処理を実行できるコマンドは指定できません: ${normalized}`);
  if (head === 'git') {
    const subcommand = (words.find((word, index) => index > 0 && !word.startsWith('-')) || '').toLowerCase(); // git のサブコマンド。
    if (!subcommand || /[*?]/.test(subcommand) || words.slice(1).some(word => /^-(c|C)$|^--(git-dir|work-tree|exec-path)/.test(word))) {
      throw new Error(`claudeCode.allowedCommands の git は、サブコマンドを明示してください（-c・-C などは使えません）: ${normalized}`);
    }
    if (CLAUDE_GIT_WRITE_SUBCOMMANDS.includes(subcommand)) throw new Error(`claudeCode.allowedCommands に git の書き込み系の操作は指定できません（commit・push は禁止）: ${normalized}`);
  }
  return normalized;
}

// ツール内で起きた、呼び出し側へ分類付きで返したいエラー。引数の不備・権限・対象なしなど、応答を作れないときに投げる。
export class BridgeToolError extends Error {
  /*
    引数: errorClass（ERROR_CLASS の値）、message（利用者向けの説明。省略すると分類の既定文）、
          options.retryable（再試行の価値。省略すると分類の既定値）、options.hidden（権限が無くて隠した項目名の配列）
  */
  constructor(errorClass, message, options = {}) {
    super(message || DEFAULT_REASON_BY_CLASS[errorClass] || DEFAULT_REASON_BY_CLASS[ERROR_CLASS.INTERNAL]);
    this.name = 'BridgeToolError';
    this.errorClass = errorClass;
    this.retryable = options.retryable ?? RETRYABLE_BY_CLASS[errorClass] ?? false;
    this.hidden = Array.isArray(options.hidden) ? options.hidden : [];
  }
}

// 分類の既定の説明文を返す。
export function defaultReason(errorClass) {
  return DEFAULT_REASON_BY_CLASS[errorClass] || DEFAULT_REASON_BY_CLASS[ERROR_CLASS.INTERNAL];
}

// 分類の既定の「再試行の価値」を返す。
export function isRetryableByDefault(errorClass) {
  return RETRYABLE_BY_CLASS[errorClass] ?? false;
}

/*
  整数の引数を検証して範囲内へ収める。未指定（undefined / null）は既定値。
  数値でない・有限でない・真偽値などは invalid_argument。範囲外は黙って収める（既存ツールと同じ振る舞い）。
  引数: value（入力値）、name（エラーに出す引数名）、options（min、max、fallback）
*/
export function clampInteger(value, name, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は整数で指定してください。`);
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/*
  文字列の引数を検証する。未指定は fallback（undefined なら必須）。
  引数: value、name、options（maxLength、fallback、pattern、patternMessage）
*/
export function requireString(value, name, { maxLength = 256, fallback, pattern, patternMessage } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は必須です。`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は空でない文字列で指定してください。`);
  }
  if (value.length > maxLength) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} が長すぎます（最大 ${maxLength} 文字）。`);
  }
  if (pattern && !pattern.test(value)) {
    throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, patternMessage || `${name} の形式が正しくありません。`);
  }
  return value;
}

// 配列を offset と limit で切り出し、ページ情報を返す。総数が分かっているときだけ total を入れる。
export function paginate(items, offset, limit) {
  const total = items.length;
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length < total ? offset + slice.length : null;
  return { items: slice, page: { offset, limit, returned: slice.length, total, nextOffset } };
}

/*
  情報源の記述を整える。
  引数: kind（SOURCE_KIND）、collectedAt（ISO 8601）、sourceUpdatedAt（情報源の更新日時。無ければ null）、detail（任意の補足。短い文）
  live は「呼び出し時点の実状態か（true）」「保存されていた内容を読んだか（false）」。最新かどうかの判定に使う。
*/
export function describeSource(kind, collectedAt, sourceUpdatedAt = null, detail = null) {
  return {
    kind,
    live: LIVE_SOURCE_KINDS.has(kind),
    collectedAt,
    sourceUpdatedAt: sourceUpdatedAt || null,
    ...(detail ? { detail } : {}),
  };
}

/*
  新ツールの共通の応答を作る。
  引数（オブジェクト）:
    tool            ツール名
    collectedAt     取得日時（ISO 8601）。省略すると現在時刻
    status          'ok' | 'partial' | 'unavailable'。省略すると、失敗なら unavailable、隠した項目・警告のうち「欠落」を表すもの（hidden か truncated）があれば partial、無ければ ok
    sources         describeSource の配列
    facts           測定・取得した事実だけ（HEAD、SHA、ブランチ名、件数など）
    inferences      推測・提案。{ claim, basis, confidence: 'low'|'medium'|'high', evidence } の配列。事実と混ぜない
    evidence        根拠の一覧。{ type: 'commit'|'document'|'file'|'ref', ... }。公開許可された情報だけ
    page            paginate が返すページ情報（無ければ null）
    hidden          権限が無くて返さなかった項目名の配列（例: 'branchNames'）
    warnings        注意事項の文の配列（浅い clone、detached HEAD など。欠落を意味しない）
    truncated       応答サイズの上限で内容を削ったか
    limits          適用した上限（件数・期間・バイト数）
    errorClass      失敗の分類（ERROR_CLASS）
    errorReason     失敗の説明。省略すると分類の既定文
    retryable       再試行の価値。省略すると分類の既定値
  戻り値: { schemaVersion, tool, meta, facts, inferences, evidence, page }。project は呼び出し側（server.mjs）が足す。
*/
export function makeEnvelope({
  tool, collectedAt = new Date().toISOString(), status, sources = [], facts = {}, inferences = [], evidence = [],
  page = null, hidden = [], warnings = [], truncated = false, limits = {}, errorClass = null, errorReason = null, retryable = null,
}) {
  const uniqueHidden = [...new Set(hidden)];
  const resolvedStatus = status || (errorClass ? STATUS.UNAVAILABLE : (uniqueHidden.length > 0 || truncated ? STATUS.PARTIAL : STATUS.OK));
  const updatedTimes = sources.map(source => source.sourceUpdatedAt).filter(Boolean).sort();
  return {
    schemaVersion: TOOL_SCHEMA_VERSION,
    tool,
    meta: {
      collectedAt,
      status: resolvedStatus,
      sources,
      sourceUpdatedAt: updatedTimes.length > 0 ? updatedTimes[updatedTimes.length - 1] : null, // 非 null の情報源のうち最も新しい更新日時。
      errorClass: errorClass || null,
      errorReason: errorClass ? (errorReason || defaultReason(errorClass)) : null,
      retryable: errorClass ? (retryable ?? isRetryableByDefault(errorClass)) : false,
      hidden: uniqueHidden,
      warnings,
      truncated,
      limits,
    },
    facts,
    inferences,
    evidence,
    page,
  };
}

// BridgeToolError から、失敗を表す応答を作る（引数の不備・権限など、呼び出し側へ分類付きで返すとき）。
export function makeErrorEnvelope(tool, error, collectedAt = new Date().toISOString()) {
  return makeEnvelope({
    tool,
    collectedAt,
    errorClass: error.errorClass,
    errorReason: error.message,
    retryable: error.retryable,
    hidden: error.hidden,
  });
}

/*
  応答を JSON にしたときの大きさが maxBytes 以内になるよう、配列を後ろから削る。
  引数: envelope（makeEnvelope の戻り値）、maxBytes、pagedKey（facts の中の、ページング対象の配列のキー。無ければ null）
  戻り値: 同じ envelope（必要なら内容を削り、meta.truncated と status と warnings を更新）。
  削る順序: まず pagedKey の配列を 25% ずつ、それでも超えるなら inferences と evidence を空にし、
  最後に facts 内の最も長い配列を 25% ずつ削る。削ったら page.returned と page.nextOffset を実際の件数に合わせる。
*/
export function fitToBudget(envelope, maxBytes, pagedKey = null) {
  const sizeOf = () => Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8'); // 実際に出力する整形済みの大きさで測る。
  if (sizeOf() <= maxBytes) return envelope;
  let dropped = false; // 何かを削ったか。
  const shrink = list => {
    const keep = Math.floor(list.length * 0.75);
    list.length = keep;
    dropped = true;
  };
  const pagedList = pagedKey && Array.isArray(envelope.facts?.[pagedKey]) ? envelope.facts[pagedKey] : null; // ページング対象の配列。
  while (sizeOf() > maxBytes && pagedList && pagedList.length > 0) shrink(pagedList);
  if (sizeOf() > maxBytes) { envelope.inferences.length = 0; envelope.evidence.length = 0; dropped = true; }
  while (sizeOf() > maxBytes) {
    const arrays = Object.values(envelope.facts || {}).filter(value => Array.isArray(value) && value.length > 0);
    if (arrays.length === 0) break;
    shrink(arrays.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest)));
  }
  if (dropped) {
    envelope.meta.truncated = true;
    if (envelope.meta.status === STATUS.OK) envelope.meta.status = STATUS.PARTIAL;
    envelope.meta.warnings.push(`応答の大きさが上限（${maxBytes} バイト）を超えたため、一部を省きました。件数や期間を絞って再度呼び出してください。`);
    envelope.meta.limits = { ...envelope.meta.limits, maxResponseBytes: maxBytes };
    if (envelope.page && pagedList) {
      envelope.page.returned = pagedList.length;
      const total = envelope.page.total;
      envelope.page.nextOffset = total === null || envelope.page.offset + pagedList.length < total ? envelope.page.offset + pagedList.length : null;
    }
  }
  return envelope;
}

/*
  連続して失敗した呼び出しを一定時間見合わせる、再試行の制限。
  同じ key（プロジェクトとツールの組）で maxConsecutiveFailures 回続けて失敗したら、cooldownMs の間は check が TOO_MANY_FAILURES を投げる。
  成功すると数え直す。失敗の原因は断定しない（timeout など分類だけを記録する）。
*/
export function createFailureGuard({ maxConsecutiveFailures = 3, cooldownMs = 30000, now = () => Date.now() } = {}) {
  const states = new Map(); // key ごとの { failures, blockedUntil, lastClass }。
  return {
    // 見合わせ中なら例外を投げる。
    check(key) {
      const state = states.get(key);
      if (state && state.blockedUntil > now()) {
        const seconds = Math.ceil((state.blockedUntil - now()) / 1000);
        throw new BridgeToolError(ERROR_CLASS.TOO_MANY_FAILURES, `連続して失敗したため（直近の分類: ${state.lastClass}）、約 ${seconds} 秒間はこの取得を見合わせています。`);
      }
    },
    recordSuccess(key) {
      states.delete(key);
    },
    recordFailure(key, errorClass) {
      const state = states.get(key) || { failures: 0, blockedUntil: 0, lastClass: errorClass };
      state.failures += 1;
      state.lastClass = errorClass;
      if (state.failures >= maxConsecutiveFailures) {
        state.blockedUntil = now() + cooldownMs;
        state.failures = 0;
      }
      states.set(key, state);
    },
  };
}

// 失敗ガードに数える分類（一時的な負荷や巨大さで起きうるもの）。引数の不備や権限は数えない。
export function countsAsOperationalFailure(errorClass) {
  return errorClass === ERROR_CLASS.TIMEOUT || errorClass === ERROR_CLASS.OUTPUT_TOO_LARGE || errorClass === ERROR_CLASS.GIT_ERROR || errorClass === ERROR_CLASS.INTERNAL;
}
