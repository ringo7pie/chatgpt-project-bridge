/*
  2.5.0 で追加した Git 詳細ツールの読み取り層。MCP サーバー（server.mjs）が、Git ルートと .git/config の検査（preflight）を
  済ませたプロジェクトに対して使う。応答の形は bridge-tools-common.mjs の makeEnvelope に従う。
  - Git の呼び出しは runGit の 1 か所に集め、許可リストにある読み取り系のサブコマンドだけを、シェルを通さず引数配列で実行する。
  - 作業ツリー・インデックス・参照・オブジェクトを書き換えるコマンド（merge・merge-tree --write-tree・fetch など）は使わない。
  - 利用者が渡したブランチ名は、自分で列挙した実在の参照と完全一致したものだけ受け付け、Git へは SHA か完全な参照名で渡す。
  - パス・件名・差分の行・ブランチ名には redact を、パスには isHiddenPath を当てる。作者名・メールアドレス・設定値・絶対パスは返さない。
  - プロジェクト外の linked worktree とサブモジュールの中では Git を実行しない（-C は常にプロジェクトルート）。
  - 件数・行数の集計（counts・diffStat など）には、isHiddenPath のファイルも数として含める。名前と内容は一覧・抜粋に出さない。
  - 出力は NUL 区切り（-z・%x00）で読む。例外は worktree list（Git 2.34 に -z が無い）と for-each-ref・reflog の行区切りで、
    参照名と reflog の本文は改行を含まない（Git が許さない）ので取り違えない。
  - Ubuntu 22.04 の Git 2.34 でも動く引数だけを使う。%(ahead-behind:)（Git 2.41 以上）は失敗したら古い数え方へ戻る。

  各ツールの facts の形（README の元）。日時は ISO 8601。コミット日時はコミッター日時で、コミットに記録された時差のまま返す。
  件数の上限（10000）を超えたものは、上限の数値と capped: true（または aheadBehindCapped: true）を返す。

  get_git_branches（ページング対象: branches）
    repository: { isShallow, hasCommits, headState: 'branch'|'detached'|'unborn', headSha, headShortSha, headCommittedAt,
                  currentBranch（detached は null、unborn は最初のコミットで作られる予定のブランチ名） }
    base: { ref（branchNames が false なら null）, kind: 'local'|'remote'|null, sha, selection: 'explicit'|'remoteDefault'|'conventionalName'|'none' }
    counts: { local, remote, mergedIntoBase, unmergedIntoBase }
            merged/unmerged は、一覧の対象（includeRemote に従う）から base 自身を除いた本数。base が無ければ null。
    branches[]（branchNames が true のときだけ）:
      { name, kind, isCurrent, sha, shortSha, lastCommitAt, upstream, upstreamState: 'tracking'|'gone'|'none',
        aheadOfUpstream, behindUpstream, mergedIntoBase: true|false|null, aheadOfBase, behindBase, aheadBehindCapped }
      並びは現在のブランチ、続けて最終コミット日時の新しい順。
      base との差は、Git 2.41 以上なら for-each-ref の %(ahead-behind:) で全ブランチを 1 回で正確に数える（capped は false）。
      それより古い Git では、そのページの分だけ rev-list で 1 本ずつ数える（上限 10000、1 回の呼び出しの持ち時間 20 秒）。

  get_branch_details（branchNames が必要。ページング対象: changedFiles）
    branch: { ref, kind, sha, shortSha, lastCommitAt, isCurrent, upstream, upstreamState, aheadOfUpstream, behindUpstream }
    base: { ref, kind, sha, selection } | { ref: null, selection: 'none' }
    mergeBase: { sha, committedAt } | null（base が無いか、共通の祖先が無い）
    ahead, behind, aheadBehindCapped（branch が base に対して。base が無ければ null）
    diffStat: { range: 'mergeBase..branch', filesChanged, insertions, deletions, binaryFiles } | null
    recentCommits[]: { sha, shortSha, committedAt, subject（commitSubjects が true のときだけ） }
    recentCommitsScope: 'notInBase'（base に無いコミット）| 'all'（base が無いときの直近）
    changedFiles[]（paths が true のときだけ）: { path, status, renamedFrom, insertions, deletions, binary, submodule }
    omittedHiddenPaths（paths が true のとき、非公開のパスのため一覧から除いた件数）
    createdAt: { at, source: 'reflog' } | 'unknown'（reflog に「branch: Created from」が残っているときだけ日時を返す）
    作成理由・目的は事実として返さない。件名からの手がかりは inferences（confidence: 'low'、「目的は未確認」）に入れる。

  compare_branches（branchNames が必要。ページング対象: changedFiles）
    base: { ref, kind, sha }, target: { ref, kind, sha }
    mergeBase: { sha, committedAt } | null, unrelatedHistories: boolean
    ahead, behind, aheadBehindCapped（target が base に対して）
    mergeState: 'identical'|'targetMergedIntoBase'|'fastForwardPossible'|'diverged'（merge-base --is-ancestor で判定。null は判定できなかった）
    diffStat: { range: 'mergeBase..target', filesChanged, insertions, deletions, binaryFiles } | null
    areaTotals: { added, modified, deleted, renamed, other }（mergeBase..target の全ファイル）
    areas[]（paths が true のときだけ）: { area（先頭のディレクトリ。ルート直下は '.'）, files, added, modified, deleted, renamed, other }
    conflictIndicators: { heuristic: true, note, overlappingFileCount, overlappingFiles（paths が true のときだけ、先頭 50 件）,
                          overlappingFilesTruncated } | null
      分岐点から両側で変更されたファイルの重なり。マージを試したものではない（実際のマージ・merge-tree は実行しない）。
    commits[]: base..target の直近（{ sha, shortSha, committedAt, subject }）
    changedFiles[]（paths が true のときだけ）, omittedHiddenPaths
    追加・削除・変更された機能の名前は作らない。言えるのはコミット件名と変更ファイル名から機械的に分かることだけ。

  get_worktree_details（ページング対象: files）
    counts: { staged, unstaged, untracked, deleted, renamed, conflicted, total }
    operationInProgress: 'merge'|'rebase'|'am'|'cherryPick'|'revert'|'bisect'|null
    files[]（paths が true のときだけ。category で絞る）:
      { path, kind: 'staged'|'unstaged'|'both'|'untracked'|'conflicted', indexStatus, worktreeStatus（Git の 1 文字。'.' は変更なし）,
        renamedFrom, insertions, deletions, submodule }
    omittedHiddenPaths
    diffStat: { staged: { filesChanged, insertions, deletions, binaryFiles } | null, unstaged: 同じ | null }
    worktrees[]: { isMain, isCurrent, isInsideProject, path（プロジェクト内かつ paths が true のときだけ、相対パス）,
                   branch（現在の worktree 以外は branchNames が true のときだけ）, headSha, detached, bare, locked, prunable }
    submodules[]: { path（paths が true のときだけ）, recordedCommit, state: 'matchesRecordedCommit'|'commitChanged'|'notCheckedOut'|'conflicted' }
    patches[]（diffExcerpts と paths の両方が true のときだけ）: { path, stage: 'staged'|'unstaged', status, renamedFrom, lines[], truncated }
      1 ファイル 40 変更行・1 行 200 文字・最大 20 ファイル・合計 64 KiB まで。バイナリ・サブモジュール・競合中・非公開のファイルは出さない。

  get_recent_activity（ページング対象: なし。大きすぎるときは recentCommits から削る）
    scope: 'localBranchesAndHead', windowDays, since, lastCommitAt, commitsInWindow, commitsInWindowCapped
    daily[]: { date（このマシンのローカル日付 yyyy-MM-dd）, commits }（期間内の全日。コミットの無い日は 0）
    recentCommits[]: { sha, shortSha, committedAt, subject（commitSubjects が true のときだけ） }
    changedFileCount, changedAreas[]（paths が true のときだけ）: { area, files }（期間内のマージ以外のコミットで変更されたファイル）
    uncommitted: { count, newestChangedFileModifiedAt（変更ファイルの更新日時の最大。参考値） }
    作者名・メールアドレスは取得しない（%an・%ae・%cn・%ce を使わない）。

  get_git_diff（2.6.0。ページング対象: files。detailExposure の sourceText・diffExcerpts と gitExposure.paths が必要。読み取り専用で、実行する Git は diff・rev-parse・rev-list・status だけ）
    mode: 'head'|'staged'|'unstaged'|'range'、base・target: { sha, shortSha, ref（ブランチ名のときだけ）, selection }、since（ISO 8601）、paths（指定したときだけ）
    totals: { filesChanged, insertions, deletions, binaryFiles, omittedHiddenPaths }（非公開のパスも件数には含めず omittedHiddenPaths に数える）
    files[]: { path, oldPath, status, additions, deletions, binary, submodule, hunks[]: { oldStart, oldLines, newStart, newLines }, totalPatchLines,
               patch（@@ の見出し行と、空白・+・-・\ で始まる本文。行ごとに秘密値・メール・ユーザー名を伏せる）, truncated, nextLineOffset,
               withheld（本文を返さない理由: binary | submodule | conflicted | secret | unavailable）}
    untracked: { count, files[], truncated, note }（head・unstaged の最初のページだけ。名前だけで、本文は read_source）、diffId（差分の内容の識別子。変わると cursor は stale_cursor）
    まず diff --raw --numstat -z で一覧とページを決め、そのページのファイルだけ、まとめて 1 回の diff -p で本文を取る（失敗したらファイルごと）。
    submodule 引数のときは、server.mjs が渡す resolveSubmodule で、そのサブモジュールの .git/config を別に検査し、そのルートで同じ読み取り層を作って実行する。
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BridgeToolError,
  DEFAULT_MAX_RESPONSE_BYTES,
  ERROR_CLASS,
  SOURCE_KIND,
  STATUS,
  clampInteger,
  describeSource,
  fitToBudget,
  makeEnvelope,
  paginate,
  requireString,
} from './bridge-tools-common.mjs';

const DEFAULT_TIMEOUT_MS = 15000; // Git 1 回の制限時間の既定値。
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // Git 1 回の出力（標準出力・標準エラー出力のそれぞれ）の上限の既定値。
const DEFAULT_SAFE_OPTIONS = Object.freeze(['-c', 'core.fsmonitor=false', '--no-optional-locks']); // safeOptions が渡されなかったときの固定オプション（server.mjs の GIT_SAFE_OPTIONS と同じ）。
const COUNT_CAP = 10000; // ahead/behind・期間内のコミット数を数える上限。超えたら上限の数値と capped を返す。
const LOOP_TIME_BUDGET_MS = 20000; // ブランチごとに Git を呼ぶ繰り返しの、1 回のツール呼び出しあたりの持ち時間。
const MAX_OFFSET = 1000000; // offset 引数の上限。
const MAX_REF_INPUT_LENGTH = 512; // ブランチ名の引数の最大文字数。
const MAX_OVERLAPPING_FILES = 50; // conflictIndicators に名前を出す、重なったファイルの最大件数。
const MAX_PATCH_PATHSPEC_CHARACTERS = 16000; // 差分の抜粋で Git へ渡すパスの合計文字数の上限（Windows のコマンド行の上限 32767 文字を避ける）。
const MAX_MTIME_ENTRIES = 5000; // 未コミットのファイルの更新日時を調べる最大件数。
const DAY_MS = 24 * 60 * 60 * 1000; // 1 日のミリ秒。
const PATCH_LIMITS = Object.freeze({ maxFiles: 20, maxChangedLinesPerFile: 40, maxLineLength: 200, maxTotalBytes: 64 * 1024 }); // 差分の抜粋の上限。
const DIFF_MODES = Object.freeze(['head', 'staged', 'unstaged', 'range']); // get_git_diff の mode（2.6.0）。
const DIFF_MAX_PATHS = 20; // get_git_diff の paths の最大件数。
const DIFF_MAX_LINE_CHARS = 2000; // get_git_diff で、差分の 1 行に残す最大文字数。
const DIFF_MAX_BYTES_PER_FILE = 100000; // get_git_diff で、1 ファイルの差分として返す最大バイト数。
const DIFF_PAGE_BUDGET_BYTES = DEFAULT_MAX_RESPONSE_BYTES - 16000; // get_git_diff で、ファイルの記録に使える大きさ（応答全体の上限から、見出し・件数などの分を除く）。
const DIFF_MAX_UNTRACKED = 100; // get_git_diff で名前を返す未追跡ファイルの最大件数。
const CONVENTIONAL_BASE_NAMES = Object.freeze(['main', 'master', 'trunk', 'develop']); // 比較基準の候補にする慣習的なローカルブランチ名（この順に探す）。
const WORKTREE_CATEGORIES = new Set(['all', 'staged', 'unstaged', 'untracked', 'conflicted', 'deleted', 'renamed']); // get_worktree_details の category。
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u; // 参照名と引数に許さない制御文字。
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // SHA-1（40 桁）か SHA-256（64 桁）のオブジェクト名。
const SUBMODULE_MODE = '160000'; // インデックス・ツリーでサブモジュール（gitlink）を表すモード。
const GIT_READ_OPTIONS = Object.freeze([
  '--no-pager',
  '--literal-pathspecs',
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=false',
  '-c', 'log.showSignature=false',
  '-c', 'status.submoduleSummary=false',
  '-c', 'diff.submodule=short',
  '-c', 'submodule.recurse=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
]); // safeOptions の後に付ける、出力の形を固定し、署名検証（gpg）・サブモジュール内の実行・自動 gc を止める固定オプション。
const GIT_NO_DIFF_PROGRAMS = Object.freeze(['--no-ext-diff', '--no-textconv', '--no-color']); // diff と log に必ず付ける、外部差分・変換プログラムと色の無効化。
const DIFF_PROGRAM_SUBCOMMANDS = new Set(['diff', 'log']); // GIT_NO_DIFF_PROGRAMS を付けるサブコマンド。
const ALLOWED_GIT_SUBCOMMANDS = new Map([
  ['rev-parse', null],
  ['symbolic-ref', null],
  ['for-each-ref', null],
  ['rev-list', null],
  ['merge-base', null],
  ['log', null],
  ['diff', null],
  ['status', null],
  ['ls-files', null],
  ['reflog', ['show']],
  ['worktree', ['list']],
]); // 実行してよいサブコマンドと、2 語目を限る場合の許可値（null は限らない）。
const FORBIDDEN_LONG_OPTIONS = Object.freeze([
  'output', // 結果をファイルへ書く（diff・log）。
  'output-directory',
  'no-index', // リポジトリ外のファイル同士を比べる（diff）。
  'ext-diff', // 外部差分プログラムの有効化。
  'textconv', // 変換プログラムの有効化。
  'exec',
  'upload-pack',
  'receive-pack',
  'open-files-in-pager',
]); // オプションの位置に置かせない長いオプション名。Git は一意な省略形も受け付けるため、前方一致（3 文字以上）で拒否する。
const REPOSITORY_LOCATION_ENV_KEYS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF',
]); // 親プロセスから引き継ぐと -C のプロジェクト以外を読みうる環境変数。Git へ渡す環境から除く。
const REF_FIELDS = Object.freeze([
  '%(refname)',
  '%(objectname)',
  '%(objectname:short)',
  '%(objecttype)',
  '%(committerdate:iso-strict)',
  '%(upstream)',
  '%(upstream:track,nobracket)',
  '%(symref)',
  '%(HEAD)',
]); // for-each-ref で読む項目。NUL で区切り、1 行 1 参照。作者名・メールアドレスは読まない。
const SAFE_REF_FIELDS = Object.freeze(['%(refname)', '%(objectname)', '%(objectname:short)', '%(upstream)', '%(symref)', '%(HEAD)']); // オブジェクトを読まない項目（欠けたオブジェクトを指す参照があっても失敗しない）。
const MAX_SHAS_PER_CALL = 300; // 1 回の Git 呼び出しに並べる SHA の数（Windows のコマンド行の上限を避ける）。
const SHALLOW_WARNING = '浅い clone（shallow）のため履歴が途中までです。ahead/behind・分岐点・コミット数が不正確な可能性があります。'; // 浅い clone の警告。
const CONFLICT_HEURISTIC_NOTE = '分岐点から両側で変更されたファイルの重なりを数えた目安です。実際にマージを試したものではなく、重なっていても競合しないことも、重なっていなくても競合することもあります。'; // conflictIndicators の注記。
const MTIME_WARNING = 'newestChangedFileModifiedAt はファイルの更新日時から求めた参考値です。コピー・チェックアウト・ツールによる書き換えでも変わるため、実際の作業日を示すとは限りません。'; // 更新日時の注意。

// 必須の Git 呼び出しが失敗したことを、ツールの共通の流れへ伝える内部の例外。分類だけを持ち、Git の出力は持たない。
class GitStepFailure extends Error {
  constructor(errorClass) {
    super(errorClass);
    this.name = 'GitStepFailure';
    this.errorClass = errorClass;
  }
}

/*
  Git の呼び出しが許可リストに合うかを検査し、合わなければ例外を投げる。runGit が実行前に必ず呼ぶ（試験からも直接呼べる）。
  引数: args（サブコマンドから始まる引数の配列。safeOptions・-C などの前置きは含めない）
  - 1 語目は許可リストのサブコマンドだけ。reflog は show、worktree は list だけ。
  - --end-of-options か -- より前に、ファイルへ書く・外部プログラムを動かす長いオプション（省略形を含む）を置かない。
  - symbolic-ref は読み取りの形（位置引数 1 つ、-d・--delete・-m なし）だけ。
*/
export function assertAllowedGitInvocation(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('Git の引数がありません。');
  for (const argument of args) {
    if (typeof argument !== 'string') throw new Error('Git の引数は文字列だけを使えます。');
    if (argument.includes('\0')) throw new Error('Git の引数に NUL は使えません。');
  }
  const [subcommand, ...rest] = args;
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) throw new Error(`許可されていない Git のサブコマンドです: ${subcommand}`);
  const allowedActions = ALLOWED_GIT_SUBCOMMANDS.get(subcommand); // 2 語目の許可値。
  if (allowedActions && !allowedActions.includes(rest[0])) throw new Error(`許可されていない Git の呼び出しです: ${subcommand} ${rest[0] ?? ''}`.trim());
  for (const argument of rest) {
    if (argument === '--end-of-options' || argument === '--') break;
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2).split('=')[0]; // 長いオプションの名前。
    if (name.length >= 3 && FORBIDDEN_LONG_OPTIONS.some(forbidden => forbidden.startsWith(name))) {
      throw new Error(`許可されていない Git のオプションです: --${name}`);
    }
  }
  if (subcommand === 'symbolic-ref') {
    const positional = rest.filter(argument => !argument.startsWith('-')); // 位置引数。2 つあると参照を書き換える。
    if (rest.some(argument => argument === '-d' || argument === '--delete' || argument === '-m') || positional.length !== 1) {
      throw new Error('symbolic-ref は読み取りの形だけを使えます。');
    }
  }
}

