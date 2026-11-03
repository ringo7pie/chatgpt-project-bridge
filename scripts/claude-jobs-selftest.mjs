#!/usr/bin/env node
/*
  2.7.0 の Claude Code のジョブ（bridge-claude-jobs.mjs・claude-job-runner.mjs と server.mjs の配線）を検証する。外部ネットワークなし。
  本物の Claude Code は起動しない（偽の claude を Node のスクリプトで作り、stream-json を出させる）。利用枠も消費しない。
  - 設定の検証（allowedCommands の拒否・未知の項目）と承認の指紋（claudeCode が無い設定は 2.6.0 と同じ）
  - Claude Code の引数（dontAsk・--setting-sources user など。--bg・-w・bypass を使わない）、settings の allow/deny、環境変数の許可リスト
  - ツールの公開（単一 29・ハブ 30、注釈）と権限（claudeCode が無い・未承認なら拒否）
  - ジョブの流れ（開始→完了・失敗・停止・時間切れ・ハブの停止）、同時実行の上限、会話の継続、ログの要約（ツールの結果の本文を返さない）
  - 2.10.0: start_claude_job の model・effort（受け付ける値の検証、引数 > 続きの引き継ぎ > 設定 > 既定の優先順位、不正な値でジョブの記録も起動も作らない、承認の指紋が変わらない）
  データ・承認・ジョブの記録はこの試験専用の一時ディレクトリだけに作り、実際のプロジェクトや資格情報、利用者のジョブの記録は使わない。
  使い方: node claude-jobs-selftest.mjs [試験名の一部]（引数を渡すと、名前にその文字列を含む試験だけ実行する）
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BridgeToolError, ERROR_CLASS, validateClaudeCommandPattern, CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_ALIASES } from './bridge-tools-common.mjs';
import { CLAUDE_JOB_TOOL_DEFINITIONS, CLAUDE_JOB_TOOL_NAMES, DETAIL_TOOL_NAMES, SOURCE_TOOL_NAMES } from './bridge-tool-definitions.mjs';
import { createProjectContext } from './server.mjs';
import {
  buildClaudeArguments, buildClaudeSettings, buildChildEnvironment, permissionPathAnchor, effectiveState, summarizeEventLine,
  applyEventToStatus, makeRelativizer, resolveClaudeExecutable, createClaudeJobManager, projectStorageKey, JOB_FILES,
  parseJobModel, parseJobEffort,
} from './bridge-claude-jobs.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url)); // この試験があるフォルダー。
const serverPath = path.join(scriptsDirectory, 'server.mjs'); // 同梱 MCP 本体。
// Windows の Node は、パスを含まないコマンド名（git など）を PATH より先に作業フォルダーから探す。作業フォルダーを同梱スクリプトのフォルダーへ移す。
if (process.platform === 'win32') process.chdir(scriptsDirectory);
const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-bridge-claude-jobs-selftest-'))); // この試験だけの削除対象。
const stateRoot = path.join(temporaryRoot, 'state', 'claude-jobs'); // ジョブの記録の置き場所（利用者の本物の記録とは別）。
process.on('exit', () => {
  try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* 子プロセスが残っていて消せないときは OS の一時領域に任せる。 */ }
});
const filter = process.argv[2] || ''; // 実行する試験名の一部。
const fakeClaude = path.join(temporaryRoot, 'fake-claude.mjs'); // 偽の Claude Code。
const LEGACY_EXPOSURE_KEYS = ['schemaVersion', 'projectRoot', 'contextFile', 'statusFile', 'allowFiles', 'allowDirectories', 'denyDirectories', 'maxDocumentBytes', 'gitExposure']; // 2.4.x からの公開範囲の項目と順序。
const TEST_ENV = { ...process.env, CONTROL_PLANE_API_KEY: 'cp-should-not-leak', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak', GITHUB_TOKEN: 'ghp_should_not_leak' }; // 渡してはいけない値を足した環境。

let failures = 0; // 合格しなかった検査数。

// 判定を表示して失敗数へ反映する。
function check(condition, label) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  if (!condition) failures += 1;
}

// 関数が指定の分類の BridgeToolError を投げるかを返す。
function throwsClass(action, errorClass) {
  try { action(); } catch (error) { return error instanceof BridgeToolError && error.errorClass === errorClass; }
  return false;
}

// 関数が例外を投げるかを返す。
function throws(action) {
  try { action(); } catch { return true; }
  return false;
}

// 条件が真になるまで待つ（最大 timeoutMs）。最後の値を返す。
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs; // 待つ期限。
  for (;;) {
    const value = predicate(); // いまの値。
    if (value || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// プロセスが生きているかを返す。
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// 偽の Claude Code を書く。依頼文の MODE:xxx で動きを変える。引数・環境・依頼文を、--settings と同じディレクトリの fake-probe.json に残す。
function writeFakeClaude() {
  fs.writeFileSync(fakeClaude, String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const valueOf = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const probeDirectory = path.dirname(valueOf('--settings'));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const sessionId = valueOf('--session-id') || valueOf('--resume');
  fs.writeFileSync(path.join(probeDirectory, 'fake-probe.json'), JSON.stringify({ args, env: process.env, cwd: process.cwd(), prompt: input, pid: process.pid }));
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  emit({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' });
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', permissionMode: valueOf('--permission-mode'), tools: ['Read', 'Edit'] });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: '作業します。password: hunter2' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(process.cwd(), 'notes.txt') } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET FILE CONTENT 12345' }] } });
  const mode = (/MODE:(\w+)/.exec(input) || [])[1] || 'ok';
  const finish = (isError, text, code) => {
    emit({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text, num_turns: 2, total_cost_usd: 0.0123, duration_ms: 1500, session_id: sessionId, permission_denials: [{ tool_name: 'Bash', tool_use_id: 't9', tool_input: { command: 'git push origin main' } }] });
    // Linux ではパイプへの書き込みが非同期で、書いた直後に process.exit すると 64 KiB を超える分が切れる（本物の Claude Code は流し切ってから終わる）。流れ切ってから終わる。
    process.stdout.write('', () => process.exit(code));
  };
  if (mode === 'ok') {
    fs.writeFileSync(path.join(process.cwd(), 'edited.txt'), 'edited by fake\n');
    emit({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: path.join(process.cwd(), 'edited.txt'), old_string: 'a', new_string: 'TOPSECRETBODY' } },
      { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: path.join(process.cwd(), '..', 'outside.txt'), content: 'x' } },
      { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'node scripts/run-selftest.mjs' } },
    ] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'TOPSECRETBODY written' }] }] } });
    finish(false, '完了しました。edited.txt を作りました。', 0);
  } else if (mode === 'fail') {
    finish(true, '失敗しました', 1);
  } else if (mode === 'noresult') {
    process.stderr.write('fatal: something broke\n');
    process.exit(3);
  } else if (mode === 'big') {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5 * 1024 * 1024) }] } });
    finish(false, 'big done', 0);
  } else if (mode === 'sleep') {
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(probeDirectory, 'fake-grandchild.pid'), String(grandchild.pid));
    setTimeout(() => finish(false, 'slept', 0), 120000);
  }
});
`, 'utf8');
}

// Git を試験用の固定設定で実行する。
function runGit(root, args) {
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', ...args], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

/*
  公開設定を指定して一時プロジェクトを作る。claudeCode を渡すと、その設定を書く。git なら初期コミットと、開始前からある未コミットの変更を作る。
  戻り値: { root, configPath, approvalFile }
*/
function makeProject(name, { claudeCode, git = false, config = {} } = {}) {
  const root = path.join(temporaryRoot, 'projects', name);
  fs.mkdirSync(path.join(root, 'private'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_CONTEXT.md'), `# ${name} 概要\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_STATUS.md'), `# ${name} 状態\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'notes\n', 'utf8');
  const configPath = path.join(root, '.chatgpt-project-bridge.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1, projectName: name, contextFile: 'CHATGPT_PROJECT_CONTEXT.md', statusFile: 'CHATGPT_PROJECT_STATUS.md',
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'], allowDirectories: [], denyDirectories: ['.git', 'private'], maxDocumentBytes: 524288,
    gitExposure: { paths: true, commitSubjects: false }, detailExposure: { branchNames: false, diffExcerpts: true, sourceText: true },
    ...(claudeCode !== undefined ? { claudeCode } : {}), ...config,
  }, null, 2), 'utf8');
  if (git) {
    runGit(root, ['init', '-q', '-b', 'main']);
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-q', '-m', 'initial']);
    fs.writeFileSync(path.join(root, 'preexisting.txt'), 'dirty before the job\n', 'utf8');
  }
  return { root, configPath, approvalFile: path.join(temporaryRoot, 'approvals', `${name}.json`) };
}

// 公開範囲と指紋をサーバー自身に出させる。失敗したら { status, stderr }。
function printExposure(project) {
  const result = spawnSync(process.execPath, [serverPath, '--print-exposure', '--project-root', project.root, '--config', project.configPath], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return { status: result.status, stderr: result.stderr };
  return { status: 0, ...JSON.parse(result.stdout) };
}

// 現在の設定を承認済みにする（管理コマンドの approve と同じ 0700 / 0600）。
function approve(project) {
  const printed = printExposure(project);
  fs.mkdirSync(path.dirname(project.approvalFile), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(project.approvalFile), 0o700);
  fs.writeFileSync(project.approvalFile, JSON.stringify({ schemaVersion: 1, sha256: printed.sha256, approvedAt: new Date().toISOString(), exposure: printed.exposure }), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(project.approvalFile, 0o600);
  return printed;
}

// JSON-RPC の要求列を標準入力で渡してサーバーを 1 回走らせ、id ごとの応答を返す。ジョブの記録は一時ディレクトリへ向ける。
function runServer(serverArguments, requests) {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-jobs-selftest', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...requests,
  ].map(item => JSON.stringify(item)).join('\n') + '\n';
  const env = { ...process.env, LOCALAPPDATA: path.join(temporaryRoot, 'server-state'), XDG_STATE_HOME: path.join(temporaryRoot, 'server-state') }; // 利用者の本物の記録に触れない。
  const result = spawnSync(process.execPath, [serverPath, ...serverArguments], { input, encoding: 'utf8', timeout: 120000, windowsHide: true, env });
  const byId = new Map(); // id ごとの応答。
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const response = JSON.parse(line);
    byId.set(response.id, response);
  }
  return { byId, status: result.status, stderr: result.stderr };
}

