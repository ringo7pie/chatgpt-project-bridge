#!/usr/bin/env node
/*
  bridge-git.mjs（Git 詳細ツールの読み取り層）を一時リポジトリで検証する（Windows / Linux 共通、外部ネットワークなし）。
  - 通常のリポジトリ（main・feature・リモート追跡ブランチ、ahead/behind・merged・base の選び方、応答の共通項目）
  - 日本語・空白を含むブランチ名とパス（リポジトリの置き場所にも空白と日本語を含める）
  - origin/main が無い・リモートなし・複数リモート・detached HEAD・初回コミット前・浅い clone・merge 競合の途中・rename・
    staged 削除・untracked・linked worktree・サブモジュール
  - 公開権限（branchNames・commitSubjects・paths・diffExcerpts）が false のとき、名前・件名・パス・差分を返さないこと
  - ブランチ名の引数による注入（オプション・リビジョン式・制御文字・長大な文字列）を受け付けず、副作用も無いこと
  - 許可リストにない Git の呼び出しを拒否すること、時間・出力・応答の大きさの上限、ページング
  - 秘密値・非公開のパス・作者名とメールアドレスを返さないこと
  - 全メソッドの前後で .git が変わらないこと（読み取り専用）、Git を常にプロジェクトルートで固定オプション付きで呼ぶこと
  環境変数 BRIDGE_REAL_REPO があれば、そのリポジトリでも全メソッドを読み取りだけで呼び、時間と状態を確かめる。
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertAllowedGitInvocation, createGitReader } from './bridge-git.mjs';
import { BridgeToolError, DEFAULT_MAX_RESPONSE_BYTES, ERROR_CLASS } from './bridge-tools-common.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url)); // この試験のフォルダー。
// Windows の Node は、パスを含まないコマンド名を PATH より先に作業フォルダーから探す。呼び出し元の git.exe を実行しないよう移る。
if (process.platform === 'win32') process.chdir(scriptDirectory);
const SAFE_OPTIONS = ['-c', 'core.fsmonitor=false', '--no-optional-locks']; // server.mjs の GIT_SAFE_OPTIONS と同じ。
const AUTHOR_NAME = 'AuthorNameMarkerQ7'; // 応答に出てはいけない作者名。
const AUTHOR_EMAIL = 'author.marker.q7@example.invalid'; // 応答に出てはいけないメールアドレス。
const MARKERS = {
  subjectVisible: 'SUBJECTVISIBLEMARKERQ7',
  subjectSecret: 'SUBJECTSECRETMARKERQ7',
  subjectPassword: 'SUBJECTPASSWORDMARKERQ7',
  diffLine: 'DIFFLINEMARKERQ7',
  diffSecret: 'DIFFSECRETMARKERQ7',
  diffPassword: 'DIFFPASSWORDMARKERQ7',
  pemBody: 'PEMBODYMARKERQ7',
  hiddenPath: 'HIDDENPATHMARKERQ7',
  hiddenEnv: 'HIDDENENVMARKERQ7',
  pathName: 'PATHNAMEMARKERQ7',
  branchName: 'BRANCHNAMEMARKERQ7',
}; // 応答への出現の有無で判定する目印。
const JAPANESE_BRANCH = 'feature/日本語　ブランチ'; // 日本語と空白（全角。Git は半角空白を参照名に使えない）を含むブランチ名。
const JAPANESE_PATH = 'docs/設計 メモ.md'; // 日本語と空白を含むパス。
const NOW_SECONDS = Math.floor(Date.now() / 1000); // 試験のコミット日時の基準。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tools-selftest-')); // この試験だけの削除対象。
const workRoot = path.join(temporaryRoot, '試験 リポジトリ'); // 空白と日本語を含む置き場所。
const globalConfig = path.join(temporaryRoot, 'gitconfig-global'); // 利用者の設定から切り離したグローバル設定。
const originalGitEnvironment = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM }; // 実リポジトリの確認で戻す値（safe.directory などの利用者の設定）。
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const gitPath = findGit(); // 試験と読み取り層が使う Git。
const invocations = []; // 読み取り層が実行した Git の引数（監査用）。
const readerRoots = new Set(); // 読み取り層に渡したルート。
const internalErrors = []; // 読み取り層の想定外の例外。

let failures = 0; // 合格しなかった検査の数。
let passes = 0; // 合格した検査の数。
let skips = 0; // 実行しなかった検査の数。

// 判定を表示して件数へ反映する。
function check(condition, label) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  if (condition) passes += 1;
  else failures += 1;
}

// 実行しなかった検査を理由付きで表示する。
function skip(label, reason) {
  process.stdout.write(`SKIP ${label}（${reason}）\n`);
  skips += 1;
}

// Git の実行ファイルを返す。Windows では PATH のうちドライブ文字か UNC で始まる要素だけから絶対パスを探す（server.mjs と同じ方針）。
function findGit() {
  if (process.platform !== 'win32') return 'git';
  for (const entry of String(process.env.PATH || '').split(';')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(directory)) continue;
    const candidate = path.join(directory, 'git.exe');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 無い要素は読み飛ばす。 */ }
  }
  return null;
}

