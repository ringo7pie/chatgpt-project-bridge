#!/usr/bin/env node
/*
  2.8.0 の権限の切り替え（管理 CLI の SetPermission / HubPermissions と、設定を変換する bridge-permission.mjs）を検証する。外部ネットワークなし。
  - bridge-permission.mjs: 変換の規則（on・off・許可コマンド）、未知のキーとキーの順を保つこと、厳密な UTF-8、既存のファイルを上書きしないこと
  - 管理 CLI: その OS の CLI を実際に起動して試す（Windows は project-bridge.ps1、Linux は project-bridge.py）。
    確認（指紋なし）は何も書かない／間違った指紋では何も変わらない／正しい指紋で設定と承認が一緒に書かれる／途中で失敗すれば設定が元に戻る／
    書けない許可コマンドと不正な UTF-8 は拒否される／Windows では Hidden 属性が保たれる／HubPermissions の出力
  データ・承認・hub.json はこの試験専用の一時ディレクトリだけに作り（APPDATA・XDG_CONFIG_HOME・HOME を一時に向ける）、実際のプロジェクトや承認には触れない。
  使い方: node permission-cli-selftest.mjs
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPermissionChanges, formatConfig, readConfigFile } from './bridge-permission.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url)); // この試験があるフォルダー。
const serverPath = path.join(scriptsDirectory, 'server.mjs'); // 同梱 MCP 本体。
const helperPath = path.join(scriptsDirectory, 'bridge-permission.mjs'); // 変換の部品。
// Windows の Node は、パスを含まないコマンド名を PATH より先に作業フォルダーから探す。作業フォルダーを同梱スクリプトのフォルダーへ移す。
if (process.platform === 'win32') process.chdir(scriptsDirectory);
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-bridge-permission-selftest-'))); // この試験だけの削除対象。
process.on('exit', () => {
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* 消せないときは OS の一時領域に任せる。 */ }
});
const isWindows = process.platform === 'win32'; // Windows の CLI（ps1）を試すか。
const homeDirectory = path.join(temporaryRoot, 'home'); // この試験の APPDATA / XDG_CONFIG_HOME / HOME の置き場所。
fs.mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
const configHome = isWindows ? path.join(homeDirectory, 'AppData', 'Roaming') : path.join(homeDirectory, '.config'); // 承認と hub.json の置き場所の親。
fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
const nodeDirectory = path.dirname(process.execPath); // CLI が node を見つけられるようにする PATH の先頭。
const cliEnvironment = {
  ...process.env,
  PATH: `${nodeDirectory}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
  ...(isWindows ? { APPDATA: configHome, USERPROFILE: homeDirectory } : { HOME: homeDirectory, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state') }),
}; // 実際の承認・設定に触れないよう、置き場所を一時に向けた環境。
const approvalsDirectory = path.join(configHome, 'chatgpt-project-bridge', 'approvals'); // CLI が承認を置くフォルダー。
const hubPath = path.join(configHome, 'chatgpt-project-bridge', 'hub.json'); // CLI が読むハブ設定。

let failures = 0; // 合格しなかった検査数。

// 判定を表示して失敗数へ反映する。
function check(condition, label) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  if (!condition) failures += 1;
}

// ファイルの内容の SHA-256（無ければ null）。
function fileHash(filePath) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; }
}

// 公開設定を指定して一時プロジェクトを作る。戻り値: { root, configPath, profile }
function makeProject(name, { config = {}, rawConfig = null } = {}) {
  const root = path.join(temporaryRoot, 'projects', name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_CONTEXT.md'), `# ${name} 概要\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_STATUS.md'), `# ${name} 状態\n`, 'utf8');
  const profile = `chatgpt-${name}-selftest`; // CLI に明示するプロファイル名（承認ファイルの名前）。
  const configPath = path.join(root, '.chatgpt-project-bridge.json');
  const base = {
    schemaVersion: 1, projectName: name, profileName: profile, contextFile: 'CHATGPT_PROJECT_CONTEXT.md', statusFile: 'CHATGPT_PROJECT_STATUS.md',
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'], allowDirectories: [], denyDirectories: ['.git', 'private'], maxDocumentBytes: 524288,
    gitExposure: { paths: false, commitSubjects: false }, customNote: '未知のキーは保たれる', ...config,
  }; // 試験用の設定。
  if (rawConfig !== null) fs.writeFileSync(configPath, rawConfig);
  else fs.writeFileSync(configPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return { root, configPath, profile };
}

// 現在の設定の公開範囲と指紋を、サーバー自身に出させる。
function printExposure(project) {
  const result = spawnSync(process.execPath, [serverPath, '--print-exposure', '--project-root', project.root, '--config', project.configPath], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}

/*
  その OS の管理 CLI を起動する。options は [名前（kebab）, 値] の配列（値が true なら値なしのスイッチ）。
  戻り値: { status, stdout, stderr, json（標準出力を JSON として読めたときだけ） }
*/
function runCli(action, options = []) {
  let command; // 起動するコマンドと引数。
  if (isWindows) {
    const pascal = name => name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(''); // kebab を PascalCase にする。
    const toArguments = options.flatMap(([name, value]) => (value === true ? [`-${pascal(name)}`] : [`-${pascal(name)}`, String(value)]));
    command = ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(scriptsDirectory, 'project-bridge.ps1'), '-Action', action, ...toArguments]];
  } else {
    const toArguments = options.flatMap(([name, value]) => (value === true ? [`--${name}`] : [`--${name}`, String(value)]));
    command = ['python3', ['-u', path.join(scriptsDirectory, 'project-bridge.py'), action, ...toArguments]];
  }
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', env: cliEnvironment, windowsHide: true, timeout: 180000 });
  let json = null; // 標準出力が JSON のときの読み取り結果。
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', json };
}