// ツールの結果（isError・本文・JSON）を取り出す。
function toolResult(session, id) {
  const result = session.byId.get(id)?.result;
  const text = result?.content?.[0]?.text ?? '';
  let json = null; // 本文が JSON のときの解析結果。
  try { json = JSON.parse(text); } catch { json = null; }
  return { isError: result?.isError, text, json };
}

// tools/call の要求を作る。
function callRequest(id, name, args = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

// 偽の Claude Code を使うジョブ管理層を作る。
function makeManager(project, label, options = {}) {
  const context = createProjectContext(project.root, project.configPath, null); // 承認ファイルなしの境界（ジョブの層は承認を見ない）。
  return {
    context,
    manager: createClaudeJobManager({
      projectLabel: label, boundary: context.claudeJobBoundary, stateRoot,
      resolveClaude: () => ({ command: process.execPath, prefixArgs: [fakeClaude] }), env: TEST_ENV, ...options,
    }),
  };
}

// ジョブの状態を返す。
function stateOf(manager, jobId) {
  return manager.get({ jobId, includeWorkingTree: false }).facts.job.state;
}

// ジョブが終わるまで待ち、最後の状態を返す。
async function waitForEnd(manager, jobId, timeoutMs = 30000) {
  return waitFor(() => {
    const state = stateOf(manager, jobId);
    return ['succeeded', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(state) ? state : null;
  }, timeoutMs) || stateOf(manager, jobId);
}

// ジョブの記録のディレクトリを返す。
function jobDirectoryOf(context, label, jobId) {
  return path.join(stateRoot, projectStorageKey(label, context.claudeJobBoundary.projectRoot, process.platform === 'win32'), jobId);
}

// 引数の並びから、オプションの値を返す。
function pairs(list, name) {
  return list[list.indexOf(name) + 1];
}

// 引数の並びの中の、オプションの出てくる回数を返す。
function countOf(list, name) {
  return list.filter(item => item === name).length;
}

// ---------- 純粋な部品の試験 ----------

function testCommandPatterns() {
  for (const ok of ['node scripts/*-selftest.mjs', 'git status', 'git diff *', 'npm test', 'godot --headless --path game -s res://tests/run.gd', '  git   log  --oneline ']) {
    check(!throws(() => validateClaudeCommandPattern(ok)), `allowedCommands: 許可する（${ok.trim()}）`);
  }
  check(validateClaudeCommandPattern('  git   log  --oneline ') === 'git log --oneline', 'allowedCommands: 前後と連続の空白を整える');
  for (const bad of ['*', '* *', 'bash -c x', '/bin/sh x', 'C:\\Windows\\System32\\cmd.exe /c dir', 'pwsh.exe -c x', 'powershell -Command x', 'curl http://example.invalid', 'wget x',
    'ssh host', 'claude -p x', 'sudo x', 'env FOO=1 x', 'git push', 'git commit -m x', 'git  push origin', 'git reset --hard', 'git checkout x', 'git -C . status',
    'git -c core.pager=x log', 'git *', 'git', 'echo (x)', 'a\nb', 'x'.repeat(201), '', 5]) {
    check(throws(() => validateClaudeCommandPattern(bad)), `allowedCommands: 拒否する（${JSON.stringify(bad).slice(0, 60)}）`);
  }
}

function testSettings() {
  const windows = buildClaudeSettings({
    projectRoot: 'E:\\work\\Games\\Example Project', platform: 'win32', allowedCommands: ['npm test', 'git status'],
    denyDirectories: ['private', 'Saved'], neverReadPaths: ['knowledge/20-bronze', 'Prompts/Prompt.txt', '.chatgpt-project-bridge.json'], sensitiveDirectoryNames: ['.git', '.ssh', 'secrets'],
  });
  const anchor = '//e/work/Games/Example Project'; // 期待する起点。
  const { allow, deny, defaultMode } = windows.permissions;
  check(permissionPathAnchor('E:\\work\\Games\\Example Project', 'win32') === anchor, 'settings: Windows のパスを //e/... の形にする');
  check(permissionPathAnchor('/home/user/Proj/x', 'linux') === '//home/user/Proj/x', 'settings: Linux のパスを //home/... の形にする');
  check(permissionPathAnchor('\\\\server\\share\\x', 'win32') === null && permissionPathAnchor('C:\\', 'win32') === null && permissionPathAnchor('/', 'linux') === null, 'settings: UNC・ドライブのルート・/ は使わない');
  check(throwsClass(() => buildClaudeSettings({ projectRoot: '\\\\server\\share\\x', platform: 'win32' }), ERROR_CLASS.CLAUDE_UNAVAILABLE), 'settings: UNC のプロジェクトは claude_unavailable');
  check(defaultMode === 'dontAsk', 'settings: 既定のモードは dontAsk');
  check(allow.includes(`Edit(${anchor}/**)`) && allow.includes('Bash(npm test)') && allow.includes('PowerShell(npm test)') && allow.includes('PowerShell(git status)'), 'settings: プロジェクトの中の編集と、許可したコマンド（Bash と PowerShell）を allow');
  check(allow.every(rule => /^(Edit|Bash|PowerShell)\(/.test(rule)) && !allow.some(rule => /^(Bash|PowerShell)\(\*?\)$/.test(rule) || rule === 'Bash' || rule === 'PowerShell'), 'settings: allow はそれだけ（コマンドの全許可を含まない）');
  for (const rule of ['Read(//**/.env)', 'Edit(//**/.env)', 'Read(//**/*.pem)', 'Read(//**/.git/**)', 'Read(//**/.ssh/**)', 'Read(//**/secrets/**)', 'Read(//**/*secret*)',
    `Read(${anchor}/knowledge/20-bronze/**)`, 'Read(./knowledge/20-bronze/**)', `Read(${anchor}/Prompts/Prompt.txt)`, `Read(${anchor}/.chatgpt-project-bridge.json)`,
    `Read(${anchor}/private/**)`, `Edit(${anchor}/Saved/**)`, `Edit(${anchor}/.claude/**)`, `Edit(${anchor}/.gitmodules)`, 'Edit(//**/zzz-Temp/**)',
    'Bash(git push *)', 'Bash(git commit *)', 'PowerShell(git push *)', 'PowerShell(git reset *)', 'Bash(git push)', 'WebFetch', 'WebSearch', 'mcp__*']) {
    check(deny.includes(rule), `settings: deny に ${rule}`);
  }
  const linux = buildClaudeSettings({ projectRoot: '/home/user/Proj/x', platform: 'linux', allowedCommands: ['npm test'] }).permissions;
  check(linux.allow.includes('Edit(//home/user/Proj/x/**)') && linux.allow.includes('Bash(npm test)') && !linux.allow.some(rule => rule.startsWith('PowerShell(')) && !linux.deny.some(rule => rule.startsWith('PowerShell(')), 'settings: Linux は PowerShell のルールを作らない');
  check(buildClaudeSettings({ projectRoot: 'E:\\a[1]', platform: 'win32' }).permissions.allow[0] === 'Edit(//e/a\\[1\\]/**)', 'settings: パスの [ ] などはエスケープする');
}

function testArgumentsAndEnvironment() {
  const fresh = buildClaudeArguments({ settingsPath: '/s/settings.json', sessionId: '11111111-2222-3333-4444-555555555555', platform: 'win32' });
  check(fresh[0] === '-p' && pairs(fresh, '--output-format') === 'stream-json' && fresh.includes('--verbose'), '引数: -p と stream-json');
  check(pairs(fresh, '--permission-mode') === 'dontAsk' && pairs(fresh, '--permission-prompts') === 'none' && pairs(fresh, '--setting-sources') === 'user', '引数: dontAsk・--permission-prompts none・--setting-sources user');
  check(pairs(fresh, '--settings') === '/s/settings.json' && fresh.includes('--strict-mcp-config') && fresh.includes('--no-chrome'), '引数: --settings・--strict-mcp-config・--no-chrome');
  check(pairs(fresh, '--tools') === 'Read,Glob,Grep,Edit,Write,NotebookEdit', '引数: コマンドを許可しないときは Bash・PowerShell を渡さない');
  check(pairs(fresh, '--session-id') === '11111111-2222-3333-4444-555555555555' && !fresh.includes('--resume'), '引数: 新しい会話は --session-id');
  check(fresh.includes('--append-system-prompt') && /commit・push/.test(pairs(fresh, '--append-system-prompt')), '引数: commit・push をしない旨をシステムプロンプトに足す');
  check(/ファイルの編集だけ/.test(pairs(fresh, '--append-system-prompt')), '引数: 許可コマンドが無いときは、コマンドを実行できない旨をシステムプロンプトに足す');
  const withCommands = buildClaudeArguments({ settingsPath: '/s/settings.json', sessionId: '11111111-2222-3333-4444-555555555555', allowCommands: true, allowedCommands: ['node scripts/*-selftest.mjs', '.\\tools\\run.ps1 -Only a,b'], platform: 'win32' });
  const promptWithCommands = pairs(withCommands, '--append-system-prompt'); // 許可コマンド付きのシステムプロンプト。
  check(promptWithCommands.includes('    node scripts/*-selftest.mjs') && promptWithCommands.includes('    .\\tools\\run.ps1 -Only a,b') && !/ファイルの編集だけ/.test(promptWithCommands), '引数: 許可コマンドの形を、システムプロンプトに書き添える');
  for (const forbidden of ['--bg', '--background', '-w', '--worktree', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--restricted', '--bare', 'acceptEdits', 'bypassPermissions', 'auto', '--mcp-config', '--chrome', '--add-dir']) {
    check(!fresh.includes(forbidden), `引数: ${forbidden} を使わない`);
  }
  const resumed = buildClaudeArguments({ settingsPath: '/s/settings.json', resumeSessionId: 'aaaaaaaa-2222-3333-4444-555555555555', model: 'sonnet', effort: 'high', maxBudgetUsd: 5, allowCommands: true, platform: 'win32' });
  check(pairs(resumed, '--resume') === 'aaaaaaaa-2222-3333-4444-555555555555' && !resumed.includes('--session-id'), '引数: 続きの会話は --resume');
  check(pairs(resumed, '--model') === 'sonnet' && pairs(resumed, '--effort') === 'high' && pairs(resumed, '--max-budget-usd') === '5', '引数: 設定の model・effort・maxBudgetUsd');
  check(pairs(resumed, '--tools').endsWith(',Bash,PowerShell') && pairs(buildClaudeArguments({ settingsPath: 's', sessionId: 'x', allowCommands: true, platform: 'linux' }), '--tools').endsWith(',Bash'), '引数: コマンドを許可するときは Bash（Windows は PowerShell も）');

  const windowsEnv = buildChildEnvironment({ Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\a', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\L', CONTROL_PLANE_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', GITHUB_TOKEN: 't', RANDOM_VAR: 'r', NoDefaultCurrentDirectoryInExePath: '1' }, 'win32');
  check(windowsEnv.Path === 'C:\\bin' && windowsEnv.USERPROFILE && windowsEnv.SystemRoot && windowsEnv.LOCALAPPDATA && windowsEnv.NoDefaultCurrentDirectoryInExePath === '1', '環境: Windows の必要な変数は渡す');
  check(!('CONTROL_PLANE_API_KEY' in windowsEnv) && !('ANTHROPIC_API_KEY' in windowsEnv) && !('ANTHROPIC_BASE_URL' in windowsEnv) && !('GITHUB_TOKEN' in windowsEnv) && !('RANDOM_VAR' in windowsEnv), '環境: Tunnel Client の鍵・ANTHROPIC_*・トークン・許可リストに無い変数は渡さない（Windows）');
  const posixEnv = buildChildEnvironment({ HOME: '/home/a', PATH: '/usr/bin', LANG: 'ja_JP.UTF-8', LC_ALL: 'C', CONTROL_PLANE_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/tmp/s' }, 'linux');
  check(posixEnv.HOME === '/home/a' && posixEnv.PATH === '/usr/bin' && posixEnv.LC_ALL === 'C' && !('CONTROL_PLANE_API_KEY' in posixEnv) && !('ANTHROPIC_API_KEY' in posixEnv) && !('SSH_AUTH_SOCK' in posixEnv), '環境: Linux も許可リストだけ（ssh-agent も渡さない）');
}

// 2.10.0: start_claude_job の model・effort の引数の検証（純粋関数）。
function testModelAndEffortValidation() {
  for (const ok of ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-4-1-20250805']) {
    check(parseJobModel(ok) === ok, `model: 受け付ける（${ok}）`);
  }
  for (const omitted of [undefined, null, '']) {
    check(parseJobModel(omitted) === null && parseJobEffort(omitted) === null, `model・effort: 省略（${omitted === undefined ? 'undefined' : JSON.stringify(omitted)}）は null`);
  }
  const badModels = ['--bare', '-x', 'Fable', 'SONNET', 'gpt-5', 'claude-', 'claude-gpt-5', 'claude-sonnet-', 'claude-sonnet-5-', ' sonnet', 'sonnet ', 'sonnet\n', 'sonnet --bare',
    'claude-sonnet-5-5\n', 'claude-sonnet-5-5 --bare', 'a'.repeat(65), 123, true, ['sonnet'], {}, 'sonnet[1m]']; // 拒否する model。[1m] は設定の claudeCode.model だけで使える。
  for (const bad of badModels) {
    check(throwsClass(() => parseJobModel(bad), ERROR_CLASS.INVALID_ARGUMENT), `model: 拒否する（${JSON.stringify(bad).slice(0, 40)}）`);
  }
  for (const level of CLAUDE_EFFORT_LEVELS) check(parseJobEffort(level) === level, `effort: 受け付ける（${level}）`);
  for (const bad of ['ultra', 'HIGH', 'high ', 'high\n', 'x-high', 5, ['high'], {}, true]) {
    check(throwsClass(() => parseJobEffort(bad), ERROR_CLASS.INVALID_ARGUMENT), `effort: 拒否する（${JSON.stringify(bad)}）`);
  }
  let modelMessage = ''; // 拒否したときの説明。
  let effortMessage = '';
  try { parseJobModel('--bare-MARKERWORD'); } catch (error) { modelMessage = error.message; }
  try { parseJobEffort('ultra-MARKERWORD'); } catch (error) { effortMessage = error.message; }
  check(modelMessage.includes('fable') && modelMessage.includes('claude-<系列>-<版>') && !modelMessage.includes('MARKERWORD'), 'model: 拒否の説明に受け付ける形を書き、入力値は書かない');
  check(effortMessage.includes('xhigh') && !effortMessage.includes('MARKERWORD'), 'effort: 拒否の説明に受け付ける値を書き、入力値は書かない');
  check(CLAUDE_MODEL_ALIASES.length === 4 && Object.isFrozen(CLAUDE_MODEL_ALIASES) && Object.isFrozen(CLAUDE_EFFORT_LEVELS) && CLAUDE_EFFORT_LEVELS.length === 5, '定数: 別名 4 つ・effort 5 つで、書き換えられない');
  const startDefinition = CLAUDE_JOB_TOOL_DEFINITIONS.find(definition => definition.name === 'start_claude_job');
  check(JSON.stringify(startDefinition.properties.effort.enum) === JSON.stringify(CLAUDE_EFFORT_LEVELS) && startDefinition.properties.effort.type === 'string', 'ツール定義: effort の enum は CLAUDE_EFFORT_LEVELS と同じ');
  check(startDefinition.properties.model.type === 'string' && !('enum' in startDefinition.properties.model) && startDefinition.properties.model.maxLength === 64, 'ツール定義: model は文字列（正式名も通すので enum にしない）');
}

function testEventSummaries() {
  const root = path.join(temporaryRoot, 'summary-root');
  fs.mkdirSync(root, { recursive: true });
  const toRelative = makeRelativizer(root);
  const redact = value => String(value).replace(/password: \S+/g, 'password: [REDACTED]');
  check(toRelative(path.join(root, 'a', 'b.txt')) === 'a/b.txt' && toRelative(path.join(root, '..', 'x.txt')) === '(プロジェクト外)' && toRelative('c/d.txt') === 'c/d.txt', '要約: パスをプロジェクト相対にし、外は (プロジェクト外)');
  const toolResult = summarizeEventLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET FILE CONTENT', is_error: false }] } }), { toRelative, redact });
  check(toolResult.length === 1 && toolResult[0].kind === 'tool_result' && toolResult[0].length === 19 && !JSON.stringify(toolResult).includes('SECRET'), '要約: ツールの結果は長さだけ（本文を返さない）');
  const assistant = summarizeEventLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'password: hunter2' }, { type: 'tool_use', name: 'Edit', input: { file_path: path.join(root, 'x.gd'), new_string: 'BODY' } }, { type: 'thinking', thinking: 'THINK' }] } }), { toRelative, redact });
  check(assistant.length === 2 && assistant[0].text === 'password: [REDACTED]' && assistant[1].target === 'x.gd' && !JSON.stringify(assistant).includes('BODY') && !JSON.stringify(assistant).includes('THINK'), '要約: 文章は伏せ字、編集は対象のファイルだけ（書いた本文・思考は返さない）');
  check(summarizeEventLine('{not json', { toRelative, redact })[0].kind === 'unparsed', '要約: 解釈できない行は unparsed');
  const status = {};
  applyEventToStatus(status, { type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555', model: 'm' }, { toRelative, redact });
  applyEventToStatus(status, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'n.txt') } }] } }, { toRelative, redact });
  applyEventToStatus(status, { type: 'result', subtype: 'success', is_error: false, result: 'done password: x', total_cost_usd: 0.5, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'git push' } }] }, { toRelative, redact });
  check(status.sessionId === '11111111-2222-3333-4444-555555555555' && status.touchedFiles[0] === 'n.txt' && status.result.text === 'done password: [REDACTED]' && status.result.costUsdEstimate === 0.5 && status.permissionDenials[0].target === 'git push', '状態: 会話 ID・編集したファイル・結果・拒否された操作を反映する');
  // 本物の Claude Code 2.1.310 の形: 実行中の permission_denied は tool_input を持たず message だけ。最後の result が同じ tool_use_id で tool_input を持つ。
  const denied = {};
  applyEventToStatus(denied, { type: 'system', subtype: 'permission_denied', tool_name: 'PowerShell', tool_use_id: 'toolu_1', message: 'Permission to use PowerShell with command git commit -am "x" has been denied.' }, { toRelative, redact });
  check(denied.permissionDenials.length === 1 && /git commit/.test(denied.permissionDenials[0].target), '状態: tool_input の無い拒否は、Claude Code の説明文を対象にする');
  applyEventToStatus(denied, { type: 'result', subtype: 'success', is_error: false, result: '', permission_denials: [{ tool_name: 'PowerShell', tool_use_id: 'toolu_1', tool_input: { command: 'git commit -am "x"' } }, { tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: { file_path: path.join(root, '.env') } }] }, { toRelative, redact });
  check(denied.permissionDenials.length === 2 && denied.permissionDenials[0].target === 'git commit -am "x"' && denied.permissionDenials[1].target === '.env', '状態: 同じ呼び出しの拒否は 1 件にまとめ、対象をコマンドに直す');
  const deniedLine = summarizeEventLine(JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'PowerShell', tool_use_id: 'toolu_1', message: 'Permission to use PowerShell with command git push has been denied.' }), { toRelative, redact });
  check(deniedLine[0].kind === 'permission_denied' && /git push/.test(deniedLine[0].target), 'ログ: tool_input の無い拒否も、対象を説明文で示す');
  const now = Date.parse('2026-10-25T00:00:40.000Z');
  check(effectiveState({ state: 'running', heartbeatAt: '2026-10-25T00:00:35.000Z' }, now) === 'running' && effectiveState({ state: 'running', heartbeatAt: '2026-10-25T00:00:00.000Z' }, now) === 'interrupted', '状態: heartbeat が 30 秒より古い動作中のジョブは interrupted');
  check(effectiveState({ state: 'succeeded', heartbeatAt: '2026-10-25T00:00:00.000Z' }, now) === 'succeeded' && effectiveState(null, now) === 'interrupted', '状態: 終わったジョブはそのまま、状態が無いものは interrupted');
}

