#!/usr/bin/env node
/*
  公開境界の防御を一時プロジェクトで検証する（Windows / Linux 共通、外部ネットワークなし）。
  - Git情報の既定非公開と gitExposure 有効時の拒否範囲
  - 秘密情報のマスク
  - 機微ファイル名とバイナリの拒否
  - プロジェクト外の承認ファイルによる公開範囲の承認
  - 使えない文字・名前を含む公開設定の拒否（--print-exposure・単独起動・ハブ）と表示用の引用
  - 大きな公開範囲の --print-exposure がパイプ越しに途中で切れないこと
  - .git/config の実行を伴う設定（fsmonitor・フィルターなど）でコマンドを動かさないこと
  - 承認ファイルとその置き場所の所有者・権限が安全でなければ承認として扱わないこと（POSIX）
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'); // 同梱MCP本体。
// Windowsの Node は、パスを含まないコマンド名（git など）をPATHより先に作業フォルダーから探す。
// 試験を呼んだ作業フォルダー（プロジェクト直下のことがある）の git.exe を実行しないよう、同梱スクリプトのフォルダーへ移る。
if (process.platform === 'win32') process.chdir(path.dirname(serverPath));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bridge-security-')); // この試験だけの削除対象。
const projectRoot = path.join(temporaryRoot, 'project'); // 模擬プロジェクトルート。
const configPath = path.join(projectRoot, '.chatgpt-project-bridge.json'); // 模擬公開設定。
const approvalPath = path.join(temporaryRoot, 'approval.json'); // 模擬承認ファイル（プロジェクト外）。
const MARKERS = {
  commitSubject: 'COMMIT_SUBJECT_MARKER_7Q',
  changedPath: 'CHANGED_PATH_MARKER_7Q',
  deniedPath: 'DENIED_PATH_MARKER_7Q',
  sensitivePath: 'SENSITIVE_PATH_MARKER_7Q',
  pemBody: 'PEMBODYMARKER7Q',
  jsonPassword: 'JSONPASSMARKER7Q',
  japanesePassword: 'JPPASSMARKER7Q',
  urlPassword: 'URLPASSMARKER7Q',
  accountKey: 'ACCOUNTKEYMARKER7Q',
  envValue: 'ENVVALUEMARKER7Q',
  visible: 'VISIBLE_TEXT_MARKER_7Q',
}; // 応答への出現有無で判定する非秘密マーカー。
const JWT_SAMPLE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJKV1RNQVJLRVI3USJ9.c2lnbmF0dXJlLW1hcmtlcg'; // マスク対象の模擬JWT。
const BASE_CONFIG = {
  schemaVersion: 1,
  projectName: 'Security Selftest',
  contextFile: 'CHATGPT_PROJECT_CONTEXT.md',
  statusFile: 'CHATGPT_PROJECT_STATUS.md',
  allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md', '.env', 'id_rsa', 'secrets.txt', 'binary.dat'],
  allowDirectories: [],
  denyDirectories: ['.git', 'private'],
  maxDocumentBytes: 524288,
}; // 機微ファイルをあえて許可リストへ入れた模擬設定。

let failures = 0; // 合格しなかった検査数。

// 判定を表示して失敗数へ反映する。
function check(condition, label) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  if (!condition) failures += 1;
}

// 模擬設定を書き込む。overridesで項目を上書きする。
function writeConfig(overrides = {}) {
  fs.writeFileSync(configPath, JSON.stringify({ ...BASE_CONFIG, ...overrides }, null, 2), 'utf8');
}

// 現在の模擬設定の公開範囲と指紋を得る。
function printExposure() {
  return JSON.parse(execFileSync(process.execPath, [serverPath, '--print-exposure', '--project-root', projectRoot, '--config', configPath], { encoding: 'utf8' }));
}

// 承認ファイルを、管理コマンドの approve と同じく所有者だけが書ける形（ファイル 0600・置き場所 0700）で書く。umask が 0002 でも崩れないよう chmod で揃える。
function writeApprovalFile(approvalFile, record) {
  fs.mkdirSync(path.dirname(approvalFile), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(approvalFile), 0o700);
  fs.writeFileSync(approvalFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(approvalFile, 0o600);
}

// 現在の模擬設定を承認済みにする。sha256を渡すとその値で書く（不一致試験用）。
function writeApproval(sha256 = null) {
  const printed = printExposure(); // 公開範囲と指紋。
  writeApprovalFile(approvalPath, { schemaVersion: 1, sha256: sha256 || printed.sha256, exposure: printed.exposure });
}

// サーバーを起動してツールを順に呼び、id別の応答と生出力を返す。
function callTools(calls, withApproval = true) {
  return new Promise((resolve, reject) => {
    const serverArgs = [serverPath, '--stdio', '--project-root', projectRoot, '--config', configPath]; // 起動引数。
    if (withApproval) serverArgs.push('--approval-file', approvalPath);
    const child = spawn(process.execPath, serverArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; // 受信した生出力。
    let stderr = ''; // 診断出力。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`MCPプロセス終了コード=${code}: ${stderr}`));
      const byId = new Map(stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).map(item => [item.id, item]));
      resolve({ joined: stdout, result: id => byId.get(id)?.result, text: id => byId.get(id)?.result?.content?.[0]?.text || '' });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'security-selftest', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    calls.forEach(([name, args], index) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: args || {} } }) + '\n');
    });
    child.stdin.end();
  });
}

// 一時リポジトリでgitを実行する。署名やフックは試験用に無効化する。
function runGit(args) {
  execFileSync('git', ['-C', projectRoot, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', ...args], { stdio: 'ignore' });
}

// gitが使えるかを確認する。
function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// 模擬プロジェクトの文書と機微ファイルを作る。
function createProjectFiles() {
  fs.mkdirSync(path.join(projectRoot, 'private'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'CHATGPT_PROJECT_CONTEXT.md'), '# Context\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'CHATGPT_PROJECT_STATUS.md'), '# Status\n\n## 課題\n\nなし\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'README.md'), [
    '# Secrets',
    MARKERS.visible,
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    `b3BlbnNzaC1rZXktdjEAAAA${MARKERS.pemBody}AAAAB3NzaC1yc2EAAAADAQAB`,
    '-----END OPENSSH PRIVATE KEY-----',
    `{"password": "${MARKERS.jsonPassword}"}`,
    `パスワード：${MARKERS.japanesePassword}`,
    `postgres://admin:${MARKERS.urlPassword}@db.example.invalid/app`,
    JWT_SAMPLE,
    `DefaultEndpointsProtocol=https;AccountKey=${MARKERS.accountKey};EndpointSuffix=core.windows.net`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.env'), `API_TOKEN=${MARKERS.envValue}\n`, 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'id_rsa'), `${MARKERS.envValue}\n`, 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'secrets.txt'), `${MARKERS.envValue}\n`, 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42, 0x0a]));
}

// Git情報の既定非公開と、有効化時の拒否範囲を検査する。
async function testGitExposure() {
  if (!gitAvailable()) {
    process.stdout.write('SKIP Git公開範囲の試験（gitがありません）\n');
    return;
  }
  fs.writeFileSync(path.join(projectRoot, 'private', `${MARKERS.deniedPath}.md`), 'v1\n', 'utf8');
  runGit(['init', '-q']);
  runGit(['add', 'CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', `private/${MARKERS.deniedPath}.md`]);
  runGit(['commit', '-q', '-m', `${MARKERS.commitSubject} initial`]);
  fs.writeFileSync(path.join(projectRoot, 'private', `${MARKERS.deniedPath}.md`), 'v2\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, `${MARKERS.changedPath}.md`), 'new\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, `.env.${MARKERS.sensitivePath}`), 'x\n', 'utf8');

  writeConfig();
  writeApproval();
  const hidden = await callTools([['get_recent_changes', { days: 30, limit: 10 }], ['get_project_status', {}]]);
  check(hidden.result(2)?.isError === false && hidden.result(3)?.isError === false, 'Git既定: ツール呼び出しが成功');
  check(!hidden.joined.includes(MARKERS.commitSubject), 'Git既定: コミット件名を返さない');
  check(!hidden.joined.includes(MARKERS.changedPath) && !hidden.joined.includes(MARKERS.deniedPath), 'Git既定: ファイル名を返さない');
  check(/"untracked": [1-9]/.test(hidden.text(2)), 'Git既定: 件数は返す');
  check(hidden.text(2).includes('changedPaths') && hidden.text(2).includes('submodules'), 'Git既定: 隠した項目を hidden で示す');

  writeConfig({ gitExposure: { paths: true, commitSubjects: true } });
  writeApproval();
  const shown = await callTools([['get_recent_changes', { days: 30, limit: 10 }]]);
  check(shown.joined.includes(MARKERS.commitSubject), 'Git有効: コミット件名を返す');
  check(shown.joined.includes(MARKERS.changedPath), 'Git有効: 許可されたファイル名を返す');
  check(!shown.joined.includes(MARKERS.deniedPath), 'Git有効: denyDirectories配下のファイル名は返さない');
  check(!shown.joined.includes(MARKERS.sensitivePath), 'Git有効: 機微なファイル名は返さない');
}

// 秘密情報のマスクを検査する。
async function testRedaction() {
  writeConfig();
  writeApproval();
  const response = await callTools([['get_document', { path: 'README.md' }], ['search', { query: 'Secrets' }]]);
  check(response.result(2)?.isError === false, 'マスク: README.mdを取得できる');
  check(response.joined.includes(MARKERS.visible), 'マスク: 秘密でない本文は残る');
  for (const [label, marker] of [
    ['PEM秘密鍵の本体', MARKERS.pemBody],
    ['JSON形式のパスワード', MARKERS.jsonPassword],
    ['日本語のパスワード', MARKERS.japanesePassword],
    ['URL内の認証情報', MARKERS.urlPassword],
    ['AccountKey', MARKERS.accountKey],
    ['JWT', JWT_SAMPLE],
  ]) {
    check(!response.joined.includes(marker), `マスク: ${label}を返さない`);
  }
}

// 機微ファイル名とバイナリの拒否を検査する。
async function testSensitiveFiles() {
  writeConfig();
  writeApproval();
  const names = ['.env', 'id_rsa', 'secrets.txt', 'binary.dat']; // 許可リストに入れた拒否対象。
  const response = await callTools([...names.map(name => ['get_document', { path: name }]), ['list_documents', {}]]);
  names.forEach((name, index) => check(response.result(index + 2)?.isError === true, `機微ファイル: ${name}を拒否`));
  const listText = response.text(names.length + 2); // list_documentsの結果。
  check(!names.some(name => listText.includes(`"path": "${name}"`)), '機微ファイル: 一覧に出さない');
  check(!response.joined.includes(MARKERS.envValue), '機微ファイル: 内容を返さない');
}

// 公開範囲の承認を検査する。
async function testApproval() {
  writeConfig();
  const withoutFile = await callTools([['get_project_context', {}]], false);
  check(withoutFile.result(2)?.isError === true && withoutFile.text(2).includes('承認'), '承認: 承認ファイル指定なしは拒否');

  fs.rmSync(approvalPath, { force: true });
  const missing = await callTools([['get_project_context', {}]]);
  check(missing.result(2)?.isError === true, '承認: 承認ファイルが無ければ拒否');

  writeApproval('0'.repeat(64));
  const mismatched = await callTools([['get_project_context', {}]]);
  check(mismatched.result(2)?.isError === true, '承認: 指紋が一致しなければ拒否');

  writeApproval();
  const approved = await callTools([['get_project_context', {}]]);
  check(approved.result(2)?.isError === false, '承認: 指紋が一致すれば応答');

  const before = printExposure().sha256; // 変更前の指紋。
  writeConfig({ allowFiles: [...BASE_CONFIG.allowFiles, 'extra.md'] });
  check(printExposure().sha256 !== before, '承認: 設定を変えると指紋が変わる');
  const changed = await callTools([['get_project_context', {}]]);
  check(changed.result(2)?.isError === true, '承認: 承認後に設定を広げると拒否');
}

/*
  サーバーを1プロセス起動し、手順を順番に実行する。
  steps の各要素は [ツール名, 引数] か、呼び出しの合間に実行する関数。
  引数: serverArgs（server.mjs へ渡す引数）、steps（手順）、env（子プロセスの環境変数。省略時は現在の環境）
  戻り値: 各呼び出しの結果（isError と本文）の配列と、全出力。60秒で終わらなければプロセスを止めて失敗にする（固まる不具合で試験全体を止めない）。
*/
function runSession(serverArgs, steps, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, ...serverArgs], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCPプロセスが60秒で終わりませんでした（固まった可能性）')); }, 60000); // 固着の検出。
    child.on('close', () => clearTimeout(timer));
    const results = []; // 呼び出しごとの結果。
    let joined = ''; // 全出力。
    let pending = ''; // 改行待ちの出力。
    let stepIndex = 0; // 次に実行する手順。
    let nextId = 2; // 次の要求ID。
    let waitingId = null; // 応答待ちの要求ID。
    let stderr = ''; // 診断出力。
    // 次の手順を実行する。関数はその場で実行し、ツール呼び出しは応答を待つ。
    const advance = () => {
      while (stepIndex < steps.length && typeof steps[stepIndex] === 'function') {
        steps[stepIndex]();
        stepIndex += 1;
      }
      if (stepIndex >= steps.length) { child.stdin.end(); return; }
      const [name, args] = steps[stepIndex];
      stepIndex += 1;
      waitingId = nextId;
      nextId += 1;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: waitingId, method: 'tools/call', params: { name, arguments: args || {} } }) + '\n');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      joined += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        const item = JSON.parse(line);
        if (item.id === 1) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); advance(); continue; }
        if (item.id === waitingId) {
          results.push({ isError: item.result?.isError === true, text: item.result?.content?.[0]?.text || '' });
          try { advance(); } catch (error) { child.kill(); reject(error); }
        }
      }
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve({ results, joined }) : reject(new Error(`MCPプロセス終了コード=${code}: ${stderr}`))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'security-selftest-session', version: '1' } } }) + '\n');
  });
}