// 空白区切りの行を、先頭から count - 1 個の項目と残り全体（パスなど空白を含みうる最後の項目）に分ける。項目が足りなければ null。
function splitFields(text, count) {
  const fields = []; // 分けた項目。
  let rest = text; // まだ分けていない部分。
  for (let index = 0; index < count - 1; index += 1) {
    const space = rest.indexOf(' ');
    if (space < 0) return null;
    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  fields.push(rest);
  return fields;
}

/*
  git status --porcelain=v2 -z の出力を分解する。
  戻り値: { headers（# branch.* の値）, entries: [{ type: 'ordinary'|'renamed'|'unmerged'|'untracked', indexStatus, worktreeStatus, submodule, path, originalPath }], anomalies }
*/
function parseStatusV2(text) {
  const tokens = text.split('\0'); // NUL 区切りの項目。
  const headers = {}; // # branch.oid などの値。
  const entries = []; // 変更の一覧。
  let anomalies = 0; // 形式が想定と違った項目の数。
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '') continue;
    const marker = token.charAt(0); // 項目の種類。
    if (marker === '#') {
      const fields = splitFields(token, 3);
      if (fields) headers[fields[1]] = fields[2];
      else if (token.startsWith('# ')) headers[token.slice(2)] = '';
      continue;
    }
    if (marker === '1' || marker === '2' || marker === 'u') {
      const fields = splitFields(token, marker === '1' ? 9 : marker === '2' ? 10 : 11);
      if (!fields || fields[1].length !== 2) { anomalies += 1; continue; }
      const entry = {
        type: marker === '1' ? 'ordinary' : marker === '2' ? 'renamed' : 'unmerged',
        indexStatus: fields[1].charAt(0),
        worktreeStatus: fields[1].charAt(1),
        submodule: fields[2].startsWith('S') ? fields[2] : null,
        path: fields[fields.length - 1],
        originalPath: null,
      };
      if (marker === '2') {
        entry.originalPath = tokens[index + 1] ?? null;
        index += 1;
      }
      entries.push(entry);
      continue;
    }
    if (marker === '?') {
      entries.push({ type: 'untracked', indexStatus: '?', worktreeStatus: '?', submodule: null, path: token.slice(2), originalPath: null });
      continue;
    }
    if (marker === '!') continue;
    anomalies += 1;
  }
  return { headers, entries, anomalies };
}

/*
  git diff --raw [--numstat] -z の出力を分解する。raw の項目の後に numstat の項目が続く。パスは見出しの後ろの決まった位置から読むので、
  パスが「:」や数字で始まっていても取り違えない。
  戻り値: { entries: [{ status, score, oldMode, newMode, path, oldPath, insertions, deletions, binary }], anomalies }
*/
function parseRawNumstat(text) {
  const tokens = text.split('\0'); // NUL 区切りの項目。
  const entries = []; // raw の項目。
  const stats = new Map(); // パスごとの numstat。
  let anomalies = 0; // 形式が想定と違った項目の数。
  let index = 0; // 読んでいる位置。
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '') { index += 1; continue; }
    if (token.startsWith(':')) {
      const fields = token.slice(1).split(' ');
      if (fields.length < 5) { anomalies += 1; index += 1; continue; }
      const statusField = fields[4]; // 状態の文字と、名前変更・複製の類似度。
      const letter = statusField.charAt(0);
      if (letter === 'R' || letter === 'C') {
        entries.push({ status: letter, score: Number(statusField.slice(1)) || null, oldMode: fields[0], newMode: fields[1], oldPath: tokens[index + 1] ?? '', path: tokens[index + 2] ?? '' });
        index += 3;
      } else {
        entries.push({ status: letter, score: null, oldMode: fields[0], newMode: fields[1], oldPath: null, path: tokens[index + 1] ?? '' });
        index += 2;
      }
      continue;
    }
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (match) {
      let filePath = match[3]; // numstat のパス。名前変更は空で、続く 2 項目が元と先。
      if (filePath === '') {
        filePath = tokens[index + 2] ?? '';
        index += 3;
      } else {
        index += 1;
      }
      const binary = match[1] === '-' || match[2] === '-';
      stats.set(filePath, { insertions: binary ? null : Number(match[1]), deletions: binary ? null : Number(match[2]), binary });
      continue;
    }
    anomalies += 1;
    index += 1;
  }
  for (const entry of entries) {
    const stat = stats.get(entry.path);
    entry.insertions = stat ? stat.insertions : null;
    entry.deletions = stat ? stat.deletions : null;
    entry.binary = stat ? stat.binary : false;
  }
  return { entries, anomalies };
}

// git worktree list --porcelain の出力を分解する（Git 2.34 には -z が無いので行で読む。知らない行は読み飛ばす）。
function parseWorktreeList(text) {
  const entries = []; // worktree の一覧。先頭が main worktree。
  let current = null; // 読んでいる worktree。
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
  }
  return entries;
}

// 差分の本文を、ファイルごとの区切り（diff --git / diff --cc）で分ける。中身の行は空白・+・-・\ で始まるので、区切りと取り違えない。
function splitPatchSections(text) {
  const sections = []; // { header, lines } の配列。
  let current = null; // 読んでいる区切り。
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      current = { header: line, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

/*
  Git が C 言語風に引用したパス（"..." と \t・\n・\"・\\・\ooo）を元の文字列へ戻す。引用されていなければそのまま返す。
  戻り値: { value（戻したパス）, rest（引用の後ろの残り） }。引用が閉じていなければ null。
*/
function unquoteGitPath(text) {
  if (!text.startsWith('"')) return { value: text, rest: '' };
  const bytes = []; // 戻したバイト列。
  const simpleEscapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }; // 1 文字のエスケープ。
  let index = 1; // 読んでいる位置。
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === '"') return { value: Buffer.from(bytes).toString('utf8'), rest: text.slice(index + 1) };
    if (character === '\\') {
      const next = text.charAt(index + 1);
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(text.slice(index + 1, index + 4), 8));
        index += 4;
        continue;
      }
      if (Object.hasOwn(simpleEscapes, next)) {
        bytes.push(simpleEscapes[next]);
        index += 2;
        continue;
      }
      return null;
    }
    bytes.push(...Buffer.from(character, 'utf8'));
    index += 1;
  }
  return null;
}

// 差分の区切りから、変更先のパスを読む。読めなければ null（その区切りは出さない）。
function patchSectionPath(section) {
  for (const line of section.lines) {
    if (line.startsWith('@@')) break;
    for (const prefix of ['rename to ', 'copy to ']) {
      if (line.startsWith(prefix)) return unquoteGitPath(line.slice(prefix.length))?.value ?? null;
    }
  }
  if (!section.header.startsWith('diff --git ')) return null;
  const rest = section.header.slice('diff --git '.length); // 「a/元 b/先」。
  if (rest.startsWith('"')) {
    const first = unquoteGitPath(rest);
    if (!first || !first.rest.startsWith(' ')) return null;
    const second = unquoteGitPath(first.rest.slice(1));
    return second && second.value.startsWith('b/') ? second.value.slice(2) : null;
  }
  if ((rest.length - 5) % 2 !== 0) return null;
  const half = (rest.length - 5) / 2; // 元と先が同じパスのときの 1 つ分の長さ。
  const candidate = rest.slice(2, 2 + half);
  return rest === `a/${candidate} b/${candidate}` ? candidate : null;
}

// 完全な参照名から、表示用の短い名前（refs/heads/ と refs/remotes/ を除いた名前）を返す。
function shortRefName(fullName) {
  if (fullName.startsWith('refs/heads/')) return fullName.slice('refs/heads/'.length);
  if (fullName.startsWith('refs/remotes/')) return fullName.slice('refs/remotes/'.length);
  return fullName;
}

// パスの先頭のディレクトリ（変更のまとまりの名前）を返す。ルート直下のファイルは '.'。
function areaOf(filePath) {
  const slash = filePath.indexOf('/');
  return slash > 0 ? filePath.slice(0, slash) : '.';
}

// このマシンのローカル日付（yyyy-MM-dd）を返す。
function localDateKey(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// upstream:track,nobracket の値（「ahead 1, behind 2」「gone」など）から ahead と behind を読む。
function parseTrack(track) {
  const ahead = /ahead (\d+)/.exec(track); // 上流より進んでいるコミット数。
  const behind = /behind (\d+)/.exec(track); // 上流より遅れているコミット数。
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: track.trim() === 'gone' };
}

// raw の状態文字を、変更のまとまりの数え方（added・modified・deleted・renamed・other）へ振り分ける。
function changeCategory(status) {
  if (status === 'A') return 'added';
  if (status === 'M' || status === 'T') return 'modified';
  if (status === 'D') return 'deleted';
  if (status === 'R' || status === 'C') return 'renamed';
  return 'other';
}

// 差分の項目から、ファイル数・追加行・削除行・バイナリの数をまとめる。同じパスが 2 度出たら 1 つと数える。
function summarizeDiff(entries) {
  const byPath = new Map(); // パスごとの項目（最初のもの）。
  for (const entry of entries) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  }
  let insertions = 0; // 追加行の合計。
  let deletions = 0; // 削除行の合計。
  let binaryFiles = 0; // バイナリの数。
  for (const entry of byPath.values()) {
    if (entry.binary) binaryFiles += 1;
    insertions += entry.insertions || 0;
    deletions += entry.deletions || 0;
  }
  return { filesChanged: byPath.size, insertions, deletions, binaryFiles };
}