function testResolveClaude() {
  const home = path.join(temporaryRoot, 'fake-home');
  const binary = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  check(resolveClaudeExecutable({ env: { USERPROFILE: home, PATH: '' }, homedir: home }) === null, '実行ファイル: 無ければ null');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, process.platform === 'win32' ? 'MZ' : '#!/bin/sh\n', { mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
  const found = resolveClaudeExecutable({ env: { USERPROFILE: home, PATH: 'relative-dir' }, homedir: home });
  check(found && path.resolve(found.command) === fs.realpathSync(binary) && found.prefixArgs.length === 0, '実行ファイル: ~/.local/bin の claude を絶対パスで見つける');
  if (process.platform !== 'win32') {
    fs.chmodSync(binary, 0o775);
    check(resolveClaudeExecutable({ env: { PATH: '' }, homedir: home }) === null, '実行ファイル: group が書き込める claude は使わない');
  } else {
    fs.rmSync(binary);
    fs.writeFileSync(path.join(path.dirname(binary), 'claude.cmd'), '@echo off\n');
    check(resolveClaudeExecutable({ env: { USERPROFILE: home, PATH: path.dirname(binary) }, homedir: home }) === null, '実行ファイル: Windows で claude.cmd（npm 版）は使わない');
  }
}

// ---------- サーバーの配線の試験 ----------

function testExposure() {
  const plain = makeProject('fp-plain');
  const plainPrinted = printExposure(plain);
  check(plainPrinted.status === 0 && !('claudeCode' in plainPrinted.exposure), '指紋: claudeCode が無い設定は、公開範囲に claudeCode を足さない（2.6.0 の承認が有効なまま）');
  const disabled = makeProject('fp-plain', { claudeCode: { enabled: false } });
  const disabledPrinted = printExposure(disabled);
  check(disabledPrinted.status === 0 && Object.keys(disabledPrinted.exposure).at(-1) === 'claudeCode' && disabledPrinted.sha256 !== plainPrinted.sha256, '指紋: claudeCode のキーがあれば（enabled: false でも）末尾に足し、指紋が変わる');
  const enabled = makeProject('fp-plain', { claudeCode: { enabled: true, allowedCommands: ['npm test', 'git status', 'npm test'], maxMinutes: 15, model: 'sonnet', effort: 'high' } });
  const enabledPrinted = printExposure(enabled);
  check(enabledPrinted.status === 0 && JSON.stringify(enabledPrinted.exposure.claudeCode) === JSON.stringify({ enabled: true, allowedCommands: ['git status', 'npm test'], model: 'sonnet', effort: 'high', maxMinutes: 15, maxBudgetUsd: null }), '指紋: claudeCode を正規化して入れる（重複を除いて整列）');
  check(LEGACY_EXPOSURE_KEYS.every((key, index) => Object.keys(plainPrinted.exposure)[index] === key), '指紋: 既存の項目の順序は変えない');
  for (const [label, claudeCode] of [
    ['未知の項目', { enabled: true, allowEverything: true }], ['enabled が文字列', { enabled: 'yes' }], ['シェル', { enabled: true, allowedCommands: ['bash -c x'] }],
    ['git push', { enabled: true, allowedCommands: ['git push'] }], ['ワイルドカードだけ', { enabled: true, allowedCommands: ['*'] }], ['配列でない', { enabled: true, allowedCommands: 'npm test' }],
    ['maxMinutes 0', { enabled: true, maxMinutes: 0 }], ['maxMinutes 181', { enabled: true, maxMinutes: 181 }], ['model に空白', { enabled: true, model: 'a b' }],
    ['effort 不正', { enabled: true, effort: 'huge' }], ['maxBudgetUsd 0', { enabled: true, maxBudgetUsd: 0 }], ['配列', [true]],
    ['model が先頭ハイフン（フラグ）', { enabled: true, model: '--bare' }], ['model が文字列でない', { enabled: true, model: 5 }], ['effort が配列', { enabled: true, effort: ['high'] }],
    ['2.10.0 で足していない項目（allowedModels）', { enabled: true, allowedModels: ['fable'] }],
  ]) {
    const project = makeProject('fp-bad', { claudeCode });
    const printed = printExposure(project);
    check(printed.status === 2 && /claudeCode/.test(printed.stderr), `設定: claudeCode の不正（${label}）は設定全体を拒否する`);
  }
  // 2.10.0: 設定の model は広い形のまま（[1m] の添え字も通る）。ChatGPT の引数より広い。設定のキーは増やしていない。
  const bracket = makeProject('fp-bracket', { claudeCode: { enabled: true, model: 'sonnet[1m]', effort: 'xhigh' } });
  const bracketPrinted = printExposure(bracket);
  check(bracketPrinted.status === 0 && bracketPrinted.exposure.claudeCode.model === 'sonnet[1m]' && bracketPrinted.exposure.claudeCode.effort === 'xhigh', '設定: claudeCode.model の sonnet[1m] と effort の xhigh は今までどおり通る');
  check(JSON.stringify(Object.keys(bracketPrinted.exposure.claudeCode)) === JSON.stringify(['enabled', 'allowedCommands', 'model', 'effort', 'maxMinutes', 'maxBudgetUsd']), '指紋: claudeCode の項目は 2.7.0 から増えていない（再承認は要らない）');
}

function testToolListsAndPermissions() {
  const plain = makeProject('srv-plain');
  approve(plain);
  const off = makeProject('srv-off', { claudeCode: { enabled: false } });
  approve(off);
  const on = makeProject('srv-on', { claudeCode: { enabled: true, allowedCommands: ['npm test'] } });
  approve(on);
  const unapproved = makeProject('srv-unapproved', { claudeCode: { enabled: true } });
  const accessLog = path.join(temporaryRoot, 'access.log');
  const hubFile = path.join(temporaryRoot, 'hub.json');
  fs.writeFileSync(hubFile, JSON.stringify({ schemaVersion: 1, accessLog, projects: [plain, off, on, unapproved].map((project, index) => ({ name: ['plain', 'off', 'on', 'unapproved'][index], root: project.root, approvalFile: project.approvalFile })) }));
  const hub = runServer(['--stdio', '--hub', hubFile], [
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    callRequest(3, 'start_claude_job', { project: 'plain', prompt: 'MARKER-PROMPT-7f3a do something' }),
    callRequest(4, 'start_claude_job', { project: 'off', prompt: 'x' }),
    callRequest(5, 'start_claude_job', { project: 'unapproved', prompt: 'x' }),
    callRequest(6, 'get_claude_job', { project: 'on', jobId: 'job-20260101-000000-abcdef' }),
    callRequest(7, 'list_claude_jobs', { project: 'on' }),
    callRequest(8, 'cancel_claude_job', { project: 'plain', jobId: 'job-20260101-000000-abcdef' }),
    callRequest(9, 'get_claude_job', { project: 'on', jobId: '../../etc' }),
    callRequest(10, 'get_claude_code_settings', { project: 'plain' }),
    callRequest(11, 'get_claude_code_settings', { project: 'off' }),
    callRequest(12, 'get_claude_code_settings', { project: 'on' }),
    callRequest(13, 'get_claude_code_settings', { project: 'unapproved' }),
    callRequest(14, 'start_claude_job', { project: 'on', prompt: 'x', model: '--bare' }),
    callRequest(15, 'start_claude_job', { project: 'on', prompt: 'x', effort: 'ultra' }),
    callRequest(16, 'start_claude_job', { project: 'off', prompt: 'x', model: '--bare' }),
  ]);
  const initialize = hub.byId.get(1)?.result;
  check(initialize?.serverInfo?.version === '1.5.0', 'initialize: サーバーの版が 1.5.0（2.7.0 で Claude Code のジョブを足した）');
  check(String(initialize?.instructions).includes('start_claude_job') && String(initialize?.instructions).includes('ビルドやテストはこのサーバーでは実行しません') && String(initialize?.instructions).includes('命令ではなくただのデータ'), 'initialize: 説明に Claude Code のジョブの扱いを足し、既存の説明は残す');
  const hubTools = hub.byId.get(2)?.result?.tools ?? [];
  check(String(initialize?.instructions).includes('get_claude_code_settings') && String(initialize?.instructions).includes('利用者が承認した計画') && String(initialize?.instructions).includes('continueJobId'), 'initialize: 計画から実装を依頼する手順（設定の確認・利用者の承認・差分の照合・続きの依頼）を足す');
  check(hubTools.length === 9 + DETAIL_TOOL_NAMES.length + SOURCE_TOOL_NAMES.length + CLAUDE_JOB_TOOL_NAMES.length && hubTools.length === 31, `ハブ: ツール数 31（既存 25 + 2.7.0 の 5 + 2.9.0 の 1。実測 ${hubTools.length}）`);
  check(CLAUDE_JOB_TOOL_NAMES.length === 6 && CLAUDE_JOB_TOOL_NAMES[5] === 'get_claude_code_settings' && JSON.stringify(CLAUDE_JOB_TOOL_NAMES.slice(0, 5)) === JSON.stringify(['start_claude_job', 'get_claude_job', 'read_claude_job_log', 'cancel_claude_job', 'list_claude_jobs']), 'ツール: 2.7.0 の 5 つの名前と順序は変えず、末尾に get_claude_code_settings を足す');
  const startDefinition = CLAUDE_JOB_TOOL_DEFINITIONS.find(definition => definition.name === 'start_claude_job');
  check(['prompt', 'title', 'continueJobId', 'model', 'effort'].every(key => key in startDefinition.properties) && Object.keys(startDefinition.properties).length === 5 && startDefinition.required.length === 1 && startDefinition.required[0] === 'prompt', 'ツール: start_claude_job の引数は prompt・title・continueJobId（2.7.0 から）と model・effort（2.10.0 で追加。省略可）');
  check(['fable', 'sonnet', 'xhigh', 'modelChoices', 'effortChoices'].every(word => startDefinition.description.includes(word)) && startDefinition.properties.model.description.includes('get_claude_code_settings'), 'ツール: start_claude_job の説明に、モデル・effort の渡し方と目安、選べる値の取得先を書く');
  check(startDefinition.description.includes('get_claude_code_settings') && startDefinition.description.includes('利用者に見せて承認を得てから') && startDefinition.description.includes('continueJobId') && startDefinition.description.includes('許可された形のとおり'), 'ツール: start_claude_job の説明に、計画の渡し方の手順とひな形を書く');
  check(JSON.stringify(hubTools.slice(25).map(tool => tool.name)) === JSON.stringify(CLAUDE_JOB_TOOL_NAMES), 'ハブ: 新ツールは既存の 25 個の後ろに並ぶ');
  for (const definition of CLAUDE_JOB_TOOL_DEFINITIONS) {
    const tool = hubTools.find(candidate => candidate.name === definition.name);
    check(tool && JSON.stringify(tool.annotations) === JSON.stringify(definition.annotations) && tool.inputSchema.required[0] === 'project' && tool.inputSchema.additionalProperties === false, `ハブ: ${definition.name} の注釈と project 引数`);
  }
  check(hubTools.find(tool => tool.name === 'start_claude_job')?.annotations.readOnlyHint === false && hubTools.find(tool => tool.name === 'cancel_claude_job')?.annotations.readOnlyHint === false, 'ハブ: start と cancel は読み取り専用ではないと注釈する');
  check(['get_claude_job', 'read_claude_job_log', 'list_claude_jobs', 'get_claude_code_settings'].every(name => hubTools.find(tool => tool.name === name)?.annotations.readOnlyHint === true), 'ハブ: get・read・list・設定の取得は読み取り専用と注釈する');
  const settingsTool = hubTools.find(tool => tool.name === 'get_claude_code_settings');
  check(JSON.stringify(Object.keys(settingsTool?.inputSchema?.properties ?? {})) === JSON.stringify(['project']) && JSON.stringify(settingsTool?.inputSchema?.required) === JSON.stringify(['project']), 'ハブ: get_claude_code_settings の引数は project だけ');
  const hubStart = hubTools.find(tool => tool.name === 'start_claude_job');
  check(hubStart?.inputSchema?.properties?.model?.type === 'string' && JSON.stringify(hubStart?.inputSchema?.properties?.effort?.enum) === JSON.stringify(CLAUDE_EFFORT_LEVELS) && JSON.stringify(hubStart?.inputSchema?.required) === JSON.stringify(['project', 'prompt']) && hubStart?.inputSchema?.additionalProperties === false, 'ハブ: start_claude_job の schema に省略可の model・effort（必須は project と prompt だけ）');
  check(hubTools.slice(0, 25).every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false), 'ハブ: 既存の 25 ツールは読み取り専用の注釈のまま');
  const plainStart = toolResult(hub, 3);
  check(plainStart.isError === true && plainStart.json?.meta?.errorClass === 'permission_denied' && plainStart.json?.meta?.hidden?.includes('claudeCode'), '権限: claudeCode の無いプロジェクトは permission_denied（hidden に claudeCode）');
  const offStart = toolResult(hub, 4);
  check(offStart.isError === true && offStart.json?.meta?.errorClass === 'permission_denied', '権限: claudeCode.enabled が false なら permission_denied');
  const unapprovedStart = toolResult(hub, 5);
  check(unapprovedStart.isError === true && unapprovedStart.text.includes('は使用できません'), '権限: 未承認のプロジェクトは、存在を明かさない共通の文言で拒否');
  check(toolResult(hub, 6).json?.meta?.errorClass === 'job_not_found', '権限: 許可したプロジェクトでは get_claude_job が動く（無い jobId は job_not_found）');
  check(toolResult(hub, 7).isError === false && Array.isArray(toolResult(hub, 7).json?.facts?.jobs), '権限: 許可したプロジェクトでは list_claude_jobs が動く');
  check(toolResult(hub, 8).json?.meta?.errorClass === 'permission_denied', '権限: 許可の無いプロジェクトでは cancel_claude_job も拒否');
  check(toolResult(hub, 9).json?.meta?.errorClass === 'invalid_argument', '引数: jobId の形が違えば invalid_argument（パスとして使わない）');
  const settingsPlain = toolResult(hub, 10);
  check(settingsPlain.isError === false && settingsPlain.json?.facts?.enabled === false && settingsPlain.json?.facts?.configured === false && settingsPlain.json?.meta?.status === 'ok', '設定の取得: claudeCode の無いプロジェクトも、エラーにせず enabled: false・configured: false を返す');
  check(settingsPlain.json?.meta?.warnings?.some(text => text.includes('chatgpt-project-bridge-gui') && text.includes('Claude Code の起動を切り替え')), '設定の取得: 無効のときは、利用者が管理画面で有効にして承認する手順を注意書きで示す');
  const settingsOff = toolResult(hub, 11);
  check(settingsOff.isError === false && settingsOff.json?.facts?.enabled === false && settingsOff.json?.facts?.configured === true, '設定の取得: enabled: false の設定は enabled: false・configured: true');
  for (const [label, result] of [['claudeCode なし', settingsPlain], ['enabled: false', settingsOff]]) {
    const factKeys = Object.keys(result.json?.facts ?? {}).sort().join(',');
    check(factKeys === 'configured,enabled', `設定の取得: 無効のとき（${label}）は、許可コマンド・制限時間などの中身を返さない（実測 ${factKeys}）`);
  }
  const settingsOn = toolResult(hub, 12);
  const onFacts = settingsOn.json?.facts ?? {};
  check(settingsOn.isError === false && onFacts.enabled === true && JSON.stringify(onFacts.allowedCommands) === JSON.stringify(['npm test']) && onFacts.maxMinutes === 30 && onFacts.model === null && onFacts.effort === null && onFacts.hasBudgetLimit === false && onFacts.activeJobs === 0, '設定の取得: 有効なら許可コマンド・制限時間・モデル・同時実行の数を返す');
  check(JSON.stringify(onFacts.review) === JSON.stringify({ workingTreeList: true, diffExcerpts: true, sourceText: true }) && Array.isArray(onFacts.commandRules) && onFacts.commandRules.length >= 3 && Array.isArray(onFacts.scope) && onFacts.scope.length >= 2, '設定の取得: 結果の確認に使える手段の公開範囲と、コマンドの規則・作業の範囲の説明を返す');
  check(settingsOn.json?.meta?.limits?.maxActiveJobsPerProject === 1 && settingsOn.json?.meta?.limits?.maxPromptChars === 20000, '設定の取得: 同時に動かせる数と、依頼文の最大文字数を limits に返す');
  check(!settingsOn.text.includes('[REDACTED]') && !settingsPlain.text.includes('[REDACTED]') && !/secret|token|password/i.test(Object.keys(onFacts).join(',')), '設定の取得: 応答のキー名が伏せ字の対象にならず、JSON が壊れない');
  const settingsUnapproved = toolResult(hub, 13);
  check(settingsUnapproved.isError === true && settingsUnapproved.text.includes('は使用できません'), '設定の取得: 未承認のプロジェクトは、他のツールと同じ文言で拒否（claudeCode の中身も明かさない）');
  check(JSON.stringify(onFacts.modelChoices) === JSON.stringify(CLAUDE_MODEL_ALIASES) && JSON.stringify(onFacts.effortChoices) === JSON.stringify(CLAUDE_EFFORT_LEVELS) && Array.isArray(onFacts.choiceRules) && onFacts.choiceRules.length >= 3 && onFacts.choiceRules.some(text => text.includes('優先順位')), '設定の取得: 有効なら、model・effort の選択肢と、優先順位・利用枠・拒否の説明を返す');
  const badModelStart = toolResult(hub, 14);
  check(badModelStart.isError === true && badModelStart.json?.meta?.errorClass === 'invalid_argument' && !badModelStart.text.includes('--bare'), '引数: 有効なプロジェクトでも、フラグのような model は invalid_argument（入力値を応答に書かない）');
  check(toolResult(hub, 15).json?.meta?.errorClass === 'invalid_argument', '引数: 範囲外の effort は invalid_argument');
  check(toolResult(hub, 16).json?.meta?.errorClass === 'permission_denied', '権限: 無効なプロジェクトでは、引数が不正でも先に permission_denied（権限の判定が先）');
  const logText = fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8') : '';
  check(logText.includes('"tool":"start_claude_job"') && !logText.includes('MARKER-PROMPT-7f3a'), 'アクセスログ: ツール名は記録し、依頼文は記録しない');

  const single = runServer(['--stdio', '--project-root', on.root, '--config', on.configPath, '--approval-file', on.approvalFile], [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const singleTools = single.byId.get(2)?.result?.tools ?? [];
  check(singleTools.length === 30 && singleTools.slice(24).every(tool => !('project' in (tool.inputSchema.properties || {}))), `単一モード: ツール数 30（既存 24 + 2.7.0 の 5 + 2.9.0 の 1。実測 ${singleTools.length}）で、project 引数は無い`);
}

// get_claude_code_settings をジョブの層で直接呼ぶ試験（有効・予算の上限・許可コマンドなし・動いているジョブの数）。
async function testClaudeCodeSettingsTool() {
  const budget = makeProject('settings-budget', { claudeCode: { enabled: true, allowedCommands: ['git status', 'npm test'], model: 'sonnet', effort: 'high', maxMinutes: 12, maxBudgetUsd: 7.5 } });
  const budgetManager = makeManager(budget, 'settings-budget');
  const budgetResponse = budgetManager.manager.settings();
  check(budgetResponse.tool === 'get_claude_code_settings' && budgetResponse.facts.hasBudgetLimit === true && !JSON.stringify(budgetResponse).includes('7.5'), '設定の取得: 予算の上限は有無だけで、金額は返さない');
  check(JSON.stringify(budgetResponse.facts.allowedCommands) === JSON.stringify(['git status', 'npm test']) && budgetResponse.facts.maxMinutes === 12 && budgetResponse.facts.model === 'sonnet' && budgetResponse.facts.effort === 'high', '設定の取得: 許可コマンド・制限時間・モデル・effort を設定どおりに返す');
  check(JSON.stringify(budgetResponse.facts.modelChoices) === JSON.stringify(['fable', 'opus', 'sonnet', 'haiku']) && JSON.stringify(budgetResponse.facts.effortChoices) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']), '設定の取得: model・effort の選択肢（別名 4 つ・effort 5 つ）は、プロジェクトの既定（sonnet・high）とは別に返す');
  check(!budgetResponse.meta.warnings.some(text => text.includes('許可コマンドが無い')), '設定の取得: 許可コマンドがあれば「コマンドを実行できない」とは書かない');

  const editOnly = makeProject('settings-edit-only', { claudeCode: { enabled: true } });
  const editOnlyManager = makeManager(editOnly, 'settings-edit-only');
  const editOnlyResponse = editOnlyManager.manager.settings();
  check(editOnlyResponse.facts.enabled === true && editOnlyResponse.facts.allowedCommands.length === 0 && editOnlyResponse.meta.warnings.some(text => text.includes('許可コマンドが無い') && text.includes('get_git_diff')), '設定の取得: 許可コマンドが無ければ、編集だけできることと、確認は差分で行う旨を注意書きで示す');

  const hidden = makeProject('settings-no-review', { claudeCode: { enabled: true }, config: { gitExposure: { paths: false, commitSubjects: false }, detailExposure: { branchNames: false, diffExcerpts: false, sourceText: false } } });
  const hiddenResponse = makeManager(hidden, 'settings-no-review').manager.settings();
  check(JSON.stringify(hiddenResponse.facts.review) === JSON.stringify({ workingTreeList: false, diffExcerpts: false, sourceText: false }) && hiddenResponse.meta.warnings.some(text => text.includes('結果の確認に使える手段が限られます')), '設定の取得: 作業ツリーの一覧・差分が非公開なら、確認の手段が限られると注意書きで示す');

  const busy = makeProject('settings-busy', { claudeCode: { enabled: true } });
  const busyManager = makeManager(busy, 'settings-busy');
  check(busyManager.manager.settings().facts.activeJobs === 0, '設定の取得: ジョブが無ければ activeJobs は 0');
  const sleeping = busyManager.manager.start({ prompt: 'MODE:sleep' });
  const jobId = sleeping.facts.job.jobId;
  const directory = jobDirectoryOf(busyManager.context, 'settings-busy', jobId);
  await waitFor(() => fs.existsSync(path.join(directory, 'fake-grandchild.pid')), 20000);
  const duringResponse = busyManager.manager.settings();
  check(duringResponse.facts.activeJobs === 1 && duringResponse.meta.warnings.some(text => text.includes('すでに動いています')), '設定の取得: 動いているジョブがあれば activeJobs が 1 で、終わってから起動するよう注意書きで示す');
  busyManager.manager.cancel({ jobId });
  await waitForEnd(busyManager.manager, jobId, 20000);
  check(busyManager.manager.settings().facts.activeJobs === 0, '設定の取得: ジョブが終われば activeJobs は 0 に戻る');
  check(!fs.existsSync(path.join(stateRoot, projectStorageKey('settings-edit-only', editOnlyManager.context.claudeJobBoundary.projectRoot, process.platform === 'win32'))), '設定の取得: 呼んだだけでは、ジョブの記録のディレクトリを作らない（読み取り専用）');
}

// ---------- ジョブの流れの試験（偽の Claude Code） ----------

async function testJobSucceeds() {
  const project = makeProject('job-ok', { claudeCode: { enabled: true, allowedCommands: ['node scripts/*-selftest.mjs'], model: 'sonnet', maxMinutes: 5 }, git: true });
  const { context, manager } = makeManager(project, 'job-ok');
  const started = Date.now();
  const response = manager.start({ prompt: 'MODE:ok テスト用の依頼', title: '題名\nの改行' });
  const jobId = response.facts.job.jobId;
  check(Date.now() - started < 15000 && /^job-\d{8}-\d{6}-[0-9a-f]{6}$/.test(jobId) && response.facts.job.state === 'queued', '開始: すぐに jobId を返す（終わるまで待たない）');
  check(response.facts.job.title === '題名 の改行' && response.facts.workingTreeAtStart.changeCount >= 1, '開始: 題名の改行を除き、開始前の未コミットの変更を数える');
  const state = await waitForEnd(manager, jobId);
  check(state === 'succeeded', `完了: 結果が成功で終了コード 0 なら succeeded（実測 ${state}）`);
  const jobDirectory = jobDirectoryOf(context, 'job-ok', jobId);
  const probe = JSON.parse(fs.readFileSync(path.join(jobDirectory, 'fake-probe.json'), 'utf8'));
  check(probe.prompt === 'MODE:ok テスト用の依頼', '起動: 依頼文を標準入力で渡す');
  check(path.resolve(probe.cwd).toLowerCase() === path.resolve(context.claudeJobBoundary.projectRoot).toLowerCase(), '起動: 作業フォルダーはプロジェクトのルート');
  check(!('CONTROL_PLANE_API_KEY' in probe.env) && !('ANTHROPIC_API_KEY' in probe.env) && !('GITHUB_TOKEN' in probe.env), '起動: Tunnel Client の鍵・ANTHROPIC_API_KEY・トークンを Claude Code に渡さない');
  check(probe.args.includes('dontAsk') && probe.args.includes('--strict-mcp-config') && !probe.args.includes('--bg') && !probe.args.includes('-w') && probe.args[probe.args.indexOf('--model') + 1] === 'sonnet', '起動: 設定どおりの引数（dontAsk・MCP なし・--bg と -w なし・model）');
  const settings = JSON.parse(fs.readFileSync(path.join(jobDirectory, JOB_FILES.settings), 'utf8'));
  check(settings.permissions.deny.includes('Read(//**/.env)') && settings.permissions.allow.includes(process.platform === 'win32' ? 'PowerShell(node scripts/*-selftest.mjs)' : 'Bash(node scripts/*-selftest.mjs)'), '起動: 生成した settings に deny と許可したコマンドが入る');
  const got = manager.get({ jobId });
  const job = got.facts.job;
  check(job.report === '完了しました。edited.txt を作りました。' && job.outcome.costUsdEstimate === 0.0123 && job.outcome.numTurns === 2 && job.model === 'fake-model', '状態: 最後の報告・推定コスト・ターン数・モデル');
  check(got.facts.touchedFiles.includes('edited.txt') && got.facts.touchedFiles.includes('(プロジェクト外)'), '状態: Claude Code が編集したファイル（プロジェクト外は名前を出さない）');
  check(got.facts.permissionDenials.some(item => item.tool === 'Bash' && item.target === 'git push origin main'), '状態: 拒否された操作');
  check(got.facts.newSinceStart.some(entry => entry.path === 'edited.txt') && got.facts.preexistingAtStart.some(entry => entry.path === 'preexisting.txt') && !got.facts.newSinceStart.some(entry => entry.path === 'preexisting.txt'), '状態: 開始前からあった変更と、開始後に増えた変更を分ける');
  const whole = JSON.stringify(got);
  check(!whole.includes('hunter2') && !whole.includes('SECRET FILE CONTENT') && !whole.includes('TOPSECRETBODY'), '状態: 秘密値・ツールの結果の本文・書いた本文を返さない');
  const page1 = manager.readLog({ jobId, limit: 3 });
  const page2 = manager.readLog({ jobId, cursor: page1.page.nextCursor, limit: 200 });
  const entries = [...page1.facts.entries, ...page2.facts.entries];
  const kinds = entries.map(entry => entry.kind);
  check(page1.facts.entries.length <= 3 && page1.page.hasMore === true && page2.page.hasMore === false, 'ログ: limit で分け、cursor で続きを取る');
  check(kinds.includes('init') && kinds.includes('text') && kinds.includes('tool_use') && kinds.includes('tool_result') && kinds.at(-1) === 'result', 'ログ: 初期化・文章・ツールの呼び出し・ツールの結果・最終結果を古い順に返す');
  check(entries.some(entry => entry.kind === 'tool_use' && entry.tool === 'Edit' && entry.target === 'edited.txt') && entries.some(entry => entry.kind === 'tool_use' && entry.tool === 'Bash' && entry.target === 'node scripts/run-selftest.mjs'), 'ログ: ツールの呼び出しは対象（ファイル・コマンド）だけ');
  const logText = JSON.stringify([page1, page2]);
  check(!logText.includes('hunter2') && !logText.includes('SECRET FILE CONTENT') && !logText.includes('TOPSECRETBODY'), 'ログ: 秘密値・ツールの結果の本文・書いた本文を返さない');
  check(throwsClass(() => manager.readLog({ jobId, cursor: '1' }), ERROR_CLASS.STALE_CURSOR) && throwsClass(() => manager.readLog({ jobId, cursor: '99999999' }), ERROR_CLASS.STALE_CURSOR) && throwsClass(() => manager.readLog({ jobId, cursor: '-1' }), ERROR_CLASS.INVALID_ARGUMENT), 'ログ: 行の途中・範囲外の cursor は stale_cursor、形の違う cursor は invalid_argument');
  const cancelDone = manager.cancel({ jobId });
  check(cancelDone.facts.cancelRequested === false && cancelDone.facts.state === 'succeeded', '停止: 終わったジョブには何もしない');

  const continued = manager.start({ prompt: 'MODE:ok 続き', continueJobId: jobId });
  await waitForEnd(manager, continued.facts.job.jobId);
  const continuedProbe = JSON.parse(fs.readFileSync(path.join(jobDirectoryOf(context, 'job-ok', continued.facts.job.jobId), 'fake-probe.json'), 'utf8'));
  check(continuedProbe.args[continuedProbe.args.indexOf('--resume') + 1] === probe.args[probe.args.indexOf('--session-id') + 1] && !continuedProbe.args.includes('--session-id'), '継続: 前のジョブの会話を --resume で引き継ぐ');
  check(manager.get({ jobId: continued.facts.job.jobId, includeWorkingTree: false }).facts.job.continuedFrom === jobId, '継続: continuedFrom に前のジョブ');
  check(throwsClass(() => manager.start({ prompt: 'x', continueJobId: 'job-20200101-000000-000000' }), ERROR_CLASS.JOB_NOT_FOUND), '継続: 無いジョブは job_not_found');
  const listed = manager.list({});
  check(listed.facts.jobs.length === 2 && listed.facts.jobs[0].jobId === continued.facts.job.jobId, '一覧: 新しい順');
  check(throwsClass(() => manager.start({ prompt: '' }), ERROR_CLASS.INVALID_ARGUMENT) && throwsClass(() => manager.start({ prompt: 'x'.repeat(20001) }), ERROR_CLASS.INVALID_ARGUMENT), '引数: 空・長すぎる依頼文は invalid_argument');
}

// ジョブの記録のディレクトリにある、ジョブの名前の一覧（並べ替え済み）。
function jobNamesOf(context, label) {
  const directory = path.dirname(jobDirectoryOf(context, label, 'job-00000000-000000-000000'));
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.startsWith('job-')).sort() : [];
}

// 2.10.0: 終わったジョブの記録（job.json）と、偽の Claude Code が残した引数（fake-probe.json）を読む。
function readJobArtifacts(context, label, jobId) {
  const directory = jobDirectoryOf(context, label, jobId);
  return {
    probe: JSON.parse(fs.readFileSync(path.join(directory, 'fake-probe.json'), 'utf8')),
    record: JSON.parse(fs.readFileSync(path.join(directory, JOB_FILES.job), 'utf8')),
  };
}

// ジョブを開始して終わるまで待ち、開始の応答・最終の状態・引数・記録を返す。
async function runJob({ context, manager }, label, input = {}) {
  const response = manager.start({ prompt: 'MODE:ok テスト', ...input });
  const jobId = response.facts.job.jobId;
  const state = await waitForEnd(manager, jobId);
  return { response, job: response.facts.job, jobId, state, ...readJobArtifacts(context, label, jobId) };
}

// 2.10.0: start_claude_job の model・effort（優先順位・続きの依頼での引き継ぎ・検証の順序）。偽の Claude Code を使う。
async function testModelAndEffortOverrides() {
  const label = 'job-model';
  const project = makeProject(label, { claudeCode: { enabled: true, model: 'sonnet', effort: 'high', maxMinutes: 5 } });
  const pair = makeManager(project, label);
  const argsOf = result => result.probe.args; // 偽の Claude Code が受け取った引数。

  // 1. 引数で model・effort を選ぶ。
  const first = await runJob(pair, label, { model: 'fable', effort: 'max' });
  check(first.state === 'succeeded', `model: 引数を付けたジョブも succeeded（実測 ${first.state}）`);
  check(pairs(argsOf(first), '--model') === 'fable' && pairs(argsOf(first), '--effort') === 'max' && countOf(argsOf(first), '--model') === 1 && countOf(argsOf(first), '--effort') === 1, '起動: 引数の model・effort を --model・--effort に 1 回ずつ渡す（設定の sonnet・high より優先）');
  check(first.job.requestedModel === 'fable' && first.job.modelSource === 'request' && first.job.effort === 'max' && first.job.effortSource === 'request', '開始: 応答に requestedModel・effort と、出どころ request');
  check(first.record.model === 'fable' && first.record.modelSource === 'request' && first.record.effort === 'max' && first.record.effortSource === 'request', '記録: job.json に実効値と出どころを残す');
  const got = pair.manager.get({ jobId: first.jobId, includeWorkingTree: false }).facts.job;
  check(got.model === 'fake-model' && got.requestedModel === 'fable' && got.modelSource === 'request', '状態: model は Claude Code が報告した実際のモデル、requestedModel は渡した値（意味を分ける）');

  // 2〜4. 一部だけ・何も渡さない・空の値は、設定で補う。
  const second = await runJob(pair, label, { effort: 'low' });
  check(pairs(argsOf(second), '--model') === 'sonnet' && pairs(argsOf(second), '--effort') === 'low' && second.job.modelSource === 'project' && second.job.effortSource === 'request', '優先順位: effort だけ渡すと、model は設定（sonnet）で補う');
  const third = await runJob(pair, label);
  check(pairs(argsOf(third), '--model') === 'sonnet' && pairs(argsOf(third), '--effort') === 'high' && third.job.modelSource === 'project' && third.job.effortSource === 'project', '優先順位: 何も渡さなければ設定（sonnet・high）');
  const fourth = await runJob(pair, label, { model: '', effort: null });
  check(pairs(argsOf(fourth), '--model') === 'sonnet' && pairs(argsOf(fourth), '--effort') === 'high' && fourth.job.modelSource === 'project', '優先順位: 空文字列・null は省略と同じ（ChatGPT が空の省略可の引数を送っても動く）');

  // 5. 続きの依頼: 前のジョブが引数で選んだ値を引き継ぐ。引数があればそちらが優先。
  const resumed = await runJob(pair, label, { continueJobId: first.jobId });
  check(countOf(argsOf(resumed), '--resume') === 1 && pairs(argsOf(resumed), '--model') === 'fable' && pairs(argsOf(resumed), '--effort') === 'max' && resumed.job.modelSource === 'continued' && resumed.job.effortSource === 'continued', '継続: 前のジョブが引数で選んだ model・effort を引き継ぐ（出どころ continued）');
  const override = await runJob(pair, label, { continueJobId: first.jobId, model: 'opus' });
  check(pairs(argsOf(override), '--model') === 'opus' && override.job.modelSource === 'request' && pairs(argsOf(override), '--effort') === 'max' && override.job.effortSource === 'continued', '継続: 引数で選び直した model が優先し、effort は引き継ぐ');
  const chained = await runJob(pair, label, { continueJobId: resumed.jobId });
  check(pairs(argsOf(chained), '--model') === 'fable' && chained.job.modelSource === 'continued', '継続: continued も次の続きへ引き継ぐ');

  // 6. 続きの依頼でも、project 由来の値は引き継がず、いまの設定を使う（設定を変えたあとに古い既定が残らない）。
  makeProject(label, { claudeCode: { enabled: true, model: 'opus', effort: 'medium', maxMinutes: 5 } });
  const changed = makeManager(project, label);
  const afterChange = await runJob(changed, label, { continueJobId: third.jobId });
  check(pairs(argsOf(afterChange), '--model') === 'opus' && pairs(argsOf(afterChange), '--effort') === 'medium' && afterChange.job.modelSource === 'project' && afterChange.job.effortSource === 'project', '継続: project 由来の値は引き継がず、いまの設定（opus・medium）を使う');

  // 7. 2.9.0 以前の記録（出どころなし）と、書き換えられた記録。
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const writeRecord = (jobId, jobFields) => {
    const directory = jobDirectoryOf(changed.context, label, jobId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, JOB_FILES.job), JSON.stringify({ schemaVersion: 1, jobId, createdAt: '2020-01-01T00:00:00.000Z', maxMinutes: 5, ...jobFields }), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, JOB_FILES.status), JSON.stringify({ schemaVersion: 1, jobId, state: 'succeeded', createdAt: '2020-01-01T00:00:00.000Z', heartbeatAt: '2020-01-01T00:00:00.000Z', sessionId }), { mode: 0o600 });
  };
  writeRecord('job-20200101-000001-000001', { model: 'sonnet', effort: 'high' });
  const legacy = await runJob(changed, label, { continueJobId: 'job-20200101-000001-000001' });
  check(pairs(argsOf(legacy), '--resume') === sessionId && pairs(argsOf(legacy), '--model') === 'opus' && legacy.job.modelSource === 'project', '継続: 出どころの無い 2.9.0 以前の記録は引き継がず、いまの設定を使う');
  writeRecord('job-20200101-000002-000002', { model: '--bare', modelSource: 'request', effort: 'ultra', effortSource: 'request' });
  const tampered = await runJob(changed, label, { continueJobId: 'job-20200101-000002-000002' });
  check(!argsOf(tampered).includes('--bare') && !argsOf(tampered).includes('ultra') && pairs(argsOf(tampered), '--model') === 'opus' && pairs(argsOf(tampered), '--effort') === 'medium', '継続: 書き換えられた記録の値（--bare・不正な effort）は引数にせず、設定へ落とす');
  writeRecord('job-20200101-000003-000003', { model: 'claude-fable-5-1', modelSource: 'continued', effort: 'xhigh', effortSource: 'request' });
  const stored = await runJob(changed, label, { continueJobId: 'job-20200101-000003-000003' });
  check(pairs(argsOf(stored), '--model') === 'claude-fable-5-1' && pairs(argsOf(stored), '--effort') === 'xhigh', '継続: 記録の正しい値は引き継ぐ（正式名も）');

  // 8. 設定に model・effort が無いプロジェクト: 指定が無ければフラグを付けない（Claude Code の既定）。
  const bareLabel = 'job-model-default';
  const bareProject = makeProject(bareLabel, { claudeCode: { enabled: true } });
  const barePair = makeManager(bareProject, bareLabel);
  const bare = await runJob(barePair, bareLabel);
  check(!argsOf(bare).includes('--model') && !argsOf(bare).includes('--effort') && bare.job.requestedModel === null && bare.job.modelSource === 'default' && bare.job.effortSource === 'default', '優先順位: 設定にも引数にも無ければ --model・--effort を付けない（出どころ default）');
  const bareChosen = await runJob(barePair, bareLabel, { model: 'haiku', effort: 'xhigh' });
  check(pairs(argsOf(bareChosen), '--model') === 'haiku' && pairs(argsOf(bareChosen), '--effort') === 'xhigh', '優先順位: 設定が無いプロジェクトでも、引数があれば渡す');

  // 9. 不正な引数: ジョブの記録も起動も作らない（検証が副作用より前にある）。
  const before = JSON.stringify(jobNamesOf(changed.context, label));
  let rejected = 0; // 拒否した数。
  const badInputs = [{ model: '--bare' }, { model: 'Fable' }, { model: 'gpt-5' }, { model: 'sonnet --bare' }, { model: 'x'.repeat(65) }, { model: 123 },
    { effort: 'ultra' }, { effort: 'HIGH' }, { effort: ['high'] }, { model: 'fable', effort: 'ultra' }, { continueJobId: first.jobId, model: '--bare' }];
  for (const bad of badInputs) {
    if (throwsClass(() => changed.manager.start({ prompt: 'MODE:ok', ...bad }), ERROR_CLASS.INVALID_ARGUMENT)) rejected += 1;
  }
  check(rejected === badInputs.length, `引数: 不正な model・effort は invalid_argument（${rejected}/${badInputs.length} 件）`);
  check(JSON.stringify(jobNamesOf(changed.context, label)) === before, '引数: 拒否したときは、ジョブの記録を作らず、ランナーも起動しない');
  check(changed.manager.list({}).facts.jobs.every(job => !['queued', 'running'].includes(job.state)), '引数: 拒否したあとに動いているジョブは無い');

  // 10. 無効なプロジェクトでは、引数の検証より先に権限の判定。
  const offLabel = 'job-model-off';
  const offPair = makeManager(makeProject(offLabel, { claudeCode: { enabled: false } }), offLabel);
  check(throwsClass(() => offPair.manager.start({ prompt: 'x', model: '--bare' }), ERROR_CLASS.PERMISSION_DENIED) && throwsClass(() => offPair.manager.start({ prompt: 'x', model: 'fable' }), ERROR_CLASS.PERMISSION_DENIED), '権限: claudeCode が無効なら、model を渡しても permission_denied（引数の検証より先）');
}