// ハブモードのサーバーを1プロセス起動し、手順を順番に実行する。
function runHubSession(hubPath, steps) {
  return runSession(['--stdio', '--hub', hubPath], steps);
}

// ハブモードで、プロジェクトごとの承認・公開範囲・名前の分離を検査する。
async function testHub() {
  const hubRoot = path.join(temporaryRoot, 'hub'); // ハブ試験の作業領域。
  const roots = { alpha: path.join(hubRoot, 'alpha'), beta: path.join(hubRoot, 'beta') }; // 2つの模擬プロジェクト。
  const approvals = { alpha: path.join(hubRoot, 'approval-alpha.json'), beta: path.join(hubRoot, 'approval-beta.json') }; // プロジェクト外の承認ファイル。
  const hubPath = path.join(hubRoot, 'hub.json'); // ハブ設定。
  const markers = { alphaOnly: 'ALPHA_ONLY_MARKER_7Q', betaContext: 'BETA_CONTEXT_MARKER_7Q', betaOnly: 'BETA_ONLY_MARKER_7Q' }; // 混入検出用マーカー。
  for (const [name, root] of Object.entries(roots)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_CONTEXT.md'), `# ${name} context\n${name === 'beta' ? markers.betaContext : ''}\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_STATUS.md'), '# Status\n', 'utf8');
    fs.writeFileSync(path.join(root, 'README.md'), `# ${name} readme\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'beta-only.md'), `${name === 'alpha' ? markers.alphaOnly : markers.betaOnly}\n`, 'utf8');
  }
  // 指定プロジェクトの設定を書く。beta だけ beta-only.md とGitのファイル名を公開する。
  const writeHubConfig = (name, extra = {}) => fs.writeFileSync(path.join(roots[name], '.chatgpt-project-bridge.json'), JSON.stringify({
    ...BASE_CONFIG,
    projectName: `${name} project`,
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md', ...(name === 'beta' ? ['beta-only.md'] : [])],
    gitExposure: { paths: name === 'beta', commitSubjects: false },
    ...extra,
  }), 'utf8');
  // 指定プロジェクトの現在の設定を承認する。
  const approveHub = name => {
    const printed = JSON.parse(execFileSync(process.execPath, [serverPath, '--print-exposure', '--project-root', roots[name], '--config', path.join(roots[name], '.chatgpt-project-bridge.json')], { encoding: 'utf8' }));
    writeApprovalFile(approvals[name], { schemaVersion: 1, sha256: printed.sha256, exposure: printed.exposure });
  };
  writeHubConfig('alpha');
  writeHubConfig('beta');
  approveHub('alpha');
  fs.writeFileSync(hubPath, JSON.stringify({ schemaVersion: 1, projects: [
    { name: 'alpha', root: roots.alpha, approvalFile: approvals.alpha },
    { name: 'beta', root: roots.beta, approvalFile: approvals.beta },
  ] }), 'utf8');

  const session = await runHubSession(hubPath, [
    ['list_projects', {}],                                                      // 0
    ['get_project_context', { project: 'alpha' }],                              // 1
    ['get_project_context', { project: 'beta' }],                               // 2
    ['get_project_context', {}],                                                // 3
    ['get_project_context', { project: 'gamma' }],                              // 4
    ['get_document', { project: 'alpha', path: '../beta/CHATGPT_PROJECT_CONTEXT.md' }], // 5
    ['get_document', { project: 'alpha', path: 'beta-only.md' }],               // 6
    ['search', { query: 'context' }],                                           // 7
    ['fetch', { id: 'alpha::README.md' }],                                      // 8
    ['fetch', { id: 'beta::README.md' }],                                       // 9
    () => approveHub('beta'),
    ['list_projects', {}],                                                      // 10
    ['get_document', { project: 'beta', path: 'beta-only.md' }],                // 11
    ['get_recent_changes', { project: 'alpha' }],                               // 12
    ['get_recent_changes', { project: 'beta' }],                                // 13
    () => writeHubConfig('beta', { allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md', 'beta-only.md', 'extra.md'] }),
    ['get_project_context', { project: 'beta' }],                               // 14
    ['get_project_context', { project: 'alpha' }],                              // 15
  ]);
  const result = session.results; // 呼び出しごとの結果。
  check(!result[0].isError && result[0].text.includes('"alpha"') && !result[0].text.includes('"beta"'), 'ハブ: list_projects は承認済みのプロジェクトだけを返す');
  check(!result[1].isError && result[1].text.includes('"project": "alpha"'), 'ハブ: 承認済みプロジェクトを project 指定で読める（応答に project を含む）');
  check(result[2].isError && !result[2].text.includes(markers.betaContext), 'ハブ: 未承認プロジェクトは拒否');
  check(result[3].isError, 'ハブ: project 指定なしは拒否');
  check(result[4].isError && result[4].text.replace('gamma', 'beta') === result[2].text, 'ハブ: 未登録の名前は未承認と同じ文言で拒否（存在を明かさない）');
  check(result[5].isError && !result[5].text.includes(markers.betaContext), 'ハブ: 別プロジェクトへの相対パスを拒否');
  check(result[6].isError && !result[6].text.includes(markers.alphaOnly), 'ハブ: 許可リストはプロジェクトごと（他プロジェクトの許可を流用しない）');
  check(!result[7].isError && result[7].text.includes('alpha::') && !result[7].text.includes('beta::'), 'ハブ: project なしの検索は承認済みプロジェクトだけを対象にする');
  check(!result[8].isError && result[8].text.includes('alpha readme'), 'ハブ: fetch は「プロジェクト名::相対パス」の文書IDで読める');
  check(result[9].isError, 'ハブ: fetch でも未承認プロジェクトは拒否');
  check(!result[10].isError && result[10].text.includes('"beta"'), 'ハブ: 承認すると再起動なしで list_projects に現れる');
  check(!result[11].isError && result[11].text.includes(markers.betaOnly), 'ハブ: 承認後は beta 自身の許可リストで読める');
  check(!result[12].isError && /"hidden": \[[^\]]*"changedPaths"/.test(result[12].text), 'ハブ: alpha の Git ファイル名は alpha の設定どおり非公開');
  check(!result[13].isError && !/"hidden": \[[^\]]*"changedPaths"/.test(result[13].text), 'ハブ: beta の Git 設定は alpha に影響されない');
  check(result[14].isError, 'ハブ: 承認後に beta の設定を変えると beta だけ拒否に戻る');
  check(!result[15].isError, 'ハブ: そのとき alpha は引き続き読める');

  // アクセスログと通知の間引き。dryRun で通知コマンドは起動しない。この時点で alpha は承認済み、beta は未承認。
  const accessLog = path.join(hubRoot, 'state', 'access.log'); // アクセスログの保存先。
  check(!fs.existsSync(accessLog), 'アクセス記録: 設定が無ければログを書かない');
  fs.writeFileSync(hubPath, JSON.stringify({
    schemaVersion: 1,
    notifications: { start: true, access: true, intervalSeconds: 60, dryRun: true },
    accessLog,
    projects: [
      { name: 'alpha', root: roots.alpha, approvalFile: approvals.alpha },
      { name: 'beta', root: roots.beta, approvalFile: approvals.beta },
    ],
  }), 'utf8');
  await runHubSession(hubPath, [
    ['get_project_context', { project: 'alpha' }],
    ['get_project_status', { project: 'alpha' }],
    ['get_project_context', { project: 'beta' }],
    ['list_projects', {}],
  ]);
  const entries = fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []; // 記録されたアクセス。
  check(entries.length === 4, 'アクセス記録: 呼び出しをすべてログに書く');
  check(entries[0]?.project === 'alpha' && entries[0]?.tool === 'get_project_context' && entries[0]?.ok === true && entries[0]?.notified === true, 'アクセス記録: 最初のアクセスは通知する');
  check(entries[1]?.project === 'alpha' && entries[1]?.notified === false, 'アクセス記録: 同じプロジェクトは1分以内なら通知をまとめる');
  check(entries[2]?.project === 'beta' && entries[2]?.ok === false && entries[2]?.notified === true, 'アクセス記録: 拒否した呼び出しも記録し、別プロジェクトは別に通知する');
  check(entries[3]?.project === '(一覧)' && entries[3]?.tool === 'list_projects', 'アクセス記録: list_projects も記録する');
  check(!fs.readFileSync(accessLog, 'utf8').includes(markers.betaContext), 'アクセス記録: 文書の内容はログに書かない');
  if (process.platform !== 'win32') check((fs.statSync(accessLog).mode & 0o777) === 0o600, 'アクセス記録: ログは0600');
}

const FORBIDDEN_MESSAGE = '公開範囲の設定に使えない文字が含まれています: '; // 使えない文字・名前を含む設定を拒否したときのエラー文の先頭。
/*
  表示用の引用の試験ベクトル（共通仕様 S2）。期待値は S2 の規則どおりに書く。
  仕様書の表では U+2028・U+202E・U+3000 の行の期待値が生の文字になっているが、規則（\uXXXX にする）を優先する。
*/
const DISPLAY_VECTORS = [
  ['README.md', '"README.md"'],
  ['a"b', String.raw`"a\"b"`],
  ['a\\b', String.raw`"a\\b"`],
  ['x\ny', String.raw`"x\u000ay"`],
  ['a\u2028b', String.raw`"a\u2028b"`],
  ['a\u202eb', String.raw`"a\u202eb"`],
  ['a\u3000b', String.raw`"a\u3000b"`],
  ['a\tb', String.raw`"a\u0009b"`],
  ['日本語 a b', '"日本語 a b"'],
  ['\u{1F600}', '"\u{1F600}"'],
  ['\u{E0041}', String.raw`"\U000e0041"`],
  ['', '""'],
];

// 概要・状態・READMEだけの模擬プロジェクトを作る。
function createSimpleProject(root, label) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_CONTEXT.md'), `# ${label} context\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_STATUS.md'), '# Status\n\n## 課題\n\nなし\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), `# ${label} readme\n`, 'utf8');
}