// 試験側の Git を実行する。署名・フックを止め、作者名とメールアドレスは目印にする。失敗したら（allowFailure でなければ）例外。
function git(repository, args, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(gitPath, [
    '-C', repository,
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=',
    '-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`,
    '-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false',
    ...args,
  ], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} が失敗しました: ${result.stderr || result.error?.message}`);
  return result;
}

// 試験側の Git の標準出力（末尾の改行を除く）を返す。
function gitOutput(repository, args) {
  return git(repository, args).stdout.replace(/\r?\n$/, '');
}

// 何日前かの UNIX 秒を返す。
function daysAgo(days) {
  return NOW_SECONDS - days * 86400;
}

// コミット日時を固定する環境変数（時差 +09:00）を返す。
function dateEnvironment(seconds) {
  return { GIT_AUTHOR_DATE: `@${seconds} +0900`, GIT_COMMITTER_DATE: `@${seconds} +0900` };
}

// ファイルを書いてすべてステージし、日時を固定してコミットする。
function commitAll(repository, message, seconds, files = {}) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(repository, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '--allow-empty', '-m', message], { env: dateEnvironment(seconds) });
}

// 空のリポジトリを作る。
function initRepository(repository, branch = 'main') {
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-q', '-b', branch]);
}

// 秘密値を伏せる簡易関数（PEM・sk- 形式・password=）。server.mjs の redact の代わり。
function simpleRedact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/(password\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

// 非公開のパスの簡易判定（private/ 配下と .env*）。server.mjs の isHiddenGitPath の代わり。
function simpleHidden(relative) {
  return relative === 'private' || relative.startsWith('private/') || /(?:^|\/)\.env[^/]*$/.test(relative);
}

// 一時リポジトリに対する読み取り層を作る。overrides で exposure や上限を変える。
function makeReader(repository, overrides = {}) {
  const root = fs.realpathSync(repository);
  readerRoots.add(root);
  const { exposure = {}, ...rest } = overrides;
  return createGitReader({
    root,
    resolveGit: () => {
      if (!gitPath) throw new Error('git がありません。');
      return gitPath;
    },
    safeOptions: SAFE_OPTIONS,
    preflight: () => ({ ok: true }),
    redact: simpleRedact,
    isHiddenPath: simpleHidden,
    exposure: { paths: true, commitSubjects: true, branchNames: true, diffExcerpts: true, ...exposure },
    onGitInvocation: args => invocations.push(args),
    onInternalError: error => internalErrors.push(error),
    ...rest,
  });
}

// JSON の文字列に、パスがそのまま（JSON のエスケープ後の形か / 区切りで）含まれるかを返す。
function containsPath(json, filePath) {
  return json.includes(JSON.stringify(filePath).slice(1, -1)) || json.includes(filePath.replace(/\\/g, '/'));
}

// 呼び出しが BridgeToolError を投げるかを調べる。戻り値: { thrown, isBridge, errorClass, hidden }。
function captureToolError(callback) {
  try {
    callback();
    return { thrown: false };
  } catch (error) {
    return { thrown: true, isBridge: error instanceof BridgeToolError, errorClass: error?.errorClass, hidden: error?.hidden || [] };
  }
}

/*
  .git の中の HEAD・refs・index・packed-refs・config・logs・worktrees・objects（名前と大きさ）などの指紋を返す。
  読み取り層の呼び出しの前後で比べ、書き込みが無いことを確かめる。
*/
function snapshotGitDirectory(repository) {
  const gitDirectory = path.join(repository, '.git');
  const hash = crypto.createHash('sha256');
  // 1 つのパスを指紋に足す（ディレクトリは名前の順にたどる）。
  const visit = relative => {
    const full = path.join(gitDirectory, relative);
    let stat; // パスの情報。
    try { stat = fs.lstatSync(full); } catch { hash.update(`missing:${relative}\n`); return; }
    if (stat.isDirectory()) {
      hash.update(`directory:${relative}\n`);
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
      return;
    }
    hash.update(`file:${relative}:${stat.size}\n`);
    if (!relative.startsWith('objects')) hash.update(fs.readFileSync(full));
  };
  for (const entry of ['HEAD', 'refs', 'index', 'packed-refs', 'config', 'logs', 'worktrees', 'objects', 'shallow', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'MERGE_MSG']) visit(entry);
  return hash.digest('hex');
}

// 読み取り層の呼び出しの前後で .git が変わらないことを確かめる。
function withReadOnlyCheck(label, repository, callback) {
  const before = snapshotGitDirectory(repository);
  callback();
  check(snapshotGitDirectory(repository) === before, `読み取り専用: ${label} の前後で .git（HEAD・refs・index・packed-refs・config・objects など）が変わらない`);
}

// 応答の共通項目（schemaVersion・tool・collectedAt・sources・status）を確かめる。
function checkEnvelope(envelope, tool, label) {
  const meta = envelope?.meta;
  check(
    envelope?.schemaVersion === 1 && envelope.tool === tool && typeof meta?.collectedAt === 'string' && Number.isFinite(Date.parse(meta.collectedAt))
      && Array.isArray(meta.sources) && meta.sources[0]?.kind === 'liveGit' && meta.sources[0]?.live === true
      && ['ok', 'partial', 'unavailable'].includes(meta.status) && Array.isArray(meta.hidden) && Array.isArray(meta.warnings),
    `${label}: 応答に schemaVersion・tool・collectedAt・sources（liveGit）・status が付く`,
  );
}

// 通常のリポジトリ（seed → bare の origin → clone したプロジェクト）を作り、主な SHA を返す。
function buildMainProject() {
  const seed = path.join(workRoot, 'seed 種');
  initRepository(seed);
  commitAll(seed, 'initial import', daysAgo(20), { 'README.md': '# readme\n', 'shared.txt': 'line1\nline2\nline3\n', [JAPANESE_PATH]: '# 設計\n', 'src/app.js': 'console.log(1);\n' });
  commitAll(seed, 'second commit', daysAgo(18), { 'src/app.js': 'console.log(2);\n' });
  git(seed, ['checkout', '-q', '-b', 'topic/merged']);
  commitAll(seed, 'topic work', daysAgo(16), { 'src/topic.js': 'topic\n' });
  git(seed, ['checkout', '-q', 'main']);
  git(seed, ['merge', '-q', '--no-ff', '-m', 'merge topic', 'topic/merged'], { env: dateEnvironment(daysAgo(15)) });
  const origin = path.join(workRoot, 'origin リモート.git');
  git(workRoot, ['clone', '-q', '--bare', seed, origin]);
  git(seed, ['remote', 'add', 'origin', origin]);
  const project = path.join(workRoot, 'プロジェクト 本体');
  git(workRoot, ['clone', '-q', origin, project]);
  git(project, ['branch', '-q', '--track', 'topic/merged', 'origin/topic/merged']);
  git(project, ['branch', '-q', 'gone-branch', 'HEAD']);
  git(project, ['config', 'branch.gone-branch.remote', 'origin']);
  git(project, ['config', 'branch.gone-branch.merge', 'refs/heads/vanished']);
  git(project, ['checkout', '-q', '-b', JAPANESE_BRANCH]);
  commitAll(project, `${MARKERS.subjectVisible} 機能の追加`, daysAgo(10), { 'shared.txt': 'line1\nfeature change\nline3\n', [JAPANESE_PATH]: '# 設計\n追記\n', 'src/feature.js': 'feature\n' });
  commitAll(project, `fix token sk-${MARKERS.subjectSecret}abcdefghijkl password=${MARKERS.subjectPassword}`, daysAgo(5), {
    [`private/${MARKERS.hiddenPath}.md`]: 'hidden\n',
    [`.env.${MARKERS.hiddenEnv}`]: 'X=1\n',
  });
  git(project, ['checkout', '-q', 'main']);
  commitAll(project, 'local main 1', daysAgo(4), { 'shared.txt': 'line1\nmain change\nline3\n' });
  commitAll(project, 'local main 2', daysAgo(2), { 'README.md': '# readme\nlocal\n' });
  commitAll(seed, 'upstream change', daysAgo(3), { 'src/app.js': 'console.log(3);\n' });
  git(seed, ['push', '-q', 'origin', 'main']);
  git(project, ['fetch', '-q', 'origin']);
  return {
    project,
    origin,
    seed,
    sha: {
      main: gitOutput(project, ['rev-parse', 'refs/heads/main']),
      feature: gitOutput(project, ['rev-parse', `refs/heads/${JAPANESE_BRANCH}`]),
      originMain: gitOutput(project, ['rev-parse', 'refs/remotes/origin/main']),
      topic: gitOutput(project, ['rev-parse', 'refs/heads/topic/merged']),
      mergeCommit: gitOutput(project, ['rev-parse', 'refs/heads/gone-branch']),
    },
  };
}

// 通常のリポジトリで get_git_branches・get_branch_details・compare_branches・get_recent_activity を検査する。
function testMainProject(main) {
  const reader = makeReader(main.project);
  withReadOnlyCheck('通常のリポジトリ（全メソッド）', main.project, () => {
    const branches = reader.getBranches({});
    checkEnvelope(branches, 'get_git_branches', '通常');
    const facts = branches.facts;
    const byName = new Map((facts.branches || []).map(branch => [`${branch.kind}:${branch.name}`, branch]));
    check(['main', 'topic/merged', 'gone-branch', JAPANESE_BRANCH].every(name => byName.has(`local:${name}`)) && facts.counts.local === 4, '通常: 全ローカルブランチ（日本語・空白入りを含む）を列挙する');
    check(byName.has('remote:origin/main') && byName.has('remote:origin/topic/merged') && facts.counts.remote === 2 && !byName.has('remote:origin/HEAD'), '通常: リモート追跡ブランチを列挙し、origin/HEAD の symref は除く');
    check(facts.repository.headState === 'branch' && facts.repository.currentBranch === 'main' && facts.repository.headSha === main.sha.main, '通常: 現在のブランチと HEAD の SHA');
    check(facts.repository.headCommittedAt === gitOutput(main.project, ['log', '-1', '--format=%cI', 'HEAD']) && /\+09:00$/.test(facts.repository.headCommittedAt), '通常: HEAD の最終コミット日時（ISO 8601、記録された時差）');
    check(facts.repository.isShallow === false && facts.repository.hasCommits === true, '通常: 浅い clone ではなく、コミットがある');
    check(facts.branches[0]?.name === 'main' && facts.branches[0]?.isCurrent === true, '通常: 現在のブランチが先頭');
    const order = facts.branches.slice(1).map(branch => Date.parse(branch.lastCommitAt));
    check(order.every((value, index) => index === 0 || order[index - 1] >= value), '通常: 2 本目以降は最終コミット日時の新しい順');
    const mainBranch = byName.get('local:main');
    check(mainBranch?.upstream === 'origin/main' && mainBranch.upstreamState === 'tracking' && mainBranch.aheadOfUpstream === 2 && mainBranch.behindUpstream === 1, '通常: upstream と ahead/behind（2 進み・1 遅れ）');
    check(byName.get('local:gone-branch')?.upstreamState === 'gone' && byName.get(`local:${JAPANESE_BRANCH}`)?.upstreamState === 'none', '通常: 上流が消えたブランチは gone、上流なしは none');
    check(facts.base.ref === 'origin/main' && facts.base.selection === 'remoteDefault' && facts.base.sha === main.sha.originMain, '通常: base は origin/HEAD が指す origin/main（remoteDefault）');
    check(facts.counts.mergedIntoBase === 3 && facts.counts.unmergedIntoBase === 2, '通常: base に取り込まれた 3 本・未取り込み 2 本');
    check(byName.get('local:topic/merged')?.mergedIntoBase === true && byName.get(`local:${JAPANESE_BRANCH}`)?.mergedIntoBase === false, '通常: ブランチごとの mergedIntoBase');
    const feature = byName.get(`local:${JAPANESE_BRANCH}`);
    check(feature?.aheadOfBase === 2 && feature.behindBase === 1 && mainBranch.aheadOfBase === 2 && mainBranch.behindBase === 1, '通常: base との ahead/behind');
    check(feature?.sha === main.sha.feature && /^[0-9a-f]{7,}$/.test(feature.shortSha) && feature.lastCommitAt === gitOutput(main.project, ['log', '-1', '--format=%cI', main.sha.feature]), '通常: ブランチの SHA・短い SHA・最終コミット日時');
    check(branches.meta.status === 'ok' && branches.page?.total === 6, '通常: status ok、page の total');

    const local = reader.getBranches({ includeRemote: false });
    check(local.facts.branches.every(branch => branch.kind === 'local') && local.facts.branches.length === 4 && local.facts.counts.remote === 2, 'includeRemote false: ローカルだけを並べ、件数は両方を返す');
    const explicit = reader.getBranches({ baseBranch: 'main' });
    check(explicit.facts.base.ref === 'main' && explicit.facts.base.selection === 'explicit' && explicit.facts.base.kind === 'local', 'baseBranch の明示指定');

    const details = reader.getBranchDetails({ branch: JAPANESE_BRANCH });
    checkEnvelope(details, 'get_branch_details', 'ブランチ詳細');
    const detail = details.facts;
    check(detail.base.ref === 'origin/main' && detail.mergeBase?.sha === main.sha.mergeCommit && detail.ahead === 2 && detail.behind === 1, 'ブランチ詳細: base・分岐点・ahead/behind');
    check(detail.diffStat?.filesChanged === 5 && detail.diffStat.insertions >= 5 && detail.diffStat.range === 'mergeBase..branch', 'ブランチ詳細: diffStat（非公開のファイルも数に含む）');
    const changedPaths = (detail.changedFiles || []).map(file => file.path).sort();
    check(JSON.stringify(changedPaths) === JSON.stringify([JAPANESE_PATH, 'shared.txt', 'src/feature.js'].sort()) && detail.omittedHiddenPaths === 2, 'ブランチ詳細: changedFiles（日本語・空白入りのパスを含み、非公開の 2 件を除く）');
    check(detail.recentCommits.length === 2 && detail.recentCommits.some(commit => commit.subject?.includes(MARKERS.subjectVisible)) && detail.recentCommitsScope === 'notInBase', 'ブランチ詳細: recentCommits と件名');
    check(typeof detail.createdAt === 'object' && detail.createdAt.source === 'reflog' && Number.isFinite(Date.parse(detail.createdAt.at)), 'ブランチ詳細: reflog の「branch: Created from」から作成日時');
    check(details.inferences.length > 0 && details.inferences.every(item => item.confidence === 'low' && item.claim.includes('目的は未確認')), 'ブランチ詳細: 件名からの推測は low で「目的は未確認」と明記');
    check(details.page?.total === 3 && details.meta.status === 'ok', 'ブランチ詳細: changedFiles のページ情報');
    const remoteDetails = reader.getBranchDetails({ branch: 'origin/topic/merged' });
    check(remoteDetails.facts.branch.kind === 'remote' && remoteDetails.facts.createdAt === 'unknown', 'ブランチ詳細: リモート追跡ブランチは作成日時 unknown');
    const mainDetails = reader.getBranchDetails({ branch: 'main', baseBranch: 'origin/main' });
    check(mainDetails.facts.ahead === 2 && mainDetails.facts.behind === 1 && mainDetails.facts.base.selection === 'explicit', 'ブランチ詳細: baseBranch の明示指定');

    const compared = reader.compareBranches({ base: 'main', target: JAPANESE_BRANCH });
    checkEnvelope(compared, 'compare_branches', 'ブランチ比較');
    const comparison = compared.facts;
    check(comparison.mergeState === 'diverged' && comparison.ahead === 2 && comparison.behind === 2 && comparison.mergeBase?.sha === main.sha.mergeCommit, 'ブランチ比較: diverged・ahead/behind・分岐点');
    check(comparison.conflictIndicators?.heuristic === true && comparison.conflictIndicators.overlappingFileCount === 1 && comparison.conflictIndicators.overlappingFiles?.[0] === 'shared.txt' && comparison.conflictIndicators.note.includes('マージを試したものではなく'), 'ブランチ比較: 競合の目安（重なり 1 件、heuristic と注記）');
    const areaNames = (comparison.areas || []).map(area => area.area).sort();
    check(JSON.stringify(areaNames) === JSON.stringify(['.', 'docs', 'src']) && comparison.areaTotals.added === 3 && comparison.areaTotals.modified === 2, 'ブランチ比較: 先頭ディレクトリ単位の areas と合計（非公開のまとまりは出さない）');
    check(comparison.commits.length === 2 && comparison.changedFiles.length === 3 && compared.inferences.some(item => item.confidence === 'low'), 'ブランチ比較: commits・changedFiles・low の推測');
    check(reader.compareBranches({ base: 'main', target: 'main' }).facts.mergeState === 'identical', 'ブランチ比較: 同じブランチは identical');
    check(reader.compareBranches({ base: 'main', target: 'topic/merged' }).facts.mergeState === 'targetMergedIntoBase', 'ブランチ比較: 取り込み済みは targetMergedIntoBase');
    check(reader.compareBranches({ base: 'topic/merged', target: 'main' }).facts.mergeState === 'fastForwardPossible', 'ブランチ比較: 祖先から見ると fastForwardPossible');
    const remoteCompare = reader.compareBranches({ base: 'origin/main', target: 'main' });
    check(remoteCompare.facts.mergeState === 'diverged' && remoteCompare.facts.ahead === 2 && remoteCompare.facts.behind === 1, 'ブランチ比較: リモート追跡ブランチとの比較');

    const activity = reader.getRecentActivity({ days: 14 });
    checkEnvelope(activity, 'get_recent_activity', '最近の活動');
    const recent = activity.facts;
    check(recent.commitsInWindow === 4 && recent.windowDays === 14 && recent.daily.length >= 14 && recent.daily.reduce((sum, day) => sum + day.commits, 0) === 4, '最近の活動: 期間内のコミット 4 件と日ごとの件数');
    check(recent.lastCommitAt === gitOutput(main.project, ['log', '-1', '--format=%cI', 'refs/heads/main']) && recent.recentCommits.length === 4, '最近の活動: 最後のコミット日時と recentCommits');
    const recentAreas = (recent.changedAreas || []).map(area => area.area).sort();
    check(JSON.stringify(recentAreas) === JSON.stringify(['.', 'docs', 'src']) && recent.changedFileCount === 6, '最近の活動: changedAreas（非公開を除く）と changedFileCount');
    check(recent.uncommitted.count === 0 && recent.uncommitted.newestChangedFileModifiedAt === null && !activity.meta.warnings.some(warning => warning.includes('参考値')), '最近の活動: 未コミットの変更なし（更新日時の警告も無い）');
    const narrow = reader.getRecentActivity({ days: 3, limit: 1 });
    check(narrow.facts.commitsInWindow === 1 && narrow.facts.recentCommits.length === 1, '最近の活動: 期間（3 日）と limit が効く');

    const summary = reader.getSummary();
    const summaryKeys = ['collectedAt', 'status', 'errorClass', 'headState', 'currentBranch', 'headSha', 'lastCommitAt', 'uncommittedCount', 'counts', 'hasRemote', 'isShallow'];
    check(summaryKeys.every(key => Object.hasOwn(summary, key)) && summary.status === 'ok' && summary.headState === 'branch' && summary.currentBranch === 'main' && summary.headSha === main.sha.main, 'getSummary: 形と HEAD の事実');
    check(summary.hasRemote === true && summary.isShallow === false && summary.uncommittedCount === 0 && summary.counts.staged === 0 && summary.lastCommitAt === facts.repository.headCommittedAt, 'getSummary: リモート・浅さ・未コミット件数・最終コミット日時');

    const everything = JSON.stringify([branches, local, explicit, details, remoteDetails, mainDetails, compared, activity, narrow, summary]);
    check(!everything.includes(MARKERS.subjectSecret) && !everything.includes(MARKERS.subjectPassword), '秘密: コミット件名の sk- 形式と password= を返さない');
    check(!everything.includes(MARKERS.hiddenPath) && !everything.includes(MARKERS.hiddenEnv), '秘密: isHiddenPath のファイル名を返さない');
    check(!everything.includes(AUTHOR_NAME) && !everything.includes(AUTHOR_EMAIL), '秘密: 作者名・メールアドレスを返さない');
    check(![fs.realpathSync(main.project), main.project, temporaryRoot].some(filePath => containsPath(everything, filePath)), '秘密: 絶対パスを返さない');
  });
  return reader;
}

// %(ahead-behind:)（Git 2.41 以上）を使わない数え方（Ubuntu 22.04 の Git 2.34 と同じ経路）でも、同じ結果になることを検査する。
function testLegacyCounting(main) {
  const modern = makeReader(main.project).getBranches({});
  const legacy = makeReader(main.project, { useAheadBehindField: false }).getBranches({});
  // 比べる項目（件数と、ブランチごとの merged・ahead/behind）を取り出す。
  const pick = response => JSON.stringify({
    counts: response.facts.counts,
    branches: response.facts.branches.map(branch => [branch.kind, branch.name, branch.mergedIntoBase, branch.aheadOfBase, branch.behindBase, branch.aheadOfUpstream, branch.behindUpstream]),
  });
  check(pick(modern) === pick(legacy) && legacy.meta.status === 'ok', '古い Git の数え方（1 本ずつ rev-list と --merged）でも同じ merged・ahead/behind');
}

// 公開権限（branchNames・commitSubjects・paths）が false のときの振る舞いを検査する。
function testExposure(main) {
  const noBranches = makeReader(main.project, { exposure: { branchNames: false } });
  const branchesHidden = noBranches.getBranches({});
  const branchesJson = JSON.stringify(branchesHidden);
  check(branchesHidden.facts.branches === undefined && branchesHidden.meta.hidden.includes('branchNames') && branchesHidden.facts.counts.local === 4 && branchesHidden.facts.repository.currentBranch === 'main', '権限 branchNames=false: branches を出さず、件数と現在のブランチは出す');
  check(!branchesJson.includes('topic/merged') && !branchesJson.includes('日本語') && !branchesJson.includes('gone-branch') && branchesHidden.facts.base.ref === null && branchesHidden.facts.base.selection === 'remoteDefault', '権限 branchNames=false: 他のブランチ名・base の名前が応答に無い');
  for (const [label, callback] of [
    ['get_branch_details', () => noBranches.getBranchDetails({ branch: 'main' })],
    ['get_branch_details（存在しない名前）', () => noBranches.getBranchDetails({ branch: 'no-such-branch' })],
    ['compare_branches', () => noBranches.compareBranches({ base: 'main', target: JAPANESE_BRANCH })],
    ['get_git_branches の baseBranch', () => noBranches.getBranches({ baseBranch: 'main' })],
  ]) {
    const captured = captureToolError(callback);
    check(captured.isBridge && captured.errorClass === ERROR_CLASS.PERMISSION_DENIED && captured.hidden.includes('branchNames'), `権限 branchNames=false: ${label} は permission_denied（実在を確かめない）`);
  }

  const noSubjects = makeReader(main.project, { exposure: { commitSubjects: false } });
  const subjectResponses = [noSubjects.getBranchDetails({ branch: JAPANESE_BRANCH }), noSubjects.compareBranches({ base: 'main', target: JAPANESE_BRANCH }), noSubjects.getRecentActivity({ days: 30 })];
  const subjectsJson = JSON.stringify(subjectResponses);
  check(!subjectsJson.includes(MARKERS.subjectVisible) && !subjectsJson.includes('local main') && !subjectsJson.includes('"subject"'), '権限 commitSubjects=false: 件名を返さない');
  check(subjectResponses.every(response => response.meta.hidden.includes('commitSubjects')) && subjectResponses[0].inferences.length === 0, '権限 commitSubjects=false: hidden に出し、件名からの推測も出さない');

  const noPaths = makeReader(main.project, { exposure: { paths: false } });
  const pathResponses = [noPaths.getBranchDetails({ branch: JAPANESE_BRANCH }), noPaths.compareBranches({ base: 'main', target: JAPANESE_BRANCH }), noPaths.getRecentActivity({ days: 30 })];
  const pathsJson = JSON.stringify(pathResponses);
  check(!pathsJson.includes('設計') && !pathsJson.includes('feature.js') && !pathsJson.includes('shared.txt') && !pathsJson.includes('"docs"'), '権限 paths=false: ファイル名・ディレクトリ名を返さない');
  check(pathResponses.every(response => response.meta.hidden.includes('paths')) && pathResponses[0].facts.changedFiles === undefined && pathResponses[0].facts.diffStat?.filesChanged === 5, '権限 paths=false: hidden に出し、件数（diffStat）は返す');
  check(pathResponses[1].facts.areas === undefined && pathResponses[1].facts.areaTotals?.added === 3 && pathResponses[1].facts.conflictIndicators?.overlappingFiles === undefined && pathResponses[1].facts.conflictIndicators?.overlappingFileCount === 1, '権限 paths=false: areas と重なったファイル名を出さず、合計と件数は返す');
  check(pathResponses[2].facts.changedAreas === undefined && pathResponses[2].facts.changedFileCount === 8, `権限 paths=false: 最近の活動はまとまりの名前を出さず件数は返す（${pathResponses[2].facts.changedFileCount} 件）`);
}

// ブランチ名の引数による注入を受け付けず、副作用（ファイルの作成）も無いことを検査する。
function testInjection(main) {
  const reader = makeReader(main.project);
  const outputFile = path.join(temporaryRoot, 'injected-output.txt'); // --output= で作られてはいけないファイル。
  const inputs = [
    `--output=${outputFile}`,
    `--output=${outputFile.replace(/\\/g, '/')}`,
    'HEAD~1',
    'HEAD',
    '@{u}',
    'main..feature',
    'main...origin/main',
    '../x',
    'refs/heads/../main',
    'main\nfeature',
    'main\0x',
    'main\u0007',
    'x'.repeat(5000),
    '-n',
    '--all',
    'origin/HEAD',
    'refs/remotes/origin/HEAD',
    main.sha.main,
    main.sha.main.slice(0, 7),
    'main^{tree}',
    ':/initial',
  ]; // 受け付けてはいけない入力。
  const startCount = invocations.length;
  let allRejected = true; // すべて invalid_argument か ref_not_found だったか。
  for (const input of inputs) {
    for (const callback of [
      () => reader.getBranchDetails({ branch: input }),
      () => reader.compareBranches({ base: 'main', target: input }),
      () => reader.compareBranches({ base: input, target: 'main' }),
      () => reader.getBranches({ baseBranch: input }),
      () => reader.getBranchDetails({ branch: 'main', baseBranch: input }),
    ]) {
      const captured = captureToolError(callback);
      const accepted = captured.isBridge && (captured.errorClass === ERROR_CLASS.INVALID_ARGUMENT || captured.errorClass === ERROR_CLASS.REF_NOT_FOUND);
      if (!accepted) {
        allRejected = false;
        process.stdout.write(`  （受け付けた入力: ${JSON.stringify(input).slice(0, 80)} → ${captured.thrown ? captured.errorClass : '例外なし'}）\n`);
      }
    }
  }
  check(allRejected, '注入: オプション・リビジョン式・SHA・制御文字・長大な文字列のブランチ名は invalid_argument か ref_not_found');
  check(!fs.existsSync(outputFile), '注入: --output= で一時ファイルが作られない');
  const suspicious = inputs.filter(input => input.length > 3 && input !== 'HEAD' && !/^[0-9a-f]+$/.test(input)); // Git の引数に現れてはいけない入力（HEAD と SHA は読み取り層が自分で使う）。
  const passedThrough = invocations.slice(startCount).some(args => args.some(argument => suspicious.some(input => argument.includes(input))));
  check(!passedThrough, '注入: 入力の文字列を Git の引数へそのまま渡さない（SHA は除く）');
  for (const [label, input] of [['branch が数値', { branch: 1 }], ['branch が空', { branch: '' }], ['branch なし', {}]]) {
    const captured = captureToolError(() => reader.getBranchDetails(input));
    check(captured.isBridge && captured.errorClass === ERROR_CLASS.INVALID_ARGUMENT, `引数: ${label} は invalid_argument`);
  }
  for (const [label, callback] of [
    ['limit が文字列', () => reader.getBranches({ limit: '5' })],
    ['includeRemote が文字列', () => reader.getBranches({ includeRemote: 'yes' })],
    ['category が不正', () => reader.getWorktreeDetails({ category: 'everything' })],
    ['days が文字列', () => reader.getRecentActivity({ days: '7' })],
  ]) {
    const captured = captureToolError(callback);
    check(captured.isBridge && captured.errorClass === ERROR_CLASS.INVALID_ARGUMENT, `引数: ${label} は invalid_argument`);
  }
}

// 許可リストの検査が、書き込み・外部実行のある呼び出しを拒否し、読み取りの呼び出しを通すことを検査する。
function testAllowList() {
  const rejected = [
    ['checkout', 'main'], ['fetch'], ['pull'], ['push'], ['commit', '-m', 'x'], ['reset', '--hard'], ['clean', '-fd'], ['merge', 'x'],
    ['rebase', 'x'], ['merge-tree', '--write-tree', 'a', 'b'], ['branch', 'x'], ['branch'], ['tag', 'x'], ['update-ref', 'refs/heads/x', 'HEAD'],
    ['worktree', 'add', 'x'], ['worktree', 'remove', 'x'], ['worktree', 'prune'], ['gc'], ['config', 'core.x', 'y'], ['config', '--list'], ['submodule', 'update'],
    ['reflog', 'expire', '--all'], ['reflog', 'delete', 'HEAD@{0}'], ['reflog'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['symbolic-ref', '-d', 'HEAD'],
    ['diff', '--output=x'], ['diff', '--outp=x'], ['log', '--output', 'x'], ['diff', '--no-index', 'a', 'b'], ['diff', '--ext-diff'], ['log', '--textconv'],
    ['-c', 'core.pager=x', 'log'], ['--git-dir=x', 'status'], ['stash', 'list'], ['cat-file', '-p', 'HEAD'], ['show', 'HEAD'], ['grep', 'x'], ['archive', 'HEAD'],
    ['status\0'], [],
  ]; // 拒否すべき呼び出し。
  const allowed = [
    ['rev-parse', '--is-shallow-repository'], ['symbolic-ref', '-q', 'HEAD'], ['for-each-ref', '--format=%(refname)', 'refs/heads'],
    ['rev-list', '--left-right', '--count', '--end-of-options', 'a...b', '--'], ['merge-base', '--is-ancestor', '--end-of-options', 'a', 'b'],
    ['log', '-1', '--format=%H', '--end-of-options', 'a', '--'], ['diff', '--raw', '-z', '--', '--output.txt'], ['status', '--porcelain=v2', '-z'],
    ['ls-files', '-s', '-z'], ['reflog', 'show', '--end-of-options', 'refs/heads/main', '--'], ['worktree', 'list', '--porcelain'], ['log', '--oneline'],
  ]; // 通すべき呼び出し。
  const wronglyAllowed = rejected.filter(args => {
    try { assertAllowedGitInvocation(args); return true; } catch { return false; }
  });
  check(wronglyAllowed.length === 0, `許可リスト: checkout・fetch・pull・push・commit・reset・clean・merge・rebase・merge-tree・branch・tag・update-ref・worktree add・gc などを拒否する${wronglyAllowed.length ? `（通ってしまった: ${wronglyAllowed.map(args => args.join(' ')).join(' / ')}）` : ''}`);
  const wronglyRejected = allowed.filter(args => {
    try { assertAllowedGitInvocation(args); return false; } catch { return true; }
  });
  check(wronglyRejected.length === 0, `許可リスト: 読み取りの呼び出しは通す${wronglyRejected.length ? `（拒否された: ${wronglyRejected.map(args => args.join(' ')).join(' / ')}）` : ''}`);
}

// origin/main が無い（origin/master だけ）・リモートなし・複数リモート・detached HEAD・base なしを検査する。
function testRepositoryShapes(main) {
  const masterSeed = path.join(workRoot, 'master 種');
  initRepository(masterSeed, 'master');
  commitAll(masterSeed, 'master initial', daysAgo(9), { 'a.txt': 'a\n' });
  const masterOnly = path.join(workRoot, 'master だけ');
  git(workRoot, ['clone', '-q', masterSeed, masterOnly]);
  withReadOnlyCheck('origin/master だけのリポジトリ', masterOnly, () => {
    const branches = makeReader(masterOnly).getBranches({});
    check(branches.facts.base.ref === 'origin/master' && branches.facts.base.selection === 'remoteDefault', 'origin/main が無い: base は origin/HEAD が指す origin/master');
  });

  git(masterOnly, ['remote', 'add', 'upstream', main.origin]);
  git(masterOnly, ['fetch', '-q', 'upstream']);
  git(masterOnly, ['remote', 'set-head', 'upstream', 'main']);
  withReadOnlyCheck('複数リモートのリポジトリ', masterOnly, () => {
    const branches = makeReader(masterOnly).getBranches({});
    check(branches.facts.base.ref === 'origin/master' && branches.facts.counts.remote === 3, '複数リモート: origin の既定ブランチを優先し、全リモートのブランチを数える');
  });
  git(masterOnly, ['remote', 'set-head', 'origin', '-d']);
  const withoutOriginHead = makeReader(masterOnly).getBranches({});
  check(withoutOriginHead.facts.base.ref === 'upstream/main' && withoutOriginHead.facts.base.selection === 'remoteDefault', '複数リモート: origin/HEAD が無ければ他のリモートの既定ブランチ');

  const noRemote = path.join(workRoot, 'リモート なし');
  initRepository(noRemote);
  commitAll(noRemote, 'first', daysAgo(8), { 'a.txt': 'a\n' });
  git(noRemote, ['branch', 'work']);
  commitAll(noRemote, 'second', daysAgo(7), { 'b.txt': 'b\n' });
  withReadOnlyCheck('リモートなしのリポジトリ', noRemote, () => {
    const reader = makeReader(noRemote);
    const branches = reader.getBranches({});
    check(branches.facts.base.ref === 'main' && branches.facts.base.selection === 'conventionalName' && branches.facts.counts.remote === 0, 'リモートなし: base はローカルの main（conventionalName）');
    check(branches.facts.counts.mergedIntoBase === 1 && branches.facts.counts.unmergedIntoBase === 0, 'リモートなし: work は main に取り込まれている');
    const workDetails = reader.getBranchDetails({ branch: 'work' });
    check(workDetails.facts.base.ref === 'main' && workDetails.facts.behind === 1 && workDetails.facts.ahead === 0, 'リモートなし: ブランチ詳細の base は main');
    const mainDetails = reader.getBranchDetails({ branch: 'main' });
    check(mainDetails.facts.base.ref === null && mainDetails.facts.recentCommitsScope === 'all' && mainDetails.facts.recentCommits.length === 2, 'リモートなし: main 自身の詳細は base なしで直近のコミット');
    check(reader.getSummary().hasRemote === false, 'リモートなし: getSummary の hasRemote は false');
  });

  git(noRemote, ['checkout', '-q', '--detach', 'HEAD']);
  withReadOnlyCheck('detached HEAD のリポジトリ', noRemote, () => {
    const reader = makeReader(noRemote);
    const branches = reader.getBranches({});
    check(branches.facts.repository.headState === 'detached' && branches.facts.repository.currentBranch === null && branches.facts.repository.headSha !== null, 'detached HEAD: headState detached、currentBranch null、SHA あり');
    check(branches.facts.branches.every(branch => branch.isCurrent === false), 'detached HEAD: どのブランチも isCurrent ではない');
    const summary = reader.getSummary();
    check(summary.headState === 'detached' && summary.currentBranch === null, 'detached HEAD: getSummary');
    check(reader.getRecentActivity({ days: 30 }).facts.commitsInWindow === 2, 'detached HEAD: 最近の活動はブランチと HEAD から数える');
  });

  const noBase = path.join(workRoot, 'base なし');
  initRepository(noBase, 'solo');
  commitAll(noBase, 'solo commit', daysAgo(6), { 'a.txt': 'a\n' });
  const soloBranches = makeReader(noBase).getBranches({});
  check(soloBranches.facts.base.selection === 'none' && soloBranches.facts.base.ref === null && soloBranches.facts.counts.mergedIntoBase === null && soloBranches.facts.branches[0].aheadOfBase === null, 'base なし: selection none、merged の件数と ahead/behind は null');
}

// 初回コミット前（unborn）のリポジトリを検査する。
function testUnborn() {
  const unborn = path.join(workRoot, '初回 前');
  initRepository(unborn);
  fs.writeFileSync(path.join(unborn, 'staged.txt'), 'staged\n');
  git(unborn, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(unborn, 'untracked.txt'), 'untracked\n');
  withReadOnlyCheck('初回コミット前のリポジトリ', unborn, () => {
    const reader = makeReader(unborn);
    const branches = reader.getBranches({});
    const repository = branches.facts.repository;
    check(branches.meta.status !== 'unavailable' && repository.headState === 'unborn' && repository.hasCommits === false && repository.currentBranch === 'main' && repository.headSha === null, '初回コミット前: headState unborn、currentBranch は作られる予定の main');
    check(branches.facts.branches.length === 0 && branches.facts.base.selection === 'none', '初回コミット前: ブランチなし、base なし');
    const worktree = reader.getWorktreeDetails({});
    check(worktree.meta.status === 'ok' && worktree.facts.counts.staged === 1 && worktree.facts.counts.untracked === 1 && worktree.facts.diffStat.staged?.filesChanged === 1, '初回コミット前: git status と diff --cached が動く');
    const activity = reader.getRecentActivity({});
    check(activity.meta.status === 'ok' && activity.facts.commitsInWindow === 0 && activity.facts.lastCommitAt === null && activity.facts.uncommitted.count === 2, '初回コミット前: コミット 0 件、未コミット 2 件');
    check(activity.inferences.some(item => item.confidence === 'low' && item.claim.includes('未コミット')) && activity.meta.warnings.some(warning => warning.includes('参考値')), '初回コミット前: 未コミット作業の可能性を low の推測に、更新日時は参考値と警告');
    const summary = reader.getSummary();
    check(summary.headState === 'unborn' && summary.currentBranch === 'main' && summary.headSha === null && summary.uncommittedCount === 2 && summary.lastCommitAt === null, '初回コミット前: getSummary');
    const captured = captureToolError(() => reader.getBranchDetails({ branch: 'main' }));
    check(captured.isBridge && captured.errorClass === ERROR_CLASS.REF_NOT_FOUND, '初回コミット前: まだ無いブランチの詳細は ref_not_found');
  });
}

// 浅い clone を検査する（file:// で clone できなければ SKIP）。
function testShallow(main) {
  const shallow = path.join(workRoot, '浅い clone');
  const url = `file://${process.platform === 'win32' ? '/' : ''}${main.origin.replace(/\\/g, '/')}`;
  const cloned = git(workRoot, ['clone', '-q', '--depth', '1', url, shallow], { allowFailure: true });
  if (cloned.status !== 0 || gitOutput(shallow, ['rev-parse', '--is-shallow-repository']) !== 'true') {
    skip('浅い clone の試験', 'file:// の浅い clone を作れませんでした');
    return;
  }
  withReadOnlyCheck('浅い clone', shallow, () => {
    const reader = makeReader(shallow);
    const branches = reader.getBranches({});
    check(branches.facts.repository.isShallow === true && branches.meta.warnings.some(warning => warning.includes('浅い clone')), '浅い clone: isShallow と、ahead/behind・分岐点が不正確な可能性の警告');
    check(reader.getSummary().isShallow === true, '浅い clone: getSummary の isShallow');
    const activity = reader.getRecentActivity({ days: 30 });
    check(activity.meta.status !== 'unavailable' && activity.meta.warnings.some(warning => warning.includes('浅い clone')), '浅い clone: 最近の活動にも警告');
  });
}