async function testJobFailures() {
  const project = makeProject('job-fail', { claudeCode: { enabled: true } });
  const { manager } = makeManager(project, 'job-fail');
  const failed = manager.start({ prompt: 'MODE:fail' });
  check(await waitForEnd(manager, failed.facts.job.jobId) === 'failed', '失敗: 結果が is_error なら failed');
  const noResult = manager.start({ prompt: 'MODE:noresult' });
  check(await waitForEnd(manager, noResult.facts.job.jobId) === 'failed', '失敗: 結果を出さずに終われば failed');
  const described = manager.get({ jobId: noResult.facts.job.jobId, includeWorkingTree: false }).facts.job;
  check(/結果を出さずに/.test(described.errorMessage) && /something broke/.test(described.stderrTail || '') && described.exitCode === 3, '失敗: 理由・終了コード・標準エラー出力の末尾を返す');
  const big = manager.start({ prompt: 'MODE:big' });
  check(await waitForEnd(manager, big.facts.job.jobId) === 'succeeded', '大きな出力: 5 MiB の 1 行があっても最後まで動く');
  const bigLog = manager.readLog({ jobId: big.facts.job.jobId, limit: 200 });
  check(bigLog.facts.omittedLines === 1 && bigLog.facts.entries.some(entry => entry.kind === 'omitted') && bigLog.facts.entries.at(-1)?.kind === 'result' && Buffer.byteLength(JSON.stringify(bigLog)) < 262144, 'ログ: 大きすぎる行は省略し、応答は 256 KiB に収める');
  const { manager: missing } = makeManager(project, 'job-fail', { resolveClaude: () => null });
  check(throwsClass(() => missing.start({ prompt: 'x' }), ERROR_CLASS.CLAUDE_UNAVAILABLE), '起動: Claude Code が無ければ claude_unavailable');
  const { manager: broken } = makeManager(project, 'job-fail', { resolveClaude: () => ({ command: path.join(temporaryRoot, 'no-such-claude.exe'), prefixArgs: [] }) });
  const brokenJob = broken.start({ prompt: 'x' });
  check(await waitForEnd(broken, brokenJob.facts.job.jobId) === 'failed' && /起動できません/.test(broken.get({ jobId: brokenJob.facts.job.jobId, includeWorkingTree: false }).facts.job.errorMessage || ''), '起動: 実行ファイルを起動できなければ failed と理由');
}