// Approve の承認ファイルの場所。
function approvalFileOf(project) {
  return path.join(approvalsDirectory, `${project.profile}.json`);
}

// 現在の設定をそのまま承認する（Approve を、指紋を渡して非対話で実行する）。
function approveCurrent(project) {
  const printed = printExposure(project); // いまの指紋。
  const result = runCli(isWindows ? 'Approve' : 'approve', [['project-root', project.root], ['profile', project.profile], ['exposure-sha256', printed.sha256]]);
  return { printed, result };
}

// SetPermission / set-permission を実行する。
function runSetPermission(project, options, sha256 = null) {
  const list = [['project-root', project.root], ['profile', project.profile], ...options]; // 渡す引数。
  if (sha256) list.push(['exposure-sha256', sha256]);
  return runCli(isWindows ? 'SetPermission' : 'set-permission', list);
}

// ---------- bridge-permission.mjs の変換（純粋な関数） ----------

function testTransformation() {
  const base = { schemaVersion: 1, projectName: 'x', gitExposure: { paths: false, commitSubjects: true }, customNote: 'keep', denyDirectories: ['.git'] }; // 元の設定。
  const on = applyPermissionChanges(base, { sourceRead: 'on' });
  check(on.changed && on.candidate.detailExposure.sourceText === true && on.candidate.gitExposure.paths === true && on.candidate.gitExposure.commitSubjects === true, '変換: sourceRead on は sourceText と paths を true にする（他の項目は残す）');
  check(JSON.stringify(Object.keys(on.candidate)) === JSON.stringify([...Object.keys(base), 'detailExposure']) && on.candidate.customNote === 'keep', '変換: 未知のキーを保ち、キーの順を変えない（足す項目は末尾）');
  check(base.detailExposure === undefined && base.gitExposure.paths === false, '変換: 元の設定のオブジェクトは変えない');
  const off = applyPermissionChanges(on.candidate, { sourceRead: 'off' });
  check(off.changed && off.candidate.detailExposure.sourceText === false && off.candidate.gitExposure.paths === true, '変換: sourceRead off は sourceText だけ false にし、paths は残す');
  const offTwice = applyPermissionChanges(off.candidate, { sourceRead: 'off' });
  check(!offTwice.changed, '変換: すでに off なら changed は false');
  const offAbsent = applyPermissionChanges(base, { sourceRead: 'off' });
  check(!offAbsent.changed && offAbsent.candidate.detailExposure === undefined, '変換: detailExposure が無い off は何もしない（項目を作らない）');
  const keepOthers = applyPermissionChanges({ detailExposure: { branchNames: true, diffExcerpts: true, sourceText: true } }, { sourceRead: 'off' });
  check(keepOthers.candidate.detailExposure.branchNames === true && keepOthers.candidate.detailExposure.diffExcerpts === true && keepOthers.candidate.detailExposure.sourceText === false, '変換: off で branchNames・diffExcerpts は変えない');

  const claudeOn = applyPermissionChanges(base, { claudeCode: 'on' });
  check(JSON.stringify(claudeOn.candidate.claudeCode) === '{"enabled":true}', '変換: claudeCode が無い on は {"enabled": true}（許可コマンドなし）で作る');
  const claudeOffAbsent = applyPermissionChanges(base, { claudeCode: 'off' });
  check(!claudeOffAbsent.changed && claudeOffAbsent.candidate.claudeCode === undefined, '変換: claudeCode が無い off は何もしない（指紋が 2.6.0 のまま）');
  const withCommands = applyPermissionChanges({ claudeCode: { enabled: true, allowedCommands: ['git status'], model: 'sonnet' } }, { claudeCode: 'off' });
  check(withCommands.candidate.claudeCode.enabled === false && withCommands.candidate.claudeCode.allowedCommands[0] === 'git status' && withCommands.candidate.claudeCode.model === 'sonnet', '変換: claudeCode off は enabled だけ false にし、許可コマンドなどは残す');
  const replaced = applyPermissionChanges({ claudeCode: { enabled: true, allowedCommands: ['git status'] } }, { allowedCommands: ['npm test', 'git diff *'] });
  check(JSON.stringify(replaced.candidate.claudeCode.allowedCommands) === '["npm test","git diff *"]' && replaced.candidate.claudeCode.enabled === true, '変換: 許可コマンドは渡したときだけ置き換え、enabled は変えない');
  const commandsOnly = applyPermissionChanges(base, { allowedCommands: ['npm test'] });
  check(commandsOnly.candidate.claudeCode.enabled === false && commandsOnly.candidate.claudeCode.allowedCommands[0] === 'npm test', '変換: claudeCode が無いとき許可コマンドだけ渡すと、enabled: false で作る（有効にはしない）');
  for (const [label, badConfig, changes] of [
    ['detailExposure が配列', { detailExposure: [] }, { sourceRead: 'on' }],
    ['gitExposure が文字列', { gitExposure: 'x' }, { sourceRead: 'on' }],
    ['claudeCode が配列', { claudeCode: [] }, { claudeCode: 'on' }],
  ]) {
    let message = ''; // 例外の文。
    try { applyPermissionChanges(badConfig, changes); } catch (error) { message = String(error.message); }
    check(/オブジェクト/.test(message), `変換: ${label}なら、手で直すよう伝えて止める`);
  }
  let rejected = false; // 不正な値を拒否したか。
  try { applyPermissionChanges(base, { sourceRead: 'maybe' }); } catch { rejected = true; }
  check(rejected, '変換: on・off 以外は拒否する');
}