// 指定プロジェクトへ公開設定を書き、--print-exposure の終了コード・標準出力・エラー出力を返す。
function printExposureFor(root, config) {
  const target = path.join(root, '.chatgpt-project-bridge.json'); // 公開設定の場所。
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf8');
  return spawnSync(process.execPath, [serverPath, '--print-exposure', '--project-root', root, '--config', target], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

// 指定プロジェクトの現在の設定を承認し、単独モードの起動引数を返す。
function approveSingle(root, config, approvalFile) {
  const printed = JSON.parse(printExposureFor(root, config).stdout); // 公開範囲と指紋。
  writeApprovalFile(approvalFile, { schemaVersion: 1, sha256: printed.sha256, exposure: printed.exposure });
  return ['--stdio', '--project-root', root, '--config', path.join(root, '.chatgpt-project-bridge.json'), '--approval-file', approvalFile];
}

/*
  正規化済みの簡単な設定（allowDirectories なし）について、server.mjs と同じ形の公開範囲から指紋を求める。
  旧版で承認済みになっている不正な設定（今の版は指紋を出さない）を再現するために使う。
*/
function replicaExposureSha(root, config) {
  const exposure = {
    schemaVersion: 1,
    projectRoot: fs.realpathSync.native(root),
    contextFile: config.contextFile,
    statusFile: config.statusFile,
    allowFiles: [...new Set(config.allowFiles)].sort(),
    allowDirectories: [],
    denyDirectories: [...new Set(config.denyDirectories)].sort(),
    maxDocumentBytes: config.maxDocumentBytes,
    gitExposure: { paths: config.gitExposure?.paths === true, commitSubjects: config.gitExposure?.commitSubjects === true },
  }; // server.mjs の buildExposure と同じ順序の公開範囲。
  return crypto.createHash('sha256').update(JSON.stringify(exposure), 'utf8').digest('hex');
}

// 使えない文字・名前を含む公開設定を、設定全体の不正として拒否することを検査する（--print-exposure・単独起動・ハブ）。
async function testForbiddenConfig() {
  const root = path.join(temporaryRoot, 'forbidden'); // 拒否試験の模擬プロジェクト。
  const approvalFile = path.join(temporaryRoot, 'approval-forbidden.json'); // 拒否試験の承認ファイル。
  const baseConfig = { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'] }; // 拒否試験の土台になる正常な設定。
  createSimpleProject(root, 'forbidden');
  // 設定が拒否され、指紋を出さず、期待した項目名と引用値をエラー文で示すかを検査する。
  const expectRejected = (overrides, expected, label) => {
    const printed = printExposureFor(root, { ...baseConfig, ...overrides });
    check(printed.status !== 0 && !/[0-9a-f]{64}/.test(printed.stdout) && printed.stderr.includes(FORBIDDEN_MESSAGE + expected), `設定の拒否: ${label}`);
  };
  for (const [name, quoted] of [
    ['key.pem.', '"key.pem."'],
    ['server.key ', '"server.key "'],
    ['.npmrc.', '".npmrc."'],
    ['.git./config', '".git./config"'],
    ['a:b', '"a:b"'],
    ['x\u2028y', String.raw`"x\u2028y"`],
  ]) {
    expectRejected({ allowFiles: [...baseConfig.allowFiles, name] }, `allowFiles[3] = ${quoted}`, `調査で使われた名前 ${quoted}`);
  }
  if (process.platform === 'win32') {
    expectRejected({ allowFiles: [...baseConfig.allowFiles, 'ENV~1'] }, 'allowFiles[3] = "ENV~1"', '8.3短縮名 "ENV~1"');
    expectRejected({ allowFiles: [...baseConfig.allowFiles, 'GIT~1/config'] }, 'allowFiles[3] = "GIT~1/config"', '8.3短縮名 "GIT~1/config"');
  } else {
    process.stdout.write('SKIP 設定の拒否: 8.3短縮名 "ENV~1"・"GIT~1/config"（Windowsだけで拒否する）\n');
  }
  expectRejected({ contextFile: 'CONTEXT\n.md' }, String.raw`contextFile = "CONTEXT\u000a.md"`, 'contextFile の改行');
  expectRejected({ statusFile: '\ufeffSTATUS.md' }, String.raw`statusFile = "\ufeffSTATUS.md"`, 'statusFile の BOM');
  expectRejected({ allowDirectories: [{ path: 'docs\u202e', recursive: true }] }, String.raw`allowDirectories[0].path = "docs\u202e"`, 'allowDirectories の書式文字');
  expectRejected({ denyDirectories: ['.git', 'private\u2029'] }, String.raw`denyDirectories[1] = "private\u2029"`, 'denyDirectories の段落区切り（拒否範囲を黙って捨てない）');
  expectRejected({ projectName: 'Name\u202etxt.md' }, String.raw`projectName = "Name\u202etxt.md"`, 'projectName の書式文字');
  for (const [character, escaped] of [
    ['\u0000', String.raw`\u0000`], ['\u007F', String.raw`\u007f`], ['\u0085', String.raw`\u0085`], ['\u00ad', String.raw`\u00ad`],
    ['\u061c', String.raw`\u061c`], ['\u200b', String.raw`\u200b`], ['\u2066', String.raw`\u2066`], ['\uD800', String.raw`\ud800`], ['\u{E0001}', String.raw`\U000e0001`],
  ]) {
    expectRejected({ allowFiles: [`bad${character}name.md`] }, `allowFiles[0] = "bad${escaped}name.md"`, `使えない文字 ${escaped}`);
  }
  // 表示用の引用（S2）。拒否させるため末尾に U+0085 を足し、エラー文の引用値で確かめる。
  for (const [input, quoted] of DISPLAY_VECTORS) {
    expectRejected({ allowFiles: [`${input}\u0085`] }, `allowFiles[0] = ${quoted.slice(0, -1)}\\u0085"`, `表示用の引用 ${quoted}`);
  }

  // プロジェクトルートのパスに使えない文字がある場合。
  const strangeRoot = path.join(temporaryRoot, 'root\u202ename'); // 書式文字を含むプロジェクトルート。
  createSimpleProject(strangeRoot, 'strange');
  const strangePrinted = printExposureFor(strangeRoot, baseConfig);
  check(strangePrinted.status !== 0 && !/[0-9a-f]{64}/.test(strangePrinted.stdout) && strangePrinted.stderr.includes(`${FORBIDDEN_MESSAGE}projectRoot = "`) && strangePrinted.stderr.includes(String.raw`root\u202ename"`), '設定の拒否: プロジェクトルートの書式文字');

  // 日本語・絵文字・U+0020・U+3000 を含む名前と、init が作る設定は拒否しない。
  const friendlyNames = ['日本語メモ.md', '絵文字\u{1F600}.md', 'my notes.md', '全角\u3000空白.md', 'サブ フォルダ/メモ.md']; // 受け入れるべき名前。
  const friendlyMarker = 'FRIENDLY_NAME_MARKER_7Q'; // 読めたことの確認用マーカー。
  for (const name of friendlyNames) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), `# ${name}\n${friendlyMarker}\n`, 'utf8');
  }
  const friendlyConfig = { ...baseConfig, projectName: '日本語 プロジェクト\u{1F600}', allowFiles: [...baseConfig.allowFiles, ...friendlyNames] }; // 受け入れるべき設定。
  const friendlyPrinted = printExposureFor(root, friendlyConfig);
  let friendlyExposure = null; // 受け入れた公開範囲。
  try { friendlyExposure = JSON.parse(friendlyPrinted.stdout); } catch { friendlyExposure = null; }
  check(friendlyPrinted.status === 0 && /^[0-9a-f]{64}$/.test(friendlyExposure?.sha256 || '') && friendlyNames.every(name => friendlyExposure.exposure.allowFiles.includes(name)), '設定の受け入れ: 日本語・絵文字・半角空白・全角空白を含む名前');
  const friendlySession = await runSession(approveSingle(root, friendlyConfig, approvalFile), friendlyNames.map(name => ['get_document', { path: name }]));
  check(friendlySession.results.length === friendlyNames.length && friendlySession.results.every(item => !item.isError && item.text.includes(friendlyMarker)), '設定の受け入れ: それらの文書を読める');
  const initConfig = {
    schemaVersion: 1,
    projectName: 'forbidden',
    contextFile: 'CHATGPT_PROJECT_CONTEXT.md',
    statusFile: 'CHATGPT_PROJECT_STATUS.md',
    profileName: 'forbidden-0123456789abcdef',
    tunnelId: null,
    healthPort: null,
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'],
    allowDirectories: [],
    denyDirectories: ['.git', '.codex', '.claude', 'node_modules', 'Saved', 'Prompts', 'Documents', 'Build', 'Builds', 'dist', 'out', 'zzz-Temp'],
    maxDocumentBytes: 524288,
    gitExposure: { paths: false, commitSubjects: false },
  }; // project-bridge.py init が作る設定と同じ形。
  const initPrinted = printExposureFor(root, initConfig);
  check(initPrinted.status === 0 && /"sha256": "[0-9a-f]{64}"/.test(initPrinted.stdout), '設定の受け入れ: init が作る設定');

  // 以降は「旧版で承認済みの不正な設定」を、試験側で求めた指紋で再現する。まずその指紋の求め方がサーバーと一致することを確かめる。
  let replicaMatches = false; // 試験側の指紋がサーバーと一致したか。
  try { replicaMatches = JSON.parse(printExposureFor(root, baseConfig).stdout).sha256 === replicaExposureSha(root, baseConfig); } catch { replicaMatches = false; }
  check(replicaMatches, '設定の拒否: 試験側で求めた指紋がサーバーと一致する（承認済みの不正な設定を再現する前提）');

  // 単独起動: 承認済みの不正な設定でも起動しない。
  const badConfig = { ...baseConfig, allowFiles: [...baseConfig.allowFiles, 'key.pem.'] }; // 末尾ドットで機微名の拒否を回避する設定。
  fs.writeFileSync(path.join(root, '.chatgpt-project-bridge.json'), JSON.stringify(badConfig), 'utf8');
  writeApprovalFile(approvalFile, { schemaVersion: 1, sha256: replicaExposureSha(root, badConfig) });
  const started = spawnSync(process.execPath, [serverPath, '--stdio', '--project-root', root, '--config', path.join(root, '.chatgpt-project-bridge.json'), '--approval-file', approvalFile], {
    input: [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'security-selftest', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_project_context', arguments: {} } },
    ].map(request => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  }); // 単独モードの起動結果。
  check(started.status === 2 && started.stdout.trim() === '' && started.stderr.includes(`${FORBIDDEN_MESSAGE}allowFiles[3] = "key.pem."`), '単独起動: 承認済みでも不正な設定では起動しない');

  // ハブ: 不正な設定のプロジェクトだけを公開せず、他のプロジェクトとハブは動き続ける。
  const hubRoot = path.join(temporaryRoot, 'forbidden-hub'); // ハブ試験の作業領域。
  const hubRoots = { alpha: path.join(hubRoot, 'alpha'), gamma: path.join(hubRoot, 'gamma'), delta: path.join(hubRoot, 'delta\u202eroot') }; // 正常・不正な設定・不正なルート。
  const hubApprovals = Object.fromEntries(Object.keys(hubRoots).map(name => [name, path.join(hubRoot, `approval-${name}.json`)])); // プロジェクト外の承認ファイル。
  const hubPath = path.join(hubRoot, 'hub.json'); // ハブ設定。
  for (const [name, hubProjectRoot] of Object.entries(hubRoots)) createSimpleProject(hubProjectRoot, name);
  const gammaBad = { ...baseConfig, projectName: 'gamma', allowFiles: [...baseConfig.allowFiles, 'key.pem.'] }; // 承認済みの不正な設定。
  const deltaConfig = { ...baseConfig, projectName: 'delta' }; // 設定は正常だがルートが不正。
  approveSingle(hubRoots.alpha, { ...baseConfig, projectName: 'alpha' }, hubApprovals.alpha);
  fs.writeFileSync(path.join(hubRoots.gamma, '.chatgpt-project-bridge.json'), JSON.stringify(gammaBad), 'utf8');
  writeApprovalFile(hubApprovals.gamma, { schemaVersion: 1, sha256: replicaExposureSha(hubRoots.gamma, gammaBad) });
  fs.writeFileSync(path.join(hubRoots.delta, '.chatgpt-project-bridge.json'), JSON.stringify(deltaConfig), 'utf8');
  writeApprovalFile(hubApprovals.delta, { schemaVersion: 1, sha256: replicaExposureSha(hubRoots.delta, deltaConfig) });
  fs.writeFileSync(hubPath, JSON.stringify({ schemaVersion: 1, projects: Object.entries(hubRoots).map(([name, hubProjectRoot]) => ({ name, root: hubProjectRoot, approvalFile: hubApprovals[name] })) }), 'utf8');
  const session = await runHubSession(hubPath, [
    ['list_projects', {}],                           // 0
    ['get_project_context', { project: 'gamma' }],   // 1
    ['get_project_context', { project: 'delta' }],   // 2
    ['get_project_context', { project: 'alpha' }],   // 3
    ['search', { query: 'context' }],                // 4
    ['get_project_context', { project: 'nothing' }], // 5
    () => approveSingle(hubRoots.gamma, { ...baseConfig, projectName: 'gamma' }, hubApprovals.gamma),
    ['list_projects', {}],                           // 6
    ['get_project_context', { project: 'gamma' }],   // 7
  ]);
  const result = session.results; // 呼び出しごとの結果。
  check(!result[0].isError && result[0].text.includes('"alpha"') && !result[0].text.includes('"gamma"') && !result[0].text.includes('"delta"'), 'ハブ: 不正な設定・ルートのプロジェクトは承認済みでも list_projects に出さない');
  check(result[1].isError && result[1].text === result[5].text.replace('nothing', 'gamma'), 'ハブ: 不正な設定のプロジェクトは未登録と同じ文言で拒否');
  check(result[2].isError && !result[2].text.includes('delta context'), 'ハブ: 不正なルートのプロジェクトを拒否');
  check(!result[3].isError && result[3].text.includes('alpha context'), 'ハブ: そのときも他のプロジェクトは読める');
  check(!result[4].isError && result[4].text.includes('alpha::') && !result[4].text.includes('gamma::') && !result[4].text.includes('delta'), 'ハブ: 横断検索も不正なプロジェクトを対象にしない');
  check(!result[6].isError && result[6].text.includes('"gamma"') && !result[7].isError && result[7].text.includes('gamma context'), 'ハブ: 設定を直して承認すると再起動なしで公開される（ハブは止まらない）');
}

// 要求されたパスや走査で見つけた名前にも、設定と同じ名前の規則を当てることを検査する。
async function testRequestPathNames() {
  if (process.platform === 'win32') {
    process.stdout.write('SKIP 要求パスの名前の規則（「:」を含むファイルを作れるWindows以外で検査する）\n');
    return;
  }
  const root = path.join(temporaryRoot, 'request-names'); // 模擬プロジェクト。
  const names = { ok: 'notes/ok.md', colon: 'notes/a:b.md', bidi: 'notes/x\u202ey.md' }; // 許可ディレクトリ内の文書。
  const markers = { ok: 'REQUEST_OK_MARKER_7Q', colon: 'REQUEST_COLON_MARKER_7Q', bidi: 'REQUEST_BIDI_MARKER_7Q' }; // 応答への出現で判定するマーカー。
  createSimpleProject(root, 'request');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  for (const key of Object.keys(names)) fs.writeFileSync(path.join(root, names[key]), `# ${key}\n${markers[key]}\n`, 'utf8');
  const config = { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'], allowDirectories: [{ path: 'notes', recursive: false }] }; // notes 直下のMarkdownを公開する設定。
  const session = await runSession(approveSingle(root, config, path.join(temporaryRoot, 'approval-request-names.json')), [
    ['get_document', { path: names.ok }],
    ['get_document', { path: names.colon }],
    ['get_document', { path: names.bidi }],
    ['list_documents', {}],
  ]);
  const result = session.results; // 呼び出しごとの結果。
  check(!result[0].isError && result[0].text.includes(markers.ok), '要求パス: 通常の名前は読める');
  check(result[1].isError && !session.joined.includes(markers.colon), '要求パス: 「:」を含む名前は公開しない');
  check(result[2].isError && !session.joined.includes(markers.bidi), '要求パス: 書式文字を含む名前は公開しない');
  check(!result[3].isError && result[3].text.includes(names.ok) && !result[3].text.includes('a:b') && !result[3].text.includes('x\u202ey'), '要求パス: 一覧にも出さない');
}

// 大きな公開範囲でも、--print-exposure がパイプ越しに全量を書き切ることを検査する（64 KiB で切れない）。
async function testLargeExposureOutput() {
  const root = path.join(temporaryRoot, 'large-exposure'); // 模擬プロジェクト。
  const allowFiles = Array.from({ length: 5000 }, (unused, index) => `docs/exposure-size-check/document-${String(index).padStart(5, '0')}-with-a-fairly-long-descriptive-name.md`); // 5,000件の明示許可。
  createSimpleProject(root, 'large');
  const target = path.join(root, '.chatgpt-project-bridge.json'); // 公開設定の場所。
  fs.writeFileSync(target, JSON.stringify({ ...BASE_CONFIG, allowFiles }), 'utf8');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath, '--print-exposure', '--project-root', root, '--config', target], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; // 受け取った出力。
    child.on('error', reject);
    child.stderr.resume();
    child.stdout.on('data', chunk => chunks.push(chunk));
    // 読み手が遅い場合を再現するため、少し待ってから読み始める（パイプの容量を超える分が、終了で捨てられないかを見る）。
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 500);
    child.on('close', code => resolve({ code, bytes: Buffer.concat(chunks) }));
  }); // パイプ越しの出力と終了コード。
  let parsed = null; // 読めた公開範囲。
  try { parsed = JSON.parse(output.bytes.toString('utf8')); } catch { parsed = null; }
  check(output.code === 0 && output.bytes.length > 400 * 1024 && parsed?.exposure?.allowFiles?.length === allowFiles.length, `公開範囲の出力: 5,000件・${output.bytes.length}バイトをパイプ越しに全量受け取り、JSONとして読める`);
}