async function testCancelTimeoutAndLimits() {
  const first = makeProject('job-limit-a', { claudeCode: { enabled: true } });
  const second = makeProject('job-limit-b', { claudeCode: { enabled: true } });
  const third = makeProject('job-limit-c', { claudeCode: { enabled: true } });
  const a = makeManager(first, 'job-limit-a');
  const b = makeManager(second, 'job-limit-b');
  const c = makeManager(third, 'job-limit-c');
  const sleeping = a.manager.start({ prompt: 'MODE:sleep' });
  const jobId = sleeping.facts.job.jobId;
  const directory = jobDirectoryOf(a.context, 'job-limit-a', jobId);
  await waitFor(() => fs.existsSync(path.join(directory, 'fake-grandchild.pid')), 20000);
  check(stateOf(a.manager, jobId) === 'running', '停止: 動いているジョブは running');
  check(throwsClass(() => a.manager.start({ prompt: 'MODE:ok' }), ERROR_CLASS.JOB_LIMIT), '上限: 1 プロジェクトで同時に 1 件まで');
  const otherJob = b.manager.start({ prompt: 'MODE:sleep' });
  check(throwsClass(() => c.manager.start({ prompt: 'MODE:ok' }), ERROR_CLASS.JOB_LIMIT), '上限: PC 全体で同時に 2 件まで');
  check(throwsClass(() => a.manager.start({ prompt: 'x', continueJobId: jobId }), ERROR_CLASS.JOB_LIMIT) || throwsClass(() => a.manager.start({ prompt: 'x', continueJobId: jobId }), ERROR_CLASS.JOB_NOT_RUNNING), '継続: 動いているジョブの続きは依頼できない');
  const grandchildPid = Number(fs.readFileSync(path.join(directory, 'fake-grandchild.pid'), 'utf8'));
  const fakePid = JSON.parse(fs.readFileSync(path.join(directory, 'fake-probe.json'), 'utf8')).pid;
  const cancelled = a.manager.cancel({ jobId });
  check(cancelled.facts.cancelRequested === true && cancelled.facts.state === 'cancelling', '停止: 停止を要求する');
  check(await waitForEnd(a.manager, jobId, 20000) === 'cancelled', '停止: cancelled になる');
  check(await waitFor(() => !isAlive(fakePid) && !isAlive(grandchildPid), 15000), '停止: Claude Code とその子プロセスまで止まる');
  b.manager.cancel({ jobId: otherJob.facts.job.jobId });
  await waitForEnd(b.manager, otherJob.facts.job.jobId, 20000);

  const quick = makeManager(third, 'job-limit-c', { timeLimitSeconds: 2 });
  const timed = quick.manager.start({ prompt: 'MODE:sleep' });
  check(await waitForEnd(quick.manager, timed.facts.job.jobId, 30000) === 'timeout', '時間切れ: 制限時間を過ぎたら止めて timeout');
}