// 作業ツリーの詳細（rename・staged 削除・untracked・両方の変更・バイナリ・worktree・サブモジュール・差分の抜粋）を検査する。
function testWorktree() {
  const worktreeRoot = path.join(workRoot, '作業 ツリー');
  initRepository(worktreeRoot);
  commitAll(worktreeRoot, 'base', daysAgo(30), {
    'a.txt': 'a\n', 'b.txt': 'b1\nb2\n', 'c.txt': 'c\n', 'd.txt': 'd1\nd2\n', [JAPANESE_PATH]: '# x\n',
    [`private/${MARKERS.hiddenPath}.md`]: 'p\n', 'bin.dat': Buffer.from([0, 1, 2, 3, 0, 5]),
  });
  const submoduleSource = path.join(workRoot, 'サブ 元');
  initRepository(submoduleSource);
  commitAll(submoduleSource, 'sub initial', daysAgo(30), { 'lib.txt': 'lib\n' });
  const submodulePath = 'libs/サブ モジュール';
  const submoduleAdded = git(worktreeRoot, ['submodule', 'add', '-q', submoduleSource.replace(/\\/g, '/'), submodulePath], { allowFailure: true }).status === 0;
  if (submoduleAdded) commitAll(worktreeRoot, 'add submodule', daysAgo(29));
  fs.appendFileSync(path.join(worktreeRoot, '.git', 'info', 'exclude'), '/inner-wt/\n');
  git(worktreeRoot, ['worktree', 'add', '-q', '-b', 'wt-inner', path.join(worktreeRoot, 'inner-wt')]);
  const outsideWorktree = path.join(workRoot, '外部 worktree');
  git(worktreeRoot, ['worktree', 'add', '-q', '-b', `wt-outside-${MARKERS.branchName}`, outsideWorktree]);
  const renamedPath = `renamed 名前 ${MARKERS.pathName}.txt`;
  git(worktreeRoot, ['mv', 'a.txt', renamedPath]);
  git(worktreeRoot, ['rm', '-q', 'c.txt']);
  fs.writeFileSync(path.join(worktreeRoot, 'b.txt'), 'b1 staged\nb2\n');
  git(worktreeRoot, ['add', 'b.txt']);
  fs.writeFileSync(path.join(worktreeRoot, 'b.txt'), 'b1 staged\nb2 unstaged\n');
  const longLine = `long ${'x'.repeat(500)}`;
  fs.writeFileSync(path.join(worktreeRoot, 'd.txt'), [
    'd1',
    `d2 ${MARKERS.diffLine}`,
    `api_key = sk-${MARKERS.diffSecret}abcdefghijklmnop`,
    `password: ${MARKERS.diffPassword}`,
    '-----BEGIN RSA PRIVATE KEY-----',
    `MIIE${MARKERS.pemBody}AAAA`,
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
    '-----END RSA PRIVATE KEY-----',
    longLine,
    ...Array.from({ length: 60 }, (unused, index) => `extra line ${index}`),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(worktreeRoot, '新規 ファイル.txt'), 'new\n');
  fs.writeFileSync(path.join(worktreeRoot, '.env.local'), 'SECRET=1\n');
  fs.writeFileSync(path.join(worktreeRoot, 'private', `${MARKERS.hiddenPath}.md`), 'p changed\n');
  fs.writeFileSync(path.join(worktreeRoot, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 5]));

  withReadOnlyCheck('作業ツリーのリポジトリ', worktreeRoot, () => {
    const reader = makeReader(worktreeRoot);
    const details = reader.getWorktreeDetails({});
    checkEnvelope(details, 'get_worktree_details', '作業ツリー');
    const facts = details.facts;
    const counts = facts.counts;
    check(counts.staged === 3 && counts.unstaged === 4 && counts.untracked === 2 && counts.deleted === 1 && counts.renamed === 1 && counts.conflicted === 0 && counts.total === 8, `作業ツリー: counts（staged 3・unstaged 4・untracked 2・deleted 1・renamed 1・total 8）${JSON.stringify(counts)}`);
    const byPath = new Map((facts.files || []).map(file => [file.path, file]));
    const renamed = byPath.get(renamedPath);
    check(renamed?.kind === 'staged' && renamed.indexStatus === 'R' && renamed.renamedFrom === 'a.txt', '作業ツリー: rename（日本語・空白入りの名前、元のパス）');
    check(byPath.get('c.txt')?.indexStatus === 'D' && byPath.get('c.txt')?.kind === 'staged', '作業ツリー: staged 削除');
    check(byPath.get('b.txt')?.kind === 'both' && byPath.get('b.txt')?.insertions === 2 && byPath.get('b.txt')?.deletions === 2, '作業ツリー: staged と unstaged の両方の変更と行数');
    check(byPath.get('新規 ファイル.txt')?.kind === 'untracked' && byPath.get('bin.dat')?.insertions === null, '作業ツリー: untracked と、バイナリの行数は null');
    check(facts.files.length === 6 && facts.omittedHiddenPaths === 2 && !JSON.stringify(details).includes(MARKERS.hiddenPath) && !JSON.stringify(details).includes('.env.local'), '作業ツリー: 非公開の 2 件は名前を出さない');
    check(facts.diffStat.staged?.filesChanged === 3 && facts.diffStat.unstaged?.filesChanged === 4 && facts.diffStat.unstaged.binaryFiles === 1, '作業ツリー: diffStat（staged・unstaged）');
    check(facts.operationInProgress === null, '作業ツリー: 進行中の操作なし');
    const worktrees = facts.worktrees || [];
    const outside = worktrees.find(entry => !entry.isInsideProject);
    const inner = worktrees.find(entry => entry.isInsideProject && !entry.isMain);
    check(worktrees.length === 3 && worktrees[0].isMain && worktrees[0].isCurrent && worktrees[0].path === '.' && worktrees[0].branch === 'main', `作業ツリー: worktree の一覧（main は '.'）${JSON.stringify(worktrees.map(entry => entry.path))}`);
    check(outside?.path === null && outside.branch === `wt-outside-${MARKERS.branchName}` && /^[0-9a-f]{40}$/.test(outside.headSha), '作業ツリー: プロジェクト外の linked worktree は位置を出さない');
    check(inner?.path === 'inner-wt' && inner.branch === 'wt-inner', '作業ツリー: プロジェクト内の linked worktree は相対パス');
    check(!JSON.stringify(details).includes('外部 worktree'), '作業ツリー: プロジェクト外の worktree のパスが応答に無い');
    if (submoduleAdded) {
      const submodule = (facts.submodules || [])[0];
      check(facts.submodules?.length === 1 && submodule.path === submodulePath && submodule.recordedCommit === gitOutput(submoduleSource, ['rev-parse', 'HEAD']) && submodule.state === 'matchesRecordedCommit', 'サブモジュール: 記録されたコミットと状態');
    } else {
      skip('サブモジュール: 記録されたコミットと状態', 'git submodule add に失敗しました');
    }
    const patches = facts.patches || [];
    const patchKeys = patches.map(patch => `${patch.stage}:${patch.path}`).sort();
    check(JSON.stringify(patchKeys) === JSON.stringify(['staged:b.txt', 'staged:c.txt', 'unstaged:b.txt', 'unstaged:d.txt']), `差分の抜粋: 対象（バイナリ・非公開・行の変化なしの rename を除く）${JSON.stringify(patchKeys)}`);
    const dPatch = patches.find(patch => patch.path === 'd.txt');
    const changedLineCount = dPatch ? dPatch.lines.filter(line => !line.startsWith('@@')).length : 0;
    check(dPatch?.truncated === true && changedLineCount <= 40 && dPatch.lines.every(line => line.length <= 201) && dPatch.lines.some(line => line.includes(MARKERS.diffLine)), '差分の抜粋: 40 変更行・1 行 200 文字までに切り、truncated を付ける');
    const patchJson = JSON.stringify(patches);
    check(!patchJson.includes(MARKERS.diffSecret) && !patchJson.includes(MARKERS.diffPassword) && !patchJson.includes(MARKERS.pemBody) && !patchJson.includes('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'), '差分の抜粋: 秘密値（sk-・password:・PEM の本体）を伏せる');
    check(Buffer.byteLength(patchJson, 'utf8') <= 64 * 1024 && patches.length <= 20, '差分の抜粋: 合計 64 KiB・20 ファイルまで');

    const page = reader.getWorktreeDetails({ limit: 2 });
    check(page.facts.files.length === 2 && page.page.nextOffset === 2 && page.page.total === 6, 'ページング: worktree の files（limit 2 → nextOffset 2）');
    const last = reader.getWorktreeDetails({ offset: 4, limit: 2 });
    check(last.facts.files.length === 2 && last.page.nextOffset === null, 'ページング: 最後のページは nextOffset null');
    const stagedOnly = reader.getWorktreeDetails({ category: 'staged' });
    check(stagedOnly.facts.files.length === 3 && stagedOnly.facts.files.every(file => file.kind === 'staged' || file.kind === 'both'), 'category staged で絞る');
    check(reader.getWorktreeDetails({ category: 'renamed' }).facts.files.length === 1 && reader.getWorktreeDetails({ category: 'deleted' }).facts.files.length === 1, 'category renamed・deleted で絞る');
    const noUntracked = reader.getWorktreeDetails({ includeUntracked: false });
    check(noUntracked.facts.counts.untracked === 0 && noUntracked.facts.counts.total === 6, 'includeUntracked false: 未追跡を数えない');

    const noExcerpts = makeReader(worktreeRoot, { exposure: { diffExcerpts: false } }).getWorktreeDetails({});
    check(noExcerpts.facts.patches === undefined && noExcerpts.meta.hidden.includes('diffExcerpts') && !JSON.stringify(noExcerpts).includes(MARKERS.diffLine), '権限 diffExcerpts=false: 差分の抜粋を返さず hidden に出す');
    const noPaths = makeReader(worktreeRoot, { exposure: { paths: false } }).getWorktreeDetails({});
    const noPathsJson = JSON.stringify(noPaths);
    check(noPaths.facts.files === undefined && noPaths.facts.patches === undefined && noPaths.meta.hidden.includes('paths') && !noPathsJson.includes(MARKERS.pathName) && !noPathsJson.includes('新規') && !noPathsJson.includes('inner-wt') && !noPathsJson.includes('サブ モジュール'), '権限 paths=false: 作業ツリーのパス・worktree の位置・サブモジュールのパス・差分を返さない');
    check(noPaths.facts.counts.total === 8, '権限 paths=false: 件数は返す');
    const noBranchNames = makeReader(worktreeRoot, { exposure: { branchNames: false } }).getWorktreeDetails({});
    check(!JSON.stringify(noBranchNames).includes(MARKERS.branchName) && noBranchNames.meta.hidden.includes('branchNames') && noBranchNames.facts.worktrees[0].branch === 'main', '権限 branchNames=false: 他の worktree のブランチ名を出さず、現在のブランチは出す');
    const summary = reader.getSummary();
    check(summary.counts.staged === 3 && summary.counts.unstaged === 4 && summary.counts.untracked === 2 && summary.uncommittedCount === 8, 'getSummary: 作業ツリーの件数');
    const activity = reader.getRecentActivity({ days: 7 });
    check(activity.facts.commitsInWindow === 0 && activity.facts.uncommitted.count === 8 && activity.facts.uncommitted.newestChangedFileModifiedAt !== null && activity.inferences.some(item => item.confidence === 'low'), '最近の活動: コミットが無くても未コミットの変更と最新の更新日時（参考値）');
    check(!JSON.stringify([details, page, summary, activity]).includes(AUTHOR_EMAIL), '作業ツリー: メールアドレスを返さない');
  });

  if (submoduleAdded) {
    const checkedOut = path.join(worktreeRoot, ...submodulePath.split('/'));
    commitAll(checkedOut, 'sub moved', daysAgo(1), { 'lib.txt': 'lib2\n' });
    const moved = makeReader(worktreeRoot).getWorktreeDetails({});
    check(moved.facts.submodules?.[0]?.state === 'commitChanged', 'サブモジュール: 中のコミットが記録と違えば commitChanged');
    const outsideRoots = invocations.filter(args => {
      const index = args.indexOf('-C');
      const target = args[index + 1] || '';
      return target.includes('サブ モジュール') || target.includes('外部 worktree') || target.includes('inner-wt');
    });
    check(outsideRoots.length === 0, 'サブモジュール・linked worktree の中で Git を実行しない');
  }
}