// ---------- bridge-permission.mjs の起動（ファイルの扱い） ----------

function testHelperFiles() {
  const project = makeProject('helper-files');
  const outputPath = path.join(temporaryRoot, 'helper-out.json');
  const run = args => spawnSync(process.execPath, [helperPath, ...args], { encoding: 'utf8', windowsHide: true });
  const before = fileHash(project.configPath); // 設定の変更前の hash。
  const first = run(['--config', project.configPath, '--output', outputPath, '--source-read', 'on', '--allowed-command', 'git status']);
  check(first.status === 0 && JSON.parse(first.stdout).changed === true && fileHash(project.configPath) === before, '部品: 候補を --output に書き、設定そのものは書き換えない');
  check(readConfigFile(outputPath).detailExposure.sourceText === true && fs.readFileSync(outputPath, 'utf8').endsWith('}\n'), '部品: 候補はインデント付きで末尾に改行がある');
  fs.writeFileSync(outputPath, 'keep me');
  const second = run(['--config', project.configPath, '--output', outputPath, '--source-read', 'on']);
  check(second.status === 2 && fs.readFileSync(outputPath, 'utf8') === 'keep me', '部品: 既に在る --output は上書きしない（終了コード 2）');
  const invalid = makeProject('helper-invalid', { rawConfig: Buffer.concat([Buffer.from('{"projectName": "'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]) });
  const invalidRun = run(['--config', invalid.configPath, '--output', path.join(temporaryRoot, 'helper-out2.json'), '--source-read', 'on']);
  check(invalidRun.status === 2 && !fs.existsSync(path.join(temporaryRoot, 'helper-out2.json')), '部品: 不正な UTF-8 は黙って置き換えず、何も書かずに失敗する');
  const bom = makeProject('helper-bom', { rawConfig: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"projectName":"bom"}')]) });
  const bomRun = run(['--config', bom.configPath, '--output', path.join(temporaryRoot, 'helper-out3.json'), '--claude-code', 'on']);
  check(bomRun.status === 0 && readConfigFile(path.join(temporaryRoot, 'helper-out3.json')).claudeCode.enabled === true, '部品: 先頭の BOM は許す（server.mjs と同じ）');
  const unknown = run(['--config', project.configPath, '--output', path.join(temporaryRoot, 'helper-out4.json'), '--write-everything', 'yes']);
  check(unknown.status === 2, '部品: 未対応の引数は拒否する');
}

// ---------- 管理 CLI（その OS のもの） ----------

function testSetPermissionFlow() {
  const label = isWindows ? 'Windows CLI（ps1）' : 'Linux CLI（py）'; // 試験の表示に使う名前。
  const project = makeProject('flow', { config: { detailExposure: { branchNames: false, diffExcerpts: false, sourceText: false } } });
  const initial = approveCurrent(project); // 最初の承認。
  const approvalPath = approvalFileOf(project); // 承認ファイル。
  check(initial.result.status === 0 && fs.existsSync(approvalPath) && JSON.parse(fs.readFileSync(approvalPath, 'utf8')).sha256 === initial.printed.sha256, `${label}: 準備 — Approve が指紋付きで承認を保存する（共通化した保存処理の回帰）`);
  const configBefore = fileHash(project.configPath);
  const approvalBefore = fileHash(approvalPath);
  const originalKeys = Object.keys(readConfigFile(project.configPath)); // 適用前のキーの順。

  const confirm = runSetPermission(project, [['source-read', 'on']]);
  check(confirm.status === 0 && confirm.json?.exposure?.detailExposure?.sourceText === true && confirm.json?.exposure?.gitExposure?.paths === true, `${label}: 確認 — 変更後の公開範囲（ソースの読み取り On）を JSON で出す`);
  check(confirm.json?.approvalState === 'changed' && confirm.json?.exposureSha256 !== initial.printed.sha256 && confirm.json?.approvedSha256 === initial.printed.sha256 && Array.isArray(confirm.json?.changes) && confirm.json.changes.length > 0, `${label}: 確認 — 承認状態は changed で、いまの承認との差分を出す`);
  check(confirm.json?.profile === project.profile && ['schemaVersion', 'projectRoot', 'profile', 'exposureSha256', 'approvalState', 'approvedSha256', 'approvedProjectRoot', 'exposure', 'changes'].every(key => key in confirm.json), `${label}: 確認 — ShowExposure と同じ形（GUI の承認ダイアログがそのまま使える）`);
  check(fileHash(project.configPath) === configBefore && fileHash(approvalPath) === approvalBefore, `${label}: 確認 — 設定も承認も書き換えない`);
  const printedAfterConfirm = printExposure(project);
  check(printedAfterConfirm.sha256 === initial.printed.sha256, `${label}: 確認 — 実際の設定の指紋は変わらない（承認はまだ有効）`);

  const wrong = runSetPermission(project, [['source-read', 'on']], '0'.repeat(64));
  check(wrong.status !== 0 && fileHash(project.configPath) === configBefore && fileHash(approvalPath) === approvalBefore, `${label}: 間違った指紋 — 失敗し、設定も承認も変わらない`);

  const apply = runSetPermission(project, [['source-read', 'on']], confirm.json.exposureSha256);
  check(apply.status === 0, `${label}: 適用 — 正しい指紋で成功する`);
  const applied = readConfigFile(project.configPath); // 適用後の設定。
  check(applied.detailExposure.sourceText === true && applied.gitExposure.paths === true && applied.customNote === '未知のキーは保たれる', `${label}: 適用 — 設定に反映し、未知のキーを保つ`);
  check(JSON.stringify(Object.keys(applied)) === JSON.stringify(originalKeys), `${label}: 適用 — キーの順を保つ（detailExposure は元の位置のまま）`);
  const approvalAfter = JSON.parse(fs.readFileSync(approvalPath, 'utf8')); // 適用後の承認。
  check(approvalAfter.sha256 === confirm.json.exposureSha256 && printExposure(project).sha256 === approvalAfter.sha256, `${label}: 適用 — 承認が新しい指紋で保存され、実物の設定の指紋と一致する（承認の空白が無い）`);
  check(runCli(isWindows ? 'ShowExposure' : 'show-exposure', [['project-root', project.root], ['profile', project.profile]]).json?.approvalState === 'approved', `${label}: 適用 — ShowExposure が approved と答える`);

  const claudeConfirm = runSetPermission(project, [['claude-code', 'on']]);
  check(claudeConfirm.json?.exposure?.claudeCode?.enabled === true && claudeConfirm.json.exposure.claudeCode.allowedCommands.length === 0, `${label}: Claude Code On の確認 — 許可コマンドなし（ファイルの編集だけ）で有効になる`);
  // 許可コマンドは、1 つの値に改行で区切って複数渡す（-File では同じ引数を繰り返せないため。コマンドの中の , や * や空白はそのまま通る）。
  const commandOptions = [['claude-code', 'on'], ['allowed-command', 'node scripts/*-selftest.mjs\n.\\tools\\run.ps1 -Only a,b,c\ngit status']]; // 許可コマンドを書く引数。
  const commandConfirm = runSetPermission(project, commandOptions); // 許可コマンドの確認。
  const claudeApply = runSetPermission(project, commandOptions, commandConfirm.json?.exposureSha256);
  check(claudeApply.status === 0 && JSON.stringify(readConfigFile(project.configPath).claudeCode.allowedCommands) === JSON.stringify(['node scripts/*-selftest.mjs', '.\\tools\\run.ps1 -Only a,b,c', 'git status']), `${label}: 許可コマンドを書いて適用する（複数・, や * や空白を含む）`);
  check(JSON.stringify(JSON.parse(fs.readFileSync(approvalPath, 'utf8')).exposure.claudeCode.allowedCommands) === JSON.stringify(['.\\tools\\run.ps1 -Only a,b,c', 'git status', 'node scripts/*-selftest.mjs']), `${label}: 承認には、サーバーが整列した許可コマンドが入る`);

  const beforeBad = [fileHash(project.configPath), fileHash(approvalPath)]; // 書けないコマンドを試す前。
  const bad = runSetPermission(project, [['allowed-command', 'bash -c "echo x"']]);
  check(bad.status !== 0 && bad.json === null && [fileHash(project.configPath), fileHash(approvalPath)].every((value, index) => value === beforeBad[index]), `${label}: 書けない許可コマンド（シェル）は確認の段階で失敗し、何も変わらない`);
  const badGit = runSetPermission(project, [['allowed-command', 'git push']]);
  check(badGit.status !== 0 && [fileHash(project.configPath), fileHash(approvalPath)].every((value, index) => value === beforeBad[index]), `${label}: git の書き込み系の許可コマンドも失敗し、何も変わらない`);

  const claudeOff = runSetPermission(project, [['claude-code', 'off']]);
  runSetPermission(project, [['claude-code', 'off']], claudeOff.json.exposureSha256);
  const afterOff = readConfigFile(project.configPath); // Claude Code Off 後の設定。
  check(afterOff.claudeCode.enabled === false && afterOff.claudeCode.allowedCommands.length === 3, `${label}: Claude Code Off — enabled: false にし、許可コマンドは残す`);
  const sourceOff = runSetPermission(project, [['source-read', 'off']]);
  check(sourceOff.json?.exposure?.detailExposure === undefined && sourceOff.json?.exposure?.gitExposure?.paths === true, `${label}: ソース Off の確認 — sourceText が false になり（detailExposure は公開範囲から消える）、paths は残る`);
  runSetPermission(project, [['source-read', 'off']], sourceOff.json.exposureSha256);
  check(readConfigFile(project.configPath).detailExposure.sourceText === false && printExposure(project).sha256 === JSON.parse(fs.readFileSync(approvalPath, 'utf8')).sha256, `${label}: ソース Off を適用する（承認も一致）`);
  const noop = runSetPermission(project, [['source-read', 'off']]);
  const noopBefore = fileHash(project.configPath);
  const noopApply = runSetPermission(project, [['source-read', 'off']], noop.json.exposureSha256);
  check(noop.json?.approvalState === 'approved' && noopApply.status === 0 && fileHash(project.configPath) === noopBefore && /変わりません/.test(noopApply.stdout), `${label}: すでにその状態なら、設定は変わらず承認済みのまま成功する`);
}

function testRollback() {
  const label = isWindows ? 'Windows CLI（ps1）' : 'Linux CLI（py）'; // 試験の表示に使う名前。
  const project = makeProject('rollback');
  approveCurrent(project);
  const approvalPath = approvalFileOf(project); // 承認ファイル。
  const confirm = runSetPermission(project, [['source-read', 'on']]);
  const configBefore = fs.readFileSync(project.configPath); // 元のバイト列。
  const approvalBefore = fs.readFileSync(approvalPath); // 元の承認。
  // 承認を置くフォルダーを、同じ名前のファイルに差し替え、承認の保存だけを失敗させる。設定を書いたあとの失敗で、設定が元のバイト列に戻ることを確かめる。
  const parkedDirectory = `${approvalsDirectory}.parked`; // 本物のフォルダーを一時的に退避する場所。
  fs.renameSync(approvalsDirectory, parkedDirectory);
  fs.writeFileSync(approvalsDirectory, 'not a directory');
  let failed; // 承認の保存に失敗する適用。
  try {
    failed = runSetPermission(project, [['source-read', 'on']], confirm.json.exposureSha256);
  } finally {
    fs.rmSync(approvalsDirectory);
    fs.renameSync(parkedDirectory, approvalsDirectory);
  }
  check(failed.status !== 0, `${label}: 承認の保存に失敗すると、全体が失敗する`);
  check(Buffer.compare(fs.readFileSync(project.configPath), configBefore) === 0, `${label}: 設定を書いたあとで失敗しても、設定は元のバイト列に戻る`);
  check(Buffer.compare(fs.readFileSync(approvalPath), approvalBefore) === 0 && printExposure(project).sha256 === JSON.parse(approvalBefore.toString('utf8')).sha256, `${label}: 失敗のあと、実際の設定の指紋は元の承認と一致する（承認の空白が残らない）`);
}

function testBadConfigFiles() {
  const label = isWindows ? 'Windows CLI（ps1）' : 'Linux CLI（py）'; // 試験の表示に使う名前。
  const project = makeProject('invalid-bytes', { rawConfig: Buffer.concat([Buffer.from('{"schemaVersion":1,"projectName":"xあ","profileName":"chatgpt-invalid-bytes-selftest","contextFile":"CHATGPT_PROJECT_CONTEXT.md","statusFile":"CHATGPT_PROJECT_STATUS.md","allowFiles":[],"allowDirectories":[],"denyDirectories":[],"maxDocumentBytes":524288,"customNote":"'), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('"}')]) });
  const before = fileHash(project.configPath);
  const confirm = runSetPermission(project, [['source-read', 'on']]);
  check(confirm.status !== 0 && fileHash(project.configPath) === before, `${label}: 設定に不正な UTF-8 があれば、確認の段階で失敗し、何も書かない`);
}

function testWindowsHidden() {
  if (!isWindows) { process.stdout.write('SKIP Hidden 属性の保持（Windows 専用）\n'); return; }
  const project = makeProject('hidden');
  const approved = approveCurrent(project);
  fs.writeFileSync(path.join(temporaryRoot, 'unused.txt'), 'x');
  spawnSync('attrib', ['+H', project.configPath], { windowsHide: true });
  // attrib の出力は、先頭の 12 文字が属性（A・S・H・R・I）で、そのあとにパスが続く。
  const hasHidden = filePath => spawnSync('attrib', [filePath], { encoding: 'utf8', windowsHide: true }).stdout.substring(0, 12).includes('H'); // Hidden 属性が付いているか。
  const hasReadOnly = filePath => spawnSync('attrib', [filePath], { encoding: 'utf8', windowsHide: true }).stdout.substring(0, 12).includes('R'); // 読み取り専用の属性が付いているか。
  check(hasHidden(project.configPath), 'Hidden: 準備 — 設定ファイルを Hidden にした');
  const confirm = runSetPermission(project, [['source-read', 'on']]);
  const apply = runSetPermission(project, [['source-read', 'on']], confirm.json.exposureSha256);
  check(apply.status === 0 && readConfigFile(project.configPath).detailExposure.sourceText === true && JSON.parse(fs.readFileSync(approvalFileOf(project), 'utf8')).sha256 !== approved.printed.sha256, 'Hidden: Hidden の設定ファイルにも書き込める（EPERM にならない）');
  check(hasHidden(project.configPath), 'Hidden: 書き換えたあとも Hidden 属性を保つ');
  spawnSync('attrib', ['+R', '+H', project.configPath], { windowsHide: true }); // Hidden のファイルは、同じ呼び出しで +H も指定しないと attrib が属性を変えない。
  const readOnlyConfirm = runSetPermission(project, [['source-read', 'off']]);
  const readOnlyApply = runSetPermission(project, [['source-read', 'off']], readOnlyConfirm.json?.exposureSha256 ?? '0'.repeat(64));
  const readOnlyKept = hasReadOnly(project.configPath); // 失敗したあとも読み取り専用のままか。
  spawnSync('attrib', ['-R', '+H', project.configPath], { windowsHide: true });
  const readOnlyOk = readOnlyApply.status !== 0 && readConfigFile(project.configPath).detailExposure.sourceText === true && readOnlyKept; // 期待どおりか。
  if (!readOnlyOk) process.stdout.write(`  診断: confirm status=${readOnlyConfirm.status} apply status=${readOnlyApply.status} readOnlyKept=${readOnlyKept}\n  stderr=${readOnlyApply.stderr.slice(0, 300)}\n  stdout=${readOnlyApply.stdout.slice(0, 300)}\n`);
  check(readOnlyOk, 'Hidden: 読み取り専用の設定ファイルは、勝手に属性を外さず、書き換えずに失敗する');
}

function testHubPermissions() {
  const label = isWindows ? 'Windows CLI（ps1）' : 'Linux CLI（py）'; // 試験の表示に使う名前。
  const approvedProject = makeProject('hub-approved', { config: { gitExposure: { paths: true, commitSubjects: false }, detailExposure: { branchNames: false, diffExcerpts: false, sourceText: true }, claudeCode: { enabled: true, allowedCommands: ['git status', 'npm test'] } } });
  approveCurrent(approvedProject);
  const changedProject = makeProject('hub-changed', { config: { detailExposure: { branchNames: false, diffExcerpts: false, sourceText: true } } });
  approveCurrent(changedProject);
  const changedConfig = readConfigFile(changedProject.configPath); // 承認のあとに、公開設定を変える（paths を true にする）。
  changedConfig.gitExposure = { paths: true, commitSubjects: false };
  fs.writeFileSync(changedProject.configPath, formatConfig(changedConfig));
  const newProject = makeProject('hub-new', {});
  const partial = makeProject('hub-partial', { config: { detailExposure: { branchNames: false, diffExcerpts: false, sourceText: true } } });
  fs.mkdirSync(path.dirname(hubPath), { recursive: true, mode: 0o700 });
  const entries = [approvedProject, changedProject, newProject, partial].map(project => ({ name: path.basename(project.root), root: project.root, approvalFile: approvalFileOf(project) }));
  entries.push({ name: 'missing-project', root: path.join(temporaryRoot, 'projects', 'does-not-exist'), approvalFile: path.join(approvalsDirectory, 'chatgpt-missing-selftest.json') });
  fs.writeFileSync(hubPath, JSON.stringify({ schemaVersion: 1, profileName: 'chatgpt-hub-selftest', tunnelId: null, healthPort: null, notifications: { start: false, access: false, intervalSeconds: 60 }, accessLog: path.join(temporaryRoot, 'access.log'), projects: entries }, null, 2), { mode: 0o600 });
  const before = [fileHash(hubPath), fileHash(approvalFileOf(approvedProject)), fileHash(approvedProject.configPath)]; // 読み取り専用の確認用。
  const result = runCli(isWindows ? 'HubPermissions' : 'hub-permissions', []);
  const byName = new Map((result.json?.projects ?? []).map(entry => [entry.name, entry])); // 名前ごとの状態。
  check(result.status === 0 && result.json?.schemaVersion === 1 && byName.size === 5, `${label}: HubPermissions — ハブの全プロジェクトを 1 つの JSON で出す`);
  const approved = byName.get('hub-approved'); // 承認済みで、ソース On・Claude Code On のプロジェクト。
  check(approved?.approvalState === 'approved' && approved.sourceRead === 'on' && approved.claudeCode === 'on' && approved.allowedCommandCount === 2 && approved.profile === approvedProject.profile, `${label}: HubPermissions — 承認済み・ソース On・Claude Code On・許可コマンド 2 件`);
  const changed = byName.get('hub-changed'); // 承認のあとに設定が変わったプロジェクト。
  check(changed?.approvalState === 'changed' && changed.sourceRead === 'on', `${label}: HubPermissions — 承認後に設定が変わったものは changed（設定上の値は On）`);
  const fresh = byName.get('hub-new'); // 承認していないプロジェクト。
  check(fresh?.approvalState === 'unapproved' && fresh.sourceRead === 'off' && fresh.claudeCode === 'unset' && fresh.allowedCommandCount === 0, `${label}: HubPermissions — 未承認・ソース Off・Claude Code は設定なし`);
  check(byName.get('hub-partial')?.sourceRead === 'partial', `${label}: HubPermissions — sourceText だけ true で paths が false なら partial（ファイル名が無く使えない）`);
  const missing = byName.get('missing-project'); // フォルダーが無いプロジェクト。
  check(missing?.approvalState === 'unavailable' && typeof missing.error === 'string' && missing.error.length > 0 && missing.sourceRead === null, `${label}: HubPermissions — 1 件の失敗は、そのプロジェクトの error に入れて残りを続ける`);
  check([fileHash(hubPath), fileHash(approvalFileOf(approvedProject)), fileHash(approvedProject.configPath)].every((value, index) => value === before[index]), `${label}: HubPermissions — hub.json・承認・設定のどれにも書かない`);
}

const TESTS = [
  ['transformation', testTransformation],
  ['helper-files', testHelperFiles],
  ['flow', testSetPermissionFlow],
  ['rollback', testRollback],
  ['bad-config', testBadConfigFiles],
  ['hidden', testWindowsHidden],
  ['hub', testHubPermissions],
]; // 試験の名前と関数。

const filter = process.argv[2] || ''; // 実行する試験名の一部。
for (const [name, test] of TESTS) {
  if (filter && !name.includes(filter)) continue;
  try {
    test();
  } catch (error) {
    check(false, `${name}: 例外 ${error?.stack || error}`);
  }
}
process.stdout.write(`PERMISSION_CLI_SELFTEST ${failures === 0 ? 'PASS' : 'FAIL'} (${failures})\n`);
process.exitCode = failures === 0 ? 0 : 1;