/*
  プロジェクトの Git を読み取り専用で調べる道具一式を作る。
  引数 options:
    root            プロジェクトルートの実パス（Git のルートであることは preflight が確かめる）
    resolveGit      Git の実行ファイルを返す関数（Windows は絶対パス、Linux は 'git'）。使えなければ例外を投げる
    safeOptions     先頭に付ける固定オプション（server.mjs の GIT_SAFE_OPTIONS）
    preflight       Git ルートと .git/config の検査。公開メソッドの呼び出しごとに最初に 1 回呼ぶ
    redact          秘密値のマスク。パス・件名・差分の行・ブランチ名に当てる
    isHiddenPath    true のパスは名前も内容も出さない
    exposure        { paths, commitSubjects, branchNames, diffExcerpts }。呼び出しのたびに読む
    timeoutMs       Git 1 回の制限時間（既定 15000）
    maxOutputBytes  Git 1 回の出力の上限（既定 4 MiB）
    試験・診断用: onGitInvocation（実行する引数の写しを受け取る）、onInternalError（想定外の例外を受け取る）、
                 useAheadBehindField（false で %(ahead-behind:) を使わない）
    2.6.0: isSourceHiddenPath（get_git_diff だけが使う、isHiddenPath に新ツールの拒否を足した判定）、displayPrefix（サブモジュールの中を調べるときの
           応答のパスの接頭辞）、resolveSubmodule（submodule 引数を検証し、そのサブモジュールの中で Git を実行する設定を返す。server.mjs が渡す）
  戻り値: { getBranches, getBranchDetails, compareBranches, getWorktreeDetails, getRecentActivity, getDiff, getSummary }
*/
export function createGitReader(options) {
  const root = path.resolve(String(options.root)); // プロジェクトルート（-C に渡す）。
  const resolveGit = options.resolveGit; // Git の実行ファイルを返す関数。
  const safeOptions = Array.isArray(options.safeOptions) ? options.safeOptions.map(String) : [...DEFAULT_SAFE_OPTIONS]; // 先頭に付ける固定オプション。
  const preflight = options.preflight; // Git ルートと .git/config の検査。
  const redact = typeof options.redact === 'function' ? options.redact : value => value; // 秘密値のマスク。
  const isHiddenPath = options.isHiddenPath; // 名前も内容も出さないパスの判定。
  const isSourceHiddenPath = typeof options.isSourceHiddenPath === 'function' ? options.isSourceHiddenPath : isHiddenPath; // get_git_diff（2.6.0）が使う、新ツールの拒否（組み込みの拒否パス・追加の秘密名）も含む判定。
  const displayPrefix = typeof options.displayPrefix === 'string' ? options.displayPrefix : ''; // サブモジュールの中を調べるとき、応答のパスに付けるプロジェクト相対の接頭辞（プロジェクト自身は空）。
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS; // Git 1 回の制限時間。
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes) && options.maxOutputBytes > 0 ? options.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES; // Git 1 回の出力の上限。
  const onGitInvocation = typeof options.onGitInvocation === 'function' ? options.onGitInvocation : null; // 試験用: 実行する引数の通知先。
  const onInternalError = typeof options.onInternalError === 'function' ? options.onInternalError : null; // 診断用: 想定外の例外の通知先。
  const useAheadBehindField = options.useAheadBehindField !== false; // 試験用: false なら %(ahead-behind:) を使わず、古い Git と同じ数え方をする。
  const rootCandidates = [root]; // worktree の位置を比べるルートの候補（指定値と、大小文字まで正規化した実パス）。
  try {
    const nativeRoot = fs.realpathSync.native(root);
    if (nativeRoot !== root) rootCandidates.push(nativeRoot);
  } catch { /* 実パスを得られなければ指定値だけで比べる。 */ }
  const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }; // Git へ渡す環境。認証の入力待ちと任意ロックを止め、メッセージを英語に固定する。
  for (const key of Object.keys(gitEnvironment)) {
    if (REPOSITORY_LOCATION_ENV_KEYS.has(key.toUpperCase())) delete gitEnvironment[key];
  }

  // 公開範囲の項目（paths・commitSubjects・branchNames・diffExcerpts）が許可されているかを、呼び出しのたびに読む。
  function exposed(key) {
    return options.exposure?.[key] === true;
  }

  // パスが非公開（isHiddenPath が true）かを返す。末尾の / を除いて判定し、判定できなければ非公開として扱う。
  function hiddenPath(filePath) {
    if (typeof filePath !== 'string' || filePath === '') return true;
    try {
      return isHiddenPath(filePath.replace(/\/+$/, '')) === true;
    } catch {
      return true;
    }
  }

  // 応答に載せるパスを整える（秘密値のマスク）。
  function showPath(filePath) {
    return redact(filePath);
  }

  // get_git_diff 用: パスが非公開か（hiddenPath に、新ツールの拒否を足したもの）。判定できなければ非公開。
  function hiddenSource(filePath) {
    if (typeof filePath !== 'string' || filePath === '') return true;
    try {
      return isSourceHiddenPath(filePath.replace(/\/+$/, '')) === true;
    } catch {
      return true;
    }
  }

  // get_git_diff 用: 応答に載せるパス（サブモジュールの中ならプロジェクト相対にし、秘密値をマスクする）。
  function showDiffPath(filePath) {
    return redact(displayPrefix ? `${displayPrefix}/${filePath}` : filePath);
  }

  /*
    Git を許可リストの検査付きで 1 回実行する。シェルを通さず、時間・出力の上限を付け、標準入力は閉じる。
    引数: args（サブコマンドから始まる引数の配列）、settings.okExitCodes（成功として扱う終了コード。既定は [0]）
    戻り値: { ok: true, exitCode, stdout, stderr } か { ok: false, errorClass }。標準エラー出力は分類と警告の件数にだけ使い、応答には載せない。
  */
  function runGit(args, { okExitCodes = [0] } = {}) {
    assertAllowedGitInvocation(args);
    let executable; // Git の実行ファイル。
    try {
      executable = resolveGit();
    } catch {
      return { ok: false, errorClass: ERROR_CLASS.GIT_UNAVAILABLE };
    }
    const [subcommand, ...rest] = args;
    const fullArgs = [
      ...safeOptions,
      ...GIT_READ_OPTIONS,
      '-C', root,
      subcommand,
      ...(DIFF_PROGRAM_SUBCOMMANDS.has(subcommand) ? GIT_NO_DIFF_PROGRAMS : []),
      ...rest,
    ]; // 実際に渡す引数。
    if (onGitInvocation) onGitInvocation(fullArgs.slice());
    const result = spawnSync(executable, fullArgs, {
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnvironment,
      shell: false,
    });
    if (result.error) {
      const code = result.error.code; // 起動・待機の失敗の種類。
      if (code === 'ETIMEDOUT') return { ok: false, errorClass: ERROR_CLASS.TIMEOUT };
      if (code === 'ENOBUFS') return { ok: false, errorClass: ERROR_CLASS.OUTPUT_TOO_LARGE };
      if (code === 'ENOENT' || code === 'EACCES') return { ok: false, errorClass: ERROR_CLASS.GIT_UNAVAILABLE };
      return { ok: false, errorClass: ERROR_CLASS.GIT_ERROR };
    }
    const stderr = result.stderr ? result.stderr.toString('utf8') : ''; // 分類にだけ使う標準エラー出力。
    if (!okExitCodes.includes(result.status)) {
      if (/not a git repository/i.test(stderr)) return { ok: false, errorClass: ERROR_CLASS.NOT_A_GIT_REPOSITORY };
      return { ok: false, errorClass: ERROR_CLASS.GIT_ERROR };
    }
    return { ok: true, exitCode: result.status, stdout: result.stdout ? result.stdout.toString('utf8') : '', stderr };
  }

  // 1 回のツール呼び出しの間だけ使う状態を作る。呼び出しをまたいで Git の結果を持ち越さない。
  function createCallState() {
    return { startedAt: Date.now(), cache: new Map(), warnings: [], hidden: [], incomplete: false, failureClass: null };
  }

  // 応答を partial にし、警告を（重複させずに）残す。errorClass を渡すと、最初の失敗の分類として記録する。
  function markIncomplete(state, warning, errorClass = null) {
    state.incomplete = true;
    if (errorClass && !state.failureClass) state.failureClass = errorClass;
    if (warning && !state.warnings.includes(warning)) state.warnings.push(warning);
  }

  // 警告を重複させずに足す（欠落を意味しない注意事項）。
  function addWarning(state, warning) {
    if (!state.warnings.includes(warning)) state.warnings.push(warning);
  }

  // 必須の Git 呼び出し。失敗したら GitStepFailure を投げ、ツールは unavailable の応答を返す。
  function requireGit(args, settings) {
    const result = runGit(args, settings);
    if (!result.ok) throw new GitStepFailure(result.errorClass);
    return result;
  }

  // 任意の Git 呼び出し。失敗したら null を返し、応答を partial にして警告を残す。label は警告に出す項目名（固定文）。
  function optionalGit(state, args, label, settings) {
    const result = runGit(args, settings);
    if (result.ok) return result;
    markIncomplete(state, `${label}を取得できませんでした（分類: ${result.errorClass}）。`, result.errorClass);
    return null;
  }

  // preflight を呼び、結果を { ok, errorClass, reason } に整える。preflight が例外を投げたら内部エラーとして扱う。
  function checkPreflight() {
    let verdict; // preflight の戻り値。
    try {
      verdict = typeof preflight === 'function' ? preflight() : { ok: true };
    } catch (error) {
      if (onInternalError) onInternalError(error);
      return { ok: false, errorClass: ERROR_CLASS.INTERNAL, reason: null };
    }
    if (verdict && verdict.ok === true) return { ok: true };
    return {
      ok: false,
      errorClass: verdict?.errorClass || ERROR_CLASS.NOT_A_GIT_REPOSITORY,
      reason: typeof verdict?.reason === 'string' && verdict.reason ? verdict.reason : null,
    };
  }

  /*
    公開メソッドの共通の流れ。preflight を 1 度だけ呼び、通らなければ Git を実行せずに unavailable の応答を返す。
    build（state を受け取り { facts, inferences, evidence, page, limits } を返す関数）の中で、
    必須の Git 呼び出しが失敗したら unavailable、任意の呼び出しだけが失敗したら partial の応答にする。
    引数の不備・権限などの BridgeToolError はそのまま投げる。想定外の例外は internal_error の応答にする（内容は載せない）。
  */
  function runTool(tool, pagedKey, build) {
    const collectedAt = new Date().toISOString(); // 取得日時。
    const sources = [describeSource(SOURCE_KIND.LIVE_GIT, collectedAt)]; // 情報源は呼び出し時点の Git。
    const gate = checkPreflight();
    if (!gate.ok) {
      return fitToBudget(makeEnvelope({ tool, collectedAt, sources, errorClass: gate.errorClass, errorReason: gate.reason }), DEFAULT_MAX_RESPONSE_BYTES, null);
    }
    const state = createCallState();
    let built; // build の戻り値。
    try {
      built = build(state);
    } catch (error) {
      if (error instanceof BridgeToolError) throw error;
      if (!(error instanceof GitStepFailure) && onInternalError) onInternalError(error);
      const errorClass = error instanceof GitStepFailure ? error.errorClass : ERROR_CLASS.INTERNAL;
      return fitToBudget(makeEnvelope({ tool, collectedAt, sources, errorClass, hidden: state.hidden, warnings: state.warnings }), DEFAULT_MAX_RESPONSE_BYTES, null);
    }
    const envelope = makeEnvelope({
      tool,
      collectedAt,
      sources,
      status: state.incomplete ? STATUS.PARTIAL : undefined,
      facts: built.facts,
      inferences: built.inferences || [],
      evidence: built.evidence || [],
      page: built.page || null,
      hidden: state.hidden,
      warnings: state.warnings,
      limits: { ...(built.limits || {}), timeoutMs, maxOutputBytes },
      errorClass: state.failureClass,
    });
    return fitToBudget(envelope, DEFAULT_MAX_RESPONSE_BYTES, pagedKey);
  }

  // 真偽値の引数を検証する。未指定は fallback。真偽値以外は invalid_argument。
  function readBoolean(value, name, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} は true か false で指定してください。`);
    return value;
  }

  // ブランチ名の引数を検証する（文字列・長さ・制御文字）。実在の確認は resolveRef が行う。
  function validateRefInput(value, name) {
    const text = requireString(value, name, { maxLength: MAX_REF_INPUT_LENGTH });
    if (CONTROL_CHARACTER_PATTERN.test(text)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `${name} に制御文字は使えません。`);
    return text;
  }

  // ブランチ名の公開が許可されていなければ、ブランチの存在を確かめずに permission_denied を投げる。
  function requireBranchNames(what) {
    if (!exposed('branchNames')) {
      throw new BridgeToolError(ERROR_CLASS.PERMISSION_DENIED, `${what}は、ブランチ名の公開（detailExposure.branchNames）が許可されていないため返せません。`, { hidden: ['branchNames'] });
    }
  }

  // 浅い clone かを返す（呼び出しの中でキャッシュする）。浅い clone なら警告を足す。
  function readShallow(state) {
    if (state.cache.has('shallow')) return state.cache.get('shallow');
    const isShallow = requireGit(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
    if (isShallow) addWarning(state, SHALLOW_WARNING);
    state.cache.set('shallow', isShallow);
    return isShallow;
  }

  // HEAD が指す参照（refs/heads/<名>）を返す。detached なら null（symbolic-ref の終了コード 1）。
  function readSymbolicHead() {
    const symbolic = requireGit(['symbolic-ref', '-q', 'HEAD'], { okExitCodes: [0, 1] });
    const target = symbolic.exitCode === 0 ? symbolic.stdout.trim() : '';
    return { detached: symbolic.exitCode === 1, headRef: target && !CONTROL_CHARACTER_PATTERN.test(target) ? target : null };
  }

  /*
    HEAD の状態を読む（呼び出しの中でキャッシュする）。HEAD がブランチを指していれば、SHA と日時は listRefs の結果を使い、Git を呼び足さない。
    戻り値: { headState: 'branch'|'detached'|'unborn', headSha, headShortSha, headCommittedAt, currentBranch, headRef }
  */
  function readHead(state) {
    if (state.cache.has('head')) return state.cache.get('head');
    const { detached, headRef } = readSymbolicHead();
    const currentBranch = headRef && headRef.startsWith('refs/heads/') ? headRef.slice('refs/heads/'.length) : null;
    let head; // HEAD の事実。
    if (!detached) {
      const current = headRef ? listRefs(state).byFullName.get(headRef) : null;
      if (current) {
        head = { headState: 'branch', headSha: current.sha, headShortSha: current.shortSha, headCommittedAt: current.committedAt, currentBranch, headRef };
      } else {
        // 指すブランチが一覧に無い: 初回コミット前（unborn）か、壊れた参照。rev-parse --verify で見分ける（unborn は終了コード 1）。
        const verified = requireGit(['rev-parse', '--verify', '-q', 'HEAD'], { okExitCodes: [0, 1] });
        const verifiedSha = verified.exitCode === 0 ? verified.stdout.trim() : '';
        const headSha = SHA_PATTERN.test(verifiedSha) ? verifiedSha : null;
        head = { headState: headSha ? 'branch' : 'unborn', headSha, headShortSha: headSha ? headSha.slice(0, 7) : null, headCommittedAt: null, currentBranch, headRef };
      }
    } else {
      const [headSha, headShortSha, headCommittedAt] = requireGit(['log', '-1', '--format=%H%x1f%h%x1f%cI', '--end-of-options', 'HEAD', '--']).stdout.trim().split('\x1f');
      head = { headState: 'detached', headSha: SHA_PATTERN.test(headSha) ? headSha : null, headShortSha: headShortSha || null, headCommittedAt: headCommittedAt || null, currentBranch: null, headRef: null };
    }
    state.cache.set('head', head);
    return head;
  }

  /*
    全ブランチの base との ahead/behind を、for-each-ref の %(ahead-behind:<コミット>)（Git 2.41 以上）で 1 回で数える。
    この項目を使えない Git（Ubuntu 22.04 の 2.34 など）や、欠けたオブジェクトで失敗したときは null を返し、呼び出し側が 1 本ずつ数える。
    戻り値: Map（完全な参照名 → { ahead, behind, capped: false }）か null。
  */
  function readAheadBehindAll(state, baseSha) {
    if (!useAheadBehindField) return null;
    const result = runGit(['for-each-ref', `--format=%(refname)%00%(ahead-behind:${baseSha})`, 'refs/heads', 'refs/remotes']);
    if (!result.ok) {
      if (result.errorClass !== ERROR_CLASS.GIT_ERROR) markIncomplete(state, `base との差を取得できませんでした（分類: ${result.errorClass}）。`, result.errorClass);
      return null;
    }
    const distances = new Map(); // 参照ごとの差。
    for (const record of parseRefRecords(result.stdout, ['fullName', 'distance']).records) {
      const match = /^(\d+) (\d+)$/.exec(record.distance);
      if (match) distances.set(record.fullName, { ahead: Number(match[1]), behind: Number(match[2]), capped: false });
    }
    return distances;
  }

  // for-each-ref の出力を、fieldNames の順の項目を持つ記録の配列にする。項目数の合わない行は数えて捨てる。
  function parseRefRecords(stdout, fieldNames) {
    const records = []; // 読んだ記録。
    let malformed = 0; // 形式の合わない行。
    for (const line of stdout.split('\n')) {
      if (line === '') continue;
      const fields = line.split('\0');
      if (fields.length !== fieldNames.length) { malformed += 1; continue; }
      records.push(Object.fromEntries(fieldNames.map((name, index) => [name, fields[index]])));
    }
    return { records, malformed };
  }

  /*
    オブジェクトの欠けた参照があるときの列挙。オブジェクトを読まない項目で列挙し直し、コミットの日時は
    log --no-walk --ignore-missing（欠けたものを読み飛ばす）で、上流との差は別の for-each-ref（失敗してもよい）で読む。
    戻り値: { records, malformed, stderr }。日時の読めなかった参照は objectType を 'missing' にする。
  */
  function listRefsWithoutObjects(state) {
    const result = requireGit(['for-each-ref', `--format=${SAFE_REF_FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes']);
    const { records, malformed } = parseRefRecords(result.stdout, ['fullName', 'sha', 'shortSha', 'upstreamFull', 'symref', 'headMark']);
    const shas = [...new Set(records.filter(record => !record.symref && SHA_PATTERN.test(record.sha)).map(record => record.sha))]; // 日時を読む SHA。
    const dates = new Map(); // コミットの SHA から日時へ。
    for (let start = 0; start < shas.length; start += MAX_SHAS_PER_CALL) {
      const chunk = shas.slice(start, start + MAX_SHAS_PER_CALL);
      const dated = optionalGit(state, ['log', '--no-walk=unsorted', '--ignore-missing', '--format=%H%x1f%cI', '--end-of-options', ...chunk, '--'], 'ブランチの最終コミット日時');
      for (const line of dated ? dated.stdout.split('\n') : []) {
        const [sha, committedAt] = line.split('\x1f');
        if (SHA_PATTERN.test(sha)) dates.set(sha, committedAt || null);
      }
    }
    const tracked = optionalGit(state, ['for-each-ref', '--format=%(refname)%00%(upstream:track,nobracket)', 'refs/heads'], 'ブランチと上流の差');
    const tracks = new Map(tracked ? parseRefRecords(tracked.stdout, ['fullName', 'track']).records.map(record => [record.fullName, record.track]) : []); // 参照から上流との差へ。
    for (const record of records) {
      record.objectType = dates.has(record.sha) ? 'commit' : 'missing';
      record.committedAt = dates.get(record.sha) || '';
      record.track = tracks.has(record.fullName) ? tracks.get(record.fullName) : null;
    }
    addWarning(state, '指すオブジェクトが無い参照があるため、オブジェクトを読まない方法で一覧を作りました。');
    return { records, malformed, stderr: result.stderr };
  }

  /*
    ローカルブランチとリモート追跡ブランチを列挙する（呼び出しの中でキャッシュする）。
    形式の合わない行・制御文字を含む名前・コミット以外（または欠けたオブジェクト）を指す参照・Git が読み飛ばした壊れた参照は、
    件数を警告に出して除く。
    戻り値: { branches: [参照], byFullName: Map, remoteHeads: Map（リモート名 → refs/remotes/<名>/HEAD が指す完全な参照名） }
  */
  function listRefs(state) {
    if (state.cache.has('refs')) return state.cache.get('refs');
    const full = runGit(['for-each-ref', `--format=${REF_FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes']);
    let listing; // { records, malformed, stderr }。
    if (full.ok) {
      listing = { ...parseRefRecords(full.stdout, ['fullName', 'sha', 'shortSha', 'objectType', 'committedAt', 'upstreamFull', 'track', 'symref', 'headMark']), stderr: full.stderr };
    } else if (full.errorClass === ERROR_CLASS.GIT_ERROR) {
      listing = listRefsWithoutObjects(state); // 欠けたオブジェクトを指す参照があると、オブジェクトを読む項目で全体が失敗するため。
    } else {
      throw new GitStepFailure(full.errorClass);
    }
    const branches = []; // 一覧の対象になる参照。
    const byFullName = new Map(); // 完全な参照名から参照へ。
    const remoteHeads = new Map(); // リモートの既定ブランチ。
    let withControl = 0; // 制御文字を含む名前。
    let nonCommit = 0; // コミット以外を指す参照。
    let missing = 0; // 欠けたオブジェクトを指す参照。
    for (const record of listing.records) {
      const { fullName, sha, shortSha, objectType, committedAt, upstreamFull, track, symref, headMark } = record;
      if ([fullName, upstreamFull, symref].some(value => CONTROL_CHARACTER_PATTERN.test(value))) { withControl += 1; continue; }
      if (fullName.startsWith('refs/remotes/') && fullName.endsWith('/HEAD') && symref) {
        remoteHeads.set(fullName.slice('refs/remotes/'.length, -'/HEAD'.length), symref);
        continue;
      }
      if (objectType === 'missing') { missing += 1; continue; }
      if (objectType !== 'commit' || !SHA_PATTERN.test(sha)) { nonCommit += 1; continue; }
      const kind = fullName.startsWith('refs/heads/') ? 'local' : 'remote';
      const parsedTime = Date.parse(committedAt); // 並べ替え用のミリ秒。
      const ref = {
        fullName,
        name: shortRefName(fullName),
        kind,
        sha,
        shortSha: shortSha || sha.slice(0, 7),
        committedAt: committedAt || null,
        committedAtMs: Number.isFinite(parsedTime) ? parsedTime : 0,
        upstreamFull: upstreamFull || null,
        track,
        isCurrent: headMark === '*',
      };
      branches.push(ref);
      byFullName.set(fullName, ref);
    }
    for (const ref of branches) {
      ref.upstreamExists = ref.upstreamFull !== null && byFullName.has(ref.upstreamFull);
    }
    const broken = (listing.stderr.match(/ignoring (?:broken ref|ref with broken name|dangling symref)/g) || []).length; // Git が読み飛ばした参照。
    if (listing.malformed > 0) addWarning(state, `参照の一覧のうち ${listing.malformed} 行は、形式が想定と違うため読み飛ばしました。`);
    if (withControl > 0) addWarning(state, `名前に制御文字を含む参照 ${withControl} 件を一覧から除きました。`);
    if (nonCommit > 0) addWarning(state, `コミット以外を指す参照 ${nonCommit} 件を一覧から除きました。`);
    if (missing > 0) addWarning(state, `壊れた参照（指すオブジェクトが無い）${missing} 件を一覧から除きました。`);
    if (broken > 0) addWarning(state, `壊れた参照 ${broken} 件は Git が読み飛ばしたため、一覧にありません。`);
    const refs = { branches, byFullName, remoteHeads };
    state.cache.set('refs', refs);
    return refs;
  }

  // 利用者が指定したブランチ名を、列挙した実在の参照と完全一致で照合する。見つからなければ ref_not_found（任意のリビジョン式は受け付けない）。
  function resolveRef(state, text, name) {
    const refs = listRefs(state);
    const candidates = [...new Set([
      ...(text.startsWith('refs/heads/') || text.startsWith('refs/remotes/') ? [text] : []),
      `refs/heads/${text}`,
      `refs/remotes/${text}`,
    ])]; // 照合する完全な参照名（この順に優先）。
    const matches = candidates.map(candidate => refs.byFullName.get(candidate)).filter(Boolean);
    if (matches.length === 0) throw new BridgeToolError(ERROR_CLASS.REF_NOT_FOUND, `${name} に指定したブランチは存在しません。`);
    if (matches.length > 1) addWarning(state, `${name} は複数の参照（ローカルブランチとリモート追跡ブランチなど）に一致したため、ローカルブランチを優先しました。`);
    return matches[0];
  }

  /*
    比較の基準（base）を、実在を確かめた参照だけから選ぶ。
    明示指定 → refs/remotes/*\/HEAD が指す先（origin を優先し、残りはリモート名の順）→ ローカルの main・master・trunk・develop → なし。
    excludeFullName（比べる相手自身）は自動選択の候補から除く。
  */
  function selectBase(state, explicitText, excludeFullName = null) {
    if (explicitText !== null && explicitText !== undefined) return { ref: resolveRef(state, explicitText, 'baseBranch'), selection: 'explicit' };
    const refs = listRefs(state);
    const remotes = [...refs.remoteHeads.keys()].sort((left, right) => {
      if (left === 'origin') return -1;
      if (right === 'origin') return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    }); // 既定ブランチを持つリモート（origin が先頭）。
    for (const remote of remotes) {
      const ref = refs.byFullName.get(refs.remoteHeads.get(remote));
      if (ref && ref.fullName !== excludeFullName) return { ref, selection: 'remoteDefault' };
    }
    for (const name of CONVENTIONAL_BASE_NAMES) {
      const ref = refs.byFullName.get(`refs/heads/${name}`);
      if (ref && ref.fullName !== excludeFullName) return { ref, selection: 'conventionalName' };
    }
    return { ref: null, selection: 'none' };
  }

  // 参照を応答用に整える（名前はマスクする）。
  function describeRef(ref) {
    return { ref: redact(ref.name), kind: ref.kind, sha: ref.sha, shortSha: ref.shortSha };
  }

  // 参照の上流（upstream）の事実を整える。リモート追跡ブランチや上流なしは none。上流との差を読めなかったときは数を null にする。
  function describeUpstream(ref) {
    if (!ref.upstreamFull) return { upstream: null, upstreamState: 'none', aheadOfUpstream: null, behindUpstream: null };
    const upstream = redact(shortRefName(ref.upstreamFull));
    if (ref.track === null) return { upstream, upstreamState: ref.upstreamExists ? 'tracking' : 'gone', aheadOfUpstream: null, behindUpstream: null };
    const track = parseTrack(ref.track);
    return {
      upstream,
      upstreamState: track.gone ? 'gone' : 'tracking',
      aheadOfUpstream: track.gone ? null : track.ahead,
      behindUpstream: track.gone ? null : track.behind,
    };
  }

  // base に対する target の ahead/behind を数える（上限付き）。同じコミットなら Git を呼ばない。失敗したら null。
  function countAheadBehind(state, baseSha, targetSha, label) {
    if (baseSha === targetSha) return { ahead: 0, behind: 0, capped: false };
    const result = optionalGit(state, ['rev-list', '--left-right', '--count', `--max-count=${COUNT_CAP + 1}`, '--end-of-options', `${baseSha}...${targetSha}`, '--'], label);
    if (!result) return null;
    const [left, right] = result.stdout.trim().split(/\s+/).map(Number); // 左が base だけにある数、右が target だけにある数。
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      markIncomplete(state, `${label}の出力を読めませんでした。`);
      return null;
    }
    return { ahead: Math.min(right, COUNT_CAP), behind: Math.min(left, COUNT_CAP), capped: left + right > COUNT_CAP };
  }

  // 2 つのコミットの分岐点を返す。{ sha }（共通の祖先が無ければ sha は null）。失敗したら null。
  function readMergeBase(state, leftSha, rightSha) {
    const result = optionalGit(state, ['merge-base', '--end-of-options', leftSha, rightSha], '分岐点', { okExitCodes: [0, 1] });
    if (!result) return null;
    const sha = result.exitCode === 0 ? result.stdout.trim().split('\n')[0] : '';
    return { sha: SHA_PATTERN.test(sha) ? sha : null };
  }

  // ancestorSha が descendantSha の祖先（同じコミットを含む）かを返す。失敗したら null。
  function isAncestor(state, ancestorSha, descendantSha) {
    const result = optionalGit(state, ['merge-base', '--is-ancestor', '--end-of-options', ancestorSha, descendantSha], 'マージ状態', { okExitCodes: [0, 1] });
    return result ? result.exitCode === 0 : null;
  }

  // コミットのコミッター日時を返す。失敗したら null。
  function readCommitDate(state, sha, label) {
    const result = optionalGit(state, ['log', '-1', '--format=%cI', '--end-of-options', sha, '--'], label);
    return result ? result.stdout.trim() || null : null;
  }

  // 2 つのコミットの間の変更（名前変更の検出付き）を返す。numstat が false なら行数を数えない。失敗したら null。
  function readTreeDiff(state, fromSha, toSha, label, numstat = true) {
    const result = optionalGit(state, ['diff', '--raw', ...(numstat ? ['--numstat'] : []), '-z', '-M', '--end-of-options', fromSha, toSha, '--'], label);
    if (!result) return null;
    const parsed = parseRawNumstat(result.stdout);
    if (parsed.anomalies > 0) addWarning(state, `${label}のうち ${parsed.anomalies} 項目は、形式が想定と違うため読み飛ばしました。`);
    return parsed.entries;
  }

  /*
    コミットの一覧を返す（新しい順）。作者名・メールアドレスは読まない。件名は commitSubjects が true のときだけ読む。
    引数: settings（include: 含める SHA の配列、exclude: 除く SHA の配列、limit、sinceSeconds、pseudoRefs（--branches など）、label）
    戻り値: [{ sha, shortSha, committedAt, committedAtMs, subject }]。失敗したら null。
  */
  function readCommits(state, { include = [], exclude = [], limit, sinceSeconds = null, pseudoRefs = [], label }) {
    const withSubjects = exposed('commitSubjects');
    const format = withSubjects ? '%H%x1f%h%x1f%cI%x1f%ct%x1f%s' : '%H%x1f%h%x1f%cI%x1f%ct'; // NUL でコミットを、0x1F で項目を区切る。
    const result = optionalGit(state, [
      'log', '-z', `--format=${format}`, `--max-count=${limit}`,
      ...(sinceSeconds !== null ? [`--since=@${sinceSeconds} +0000`] : []),
      ...pseudoRefs,
      '--end-of-options', ...include, ...exclude.map(sha => `^${sha}`), '--',
    ], label);
    if (!result) return null;
    const commits = []; // 読んだコミット。
    for (const record of result.stdout.split('\0')) {
      if (record === '') continue;
      const [sha, shortSha, committedAt, unixSeconds, ...subjectParts] = record.split('\x1f');
      if (!SHA_PATTERN.test(sha)) continue;
      commits.push({
        sha,
        shortSha,
        committedAt: committedAt || null,
        committedAtMs: Number(unixSeconds) * 1000,
        subject: withSubjects ? redact(subjectParts.join('\x1f')) : null,
      });
    }
    return commits;
  }

  // コミットを応答用に整える。件名は commitSubjects が true のときだけ入れる。
  function describeCommit(commit) {
    return { sha: commit.sha, shortSha: commit.shortSha, committedAt: commit.committedAt, ...(exposed('commitSubjects') ? { subject: commit.subject } : {}) };
  }

  // 件名から言える手がかりを、目的は未確認と明記した低い確度の推測にする。件名が非公開なら推測を出さない。
  function subjectInferences(commits, subjectLabel) {
    if (!exposed('commitSubjects') || !commits || commits.length === 0) return [];
    const quoted = commits.slice(0, 3).map(commit => `「${commit.subject}」`).join('');
    return [{
      claim: `${subjectLabel}の直近のコミット件名（${commits.length} 件。例: ${quoted}）は作業内容の手がかりになりますが、目的は未確認です。`,
      basis: 'コミット件名だけから読み取ったもので、作成理由や目的を記録した情報ではありません。',
      confidence: 'low',
      evidence: commits.slice(0, 5).map(commit => ({ type: 'commit', sha: commit.sha })),
    }];
  }

  // 差分の項目を、変更ファイルの一覧（公開してよいものだけ）と、非公開のため除いた件数にする。
  function describeChangedFiles(entries) {
    const files = []; // 応答に載せる変更ファイル。
    let omitted = 0; // 非公開のため除いた件数。
    for (const entry of entries) {
      if (hiddenPath(entry.path) || (entry.oldPath && hiddenPath(entry.oldPath))) { omitted += 1; continue; }
      files.push({
        path: showPath(entry.path),
        status: entry.status,
        renamedFrom: entry.oldPath ? showPath(entry.oldPath) : null,
        insertions: entry.insertions,
        deletions: entry.deletions,
        binary: entry.binary === true,
        submodule: entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE,
      });
    }
    return { files, omitted };
  }

  // ブランチの作成日時を reflog の「branch: Created from」から読む。無ければ 'unknown'。reflog の本文（URL を含みうる）は返さない。
  function readCreation(state, ref) {
    if (ref.kind !== 'local') return 'unknown';
    const result = optionalGit(state, ['reflog', 'show', '--date=iso-strict', '--format=%gD%x1f%gs', '--end-of-options', ref.fullName, '--'], 'ブランチの reflog');
    if (!result) return 'unknown';
    let createdAt = null; // 最も古い「branch: Created from」の日時。reflog は新しい順なので最後に見つかったもの。
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf('\x1f');
      if (separator < 0 || !line.slice(separator + 1).startsWith('branch: Created from')) continue;
      const selector = line.slice(0, separator); // refs/heads/<名>@{日時}。参照名に @{ は使えない。
      const start = selector.lastIndexOf('@{');
      if (start >= 0 && selector.endsWith('}')) createdAt = selector.slice(start + 2, -1);
    }
    return createdAt && Number.isFinite(Date.parse(createdAt)) ? { at: createdAt, source: 'reflog' } : 'unknown';
  }

  // 状態の項目の種類（staged・unstaged・both・untracked・conflicted）を返す。
  function entryKind(entry) {
    if (entry.type === 'unmerged') return 'conflicted';
    if (entry.type === 'untracked') return 'untracked';
    const staged = entry.indexStatus !== '.';
    const unstaged = entry.worktreeStatus !== '.';
    if (staged && unstaged) return 'both';
    return staged ? 'staged' : 'unstaged';
  }

  // 作業ツリーの状態の件数を数える（非公開のパスも数に含める）。
  function countStatus(entries) {
    const counts = { staged: 0, unstaged: 0, untracked: 0, deleted: 0, renamed: 0, conflicted: 0, total: entries.length };
    for (const entry of entries) {
      const kind = entryKind(entry);
      if (kind === 'conflicted') { counts.conflicted += 1; continue; }
      if (kind === 'untracked') { counts.untracked += 1; continue; }
      if (kind === 'staged' || kind === 'both') counts.staged += 1;
      if (kind === 'unstaged' || kind === 'both') counts.unstaged += 1;
      if (entry.indexStatus === 'D' || entry.worktreeStatus === 'D') counts.deleted += 1;
      if (entry.indexStatus === 'R' || entry.worktreeStatus === 'R') counts.renamed += 1;
    }
    return counts;
  }

  // git status（porcelain v2、NUL 区切り）を読む。サブモジュールの中では status を動かさない（--ignore-submodules=dirty）。
  function readStatus(state, { includeUntracked = true, required = true } = {}) {
    const args = [
      'status', '--porcelain=v2', '-z', `--untracked-files=${includeUntracked ? 'normal' : 'no'}`, '--ignore-submodules=dirty', '--find-renames',
    ]; // 状態の取得の引数。
    const result = required ? requireGit(args) : optionalGit(state, args, '作業ツリーの状態');
    if (!result) return null;
    const parsed = parseStatusV2(result.stdout);
    if (parsed.anomalies > 0) addWarning(state, `作業ツリーの状態のうち ${parsed.anomalies} 項目は、形式が想定と違うため読み飛ばしました。`);
    return parsed;
  }

  // ステージ済み（cached）か未ステージの差分の一覧と行数を返す。失敗したら null。
  function readWorktreeDiff(state, cached) {
    const label = cached ? 'ステージ済みの差分' : '未ステージの差分';
    const result = optionalGit(state, ['diff', ...(cached ? ['--cached'] : []), '--raw', '--numstat', '-z', '-M', '--ignore-submodules=dirty', '--'], label);
    if (!result) return null;
    const parsed = parseRawNumstat(result.stdout);
    if (parsed.anomalies > 0) addWarning(state, `${label}のうち ${parsed.anomalies} 項目は、形式が想定と違うため読み飛ばしました。`);
    return parsed.entries;
  }

  // Git が出した worktree のパスが、プロジェクトの中にあるかを調べる。中なら / 区切りの相対パス（ルート自身は ''）を返す。
  function locateInsideRoot(gitPath) {
    if (!gitPath) return { inside: false, relative: null };
    // 1 つの候補パスについて、ルートの候補のどれかの中にあれば相対パスを返す。
    const relativeTo = candidate => {
      for (const rootCandidate of rootCandidates) {
        const relative = path.relative(rootCandidate, path.resolve(candidate));
        if (relative === '') return '';
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        return relative.split(path.sep).join('/');
      }
      return null;
    };
    let relative = relativeTo(gitPath); // Git の表記のままで比べた結果。
    if (relative === null) {
      try { relative = relativeTo(fs.realpathSync.native(gitPath)); } catch { relative = null; }
    }
    return { inside: relative !== null, relative };
  }

  // worktree の一覧を応答用に整える。プロジェクト外の worktree は位置を出さず、中で Git も実行しない。失敗したら null。
  function readWorktrees(state) {
    const result = optionalGit(state, ['worktree', 'list', '--porcelain'], 'worktree の一覧');
    if (!result) return null;
    let branchHidden = false; // ブランチ名を伏せた worktree があったか。
    const worktrees = parseWorktreeList(result.stdout).map((entry, index) => {
      const location = locateInsideRoot(entry.path);
      const isCurrent = location.inside && location.relative === '';
      let shownPath = null; // 応答に載せる相対パス。
      if (location.inside && exposed('paths')) {
        if (location.relative === '') shownPath = '.';
        else if (!hiddenPath(location.relative)) shownPath = showPath(location.relative);
      }
      const branchName = entry.branch && !CONTROL_CHARACTER_PATTERN.test(entry.branch) ? shortRefName(entry.branch) : null;
      const branchShown = branchName !== null && (isCurrent || exposed('branchNames'));
      if (branchName !== null && !branchShown) branchHidden = true;
      return {
        isMain: index === 0,
        isCurrent,
        isInsideProject: location.inside,
        path: shownPath,
        branch: branchShown ? redact(branchName) : null,
        headSha: entry.head && SHA_PATTERN.test(entry.head) ? entry.head : null,
        detached: entry.detached,
        bare: entry.bare,
        locked: entry.locked,
        prunable: entry.prunable,
      };
    });
    if (branchHidden) state.hidden.push('branchNames');
    return worktrees;
  }

  // サブモジュールを ls-files -s のモード 160000 で列挙し、記録されたコミットと状態だけを返す。中では Git を実行しない。失敗したら null。
  function readSubmodules(state, statusEntries) {
    const result = optionalGit(state, ['ls-files', '-s', '-z'], 'サブモジュールの一覧');
    if (!result) return null;
    const byPath = new Map(); // パスごとの { recordedCommit, conflicted }。
    for (const token of result.stdout.split('\0')) {
      if (!token.startsWith(`${SUBMODULE_MODE} `)) continue;
      const tab = token.indexOf('\t');
      if (tab < 0) continue;
      const [, sha, stage] = token.slice(0, tab).split(' ');
      const filePath = token.slice(tab + 1);
      const record = byPath.get(filePath) || { recordedCommit: null, conflicted: false };
      if (stage === '0') record.recordedCommit = SHA_PATTERN.test(sha) ? sha : null;
      else record.conflicted = true;
      byPath.set(filePath, record);
    }
    const changedCommit = new Set(statusEntries.filter(entry => entry.submodule && entry.submodule.charAt(1) === 'C').map(entry => entry.path)); // 記録と違うコミットのサブモジュール。
    const submodules = []; // 応答に載せるサブモジュール。
    for (const [filePath, record] of byPath) {
      if (hiddenPath(filePath)) continue;
      let checkedOut = false; // 中身が取り出されているか（.git の有無だけを見る）。
      try { checkedOut = fs.existsSync(path.join(root, ...filePath.split('/'), '.git')); } catch { checkedOut = false; }
      let submoduleState = 'matchesRecordedCommit';
      if (record.conflicted) submoduleState = 'conflicted';
      else if (!checkedOut) submoduleState = 'notCheckedOut';
      else if (changedCommit.has(filePath)) submoduleState = 'commitChanged';
      submodules.push({ ...(exposed('paths') ? { path: showPath(filePath) } : {}), recordedCommit: record.recordedCommit, state: submoduleState });
    }
    if (submodules.length > 0) addWarning(state, 'サブモジュールの中では Git を実行しないため、サブモジュール内の未コミットの変更は調べていません。');
    return submodules;
  }

  // 進行中の操作（merge・rebase など）を、Git ディレクトリの中の目印のファイルの有無で調べる。失敗したら null。
  function readOperationInProgress(state) {
    const result = optionalGit(state, ['rev-parse', '--absolute-git-dir'], '進行中の操作');
    const gitDirectory = result ? result.stdout.trim() : '';
    if (!gitDirectory) return null;
    // Git ディレクトリの中に目印があるかを返す。
    const has = name => {
      try { return fs.existsSync(path.join(gitDirectory, name)); } catch { return false; }
    };
    if (has('rebase-merge')) return 'rebase';
    if (has('rebase-apply')) return has(path.join('rebase-apply', 'applying')) ? 'am' : 'rebase';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherryPick';
    if (has('REVERT_HEAD')) return 'revert';
    if (has('BISECT_LOG')) return 'bisect';
    return null;
  }

  // 差分の 1 ファイル分を、上限（変更行・1 行の長さ）とマスクを当てた抜粋にする。複数行にまたがる秘密（PEM など）も伏せるため、まとめて redact してから各行にも当てる。
  function buildExcerpt(section) {
    const collected = []; // 上限までの行（hunk の見出しと +/- の行）。
    let changedLines = 0; // 集めた変更行の数。
    let truncated = false; // 何かを省いたか。
    let inHunk = false; // 最初の @@ を過ぎたか。
    for (const line of section.lines) {
      if (line.startsWith('@@')) {
        inHunk = true;
        const marker = /^@@ -[0-9,]+ \+[0-9,]+ @@/.exec(line); // 行番号だけを残し、後ろの関数名（ファイルの内容）は捨てる。
        if (marker) collected.push(marker[0]);
        continue;
      }
      if (!inHunk || !(line.startsWith('+') || line.startsWith('-'))) continue;
      if (changedLines >= PATCH_LIMITS.maxChangedLinesPerFile) { truncated = true; break; }
      changedLines += 1;
      collected.push(line);
    }
    const lines = redact(collected.join('\n')).split('\n').map(line => {
      const masked = redact(line);
      if (masked.length <= PATCH_LIMITS.maxLineLength) return masked;
      truncated = true;
      return `${masked.slice(0, PATCH_LIMITS.maxLineLength)}…`;
    });
    return { lines, truncated };
  }

  // 差分の抜粋の対象にしてよいファイルかを返す（バイナリ・サブモジュール・競合中・非公開・行の変化なしは除く）。
  function isPatchCandidate(entry, conflictedPaths) {
    if (entry.binary || entry.status === 'U' || conflictedPaths.has(entry.path)) return false;
    if (entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE) return false;
    if (hiddenPath(entry.path) || (entry.oldPath && hiddenPath(entry.oldPath))) return false;
    return (entry.insertions || 0) + (entry.deletions || 0) > 0;
  }

  /*
    ステージ済み・未ステージの差分から、上限内の抜粋を作る。Git へは選んだファイルだけをパスで渡し（--literal-pathspecs）、
    出力の区切りから読んだパスが選んだものと一致した区切りだけを使う（選んでいないファイルの内容は出さない）。
  */
  function collectPatches(state, stagedEntries, unstagedEntries, conflictedPaths) {
    const selections = []; // { stage, entry }。
    for (const [stage, entries] of [['staged', stagedEntries], ['unstaged', unstagedEntries]]) {
      for (const entry of entries || []) {
        if (selections.length >= PATCH_LIMITS.maxFiles) break;
        if (isPatchCandidate(entry, conflictedPaths)) selections.push({ stage, entry });
      }
    }
    const patches = []; // 応答に載せる抜粋。
    let usedBytes = 0; // 抜粋の合計バイト数。
    let truncated = false; // 上限のためにファイルを省いたか。
    for (const stage of ['staged', 'unstaged']) {
      const chosen = selections.filter(selection => selection.stage === stage);
      if (chosen.length === 0 || truncated) continue;
      const pathspecs = []; // Git へ渡すパス。名前変更は元と先の両方。
      const byPath = new Map(); // 変更先のパスから項目へ。
      let characters = 0; // パスの合計文字数。
      for (const selection of chosen) {
        const names = [selection.entry.path, ...(selection.entry.oldPath ? [selection.entry.oldPath] : [])];
        const size = names.reduce((sum, name) => sum + name.length + 3, 0);
        if (characters + size > MAX_PATCH_PATHSPEC_CHARACTERS) { truncated = true; break; }
        characters += size;
        pathspecs.push(...names);
        byPath.set(selection.entry.path, selection.entry);
      }
      const result = optionalGit(state, [
        'diff', ...(stage === 'staged' ? ['--cached'] : []), '-p', '-U0', '-M', '--src-prefix=a/', '--dst-prefix=b/',
        '--ignore-submodules=dirty', '--submodule=short', '--', ...pathspecs,
      ], '差分の抜粋');
      if (!result) continue;
      for (const section of splitPatchSections(result.stdout)) {
        const sectionPath = patchSectionPath(section);
        const entry = sectionPath === null ? null : byPath.get(sectionPath);
        if (!entry) continue;
        byPath.delete(sectionPath);
        const excerpt = buildExcerpt(section);
        const record = {
          path: showPath(entry.path),
          stage,
          status: entry.status,
          renamedFrom: entry.oldPath ? showPath(entry.oldPath) : null,
          lines: excerpt.lines,
          truncated: excerpt.truncated,
        };
        const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
        if (usedBytes + size > PATCH_LIMITS.maxTotalBytes) { truncated = true; break; }
        usedBytes += size;
        patches.push(record);
      }
    }
    if (truncated || selections.length >= PATCH_LIMITS.maxFiles) {
      addWarning(state, `差分の抜粋は最大 ${PATCH_LIMITS.maxFiles} ファイル・合計 ${PATCH_LIMITS.maxTotalBytes / 1024} KiB までです。残りのファイルは省きました。`);
    }
    return patches;
  }

  // get_git_branches: ブランチの一覧と、HEAD・比較基準・件数の事実を返す。
  function getBranches(input = {}) {
    return runTool('get_git_branches', 'branches', state => {
      const offset = clampInteger(input?.offset, 'offset', { min: 0, max: MAX_OFFSET, fallback: 0 });
      const limit = clampInteger(input?.limit, 'limit', { min: 1, max: 200, fallback: 50 });
      const includeRemote = readBoolean(input?.includeRemote, 'includeRemote', true);
      const baseGiven = input?.baseBranch !== undefined && input?.baseBranch !== null; // baseBranch が指定されたか。
      if (baseGiven) requireBranchNames('baseBranch の指定');
      const baseText = baseGiven ? validateRefInput(input.baseBranch, 'baseBranch') : null;
      const isShallow = readShallow(state);
      const head = readHead(state);
      const refs = listRefs(state);
      const base = selectBase(state, baseText);
      const listed = refs.branches.filter(ref => includeRemote || ref.kind === 'local'); // 一覧の対象。
      let merged = null; // base に取り込まれた参照の完全な名前。
      let allDistances = null; // %(ahead-behind:) で数えた全ブランチの base との差（使えなければ null）。
      if (base.ref) {
        allDistances = readAheadBehindAll(state, base.ref.sha);
        if (allDistances) {
          merged = new Set([...allDistances].filter(([, distance]) => distance.ahead === 0).map(([fullName]) => fullName)); // base に無いコミットが 0 なら取り込み済み（--merged と同じ）。
        } else {
          const result = optionalGit(state, ['for-each-ref', `--merged=${base.ref.sha}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'], 'base に取り込まれたブランチ');
          if (result) merged = new Set(result.stdout.split('\n').filter(Boolean));
        }
      }
      const others = base.ref ? listed.filter(ref => ref.fullName !== base.ref.fullName) : []; // base 自身を除いた一覧の対象。
      const facts = {
        repository: {
          isShallow,
          hasCommits: head.headSha !== null || refs.branches.length > 0,
          headState: head.headState,
          headSha: head.headSha,
          headShortSha: head.headShortSha,
          headCommittedAt: head.headCommittedAt,
          currentBranch: head.currentBranch === null ? null : redact(head.currentBranch),
        },
        base: base.ref
          ? { ref: exposed('branchNames') ? redact(base.ref.name) : null, kind: base.ref.kind, sha: base.ref.sha, selection: base.selection }
          : { ref: null, kind: null, sha: null, selection: base.selection },
        counts: {
          local: refs.branches.filter(ref => ref.kind === 'local').length,
          remote: refs.branches.filter(ref => ref.kind === 'remote').length,
          mergedIntoBase: merged ? others.filter(ref => merged.has(ref.fullName)).length : null,
          unmergedIntoBase: merged ? others.filter(ref => !merged.has(ref.fullName)).length : null,
        },
      };
      let page = null; // branches のページ情報。
      if (exposed('branchNames')) {
        const sorted = listed.slice().sort((left, right) => {
          if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
          if (left.committedAtMs !== right.committedAtMs) return right.committedAtMs - left.committedAtMs;
          if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1;
          return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
        });
        const paged = paginate(sorted, offset, limit);
        page = paged.page;
        const distances = new Map(); // SHA ごとの base との差。同じコミットの枝は 1 回だけ数える。
        let skipped = 0; // 持ち時間切れか失敗のため数えなかった本数。
        let stopped = false; // 失敗したので以降を数えないか。
        facts.branches = paged.items.map(ref => {
          let distance = null; // base との差。
          if (base.ref) {
            if (allDistances) distance = allDistances.get(ref.fullName) || null;
            else if (distances.has(ref.sha)) distance = distances.get(ref.sha);
            else if (stopped || Date.now() - state.startedAt > LOOP_TIME_BUDGET_MS) skipped += 1;
            else {
              distance = countAheadBehind(state, base.ref.sha, ref.sha, 'base との差');
              if (distance === null) stopped = true;
              distances.set(ref.sha, distance);
            }
          }
          return {
            name: redact(ref.name),
            kind: ref.kind,
            isCurrent: ref.isCurrent,
            sha: ref.sha,
            shortSha: ref.shortSha,
            lastCommitAt: ref.committedAt,
            ...describeUpstream(ref),
            mergedIntoBase: merged ? merged.has(ref.fullName) : null,
            aheadOfBase: distance ? distance.ahead : null,
            behindBase: distance ? distance.behind : null,
            aheadBehindCapped: distance ? distance.capped : false,
          };
        });
        if (skipped > 0) markIncomplete(state, `${skipped} 本のブランチは、時間の上限か取得の失敗のため base との差を数えていません。`);
      } else {
        state.hidden.push('branchNames');
      }
      return { facts, page, limits: { offset, limit, maxCount: COUNT_CAP } };
    });
  }

  // get_branch_details: 1 本のブランチの、base との差・分岐点・変更・直近のコミット・作成日時を返す。
  function getBranchDetails(input = {}) {
    return runTool('get_branch_details', 'changedFiles', state => {
      requireBranchNames('ブランチの詳細');
      const branchText = validateRefInput(input?.branch, 'branch');
      const baseText = input?.baseBranch === undefined || input?.baseBranch === null ? null : validateRefInput(input.baseBranch, 'baseBranch');
      const commitLimit = clampInteger(input?.commitLimit, 'commitLimit', { min: 1, max: 100, fallback: 20 });
      const fileOffset = clampInteger(input?.fileOffset, 'fileOffset', { min: 0, max: MAX_OFFSET, fallback: 0 });
      const fileLimit = clampInteger(input?.fileLimit, 'fileLimit', { min: 1, max: 500, fallback: 100 });
      readShallow(state);
      const target = resolveRef(state, branchText, 'branch');
      const base = selectBase(state, baseText, target.fullName);
      const facts = {
        branch: { ...describeRef(target), lastCommitAt: target.committedAt, isCurrent: target.isCurrent, ...describeUpstream(target) },
        base: base.ref ? { ...describeRef(base.ref), selection: base.selection } : { ref: null, selection: 'none' },
        mergeBase: null,
        ahead: null,
        behind: null,
        aheadBehindCapped: false,
        diffStat: null,
      };
      let changes = null; // 分岐点から branch までの変更。
      if (base.ref) {
        const mergeBase = readMergeBase(state, base.ref.sha, target.sha);
        if (mergeBase?.sha) facts.mergeBase = { sha: mergeBase.sha, committedAt: readCommitDate(state, mergeBase.sha, '分岐点の日時') };
        else if (mergeBase) addWarning(state, 'branch と base に共通の祖先がありません（履歴がつながっていないか、浅い clone で途中までしかありません）。');
        const distance = countAheadBehind(state, base.ref.sha, target.sha, 'base との差');
        if (distance) Object.assign(facts, { ahead: distance.ahead, behind: distance.behind, aheadBehindCapped: distance.capped });
        if (facts.mergeBase) {
          changes = readTreeDiff(state, facts.mergeBase.sha, target.sha, 'ブランチの変更');
          if (changes) facts.diffStat = { range: 'mergeBase..branch', ...summarizeDiff(changes) };
        }
      } else {
        addWarning(state, '比較の基準（base）にできるブランチが見つからないため、base との差・分岐点・変更の集計はありません。baseBranch で指定できます。');
      }
      const commits = readCommits(state, {
        include: [target.sha],
        exclude: base.ref ? [base.ref.sha] : [],
        limit: commitLimit,
        label: '直近のコミット',
      });
      facts.recentCommits = (commits || []).map(describeCommit);
      facts.recentCommitsScope = base.ref ? 'notInBase' : 'all';
      let page = null; // changedFiles のページ情報。
      if (exposed('paths')) {
        if (changes) {
          const described = describeChangedFiles(changes);
          const paged = paginate(described.files, fileOffset, fileLimit);
          facts.changedFiles = paged.items;
          facts.omittedHiddenPaths = described.omitted;
          page = paged.page;
        }
      } else {
        state.hidden.push('paths');
      }
      if (!exposed('commitSubjects')) state.hidden.push('commitSubjects');
      facts.createdAt = readCreation(state, target);
      return {
        facts,
        page,
        inferences: subjectInferences(commits, 'このブランチ'),
        evidence: [
          { type: 'ref', ref: redact(target.name), sha: target.sha },
          ...(base.ref ? [{ type: 'ref', ref: redact(base.ref.name), sha: base.ref.sha }] : []),
          ...(facts.mergeBase ? [{ type: 'commit', sha: facts.mergeBase.sha, role: 'mergeBase' }] : []),
        ],
        limits: { commitLimit, fileOffset, fileLimit, maxCount: COUNT_CAP },
      };
    });
  }

  // compare_branches: 2 本のブランチの差・マージの状態・変更のまとまり・競合の目安を返す。マージは試さない。
  function compareBranches(input = {}) {
    return runTool('compare_branches', 'changedFiles', state => {
      requireBranchNames('ブランチの比較');
      const baseText = validateRefInput(input?.base, 'base');
      const targetText = validateRefInput(input?.target, 'target');
      const commitLimit = clampInteger(input?.commitLimit, 'commitLimit', { min: 1, max: 100, fallback: 20 });
      const fileOffset = clampInteger(input?.fileOffset, 'fileOffset', { min: 0, max: MAX_OFFSET, fallback: 0 });
      const fileLimit = clampInteger(input?.fileLimit, 'fileLimit', { min: 1, max: 500, fallback: 100 });
      readShallow(state);
      const base = resolveRef(state, baseText, 'base');
      const target = resolveRef(state, targetText, 'target');
      const facts = {
        base: describeRef(base),
        target: describeRef(target),
        mergeBase: null,
        unrelatedHistories: false,
        ahead: null,
        behind: null,
        aheadBehindCapped: false,
        mergeState: null,
        diffStat: null,
        areaTotals: null,
        conflictIndicators: null,
      };
      const inferences = []; // 推測。
      let targetChanges = null; // 分岐点から target までの変更。
      if (base.sha === target.sha) {
        Object.assign(facts, { mergeBase: { sha: base.sha, committedAt: base.committedAt }, ahead: 0, behind: 0, mergeState: 'identical' });
        targetChanges = [];
      } else {
        const mergeBase = readMergeBase(state, base.sha, target.sha);
        if (mergeBase?.sha) facts.mergeBase = { sha: mergeBase.sha, committedAt: readCommitDate(state, mergeBase.sha, '分岐点の日時') };
        else if (mergeBase) facts.unrelatedHistories = true;
        const distance = countAheadBehind(state, base.sha, target.sha, 'base との差');
        if (distance) Object.assign(facts, { ahead: distance.ahead, behind: distance.behind, aheadBehindCapped: distance.capped });
        const targetInBase = isAncestor(state, target.sha, base.sha);
        const baseInTarget = targetInBase === false ? isAncestor(state, base.sha, target.sha) : null;
        if (targetInBase === true) facts.mergeState = 'targetMergedIntoBase';
        else if (baseInTarget === true) facts.mergeState = 'fastForwardPossible';
        else if (targetInBase === false && baseInTarget === false) facts.mergeState = 'diverged';
        if (facts.mergeBase) targetChanges = readTreeDiff(state, facts.mergeBase.sha, target.sha, 'target 側の変更');
        if (facts.unrelatedHistories) addWarning(state, 'base と target に共通の祖先がありません（履歴がつながっていないか、浅い clone で途中までしかありません）。');
      }
      if (targetChanges) {
        facts.diffStat = { range: 'mergeBase..target', ...summarizeDiff(targetChanges) };
        const totals = { added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 };
        const areas = new Map(); // 先頭ディレクトリごとの件数（公開してよいファイルだけ）。
        for (const entry of targetChanges) {
          const category = changeCategory(entry.status);
          totals[category] += 1;
          if (hiddenPath(entry.path) || (entry.oldPath && hiddenPath(entry.oldPath))) continue;
          const area = areaOf(entry.path);
          const counts = areas.get(area) || { area: showPath(area), files: 0, added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 };
          counts.files += 1;
          counts[category] += 1;
          areas.set(area, counts);
        }
        facts.areaTotals = totals;
        if (exposed('paths')) facts.areas = [...areas.values()].sort((left, right) => right.files - left.files || (left.area < right.area ? -1 : 1));
      }
      if (facts.mergeBase && targetChanges && facts.mergeState !== 'identical') {
        const baseChanges = readTreeDiff(state, facts.mergeBase.sha, base.sha, 'base 側の変更', false);
        if (baseChanges) {
          const touched = entries => new Set(entries.flatMap(entry => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])])); // 変更に関わったパス（名前変更は元と先）。
          const targetPaths = touched(targetChanges);
          const overlapping = [...touched(baseChanges)].filter(filePath => targetPaths.has(filePath)).sort();
          const visible = overlapping.filter(filePath => !hiddenPath(filePath));
          facts.conflictIndicators = {
            heuristic: true,
            note: CONFLICT_HEURISTIC_NOTE,
            overlappingFileCount: overlapping.length,
            ...(exposed('paths') ? { overlappingFiles: visible.slice(0, MAX_OVERLAPPING_FILES).map(showPath), overlappingFilesTruncated: visible.length > MAX_OVERLAPPING_FILES } : {}),
          };
          if (overlapping.length > 0) {
            inferences.push({
              claim: `分岐点から両側で同じファイル（${overlapping.length} 件）が変更されているため、マージ時に競合する可能性があります（未確認）。`,
              basis: '変更されたファイルの名前の重なりだけで判断しています。実際のマージは試していません。',
              confidence: 'low',
              evidence: [{ type: 'commit', sha: facts.mergeBase.sha, role: 'mergeBase' }],
            });
          }
        }
      }
      const commits = facts.mergeState === 'identical' ? [] : readCommits(state, { include: [target.sha], exclude: [base.sha], limit: commitLimit, label: 'target 側のコミット' });
      facts.commits = (commits || []).map(describeCommit);
      let page = null; // changedFiles のページ情報。
      if (exposed('paths')) {
        if (targetChanges) {
          const described = describeChangedFiles(targetChanges);
          const paged = paginate(described.files, fileOffset, fileLimit);
          facts.changedFiles = paged.items;
          facts.omittedHiddenPaths = described.omitted;
          page = paged.page;
        }
      } else {
        state.hidden.push('paths');
      }
      if (!exposed('commitSubjects')) state.hidden.push('commitSubjects');
      return {
        facts,
        page,
        inferences: [...subjectInferences(commits, 'target 側'), ...inferences],
        evidence: [
          { type: 'ref', ref: redact(base.name), sha: base.sha, role: 'base' },
          { type: 'ref', ref: redact(target.name), sha: target.sha, role: 'target' },
        ],
        limits: { commitLimit, fileOffset, fileLimit, maxCount: COUNT_CAP, maxOverlappingFiles: MAX_OVERLAPPING_FILES },
      };
    });
  }

  // get_worktree_details: 作業ツリーの変更・差分の集計・worktree・サブモジュール・差分の抜粋を返す。
  function getWorktreeDetails(input = {}) {
    return runTool('get_worktree_details', 'files', state => {
      const offset = clampInteger(input?.offset, 'offset', { min: 0, max: MAX_OFFSET, fallback: 0 });
      const limit = clampInteger(input?.limit, 'limit', { min: 1, max: 500, fallback: 100 });
      const category = input?.category === undefined || input?.category === null ? 'all' : input.category;
      if (typeof category !== 'string' || !WORKTREE_CATEGORIES.has(category)) {
        throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `category は ${[...WORKTREE_CATEGORIES].join('・')} のどれかで指定してください。`);
      }
      const includeUntracked = readBoolean(input?.includeUntracked, 'includeUntracked', true);
      const status = readStatus(state, { includeUntracked });
      const stagedEntries = readWorktreeDiff(state, true);
      const unstagedEntries = readWorktreeDiff(state, false);
      // 1 つの差分の一覧から、パスごとの行数を引けるようにする。
      const statsByPath = entries => new Map((entries || []).map(entry => [entry.path, entry]));
      const stagedStats = statsByPath(stagedEntries);
      const unstagedStats = statsByPath(unstagedEntries);
      const facts = {
        counts: countStatus(status.entries),
        operationInProgress: readOperationInProgress(state),
        diffStat: {
          staged: stagedEntries ? summarizeDiff(stagedEntries) : null,
          unstaged: unstagedEntries ? summarizeDiff(unstagedEntries) : null,
        },
      };
      let page = null; // files のページ情報。
      if (exposed('paths')) {
        // カテゴリに当てはまる項目かを返す。
        const matches = (entry, kind) => {
          if (category === 'all') return true;
          if (category === 'staged') return kind === 'staged' || kind === 'both';
          if (category === 'unstaged') return kind === 'unstaged' || kind === 'both';
          if (category === 'deleted') return kind !== 'conflicted' && (entry.indexStatus === 'D' || entry.worktreeStatus === 'D');
          if (category === 'renamed') return entry.indexStatus === 'R' || entry.worktreeStatus === 'R';
          return kind === category;
        };
        const files = []; // 応答に載せる変更ファイル。
        let omitted = 0; // 非公開のため除いた件数。
        for (const entry of status.entries) {
          if (hiddenPath(entry.path) || (entry.originalPath && hiddenPath(entry.originalPath))) { omitted += 1; continue; }
          const kind = entryKind(entry);
          if (!matches(entry, kind)) continue;
          const staged = stagedStats.get(entry.path);
          const unstaged = unstagedStats.get(entry.path);
          const binary = Boolean(staged?.binary || unstaged?.binary);
          const known = (staged && !staged.binary) || (unstaged && !unstaged.binary);
          files.push({
            path: showPath(entry.path),
            kind,
            indexStatus: entry.indexStatus,
            worktreeStatus: entry.worktreeStatus,
            renamedFrom: entry.originalPath ? showPath(entry.originalPath) : null,
            insertions: known && !binary ? (staged?.insertions || 0) + (unstaged?.insertions || 0) : null,
            deletions: known && !binary ? (staged?.deletions || 0) + (unstaged?.deletions || 0) : null,
            submodule: entry.submodule !== null,
          });
        }
        const paged = paginate(files, offset, limit);
        facts.files = paged.items;
        facts.omittedHiddenPaths = omitted;
        page = paged.page;
      } else {
        state.hidden.push('paths');
      }
      facts.worktrees = readWorktrees(state);
      facts.submodules = readSubmodules(state, status.entries);
      if (exposed('diffExcerpts') && exposed('paths')) {
        const conflictedPaths = new Set(status.entries.filter(entry => entry.type === 'unmerged').map(entry => entry.path));
        facts.patches = collectPatches(state, stagedEntries, unstagedEntries, conflictedPaths);
      } else if (!exposed('diffExcerpts')) {
        state.hidden.push('diffExcerpts');
      }
      if (!includeUntracked) addWarning(state, 'includeUntracked が false のため、未追跡のファイルは数えていません。');
      return { facts, page, limits: { offset, limit, category, includeUntracked, ...PATCH_LIMITS } };
    });
  }

  // get_recent_activity: 期間内のコミット・日ごとの件数・変更されたまとまり・未コミットの作業の手がかりを返す。
  function getRecentActivity(input = {}) {
    return runTool('get_recent_activity', 'recentCommits', state => {
      const days = clampInteger(input?.days, 'days', { min: 1, max: 365, fallback: 14 });
      const limit = clampInteger(input?.limit, 'limit', { min: 1, max: 200, fallback: 50 });
      const nowMs = Date.now(); // 期間の終わり。
      const sinceMs = nowMs - days * DAY_MS; // 期間の始まり。
      const sinceSeconds = Math.floor(sinceMs / 1000);
      const probeLines = requireGit(['rev-parse', '--is-shallow-repository', '--branches']).stdout.split('\n').filter(Boolean); // 浅い clone かと、ローカルブランチの SHA を 1 回で読む。
      if (probeLines[0] === 'true') addWarning(state, SHALLOW_WARNING);
      const hasBranches = probeLines.length > 1; // ローカルブランチが 1 本以上あるか。
      const { detached } = readSymbolicHead();
      const pseudoRefs = hasBranches ? ['--branches'] : []; // 対象はローカルブランチ全部と HEAD（ブランチ上の HEAD は --branches に含まれる）。
      const include = detached ? ['HEAD'] : [];
      const hasHistory = hasBranches || detached; // コミットが 1 つでもありうるか（初回コミット前でブランチも無ければ log を呼ばない）。
      let lastCommitAt = null; // 対象の中で最も新しいコミットの日時。
      let windowCommits = []; // 期間内のコミット。
      let changedPaths = null; // 期間内に変更されたファイル。
      if (hasHistory) {
        windowCommits = readCommits(state, { include, limit: COUNT_CAP + 1, sinceSeconds, pseudoRefs, label: '期間内のコミット' }) || [];
        const newestInWindow = windowCommits.reduce((newest, commit) => (!newest || commit.committedAtMs > newest.committedAtMs ? commit : newest), null);
        if (newestInWindow) {
          lastCommitAt = newestInWindow.committedAt; // 期間外のコミットは期間内のものより古いので、期間内の最大が全体の最新。
        } else {
          const newest = optionalGit(state, ['log', '-1', '--format=%cI', ...pseudoRefs, '--end-of-options', ...include, '--'], '最後のコミットの日時');
          lastCommitAt = newest ? newest.stdout.trim() || null : null;
        }
        const names = optionalGit(state, [
          'log', '-z', '--format=', '--name-only', '--no-renames', '--no-merges', `--since=@${sinceSeconds} +0000`, `--max-count=${COUNT_CAP + 1}`,
          ...pseudoRefs, '--end-of-options', ...include, '--',
        ], '期間内に変更されたファイル');
        if (names) changedPaths = [...new Set(names.stdout.split('\0').filter(Boolean))];
      }
      const capped = windowCommits.length > COUNT_CAP;
      if (capped) windowCommits = windowCommits.slice(0, COUNT_CAP);
      const perDay = new Map(); // ローカル日付ごとのコミット数。
      for (const commit of windowCommits) {
        if (!Number.isFinite(commit.committedAtMs)) continue;
        const key = localDateKey(new Date(commit.committedAtMs));
        perDay.set(key, (perDay.get(key) || 0) + 1);
      }
      const daily = []; // 期間内の全日の件数。
      const cursor = new Date(sinceMs);
      cursor.setHours(0, 0, 0, 0);
      while (cursor.getTime() <= nowMs) {
        const key = localDateKey(cursor);
        daily.push({ date: key, commits: perDay.get(key) || 0 });
        cursor.setDate(cursor.getDate() + 1);
      }
      const facts = {
        scope: 'localBranchesAndHead',
        windowDays: days,
        since: new Date(sinceMs).toISOString(),
        lastCommitAt,
        commitsInWindow: windowCommits.length,
        commitsInWindowCapped: capped,
        daily,
        recentCommits: windowCommits.slice(0, limit).map(describeCommit),
        changedFileCount: changedPaths ? changedPaths.length : null,
      };
      if (exposed('paths')) {
        if (changedPaths) {
          const areas = new Map(); // 先頭ディレクトリごとのファイル数（公開してよいファイルだけ）。
          for (const filePath of changedPaths) {
            if (hiddenPath(filePath)) continue;
            const area = areaOf(filePath);
            areas.set(area, (areas.get(area) || 0) + 1);
          }
          facts.changedAreas = [...areas.entries()].map(([area, files]) => ({ area: showPath(area), files })).sort((left, right) => right.files - left.files || (left.area < right.area ? -1 : 1));
        }
      } else {
        state.hidden.push('paths');
      }
      if (!exposed('commitSubjects')) state.hidden.push('commitSubjects');
      const status = readStatus(state, { required: false });
      let newestMs = null; // 変更ファイルの更新日時の最大（非公開のパスは見ない）。
      if (status) {
        for (const entry of status.entries.slice(0, MAX_MTIME_ENTRIES)) {
          if (entry.worktreeStatus === 'D' || hiddenPath(entry.path)) continue;
          try {
            const modifiedMs = fs.lstatSync(path.join(root, ...entry.path.replace(/\/+$/, '').split('/'))).mtimeMs;
            if (newestMs === null || modifiedMs > newestMs) newestMs = modifiedMs;
          } catch { /* 消えたファイルは読み飛ばす。 */ }
        }
      }
      facts.uncommitted = {
        count: status ? status.entries.length : null,
        newestChangedFileModifiedAt: newestMs === null ? null : new Date(newestMs).toISOString(),
      };
      if (newestMs !== null) addWarning(state, MTIME_WARNING);
      const inferences = []; // 推測。
      if (windowCommits.length === 0) {
        const uncommittedCount = facts.uncommitted.count || 0;
        inferences.push({
          claim: uncommittedCount > 0
            ? `直近 ${days} 日にコミットはありませんが、未コミットの変更が ${uncommittedCount} 件あるため、コミットされていない作業が進んでいる可能性があります（作業日は未確認）。`
            : `直近 ${days} 日にコミットはありません。ただし、コミットされていない作業や Git の外での作業が無いとは言い切れません。`,
          basis: 'コミット履歴と git status の件数だけから判断しています。',
          confidence: 'low',
          evidence: [],
        });
      }
      return { facts, inferences, limits: { days, limit, maxCount: COUNT_CAP } };
    });
  }

  // ---------- get_git_diff（2.6.0） ----------

  // 差分を返す権限（sourceText・paths・diffExcerpts）が揃っていなければ、Git を実行する前に拒否する。
  function requireDiffExposure() {
    const missing = ['sourceText', 'paths', 'diffExcerpts'].filter(key => !exposed(key)); // 許可されていない権限。
    if (missing.length > 0) {
      throw new BridgeToolError(ERROR_CLASS.PERMISSION_DENIED, '差分の本文を返すには、detailExposure.sourceText・gitExposure.paths・detailExposure.diffExcerpts の許可が必要です。', { hidden: missing });
    }
  }

  // 差分の対象にするパス（プロジェクト相対。サブモジュールのときはそのルートからの相対）を検証する。glob としては解釈しない（--literal-pathspecs）。
  function normalizeDiffPaths(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > DIFF_MAX_PATHS) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `paths は文字列の配列（最大 ${DIFF_MAX_PATHS} 件）で指定してください。`);
    const prefix = displayPrefix ? `${displayPrefix}/` : ''; // サブモジュールのとき、プロジェクト相対で渡されたパスから外す接頭辞。
    return [...new Set(value.map(item => {
      if (typeof item !== 'string' || item.trim() === '' || item.length > 260 || CONTROL_CHARACTER_PATTERN.test(item)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'paths の要素は空でない文字列で指定してください。');
      let raw = item.trim().replace(/\\/g, '/').replace(/^\.\//, ''); // 区切りを揃えたパス。
      if (prefix && raw.startsWith(prefix)) raw = raw.slice(prefix.length);
      if (raw === '' || raw.startsWith('/') || raw.startsWith(':') || /^[A-Za-z]:/.test(raw)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'paths にはプロジェクト相対のパスを指定してください（絶対パスは使えません）。');
      const normalized = path.posix.normalize(raw).replace(/\/+$/, ''); // 正規化したパス。
      if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'paths に .. は使えません。');
      return normalized;
    }))];
  }

  // since の日時を、Unix 秒にする。日付だけ（2026-10-24）はこのマシンのローカル時刻の 0 時。時刻だけで時差が無いものもローカル時刻。
  function parseSinceSeconds(value) {
    const text = requireString(value, 'since', { maxLength: 64 }).trim(); // 指定された日時。
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text); // 日付だけの指定。
    const milliseconds = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime() : Date.parse(text); // 指定の時刻（ミリ秒）。
    if (!Number.isFinite(milliseconds)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'since は ISO 8601 の日付か日時で指定してください（例: 2026-10-24、2026-10-24T09:00:00+09:00）。');
    return Math.floor(milliseconds / 1000);
  }

  /*
    base・target に指定された値を、実在するコミットにする。7〜64 桁の 16 進数はコミットの SHA として確かめ（rev-parse --verify --end-of-options）、
    そうでなければブランチ名として列挙した実在の参照と照合する（detailExposure.branchNames が必要）。任意のリビジョン式は受け付けない。
    戻り値: { sha, shortSha, ref（ブランチ名のときだけ）, kind: 'commit' | 'local' | 'remote' }
  */
  function resolveCommitish(state, value, name) {
    const text = validateRefInput(value, name); // 指定された値。
    const looksLikeSha = /^[0-9a-f]{7,64}$/i.test(text); // SHA らしい形か。
    if (looksLikeSha) {
      const verified = runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${text.toLowerCase()}^{commit}`], { okExitCodes: [0, 1] });
      if (!verified.ok) throw new GitStepFailure(verified.errorClass);
      const sha = verified.exitCode === 0 ? verified.stdout.trim() : ''; // 完全な SHA。
      if (SHA_PATTERN.test(sha)) return { sha, shortSha: sha.slice(0, 7), ref: null, kind: 'commit' };
    }
    if (!exposed('branchNames')) {
      if (looksLikeSha) throw new BridgeToolError(ERROR_CLASS.REF_NOT_FOUND, `${name} に指定したコミットが見つかりません。`);
      throw new BridgeToolError(ERROR_CLASS.PERMISSION_DENIED, `${name} をブランチ名で指定するには、ブランチ名の公開（detailExposure.branchNames）が許可されている必要があります。コミットの SHA（7〜64 桁）なら指定できます。`, { hidden: ['branchNames'] });
    }
    const ref = resolveRef(state, text, name); // 実在のブランチ。
    return { sha: ref.sha, shortSha: ref.shortSha, ref: redact(ref.name), kind: ref.kind };
  }

  // 差分ツールの cursor（ページの位置と、差分の内容の識別子）を作る・読む。識別子が変わったら、続きではなく取得し直しを求める。
  function encodeDiffCursor(offset, diffId) {
    return Buffer.from(JSON.stringify({ k: 'diff', o: offset, d: diffId }), 'utf8').toString('base64url');
  }

  function decodeDiffCursor(text) {
    let payload; // 読んだ内容。
    try {
      if (typeof text !== 'string' || text === '' || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('bad');
      payload = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    } catch {
      throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor が正しくありません。前回の応答の page.nextCursor をそのまま渡してください。');
    }
    if (!payload || payload.k !== 'diff' || !Number.isInteger(payload.o) || payload.o < 0 || typeof payload.d !== 'string') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'cursor がこのツールのものではありません。');
    return payload;
  }

  /*
    差分の 1 ファイル分（splitPatchSections の区切り）を、行ごとに秘密値をマスクした「統一差分の行」と、変更範囲の一覧にする。
    引数: section、io（bridge-source-io.mjs）
    戻り値: { lines（@@ の見出し行と、空白・+・-・\ で始まる本文の行。マスク・長い行の切り詰め済み）、hunks（[{ oldStart, oldLines, newStart, newLines }]）、secret（追加行が秘密ファイルらしいか）}
  */
  function parsePatchSection(section, io) {
    const masker = io.createLineMasker(redact); // 行ごとのマスク（PEM の秘密鍵ブロックは行ごとに置換する）。
    const lines = []; // 出力する行。
    const hunks = []; // 変更範囲。
    const addedText = []; // 追加行の本文（秘密ファイルらしさの判定用）。
    let inHunk = false; // 最初の @@ を過ぎたか。
    for (const line of section.lines) {
      if (line.startsWith('@@')) {
        inHunk = true;
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line); // 変更範囲の見出し。
        if (header) {
          hunks.push({ oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]) });
          const context = line.slice(header[0].length).trim(); // 見出しの後ろの関数名など（ファイルの内容）。
          lines.push(context ? `${header[0]} ${io.clipLine(masker.mask(context), 120).text}` : header[0]);
        } else {
          lines.push('@@');
        }
        continue;
      }
      if (!inHunk) continue;
      const marker = line.charAt(0); // 行の種類（空白・+・-・\）。
      if (line === '' ) continue; // 出力の最後の空の断片。
      if (marker === '\\') { lines.push(line); continue; }
      if (marker !== ' ' && marker !== '+' && marker !== '-') continue;
      const body = line.slice(1); // 行の本文。
      if (marker === '+') addedText.push(body);
      lines.push(marker + io.clipLine(masker.mask(body), DIFF_MAX_LINE_CHARS).text);
    }
    return { lines, hunks, secret: io.detectSecretContent(addedText.join('\n')) };
  }

  // get_git_diff の本体。
  function buildDiff(state, input, io) {
    const mode = input.mode === undefined || input.mode === null ? 'head' : input.mode; // 差分の種類。
    if (!DIFF_MODES.includes(mode)) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, `mode は ${DIFF_MODES.join(' / ')} のどれかで指定してください。`);
    const contextLines = clampInteger(input.contextLines, 'contextLines', { min: 0, max: 20, fallback: 3 }); // 前後の行数。
    const filesPerPage = clampInteger(input.filesPerPage, 'filesPerPage', { min: 1, max: 50, fallback: 10 }); // 1 ページのファイル数。
    const maxLinesPerFile = clampInteger(input.maxLinesPerFile, 'maxLinesPerFile', { min: 10, max: 2000, fallback: 400 }); // 1 ファイルの差分の最大行数。
    const lineOffset = clampInteger(input.lineOffset, 'lineOffset', { min: 0, max: 100000000, fallback: 0 }); // 1 ファイルの差分の読み始める行。
    const pathspecs = normalizeDiffPaths(input.paths); // 対象のパス。
    const given = key => input[key] !== undefined && input[key] !== null && input[key] !== ''; // 引数が指定されたか。
    if (mode !== 'range' && (given('base') || given('target') || given('since'))) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'base・target・since は mode: range のときだけ指定できます。');
    if (mode === 'range') {
      if (given('since') && given('base')) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'since と base は同時に指定できません。');
      if (!given('since') && !given('base')) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'mode: range には base か since を指定してください。');
    }
    const sinceSeconds = given('since') ? parseSinceSeconds(input.since) : null; // since の Unix 秒。
    const cursor = given('cursor') ? decodeDiffCursor(input.cursor) : null; // 続きの位置。
    // HEAD のコミット（Git の呼び出しを増やさないよう、ブランチの一覧は読まず 1 回で確かめる）。無ければ（初回コミット前）終了コード 1。
    const headProbe = requireGit(['rev-parse', '--verify', '-q', 'HEAD'], { okExitCodes: [0, 1] });
    const headSha = headProbe.exitCode === 0 && SHA_PATTERN.test(headProbe.stdout.trim()) ? headProbe.stdout.trim() : null; // HEAD の SHA。
    const unborn = headSha === null; // 初回コミット前か。
    let base = null; // 比較元のコミット。
    let target = null; // 比較先のコミット。
    let flags = []; // 差分の種類を表すオプション。
    let revisions = []; // 比較するコミット。
    if (mode === 'range') {
      if (unborn) throw new BridgeToolError(ERROR_CLASS.REF_NOT_FOUND, 'HEAD にコミットが無いため、range の差分は取得できません。');
      if (sinceSeconds !== null) {
        const found = requireGit(['rev-list', '-1', `--before=@${sinceSeconds} +0000`, '--end-of-options', 'HEAD', '--']).stdout.trim(); // since 以前の最後のコミット。
        if (!SHA_PATTERN.test(found)) throw new BridgeToolError(ERROR_CLASS.REF_NOT_FOUND, 'since 以前のコミットが HEAD の履歴にありません。');
        base = { sha: found, shortSha: found.slice(0, 7), ref: null, kind: 'commit', selection: 'lastCommitBeforeSince' };
      } else {
        base = { ...resolveCommitish(state, input.base, 'base'), selection: 'explicit' };
      }
      target = given('target') ? resolveCommitish(state, input.target, 'target') : { sha: headSha, shortSha: headSha.slice(0, 7), ref: null, kind: 'commit' };
      revisions = [base.sha, target.sha];
    } else if (mode === 'head') {
      if (unborn) { flags = ['--cached']; addWarning(state, 'HEAD にコミットが無いため、ステージ済みの内容を（空の状態との差として）返しています。'); } else { revisions = ['HEAD']; }
    } else if (mode === 'staged') {
      flags = ['--cached'];
    }
    const statArgs = ['diff', ...flags, '--raw', '--numstat', '-z', '-M', '--ignore-submodules=dirty', '--end-of-options', ...revisions, '--', ...pathspecs]; // 変更の一覧を取る Git の引数。
    const parsed = parseRawNumstat(requireGit(statArgs).stdout); // 変更の一覧。
    if (parsed.anomalies > 0) addWarning(state, `変更の一覧のうち ${parsed.anomalies} 項目は、形式が想定と違うため読み飛ばしました。`);
    const visible = []; // 公開してよい変更。
    let omittedHiddenPaths = 0; // 非公開のため除いた件数。
    for (const entry of parsed.entries) {
      if (hiddenSource(entry.path) || (entry.oldPath && hiddenSource(entry.oldPath))) { omittedHiddenPaths += 1; continue; }
      visible.push(entry);
    }
    const totals = summarizeDiff(visible); // 公開してよい変更の合計。
    const diffId = crypto.createHash('sha256').update(JSON.stringify([mode, base && base.sha, target && target.sha, pathspecs, visible.map(entry => [entry.path, entry.status, entry.insertions, entry.deletions])])).digest('hex').slice(0, 16); // 差分の内容の識別子。
    if (cursor && cursor.d !== diffId) throw new BridgeToolError(ERROR_CLASS.STALE_CURSOR, '前回の取得から差分が変わったため、cursor では続きを取得できません。最初から取得し直してください。');
    const offset = cursor ? cursor.o : 0; // このページの先頭の位置。
    const pageEntries = visible.slice(offset, offset + filesPerPage); // このページの変更。
    if (lineOffset > 0 && pageEntries.length !== 1) throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'lineOffset は 1 ファイルの差分に対してだけ使えます（paths でファイルを 1 つに絞ってください）。');
    const files = []; // 応答に載せるファイル。
    const pending = []; // 差分の本文を取得するファイル { entry, record }。
    for (const entry of pageEntries) {
      const isSubmodule = entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE; // サブモジュールの項目か。
      const record = {
        path: showDiffPath(entry.path),
        oldPath: entry.oldPath ? showDiffPath(entry.oldPath) : null,
        status: entry.status,
        additions: entry.insertions,
        deletions: entry.deletions,
        binary: entry.binary === true,
        submodule: isSubmodule,
      }; // ファイル 1 件の記録。
      files.push(record);
      if (record.binary) { record.withheld = 'binary'; continue; }
      if (isSubmodule) { record.withheld = 'submodule'; continue; }
      if (entry.status === 'U') { record.withheld = 'conflicted'; continue; }
      if (!((entry.insertions || 0) + (entry.deletions || 0) > 0)) { record.hunks = []; record.patch = ''; continue; } // 行の変化が無い（名前変更・モードの変更だけ）。
      pending.push({ entry, record });
    }
    // 差分の本文は、ページ内のファイルをまとめて 1 回の Git で取る（Git の呼び出しは遅い環境があるため）。まとめて失敗したら、ファイルごとに取り直す。
    const diffArguments = names => ['diff', ...flags, '-p', `-U${contextLines}`, '-M', '--src-prefix=a/', '--dst-prefix=b/', '--ignore-submodules=dirty', '--submodule=short', '--end-of-options', ...revisions, '--', ...names]; // 本文を取る Git の引数。
    const sectionByPath = new Map(); // 変更先のパスから、差分の区切りへ。
    const namesOf = entry => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]; // Git へ渡すパス（名前変更は元と先の両方）。
    if (pending.length > 1) {
      const allNames = pending.flatMap(item => namesOf(item.entry)); // まとめて渡すパス。
      if (allNames.reduce((sum, name) => sum + name.length + 3, 0) <= MAX_PATCH_PATHSPEC_CHARACTERS) {
        const batch = runGit(diffArguments(allNames)); // まとめて取った差分。
        if (batch.ok) {
          for (const section of splitPatchSections(batch.stdout)) {
            const sectionPath = patchSectionPath(section); // 区切りの変更先のパス。
            if (sectionPath !== null && !sectionByPath.has(sectionPath)) sectionByPath.set(sectionPath, section);
          }
        }
      }
    }
    for (const { entry, record } of pending) {
      let section = sectionByPath.get(entry.path) || null; // このファイルの区切り。
      if (!section) {
        const fetched = optionalGit(state, diffArguments(namesOf(entry)), '差分の本文'); // このファイルだけの差分。
        if (fetched) section = splitPatchSections(fetched.stdout).find(candidate => patchSectionPath(candidate) === entry.path) || null;
      }
      if (!section) { record.withheld = 'unavailable'; continue; }
      const patch = parsePatchSection(section, io); // マスク済みの差分の行と変更範囲。
      if (patch.secret) { record.withheld = 'secret'; continue; }
      record.hunks = patch.hunks.slice(0, 200);
      record.totalPatchLines = patch.lines.length;
      let end = lineOffset; // 返す最後の行の次の位置。
      let bytes = 0; // 返す差分のバイト数。
      while (end < patch.lines.length && end - lineOffset < maxLinesPerFile && bytes + patch.lines[end].length + 1 <= DIFF_MAX_BYTES_PER_FILE) {
        bytes += Buffer.byteLength(patch.lines[end], 'utf8') + 1;
        end += 1;
      }
      if (end === lineOffset && lineOffset < patch.lines.length) end += 1; // 1 行が大きくても、最低 1 行は進める。
      record.patch = patch.lines.slice(lineOffset, end).join('\n');
      record.truncated = end < patch.lines.length;
      record.nextLineOffset = end < patch.lines.length ? end : null;
      if (lineOffset > 0) record.startLineOffset = lineOffset;
      if (record.truncated) markIncomplete(state, '一部のファイルの差分は、行数・大きさの上限（maxLinesPerFile）のため途中までです。files[].nextLineOffset を lineOffset に渡す（paths でそのファイルだけを指定する）と続きを取得できます。');
    }
    if (files.some(file => file.withheld === 'unavailable')) markIncomplete(state, '一部のファイルの差分を取得できませんでした（時間・出力の上限など）。paths で絞って取得し直してください。');
    // 応答の大きさに収まるよう、ページの後ろのファイルを次のページへ回す（cursor の位置を、残した最後のファイルの次へ戻す）。
    let kept = files.length; // 残すファイル数。
    while (kept > 1 && Buffer.byteLength(JSON.stringify(files.slice(0, kept)), 'utf8') > DIFF_PAGE_BUDGET_BYTES) kept = Math.max(1, Math.floor(kept * 0.75));
    if (kept < files.length) addWarning(state, '応答の大きさの上限のため、このページの後ろのファイルを次のページへ回しました。page.nextCursor で続きを取得してください。');
    const returnedFiles = files.slice(0, kept); // 応答に載せるファイル。
    const nextOffset = offset + kept; // 次のページの先頭の位置。
    const hasMore = nextOffset < visible.length; // 続きがあるか。
    let untracked = null; // 未追跡ファイル（本文は無い）。
    if ((mode === 'head' || mode === 'unstaged') && offset === 0) {
      const status = optionalGit(state, ['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'], '未追跡ファイルの一覧'); // 作業ツリーの状態。
      if (status) {
        const matchesPaths = candidate => pathspecs.length === 0 || pathspecs.some(spec => candidate === spec || candidate.startsWith(`${spec}/`) || spec.startsWith(`${candidate.replace(/\/+$/, '')}/`)); // paths に当たるか。
        const names = parseStatusV2(status.stdout).entries.filter(entry => entry.type === 'untracked' && matchesPaths(entry.path) && !hiddenSource(entry.path)).map(entry => showDiffPath(entry.path)); // 公開してよい未追跡のパス。
        untracked = { count: names.length, files: names.slice(0, DIFF_MAX_UNTRACKED), truncated: names.length > DIFF_MAX_UNTRACKED, note: '未追跡ファイルは差分を持たないため、名前だけです。本文は read_source で読めます。' };
      }
    }
    return {
      facts: {
        mode,
        ...(displayPrefix ? { submodule: displayPrefix } : {}),
        base: base ? { sha: base.sha, shortSha: base.shortSha, ref: base.ref, selection: base.selection } : null,
        target: target ? { sha: target.sha, shortSha: target.shortSha, ref: target.ref } : null,
        since: sinceSeconds === null ? null : new Date(sinceSeconds * 1000).toISOString(),
        paths: pathspecs.length > 0 ? pathspecs.map(showDiffPath) : null,
        totals: { ...totals, omittedHiddenPaths },
        files: returnedFiles,
        ...(untracked ? { untracked } : {}),
        diffId,
      },
      page: { offset, limit: filesPerPage, returned: returnedFiles.length, total: visible.length, nextOffset: hasMore ? nextOffset : null, nextCursor: hasMore ? encodeDiffCursor(nextOffset, diffId) : null },
      limits: { maxFilesPerPage: 50, maxLinesPerFile: 2000, maxBytesPerFile: DIFF_MAX_BYTES_PER_FILE, maxContextLines: 20, maxPaths: DIFF_MAX_PATHS },
    };
  }

  // サブモジュールの中の差分。サブモジュールの .git/config を、親とは別に検査してから、そのルートで Git を実行する読み取り層に任せる。
  function getSubmoduleDiff(input) {
    if (typeof options.resolveSubmodule !== 'function') throw new BridgeToolError(ERROR_CLASS.INVALID_ARGUMENT, 'この呼び出しでは submodule を指定できません。');
    const nestedOptions = options.resolveSubmodule(input.submodule); // サブモジュールの中で Git を実行するための設定（検証済み）。
    const nested = createGitReader(nestedOptions); // サブモジュール用の読み取り層。
    return nested.getDiff({ ...input, submodule: undefined });
  }

  // get_git_diff: 差分を、変更前後の行と変更範囲つきで、ファイルごとに分割して返す。読み取り専用（許可リストの diff・rev-parse・rev-list・status だけを使う）。
  async function getDiff(input = {}) {
    requireDiffExposure();
    if (input.submodule !== undefined && input.submodule !== null) return getSubmoduleDiff(input);
    let io; // 秘密値のマスクなどの部品（bridge-source-io.mjs）。呼ばれたときだけ読み込む。
    try {
      io = await import('./bridge-source-io.mjs');
    } catch {
      throw new BridgeToolError(ERROR_CLASS.INTERNAL, 'この機能のモジュール（bridge-source-io.mjs）を読み込めませんでした。導入が不完全か、ファイルが壊れている可能性があります。');
    }
    return runTool('get_git_diff', null, state => buildDiff(state, input, io));
  }

  // 全プロジェクト横断サマリー用の軽量情報を返す（Git 呼び出しは 3 回以内）。応答の envelope ではなく普通のオブジェクト。
  function getSummary() {
    const collectedAt = new Date().toISOString(); // 取得日時。
    const unavailable = errorClass => ({
      collectedAt, status: STATUS.UNAVAILABLE, errorClass, headState: null, currentBranch: null, headSha: null, lastCommitAt: null,
      uncommittedCount: null, counts: null, hasRemote: null, isShallow: null,
    }); // 取得できなかったときの形。
    const gate = checkPreflight();
    if (!gate.ok) return unavailable(gate.errorClass);
    try {
      const statusResult = runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']);
      if (!statusResult.ok) return unavailable(statusResult.errorClass);
      const parsed = parseStatusV2(statusResult.stdout);
      const oid = parsed.headers['branch.oid'] || ''; // HEAD の SHA か (initial)。
      const headName = parsed.headers['branch.head'] || ''; // ブランチ名か (detached)。
      const headSha = SHA_PATTERN.test(oid) ? oid : null;
      const headState = headSha ? (headName === '(detached)' ? 'detached' : 'branch') : 'unborn';
      const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
      for (const entry of parsed.entries) {
        const kind = entryKind(entry);
        if (kind === 'conflicted' || kind === 'untracked') counts[kind] += 1;
        if (kind === 'staged' || kind === 'both') counts.staged += 1;
        if (kind === 'unstaged' || kind === 'both') counts.unstaged += 1;
      }
      let failureClass = null; // 2 回目以降の失敗の分類。
      let isShallow = null; // 浅い clone か。
      let hasRemote = null; // リモート追跡ブランチ（refs/remotes）が 1 本以上あるか。
      const probe = runGit(['rev-parse', '--is-shallow-repository', '--remotes']);
      if (probe.ok) {
        const lines = probe.stdout.split('\n').filter(Boolean);
        isShallow = lines[0] === 'true';
        hasRemote = lines.length > 1;
      } else {
        failureClass = probe.errorClass;
      }
      let lastCommitAt = null; // HEAD のコミッター日時。
      if (headSha) {
        const dated = runGit(['log', '-1', '--format=%cI', '--end-of-options', headSha, '--']);
        if (dated.ok) lastCommitAt = dated.stdout.trim() || null;
        else failureClass = failureClass || dated.errorClass;
      }
      const branchUsable = headState !== 'detached' && headName && !headName.startsWith('(') && !CONTROL_CHARACTER_PATTERN.test(headName);
      return {
        collectedAt,
        status: failureClass ? STATUS.PARTIAL : STATUS.OK,
        errorClass: failureClass,
        headState,
        currentBranch: branchUsable ? redact(headName) : null,
        headSha,
        lastCommitAt,
        uncommittedCount: parsed.entries.length,
        counts,
        hasRemote,
        isShallow,
      };
    } catch (error) {
      if (onInternalError) onInternalError(error);
      return unavailable(ERROR_CLASS.INTERNAL);
    }
  }

  return { getBranches, getBranchDetails, compareBranches, getWorktreeDetails, getRecentActivity, getDiff, getSummary };
}