// merge 競合の途中のリポジトリを検査する（競合は試験側の git merge で作る。読み取り層は merge しない）。
function testConflict() {
  const conflictRoot = path.join(workRoot, '競合 中');
  initRepository(conflictRoot);
  commitAll(conflictRoot, 'base', daysAgo(5), { 'x.txt': 'base\n', 'y.txt': 'y\n' });
  git(conflictRoot, ['checkout', '-q', '-b', 'other']);
  commitAll(conflictRoot, 'other side', daysAgo(4), { 'x.txt': 'other\n' });
  git(conflictRoot, ['checkout', '-q', 'main']);
  commitAll(conflictRoot, 'main side', daysAgo(3), { 'x.txt': 'main\n', 'y.txt': 'y changed\n' });
  const merged = git(conflictRoot, ['merge', 'other'], { allowFailure: true });
  if (merged.status === 0 || !fs.existsSync(path.join(conflictRoot, '.git', 'MERGE_HEAD'))) {
    skip('merge 競合の途中', '競合を作れませんでした');
    return;
  }
  withReadOnlyCheck('merge 競合の途中のリポジトリ', conflictRoot, () => {
    const reader = makeReader(conflictRoot);
    const details = reader.getWorktreeDetails({});
    const conflicted = (details.facts.files || []).find(file => file.path === 'x.txt');
    check(details.meta.status !== 'unavailable' && details.facts.counts.conflicted === 1 && conflicted?.kind === 'conflicted' && conflicted.indexStatus === 'U' && conflicted.worktreeStatus === 'U', '競合の途中: conflicted の件数と種類');
    check(details.facts.operationInProgress === 'merge', '競合の途中: operationInProgress は merge');
    check(!(details.facts.patches || []).some(patch => patch.path === 'x.txt'), '競合の途中: 競合中のファイルは差分の抜粋に出さない');
    check(reader.getSummary().counts.conflicted === 1, '競合の途中: getSummary の conflicted');
    const compared = reader.compareBranches({ base: 'main', target: 'other' });
    check(compared.facts.mergeState === 'diverged' && compared.facts.conflictIndicators.overlappingFileCount === 1, '競合の途中: compare_branches の重なり（目安）');
  });
}