// .git/config の実行を伴う設定でコマンドを動かさず、Git情報を取得しない理由を返すことを検査する（再現した攻撃そのもの）。
async function testGitSafety() {
  if (!gitAvailable()) {
    process.stdout.write('SKIP Git安全性の試験（gitがありません）\n');
    return;
  }
  const root = path.join(temporaryRoot, 'git-safety'); // 攻撃を再現する模擬リポジトリ。
  const gitFileRoot = path.join(temporaryRoot, 'git-safety-gitfile'); // .git がファイル（gitdir:）の模擬リポジトリ。
  const markerDirectory = path.join(temporaryRoot, 'git-markers'); // コマンドが実行されたら作られるマーカーの置き場（リポジトリ外）。
  const markers = {
    fsmonitor: path.join(markerDirectory, 'FSMONITOR_RAN'),
    filter: path.join(markerDirectory, 'FILTER_RAN'),
    globalFsmonitor: path.join(markerDirectory, 'GLOBAL_FSMONITOR_RAN'),
    gitFile: path.join(markerDirectory, 'GITFILE_FSMONITOR_RAN'),
    submodule: path.join(markerDirectory, 'SUBMODULE_FILTER_RAN'),
    lfs: path.join(markerDirectory, 'LFS_CLEAN_RAN'),
    activeFsmonitor: path.join(markerDirectory, 'ACTIVE_SUBMODULE_FSMONITOR_RAN'),
    activeFilter: path.join(markerDirectory, 'ACTIVE_SUBMODULE_FILTER_RAN'),
  }; // 攻撃ごとのマーカー。
  const globalConfig = path.join(temporaryRoot, 'gitconfig-global'); // 利用者の設定から切り離したグローバル設定。
  const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }; // 試験のgitとサーバーに渡す環境。
  const tokenMarker = 'URLTOKENMARKER7Q'; // 応答に出てはいけない、設定キー内の資格情報。
  const reasonPrefix = 'Git の情報を取得しません: .git/config に実行を伴いうる設定があります: '; // Git情報を取得しない理由の先頭。
  fs.mkdirSync(markerDirectory, { recursive: true });
  fs.writeFileSync(globalConfig, '', 'utf8');
  // 試験用のgitを指定リポジトリで実行する。署名は無効にする。
  const gitIn = (repository, args) => execFileSync('git', ['-C', repository, '-c', 'commit.gpgsign=false', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', ...args], { stdio: 'ignore', env: gitEnvironment });
  // マーカーを作るだけのシェルコマンド。gitが後ろに付ける引数は「#」でコメントにして無視させる。
  const touchCommand = marker => `touch "${marker.replace(/\\/g, '/')}" #`;
  // 素の git status でコマンドが実行されるか（攻撃が再現するか）を確かめ、マーカーを消す。
  const reproducesWithPlainGit = (repository, marker) => {
    try { execFileSync('git', ['-C', repository, 'status', '--porcelain'], { stdio: 'ignore', env: gitEnvironment }); } catch { /* 失敗してもマーカーの有無で判定する。 */ }
    const reproduced = fs.existsSync(marker);
    fs.rmSync(marker, { force: true });
    return reproduced;
  };
  // 素のgitで攻撃が再現した場合だけ、サーバー経由でマーカーが作られないことを判定する。
  const markerCheck = (reproduced, created, label) => {
    if (!reproduced) {
      process.stdout.write(`SKIP ${label}（このgitでは素の git status でも再現しない）\n`);
      return;
    }
    check(created === false, label);
  };

  createSimpleProject(root, 'git-safety');
  gitIn(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=evil\n', 'utf8');
  fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n', 'utf8');
  gitIn(root, ['add', '.']);
  gitIn(root, ['commit', '-q', '-m', 'initial']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n', 'utf8'); // 大きさを変えずに内容を変え、status が clean フィルターを通して読み直す状態にする。
  const serverArgs = approveSingle(root, { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'] }, path.join(temporaryRoot, 'approval-git-safety.json')); // 単独モードの起動引数。

  // 攻撃が素のgitで再現するかを先に確かめる。
  gitIn(root, ['config', 'core.fsmonitor', touchCommand(markers.fsmonitor)]);
  const fsmonitorReproduced = reproducesWithPlainGit(root, markers.fsmonitor);
  gitIn(root, ['config', '--unset', 'core.fsmonitor']);
  gitIn(root, ['config', 'filter.evil.clean', touchCommand(markers.filter)]);
  const filterReproduced = reproducesWithPlainGit(root, markers.filter);
  gitIn(root, ['config', '--unset', 'filter.evil.clean']);
  execFileSync('git', ['config', '--file', globalConfig, 'core.fsmonitor', touchCommand(markers.globalFsmonitor)], { stdio: 'ignore', env: gitEnvironment });
  const globalReproduced = reproducesWithPlainGit(root, markers.globalFsmonitor);
  fs.writeFileSync(globalConfig, '', 'utf8');

  const observed = {}; // 各呼び出しの直後に見たマーカーの有無。
  const session = await runSession(serverArgs, [
    () => gitIn(root, ['config', 'core.fsmonitor', touchCommand(markers.fsmonitor)]),
    ['get_project_status', {}],                       // 0
    ['get_recent_changes', { days: 30, limit: 10 }],  // 1
    () => {
      observed.fsmonitor = fs.existsSync(markers.fsmonitor);
      gitIn(root, ['config', '--unset', 'core.fsmonitor']);
      gitIn(root, ['config', 'filter.evil.clean', touchCommand(markers.filter)]);
    },
    ['get_project_status', {}],                       // 2
    () => {
      observed.filter = fs.existsSync(markers.filter);
      gitIn(root, ['config', '--unset', 'filter.evil.clean']);
      gitIn(root, ['config', `url.https://${tokenMarker}@example.invalid/.insteadOf`, 'https://example.invalid/']);
    },
    ['get_project_status', {}],                       // 3
    () => gitIn(root, ['config', '--unset', `url.https://${tokenMarker}@example.invalid/.insteadOf`]),
    ['get_project_status', {}],                       // 4
    () => execFileSync('git', ['config', '--file', globalConfig, 'core.fsmonitor', touchCommand(markers.globalFsmonitor)], { stdio: 'ignore', env: gitEnvironment }),
    ['get_project_status', {}],                       // 5
    () => {
      observed.globalFsmonitor = fs.existsSync(markers.globalFsmonitor);
      fs.writeFileSync(globalConfig, '', 'utf8');
    },
  ], gitEnvironment);
  const parsed = session.results.map(item => { try { return JSON.parse(item.text); } catch { return null; } }); // 呼び出しごとの応答本文。
  check(!session.results[0].isError && parsed[0]?.liveGit?.isGitRepository === false && parsed[0]?.liveGit?.gitUnavailableReason === `${reasonPrefix}core.fsmonitor`, 'Git安全性: core.fsmonitor があれば Git 情報を取得せず理由を返す');
  check(String(parsed[0]?.document?.text || '').includes('# Status'), 'Git安全性: そのときも状態文書は返す');
  check(!session.results[1].isError && parsed[1]?.gitUnavailableReason === `${reasonPrefix}core.fsmonitor` && Array.isArray(parsed[1]?.recentCommits) && parsed[1].recentCommits.length === 0, 'Git安全性: get_recent_changes も Git 情報を取得せず理由を返す');
  markerCheck(fsmonitorReproduced, observed.fsmonitor, 'Git安全性: .git/config の core.fsmonitor のコマンドを実行しない');
  check(parsed[2]?.liveGit?.gitUnavailableReason === `${reasonPrefix}filter.*.clean`, 'Git安全性: clean フィルターがあれば Git 情報を取得しない（理由のサブセクションは伏せる）');
  markerCheck(filterReproduced, observed.filter, 'Git安全性: .gitattributes が参照する clean フィルターのコマンドを実行しない');
  check(parsed[3]?.liveGit?.gitUnavailableReason === `${reasonPrefix}url.*.insteadof` && !session.joined.includes(tokenMarker), 'Git安全性: url.<URL>.insteadOf の理由に URL（資格情報）を含めない');
  check(parsed[4]?.liveGit?.isGitRepository === true && parsed[4]?.liveGit?.gitUnavailableReason === undefined && parsed[4]?.liveGit?.worktree?.modified >= 1, 'Git安全性: 危険な設定が無ければ Git 情報を返す（設定を直すと再起動なしで戻る）');
  check(parsed[5]?.liveGit?.isGitRepository === true, 'Git安全性: local・worktree 以外（global）の設定は検査の対象外');
  markerCheck(globalReproduced, observed.globalFsmonitor, 'Git安全性: 検査を通っても -c core.fsmonitor=false で fsmonitor を実行しない（二重の防御）');

  // .git がファイル（gitdir: で別の場所を指す）の場合も、同じように検査する。
  createSimpleProject(gitFileRoot, 'git-file');
  gitIn(gitFileRoot, ['init', '-q', '--separate-git-dir', path.join(temporaryRoot, 'separate-git-dir')]);
  gitIn(gitFileRoot, ['add', '.']);
  gitIn(gitFileRoot, ['commit', '-q', '-m', 'initial']);
  fs.writeFileSync(path.join(gitFileRoot, 'README.md'), '# git-file changed\n', 'utf8');
  gitIn(gitFileRoot, ['config', 'core.fsmonitor', touchCommand(markers.gitFile)]);
  const gitFileReproduced = reproducesWithPlainGit(gitFileRoot, markers.gitFile);
  const gitFileSession = await runSession(approveSingle(gitFileRoot, { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'] }, path.join(temporaryRoot, 'approval-git-file.json')), [['get_project_status', {}]], gitEnvironment);
  let gitFileParsed = null; // 応答本文。
  try { gitFileParsed = JSON.parse(gitFileSession.results[0]?.text || ''); } catch { gitFileParsed = null; }
  check(fs.statSync(path.join(gitFileRoot, '.git')).isFile() && gitFileParsed?.liveGit?.gitUnavailableReason === `${reasonPrefix}core.fsmonitor`, 'Git安全性: .git がファイル（gitdir:）でも検査する');
  markerCheck(gitFileReproduced, fs.existsSync(markers.gitFile), 'Git安全性: .git がファイルのときも fsmonitor のコマンドを実行しない');

  // サブモジュール（gitlink で登録した中のリポジトリ）の .git/config は検査の対象外なので、status が中へ入ってそのフィルターを動かさないことを確かめる。
  const superRoot = path.join(temporaryRoot, 'git-safety-submodule'); // サブモジュールを含む模擬リポジトリ。
  const childRoot = path.join(superRoot, 'child'); // 中に置いたリポジトリ。
  createSimpleProject(superRoot, 'git-submodule');
  fs.mkdirSync(childRoot, { recursive: true });
  gitIn(superRoot, ['init', '-q']);
  gitIn(childRoot, ['init', '-q']);
  fs.writeFileSync(path.join(childRoot, '.gitattributes'), '*.txt filter=evil\n', 'utf8');
  fs.writeFileSync(path.join(childRoot, 'a.txt'), 'v1\n', 'utf8');
  gitIn(childRoot, ['add', '.']);
  gitIn(childRoot, ['commit', '-q', '-m', 'child']);
  gitIn(superRoot, ['-c', 'advice.addEmbeddedRepo=false', 'add', '.']);
  gitIn(superRoot, ['commit', '-q', '-m', 'super']);
  gitIn(childRoot, ['config', 'filter.evil.clean', touchCommand(markers.submodule)]);
  fs.writeFileSync(path.join(childRoot, 'a.txt'), 'v2\n', 'utf8'); // 大きさを変えずに内容を変え、中の status が clean フィルターを通す状態にする。
  const submoduleReproduced = reproducesWithPlainGit(superRoot, markers.submodule);
  const submoduleSession = await runSession(approveSingle(superRoot, { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'] }, path.join(temporaryRoot, 'approval-git-submodule.json')), [['get_project_status', {}]], gitEnvironment);
  let submoduleParsed = null; // 応答本文。
  try { submoduleParsed = JSON.parse(submoduleSession.results[0]?.text || ''); } catch { submoduleParsed = null; }
  check(submoduleParsed?.liveGit?.isGitRepository === true, 'Git安全性: サブモジュールを含むリポジトリでも、親の設定が安全なら Git 情報を返す');
  markerCheck(submoduleReproduced, fs.existsSync(markers.submodule), 'Git安全性: サブモジュールの中の clean フィルターのコマンドを実行しない');

  // 例外 E1（正規の LFS 設定）・E2（サブモジュールのデータ用の設定）と、理由文に設定値を含めないことを確かめる。
  const valueMarker = 'CONFIGVALUEMARKER7Q'; // 理由文や応答に出てはいけない設定値。
  // 指定した設定を、攻撃を再現するリポジトリの .git/config に書く。
  const setConfig = entries => entries.forEach(([key, value]) => gitIn(root, ['config', key, value]));
  // 指定したセクションを .git/config から消す。無ければ何もしない。
  const removeSections = sections => sections.forEach(section => {
    try { gitIn(root, ['config', '--remove-section', section]); } catch { /* 無いセクションは消さなくてよい。 */ }
  });
  let lfsReproduced = false; // 悪意ある LFS の clean が素の git で実行されたか。
  const exceptionSession = await runSession(serverArgs, [
    () => setConfig([['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.lfs.smudge', 'git-lfs smudge -- %f'], ['filter.lfs.process', 'git-lfs filter-process'], ['filter.lfs.required', 'true']]),
    ['get_project_status', {}], // 0
    () => setConfig([['filter.lfs.smudge', 'git-lfs smudge --skip -- %f'], ['filter.lfs.process', 'git-lfs filter-process --skip']]),
    ['get_project_status', {}], // 1
    () => setConfig([['filter.lfs.process', 'GIT-LFS filter-process']]),
    ['get_project_status', {}], // 2
    () => {
      removeSections(['filter.lfs']);
      setConfig([['submodule.x.url', 'https://example.invalid/x.git'], ['submodule.x.active', 'true'], ['submodule.x.branch', 'main'], ['submodule.active', '.']]);
    },
    ['get_project_status', {}], // 3
    () => setConfig([['submodule.x.update', `!echo ${valueMarker}`]]),
    ['get_project_status', {}], // 4
    () => {
      removeSections(['submodule.x', 'submodule']);
      setConfig([['credential.helper', `store --file ${valueMarker}`]]);
    },
    ['get_project_status', {}], // 5
    () => {
      removeSections(['credential']);
      setConfig([['http.https://example.invalid/.extraHeader', `X-Selftest: ${valueMarker}`]]);
    },
    ['get_project_status', {}], // 6
    () => {
      removeSections(['http.https://example.invalid/']);
      fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=lfs\n', 'utf8');
      setConfig([['filter.lfs.clean', touchCommand(markers.lfs)]]);
      lfsReproduced = reproducesWithPlainGit(root, markers.lfs);
    },
    ['get_project_status', {}], // 7
    () => {
      observed.lfs = fs.existsSync(markers.lfs);
      removeSections(['filter.lfs']);
    },
  ], gitEnvironment);
  const exceptionParsed = exceptionSession.results.map(item => { try { return JSON.parse(item.text); } catch { return null; } }); // 呼び出しごとの応答本文。
  // 応答が Git 情報を返している（理由が無い）かを判定する。
  const gitEnabled = item => item?.liveGit?.isGitRepository === true && item?.liveGit?.gitUnavailableReason === undefined;
  check(gitEnabled(exceptionParsed[0]), 'Git安全性（E1）: git lfs install の標準の LFS 設定では Git 情報を返す');
  check(gitEnabled(exceptionParsed[1]), 'Git安全性（E1）: --skip 付きの標準の LFS 設定でも Git 情報を返す');
  check(exceptionParsed[2]?.liveGit?.gitUnavailableReason === `${reasonPrefix}filter.*.process`, 'Git安全性（E1）: 値が大文字小文字まで一致しない LFS 設定は危険とみなす');
  check(gitEnabled(exceptionParsed[3]), 'Git安全性（E2）: submodule.<name>.url・active・branch と submodule.active では Git 情報を返す');
  check(exceptionParsed[4]?.liveGit?.gitUnavailableReason === `${reasonPrefix}submodule.*.update`, 'Git安全性（E2）: submodule.<name>.update は危険とみなす');
  check(exceptionParsed[5]?.liveGit?.gitUnavailableReason === `${reasonPrefix}credential.helper`, 'Git安全性: 理由文は危険なキーの名前だけ（credential.helper）');
  check(exceptionParsed[6]?.liveGit?.gitUnavailableReason === `${reasonPrefix}http.*.extraheader`, 'Git安全性: 理由文は危険なキーの名前だけ（http.<URL>.extraHeader はURLも伏せる）');
  check(!exceptionSession.joined.includes(valueMarker), 'Git安全性: 応答に危険な設定の値を含めない');
  check(exceptionParsed[7]?.liveGit?.gitUnavailableReason === `${reasonPrefix}filter.*.clean`, 'Git安全性（E1）: clean を書き換えた LFS 設定は危険とみなす');
  markerCheck(lfsReproduced, observed.lfs, 'Git安全性（E1）: 書き換えた LFS の clean のコマンドを実行しない');

  // 有効なサブモジュールがあるとき、submodule status などがサブモジュール側の .git/config（fsmonitor・clean フィルター）を実行しないことを確かめる。
  const activeRoot = path.join(temporaryRoot, 'git-safety-active-submodule'); // 有効なサブモジュールを含む模擬リポジトリ。
  const activeChild = path.join(activeRoot, 'child'); // .gitmodules に登録したサブモジュール。
  createSimpleProject(activeRoot, 'git-active-submodule');
  fs.mkdirSync(activeChild, { recursive: true });
  gitIn(activeRoot, ['init', '-q']);
  gitIn(activeChild, ['init', '-q']);
  fs.writeFileSync(path.join(activeChild, '.gitattributes'), '*.txt filter=evil\n', 'utf8');
  fs.writeFileSync(path.join(activeChild, 'a.txt'), 'v1\n', 'utf8');
  gitIn(activeChild, ['add', '.']);
  gitIn(activeChild, ['commit', '-q', '-m', 'child']);
  fs.writeFileSync(path.join(activeRoot, '.gitmodules'), '[submodule "child"]\n\tpath = child\n\turl = ./child\n', 'utf8');
  gitIn(activeRoot, ['-c', 'advice.addEmbeddedRepo=false', 'add', '.']);
  gitIn(activeRoot, ['commit', '-q', '-m', 'super']);
  gitIn(activeRoot, ['config', 'submodule.child.url', './child']);
  gitIn(activeRoot, ['config', 'submodule.child.active', 'true']);
  fs.writeFileSync(path.join(activeChild, 'b.txt'), 'v1\n', 'utf8');
  gitIn(activeChild, ['add', 'b.txt']);
  gitIn(activeChild, ['commit', '-q', '-m', 'moved']); // サブモジュールの HEAD を動かし、submodule status が中で describe する経路にする。
  gitIn(activeChild, ['config', 'core.fsmonitor', touchCommand(markers.activeFsmonitor)]);
  gitIn(activeChild, ['config', 'filter.evil.clean', touchCommand(markers.activeFilter)]);
  fs.writeFileSync(path.join(activeChild, 'a.txt'), 'v2\n', 'utf8'); // サブモジュールの作業ツリーを汚し、中の status が clean フィルターを通す状態にする。
  // サブモジュールの中で素の git status を1回実行し、サブモジュール側の設定が生きているか（両方のマーカーが作られるか）を確かめる。
  const activeFilterReproduced = reproducesWithPlainGit(activeChild, markers.activeFilter);
  const activeFsmonitorReproduced = fs.existsSync(markers.activeFsmonitor);
  fs.rmSync(markers.activeFsmonitor, { force: true });
  const activeSession = await runSession(approveSingle(activeRoot, { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'], gitExposure: { paths: true, commitSubjects: false } }, path.join(temporaryRoot, 'approval-git-active-submodule.json')), [
    ['get_project_status', {}],
    ['get_recent_changes', { days: 30, limit: 10 }],
  ], gitEnvironment);
  const activeParsed = activeSession.results.map(item => { try { return JSON.parse(item.text); } catch { return null; } }); // 呼び出しごとの応答本文。
  check(gitEnabled(activeParsed[0]), 'Git安全性（E2）: 有効なサブモジュールを含むリポジトリでも Git 情報を返す');
  check(Array.isArray(activeParsed[1]?.submodules) && activeParsed[1].submodules.some(line => /^\+[0-9a-f]{40} child\b/.test(line)), 'Git安全性: submodule status が有効なサブモジュールを調べた（HEAD の移動を返す）');
  markerCheck(activeFsmonitorReproduced, fs.existsSync(markers.activeFsmonitor), 'Git安全性: status・submodule status・rev-list などはサブモジュール側の fsmonitor を実行しない');
  markerCheck(activeFilterReproduced, fs.existsSync(markers.activeFilter), 'Git安全性: status・submodule status・rev-list などはサブモジュール側の clean フィルターを実行しない');
}

// 承認ファイルとその置き場所の所有者・権限が安全でなければ、指紋が一致しても承認として扱わないことを検査する（POSIX）。
async function testApprovalFilePermissions() {
  if (process.platform === 'win32') {
    process.stdout.write('SKIP 承認ファイルの権限（Windows の ACL の検査は未対応）\n');
    return;
  }
  const root = path.join(temporaryRoot, 'approval-permissions'); // 模擬プロジェクト。
  const approvalDirectory = path.join(temporaryRoot, 'approval-permissions-store'); // 承認ファイルの置き場所。
  const approvalFile = path.join(approvalDirectory, 'approval.json'); // 検査する承認ファイル。
  const elsewhere = path.join(temporaryRoot, 'approval-permissions-elsewhere', 'approval.json'); // シンボリックリンクの指す先（安全な権限の正しい承認）。
  const config = { ...BASE_CONFIG, allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'] }; // 模擬設定。
  createSimpleProject(root, 'approval-permissions');
  const serverArgs = approveSingle(root, config, approvalFile); // 単独モードの起動引数。
  const record = JSON.parse(fs.readFileSync(approvalFile, 'utf8')); // 正しい承認の内容。
  writeApprovalFile(elsewhere, record);
  // 承認ファイルを正しい内容・0600 で置き直す。
  const restore = () => {
    fs.rmSync(approvalFile, { force: true });
    writeApprovalFile(approvalFile, record);
  };
  // 承認されて文書を返したかを判定する。
  const approved = item => item?.isError === false && item.text.includes('approval-permissions context');
  // 承認ファイルの権限を理由に拒否し、ファイルの場所を出していないかを判定する。
  const deniedForPermission = item => item?.isError === true && item.text.includes('承認ファイルの権限') && !item.text.includes(temporaryRoot);
  const session = await runSession(serverArgs, [
    ['get_project_context', {}], // 0
    () => fs.chmodSync(approvalFile, 0o666),
    ['get_project_context', {}], // 1
    () => fs.chmodSync(approvalFile, 0o620),
    ['get_project_context', {}], // 2
    () => {
      fs.chmodSync(approvalFile, 0o600);
      fs.chmodSync(approvalDirectory, 0o777);
    },
    ['get_project_context', {}], // 3
    () => fs.chmodSync(approvalDirectory, 0o770),
    ['get_project_context', {}], // 4
    () => {
      fs.chmodSync(approvalDirectory, 0o700);
      fs.rmSync(approvalFile);
      fs.symlinkSync(elsewhere, approvalFile);
    },
    ['get_project_context', {}], // 5
    restore,
    ['get_project_context', {}], // 6
  ]);
  const result = session.results; // 呼び出しごとの結果。
  check(approved(result[0]), '承認ファイルの権限: 所有者が自分・0600（approve が作る形）の承認は有効');
  check(deniedForPermission(result[1]), '承認ファイルの権限: 0666 は指紋が一致しても未承認');
  check(deniedForPermission(result[2]), '承認ファイルの権限: 0620（group 書き込み可）は未承認');
  check(deniedForPermission(result[3]), '承認ファイルの権限: 置き場所のフォルダーが 0777 なら未承認');
  check(deniedForPermission(result[4]), '承認ファイルの権限: 置き場所のフォルダーが 0770（group 書き込み可）なら未承認');
  check(deniedForPermission(result[5]), '承認ファイルの権限: シンボリックリンクは指す先が正しい承認でも未承認');
  check(approved(result[6]), '承認ファイルの権限: 直すと再起動なしで有効に戻る');

  // FIFO に差し替えても、書き手がいなくて固まらずに未承認として返す。
  let fifoCreated = false; // mkfifo で FIFO を作れたか。
  try {
    fs.rmSync(approvalFile, { force: true });
    execFileSync('mkfifo', ['-m', '600', approvalFile], { stdio: 'ignore' });
    fifoCreated = true;
  } catch {
    fifoCreated = false;
  }
  if (fifoCreated) {
    let fifoResult = null; // FIFO のときの応答。固まって時間切れなら null。
    try { fifoResult = (await runSession(serverArgs, [['get_project_context', {}]])).results[0]; } catch { fifoResult = null; }
    check(deniedForPermission(fifoResult), '承認ファイルの権限: FIFO に差し替えても固まらずに未承認');
  } else {
    process.stdout.write('SKIP 承認ファイルの権限: FIFO（mkfifo がありません）\n');
  }
  restore();

  // ハブ: 承認ファイルまたは置き場所の権限が安全でないプロジェクトは、承認済みでも公開しない（未承認と同じく存在も明かさない）。
  const hubRoot = path.join(temporaryRoot, 'approval-permissions-hub'); // ハブ試験の作業領域。
  const hubRoots = { safe: path.join(hubRoot, 'safe'), loose: path.join(hubRoot, 'loose'), opendir: path.join(hubRoot, 'opendir') }; // 安全・0666・置き場所 0777。
  const hubApprovals = {
    safe: path.join(hubRoot, 'approvals', 'safe.json'),
    loose: path.join(hubRoot, 'approvals', 'loose.json'),
    opendir: path.join(hubRoot, 'open-approvals', 'opendir.json'),
  }; // プロジェクト外の承認ファイル。
  const hubPath = path.join(hubRoot, 'hub.json'); // ハブ設定。
  for (const [name, hubProjectRoot] of Object.entries(hubRoots)) {
    createSimpleProject(hubProjectRoot, name);
    approveSingle(hubProjectRoot, { ...config, projectName: name }, hubApprovals[name]);
  }
  fs.chmodSync(hubApprovals.loose, 0o666);
  fs.chmodSync(path.dirname(hubApprovals.opendir), 0o777);
  fs.writeFileSync(hubPath, JSON.stringify({ schemaVersion: 1, projects: Object.entries(hubRoots).map(([name, hubProjectRoot]) => ({ name, root: hubProjectRoot, approvalFile: hubApprovals[name] })) }), 'utf8');
  const hubSession = await runHubSession(hubPath, [
    ['list_projects', {}],                             // 0
    ['get_project_context', { project: 'loose' }],     // 1
    ['get_project_context', { project: 'opendir' }],   // 2
    ['get_project_context', { project: 'safe' }],      // 3
    ['get_project_context', { project: 'nothing' }],   // 4
  ]);
  const hubResult = hubSession.results; // 呼び出しごとの結果。
  check(!hubResult[0].isError && hubResult[0].text.includes('"safe"') && !hubResult[0].text.includes('"loose"') && !hubResult[0].text.includes('"opendir"'), '承認ファイルの権限（ハブ）: 権限が安全でない承認のプロジェクトは list_projects に出さない');
  check(hubResult[1].isError && hubResult[1].text === hubResult[4].text.replace('nothing', 'loose'), '承認ファイルの権限（ハブ）: 0666 の承認のプロジェクトは未登録と同じ文言で拒否');
  check(hubResult[2].isError && hubResult[2].text === hubResult[4].text.replace('nothing', 'opendir'), '承認ファイルの権限（ハブ）: 置き場所が 0777 のプロジェクトは未登録と同じ文言で拒否');
  check(!hubResult[3].isError && hubResult[3].text.includes('safe context'), '承認ファイルの権限（ハブ）: 安全な承認のプロジェクトは読める');
}

try {
  fs.mkdirSync(projectRoot, { recursive: true });
  createProjectFiles();
  await testRedaction();
  await testSensitiveFiles();
  await testApproval();
  await testGitExposure();
  await testHub();
  await testForbiddenConfig();
  await testRequestPathNames();
  await testLargeExposureOutput();
  await testGitSafety();
  await testApprovalFilePermissions();
} catch (error) {
  process.stdout.write(`FAIL 例外: ${error?.message || error}\n`);
  failures += 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
process.stdout.write(failures === 0 ? 'PROJECT_BRIDGE_SECURITY_SELFTEST PASS\n' : `PROJECT_BRIDGE_SECURITY_SELFTEST FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