async function testHubStopInterruptsJob() {
  const project = makeProject('job-parent', { claudeCode: { enabled: true } });
  const helper = path.join(temporaryRoot, 'parent-helper.mjs');
  // 親（ハブの代わり）がジョブを始めて、すぐ終わる。
  fs.writeFileSync(helper, `
import fs from 'node:fs';
import path from 'node:path';
import { createProjectContext } from ${JSON.stringify(pathToFileURL(serverPath).href)};
import { createClaudeJobManager } from ${JSON.stringify(pathToFileURL(path.join(scriptsDirectory, 'bridge-claude-jobs.mjs')).href)};
const context = createProjectContext(${JSON.stringify(project.root)}, ${JSON.stringify(project.configPath)}, null);
const manager = createClaudeJobManager({ projectLabel: 'job-parent', boundary: context.claudeJobBoundary, stateRoot: ${JSON.stringify(stateRoot)},
  resolveClaude: () => ({ command: process.execPath, prefixArgs: [${JSON.stringify(fakeClaude)}] }) });
const job = manager.start({ prompt: 'MODE:sleep' });
process.stdout.write(job.facts.job.jobId + '\\n');
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  const status = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(stateRoot)}, fs.readdirSync(${JSON.stringify(stateRoot)}).find(name => name.startsWith('job-parent-')), job.facts.job.jobId, 'status.json'), 'utf8'));
  if (status.claudePid || Date.now() > deadline) { process.stdout.write(String(status.runnerPid) + '\\n'); clearInterval(timer); process.exit(0); }
}, 100);
`, 'utf8');
  const result = spawnSync(process.execPath, [helper], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const [jobId, runnerPid] = result.stdout.trim().split(/\r?\n/);
  const { context, manager } = makeManager(project, 'job-parent');
  const directory = jobDirectoryOf(context, 'job-parent', jobId);
  await waitFor(() => fs.existsSync(path.join(directory, 'fake-grandchild.pid')), 10000);
  const grandchildPath = path.join(directory, 'fake-grandchild.pid');
  const grandchildPid = fs.existsSync(grandchildPath) ? Number(fs.readFileSync(grandchildPath, 'utf8')) : 0;
  check(await waitFor(() => !isAlive(Number(runnerPid)) && (!grandchildPid || !isAlive(grandchildPid)), 20000), 'ハブの停止: 親が終わると、ランナーと Claude Code の子プロセスも止まる');
  const state = stateOf(manager, jobId);
  if (process.platform === 'win32') {
    // Windows ではランナーが Job object ごと止まり、状態を書けない。heartbeat が古くなった時点で interrupted と表示する。
    const status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    check(state === 'running' || state === 'interrupted', `ハブの停止: 止まった直後の状態（実測 ${state}）`);
    check(effectiveState(status, Date.parse(status.heartbeatAt) + 31000) === 'interrupted', 'ハブの停止: heartbeat が途絶えたジョブは interrupted と表示する');
  } else {
    check(await waitFor(() => stateOf(manager, jobId) === 'interrupted', 10000), 'ハブの停止: ランナーが親の消滅に気付き interrupted と記録する');
  }
}

async function testPruning() {
  const project = makeProject('job-prune', { claudeCode: { enabled: true } });
  const { context, manager } = makeManager(project, 'job-prune');
  const projectDirectory = path.join(stateRoot, projectStorageKey('job-prune', context.claudeJobBoundary.projectRoot, process.platform === 'win32'));
  fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 31; index += 1) {
    const jobId = `job-20200101-0000${String(index).padStart(2, '0')}-000000`;
    const directory = path.join(projectDirectory, jobId);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify({ schemaVersion: 1, jobId, createdAt: '2020-01-01T00:00:00.000Z', maxMinutes: 30 }), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ schemaVersion: 1, jobId, state: 'succeeded', heartbeatAt: '2020-01-01T00:00:00.000Z' }), { mode: 0o600 });
  }
  const started = manager.start({ prompt: 'MODE:ok' });
  await waitForEnd(manager, started.facts.job.jobId);
  const remaining = fs.readdirSync(projectDirectory).filter(name => name.startsWith('job-'));
  check(remaining.length === 30 && remaining.includes(started.facts.job.jobId) && !remaining.includes('job-20200101-000000-000000'), '保持: プロジェクトごとに 30 件を残し、古い終了済みの記録から消す');
}

const TESTS = [
  ['command-patterns', testCommandPatterns],
  ['settings', testSettings],
  ['arguments', testArgumentsAndEnvironment],
  ['model-effort-validation', testModelAndEffortValidation],
  ['summaries', testEventSummaries],
  ['resolve', testResolveClaude],
  ['exposure', testExposure],
  ['tools', testToolListsAndPermissions],
  ['settings-tool', testClaudeCodeSettingsTool],
  ['job-ok', testJobSucceeds],
  ['model-effort-jobs', testModelAndEffortOverrides],
  ['job-fail', testJobFailures],
  ['cancel-timeout-limit', testCancelTimeoutAndLimits],
  ['hub-stop', testHubStopInterruptsJob],
  ['prune', testPruning],
]; // 試験の名前と関数。

writeFakeClaude();
for (const [name, test] of TESTS) {
  if (filter && !name.includes(filter)) continue;
  try {
    await test();
  } catch (error) {
    check(false, `${name}: 例外 ${error?.stack || error}`);
  }
}
process.stdout.write(`CLAUDE_JOBS_SELFTEST ${failures === 0 ? 'PASS' : 'FAIL'} (${failures})\n`);
process.exitCode = failures === 0 ? 0 : 1;