// 時間・出力・応答の大きさの上限とページング、壊れた参照を検査する。
function testLimits(main) {
  const timedOut = makeReader(main.project, { timeoutMs: 1 });
  const timeoutResponse = timedOut.getBranches({});
  check(timeoutResponse.meta.status === 'unavailable' && timeoutResponse.meta.errorClass === ERROR_CLASS.TIMEOUT && timeoutResponse.meta.retryable === true, '上限: timeoutMs 1 で timeout 分類（status unavailable）');
  check(timedOut.getSummary().errorClass === ERROR_CLASS.TIMEOUT, '上限: getSummary も timeout 分類');
  check(!containsPath(JSON.stringify(timeoutResponse), fs.realpathSync(main.project)), '上限: 失敗の応答に絶対パスを載せない');
  const tooLarge = makeReader(main.project, { maxOutputBytes: 64 }).getBranches({});
  check(tooLarge.meta.status === 'unavailable' && tooLarge.meta.errorClass === ERROR_CLASS.OUTPUT_TOO_LARGE, '上限: maxOutputBytes を小さくすると output_too_large 分類');
  const noGit = createGitReader({ root: fs.realpathSync(main.project), resolveGit: () => { throw new Error('なし'); }, safeOptions: SAFE_OPTIONS, preflight: () => ({ ok: true }), redact: simpleRedact, isHiddenPath: simpleHidden, exposure: {} });
  check(noGit.getBranches({}).meta.errorClass === ERROR_CLASS.GIT_UNAVAILABLE && noGit.getSummary().errorClass === ERROR_CLASS.GIT_UNAVAILABLE, '上限: Git が無ければ git_unavailable');
  let preflightCalls = 0; // preflight の呼び出し回数。
  const blockedStart = invocations.length;
  const blocked = createGitReader({
    root: fs.realpathSync(main.project), resolveGit: () => gitPath, safeOptions: SAFE_OPTIONS,
    preflight: () => { preflightCalls += 1; return { ok: false, errorClass: ERROR_CLASS.UNSAFE_GIT_CONFIG, reason: 'Git の情報を取得しません: .git/config に実行を伴いうる設定があります: core.fsmonitor' }; },
    redact: simpleRedact, isHiddenPath: simpleHidden, exposure: { branchNames: true }, onGitInvocation: args => invocations.push(args),
  });
  const blockedResponses = [blocked.getBranches({}), blocked.getBranchDetails({ branch: 'main' }), blocked.compareBranches({ base: 'main', target: 'main' }), blocked.getWorktreeDetails({}), blocked.getRecentActivity({})];
  check(blockedResponses.every(response => response.meta.status === 'unavailable' && response.meta.errorClass === ERROR_CLASS.UNSAFE_GIT_CONFIG) && blocked.getSummary().errorClass === ERROR_CLASS.UNSAFE_GIT_CONFIG, 'preflight が ok:false なら、その分類で unavailable');
  check(invocations.length === blockedStart && preflightCalls === 6, 'preflight が ok:false なら Git を一切実行せず、呼び出しごとに 1 回だけ preflight を呼ぶ');
  const notRepository = path.join(workRoot, 'Git ではない');
  fs.mkdirSync(notRepository, { recursive: true });
  const outside = makeReader(notRepository).getBranches({});
  check(outside.meta.status === 'unavailable' && [ERROR_CLASS.NOT_A_GIT_REPOSITORY, ERROR_CLASS.GIT_ERROR].includes(outside.meta.errorClass), `Git リポジトリでない場所は unavailable（分類: ${outside.meta.errorClass}）`);

  const reader = makeReader(main.project);
  const firstPage = reader.getBranches({ limit: 2 });
  const secondPage = reader.getBranches({ offset: 2, limit: 2 });
  const lastPage = reader.getBranches({ offset: 4, limit: 2 });
  check(firstPage.facts.branches.length === 2 && firstPage.page.nextOffset === 2 && secondPage.page.nextOffset === 4 && lastPage.page.nextOffset === null && lastPage.facts.branches.length === 2, 'ページング: offset と limit、nextOffset');
  const pageNames = [...firstPage.facts.branches, ...secondPage.facts.branches, ...lastPage.facts.branches].map(branch => `${branch.kind}:${branch.name}`);
  check(new Set(pageNames).size === 6, 'ページング: ページをつなぐと重複なく全件');

  const many = path.join(workRoot, '多数 ブランチ');
  initRepository(many);
  commitAll(many, 'only commit', daysAgo(1), { 'a.txt': 'a\n' });
  git(many, ['branch', '-q', 'upstream-local']);
  git(many, ['branch', '-q', '--set-upstream-to=upstream-local', 'main']);
  const headSha = gitOutput(many, ['rev-parse', 'HEAD']);
  const packedLines = ['# pack-refs with: peeled fully-peeled '];
  for (let index = 0; index < 300; index += 1) packedLines.push(`${headSha} refs/heads/long/${String(index).padStart(3, '0')}-${'n'.repeat(1400)}`);
  packedLines.push(`${headSha} refs/heads/bad name`);
  fs.writeFileSync(path.join(many, '.git', 'packed-refs'), `${packedLines.join('\n')}\n`);
  fs.mkdirSync(path.join(many, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(many, '.git', 'refs', 'heads', 'broken-object'), `${'d'.repeat(40)}\n`);
  withReadOnlyCheck('多数のブランチのリポジトリ', many, () => {
    const started = Date.now();
    const big = makeReader(many).getBranches({ limit: 200 });
    const elapsed = Date.now() - started;
    const size = Buffer.byteLength(JSON.stringify(big), 'utf8');
    check(big.meta.truncated === true && big.meta.status === 'partial' && size <= DEFAULT_MAX_RESPONSE_BYTES && big.facts.branches.length < 200 && big.page.returned === big.facts.branches.length && big.page.nextOffset === big.facts.branches.length, `応答の大きさの上限: 300 本の長い名前で fitToBudget が効き、page を実際の件数に合わせる（${big.facts.branches.length} 本・${size} バイト・${elapsed} ms）`);
    check(big.facts.counts.local === 302 && !JSON.stringify(big).includes('bad name') && !JSON.stringify(big).includes('broken-object'), `壊れた参照: 例外にせず、壊れた名前・欠けたオブジェクトを指す参照は一覧に出さない（local ${big.facts.counts.local}）`);
    const head = big.facts.branches[0];
    check(head?.name === 'main' && head.upstream === 'upstream-local' && head.upstreamState === 'tracking' && head.aheadOfUpstream === 0 && Number.isFinite(Date.parse(head.lastCommitAt)), '壊れた参照: オブジェクトを読まない列挙でも、日時と上流との差を別に読む');
    check(big.meta.warnings.some(warning => warning.includes('壊れた参照')), '壊れた参照: Git が読み飛ばした件数を warnings に書く');
  });
}

// 読み取り層が実行した Git の引数を監査する（固定オプション・ルート・許可リスト・差分プログラムの無効化）。
function testInvocationAudit() {
  const problems = []; // 問題のあった呼び出し。
  for (const args of invocations) {
    const rootIndex = args.indexOf('-C');
    const subcommandArgs = rootIndex >= 0 ? args.slice(rootIndex + 2) : [];
    const subcommand = subcommandArgs[0];
    let allowed = true; // 許可リストに合うか。
    try { assertAllowedGitInvocation(subcommandArgs); } catch { allowed = false; }
    const startsSafe = SAFE_OPTIONS.every((option, index) => args[index] === option);
    const hasFixed = ['core.quotepath=false', 'color.ui=false', 'log.showSignature=false'].every(option => args.includes(option));
    const diffSafe = !['diff', 'log'].includes(subcommand) || (subcommandArgs.includes('--no-ext-diff') && subcommandArgs.includes('--no-textconv'));
    if (!startsSafe || !hasFixed || !allowed || !diffSafe || !readerRoots.has(args[rootIndex + 1])) problems.push(args.join(' ').slice(0, 160));
  }
  check(invocations.length > 0 && problems.length === 0, `監査: すべての Git 呼び出し（${invocations.length} 回）が固定オプション付き・プロジェクトルート・許可リスト内・diff/log は外部差分と変換を無効化${problems.length ? `（問題: ${problems.slice(0, 3).join(' / ')}）` : ''}`);
  const subcommands = new Set(invocations.map(args => args[args.indexOf('-C') + 2]));
  check(![...subcommands].some(name => ['merge', 'merge-tree', 'checkout', 'fetch', 'commit', 'reset', 'update-ref', 'branch', 'tag', 'config', 'gc'].includes(name)), `監査: 書き込み系のサブコマンドを 1 度も実行しない（使ったもの: ${[...subcommands].sort().join('・')}）`);
  check(internalErrors.length === 0, `監査: 想定外の内部エラーが無い${internalErrors.length ? `（${internalErrors[0]?.stack?.split('\n').slice(0, 3).join(' | ')}）` : ''}`);
}

// 環境変数 BRIDGE_REAL_REPO が指す実リポジトリで、全メソッドが例外なく 15 秒以内に終わり、unavailable でないことを確かめる（読み取りだけ）。
function testRealRepository() {
  const realRoot = process.env.BRIDGE_REAL_REPO;
  if (!realRoot) {
    skip('実リポジトリでの確認', '環境変数 BRIDGE_REAL_REPO が未設定');
    return;
  }
  // 実リポジトリは利用者の設定（safe.directory など）で読む。サーバーも利用者の設定で Git を動かすため。
  for (const [key, value] of Object.entries(originalGitEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const reader = makeReader(realRoot);
  // 1 つのメソッドを時間を測って呼び、例外・時間・状態を確かめる。
  const measure = (label, callback) => {
    const started = Date.now();
    let result = null; // 戻り値。
    let failure = null; // 例外。
    try { result = callback(); } catch (error) { failure = error; }
    const elapsed = Date.now() - started;
    const status = result?.meta?.status ?? result?.status ?? null;
    if (failure instanceof BridgeToolError && failure.errorClass === ERROR_CLASS.REF_NOT_FOUND) {
      skip(`実リポジトリ: ${label}`, '対象のブランチがありません');
      return null;
    }
    check(!failure && elapsed < 15000 && status !== 'unavailable', `実リポジトリ: ${label}（${elapsed} ms、status ${status}${result?.meta?.errorClass ? `、${result.meta.errorClass}` : ''}${failure ? `、例外 ${failure.message}` : ''}）`);
    return result;
  };
  const branches = measure('get_git_branches', () => reader.getBranches({}));
  const names = (branches?.facts?.branches || []).map(branch => branch.name);
  const first = branches?.facts?.repository?.currentBranch || names[0] || 'main';
  measure('get_branch_details', () => reader.getBranchDetails({ branch: first }));
  if (names.length >= 2) measure('compare_branches', () => reader.compareBranches({ base: names[0], target: names[1] }));
  else skip('実リポジトリ: compare_branches', 'ブランチが 2 本未満');
  measure('get_worktree_details', () => reader.getWorktreeDetails({}));
  measure('get_recent_activity', () => reader.getRecentActivity({ days: 30 }));
  measure('getSummary', () => reader.getSummary());
}

try {
  if (!gitPath) {
    skip('Git の詳細ツールの試験', 'git がありません');
  } else {
    fs.mkdirSync(workRoot, { recursive: true });
    fs.writeFileSync(globalConfig, '', 'utf8');
    testAllowList();
    const main = buildMainProject();
    testMainProject(main);
    testLegacyCounting(main);
    testExposure(main);
    testInjection(main);
    testRepositoryShapes(main);
    testUnborn();
    testShallow(main);
    testWorktree();
    testConflict();
    testLimits(main);
    testRealRepository();
    testInvocationAudit();
  }
} catch (error) {
  process.stdout.write(`FAIL 例外: ${error?.stack || error}\n`);
  failures += 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
process.stdout.write(`集計: PASS ${passes} / FAIL ${failures} / SKIP ${skips}\n`);
process.stdout.write(failures === 0 ? 'GIT_TOOLS_SELFTEST PASS\n' : `GIT_TOOLS_SELFTEST FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
