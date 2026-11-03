#!/usr/bin/env node
/*
  2.5.0 の新ツール 10 個と 2.6.0 のソース読み取りツール 6 個（それぞれ最小の引数で 1 回ずつ）を、実機のハブ設定に登録された承認済みプロジェクトに対して読み取りだけで呼び、結果の一覧を表示する点検用スクリプト。
  2.7.0 の Claude Code のジョブのツールは、公開されていることを確かめ、読み取りだけの list_claude_jobs と、2.9.0 の get_claude_code_settings だけを呼ぶ（start_claude_job・cancel_claude_job は呼ばない。Claude Code は起動しない）。
  Windows と Ubuntu のどちらでも同じコマンドで動く。ChatGPT を介さずに、導入先で新ツールが動くかを確かめる。

  使い方:
    node scripts/tools-smoke.mjs --hub <hub.json> [--project <名前>] [--out <保存先フォルダー>]
  - hub.json は書き換えない。通知とアクセスログの項目を外した一時コピーを作ってサーバーに渡すので、実機の通知もアクセスログも増えない。
  - 承認ファイルとプロジェクトは読み取りだけ。ビルドもテストも実行しない。Git の書き込み系コマンドも実行しない。
  - --out を付けると、各応答の JSON を 1 件 1 ファイルで保存する（実プロジェクトの内容が含まれるので、保存先の扱いに注意する）。
  - 終了コード: 0 = 想定外の失敗なし、1 = 想定外の失敗あり（internal_error・timeout など）、2 = 使い方の誤り。
  hub.json の既定の場所: Windows は %APPDATA%\chatgpt-project-bridge\hub.json、Ubuntu は ~/.config/chatgpt-project-bridge/hub.json。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url)); // このスクリプトがあるフォルダー。
const serverPath = path.join(scriptsDirectory, 'server.mjs'); // 同梱MCP本体。
// Windowsの Node は、パスを含まないコマンド名（git など）をPATHより先に作業フォルダーから探す。作業フォルダーを同梱スクリプトのフォルダーへ移す。
if (process.platform === 'win32') process.chdir(scriptsDirectory);
const PROJECT_TOOLS = ['get_git_branches', 'get_worktree_details', 'get_recent_activity', 'get_project_overview', 'get_project_structure', 'get_project_tasks', 'get_project_validation']; // 引数なしで呼べる、プロジェクト別の新ツール。
const UNEXPECTED_CLASSES = new Set(['internal_error', 'timeout', 'output_too_large', 'too_many_failures', 'git_error']); // 出たら点検の失敗とみなす分類。

// CLI引数を --key value 形式で読む。
function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const next = argv[index + 1];
    parsed[argv[index].slice(2)] = next && !next.startsWith('--') ? next : true;
    if (parsed[argv[index].slice(2)] !== true) index += 1;
  }
  return parsed;
}

// 使い方を表示して終わる。
function usage(message) {
  process.stderr.write(`${message}\n使い方: node scripts/tools-smoke.mjs --hub <hub.json> [--project <名前>] [--out <保存先フォルダー>]\n`);
  process.exit(2);
}

const options = parseArguments(process.argv.slice(2));
if (typeof options.hub !== 'string') usage('--hub が必要です。');
const hubPath = path.resolve(options.hub);
if (!fs.existsSync(hubPath)) usage(`hub.json が存在しません: ${hubPath}`);
const hubText = fs.readFileSync(hubPath, 'utf8'); // 読み取りだけ。
const hub = JSON.parse(hubText.charCodeAt(0) === 0xFEFF ? hubText.slice(1) : hubText); // BOM付きの JSON も読む。
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-smoke-')); // 一時コピーの置き場。終了時に消す。
process.on('exit', () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
const temporaryHub = path.join(temporaryDirectory, 'hub.json'); // 通知とアクセスログを外した一時コピー。
const { notifications: unusedNotifications, accessLog: unusedAccessLog, ...hubWithoutSideEffects } = hub;
fs.writeFileSync(temporaryHub, JSON.stringify(hubWithoutSideEffects), 'utf8');
if (typeof options.out === 'string') fs.mkdirSync(path.resolve(options.out), { recursive: true });

const child = spawn(process.execPath, [serverPath, '--stdio', '--hub', temporaryHub], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); // 点検用に起動するハブ。
let stderr = ''; // 診断用。
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.setEncoding('utf8');
const pending = new Map(); // id → 応答待ちの resolve。
let buffer = ''; // 改行待ちの出力。
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  }
});
let nextId = 1; // 次の要求 id。

// JSON-RPC の要求を 1 件送り、応答を待つ（180 秒で時間切れ）。
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`時間切れ: ${method}`)); }, 180000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ツールを呼び、結果（isError・JSON・大きさ・所要時間）を返す。
async function callTool(name, args = {}) {
  const started = Date.now();
  const response = await request('tools/call', { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? '';
  let json = null; // 本文が JSON のときの解析結果。
  try { json = JSON.parse(text); } catch { json = null; }
  return { isError: response.result?.isError === true, text, json, bytes: Buffer.byteLength(text, 'utf8'), milliseconds: Date.now() - started };
}

const rows = []; // 表示する結果。
let unexpectedFailures = 0; // 想定外の失敗の数。

// 1 件の結果を記録する。
function record(project, tool, result, note = '') {
  const meta = result.json?.meta; // 新ツールの共通メタデータ。
  const errorClass = meta?.errorClass ?? null; // 失敗の分類。
  const unexpected = result.json === null || (UNEXPECTED_CLASSES.has(errorClass ?? '') && meta?.status === 'unavailable') || (result.isError && errorClass !== 'permission_denied' && errorClass !== 'invalid_argument'); // 想定外の失敗か。
  if (unexpected) unexpectedFailures += 1;
  rows.push({ project, tool, isError: result.isError, status: meta?.status ?? '(不明)', errorClass: errorClass ?? '', hidden: (meta?.hidden ?? []).join('+'), bytes: result.bytes, milliseconds: result.milliseconds, flag: unexpected ? '想定外' : '', note });
  if (typeof options.out === 'string') {
    const fileName = `${project.replace(/[^A-Za-z0-9._-]/g, '_')}__${tool}.json`;
    fs.writeFileSync(path.join(path.resolve(options.out), fileName), result.json ? JSON.stringify(result.json, null, 2) : result.text, 'utf8');
  }
}

try {
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-smoke', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  const toolNames = (listed.result?.tools ?? []).map(tool => tool.name);
  const expected = [...PROJECT_TOOLS, 'get_branch_details', 'compare_branches', 'get_portfolio_summary', 'list_source_files', 'search_code', 'read_source', 'find_references', 'get_git_diff', 'read_test_log',
    'start_claude_job', 'get_claude_job', 'read_claude_job_log', 'cancel_claude_job', 'list_claude_jobs', 'get_claude_code_settings'];
  const missing = expected.filter(name => !toolNames.includes(name));
  process.stdout.write(`サーバー: ${initialized.result?.serverInfo?.name} ${initialized.result?.serverInfo?.version} / ツール ${toolNames.length} 個 / OS ${process.platform} / Node ${process.version}\n`);
  if (missing.length > 0) {
    process.stdout.write(`新ツールが公開されていません: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  // 2.10.0: start_claude_job が省略可の model・effort を持つ（導入先が 2.10.0 以降か。start_claude_job は呼ばない）。
  const startSchema = (listed.result?.tools ?? []).find(tool => tool.name === 'start_claude_job')?.inputSchema; // start_claude_job の引数の schema。
  const effortEnum = startSchema?.properties?.effort?.enum; // effort の選択肢。
  if (startSchema?.properties?.model?.type !== 'string' || !Array.isArray(effortEnum) || !['low', 'medium', 'high', 'xhigh', 'max'].every(level => effortEnum.includes(level)) || (startSchema.required ?? []).includes('model') || (startSchema.required ?? []).includes('effort')) {
    process.stdout.write('start_claude_job に省略可の model・effort がありません（導入先が 2.10.0 より前の版です）。\n');
    process.exit(1);
  }

  // 横断サマリーを、次のページが無くなるまで取得する。
  const portfolioProjects = []; // 横断サマリーに現れたプロジェクト名。
  let offset = 0; // 次に取得する位置。
  for (let guard = 0; guard < 20; guard += 1) {
    const result = await callTool('get_portfolio_summary', { offset, limit: 50 });
    record('(全プロジェクト)', 'get_portfolio_summary', result, `offset=${offset}`);
    for (const entry of result.json?.facts?.projects ?? []) portfolioProjects.push(entry.project);
    const nextOffset = result.json?.page?.nextOffset; // 続きの位置。
    if (typeof nextOffset !== 'number') break;
    offset = nextOffset;
  }
  const targets = typeof options.project === 'string' ? portfolioProjects.filter(name => name === options.project) : portfolioProjects; // 点検するプロジェクト。
  if (typeof options.project === 'string' && targets.length === 0) process.stdout.write(`注意: 承認済みの一覧に「${options.project}」がありません。\n`);

  for (const project of targets) {
    let branchName = null; // ブランチ名が見えるときの、現在以外のローカルブランチの 1 本目。
    let currentBranch = null; // 現在のブランチ。
    for (const tool of PROJECT_TOOLS) {
      const result = await callTool(tool, { project });
      record(project, tool, result);
      if (tool === 'get_git_branches') {
        const branches = result.json?.facts?.branches ?? []; // 名前が公開されているときだけ入る。
        currentBranch = result.json?.facts?.repository?.currentBranch ?? null;
        branchName = branches.find(branch => branch.kind === 'local' && branch.isCurrent !== true)?.name ?? null;
      }
    }
    // 2.6.0 のソース読み取りツール。権限（sourceText・paths・diffExcerpts・sourceScope.logDirectories）が無いプロジェクトは permission_denied で、想定内。
    const sourceListing = await callTool('list_source_files', { project, limit: 5 }); // 先頭のファイルの一覧。
    record(project, 'list_source_files', sourceListing);
    const firstSourceFile = sourceListing.json?.facts?.files?.[0]?.path ?? null; // 一覧の先頭のファイル。
    record(project, 'search_code', await callTool('search_code', { project, query: 'TODO', maxResults: 3, timeBudgetMs: 5000 }));
    if (firstSourceFile) {
      record(project, 'read_source', await callTool('read_source', { project, path: firstSourceFile, lineCount: 5 }));
      const symbol = path.basename(firstSourceFile).replace(/\.[^.]*$/, ''); // ファイル名から取った探す名前。
      if (/^\S{1,128}$/.test(symbol)) record(project, 'find_references', await callTool('find_references', { project, symbol, limit: 3, timeBudgetMs: 5000 }));
    }
    record(project, 'get_git_diff', await callTool('get_git_diff', { project, filesPerPage: 1, maxLinesPerFile: 20 }));
    record(project, 'read_test_log', await callTool('read_test_log', { project, action: 'directories' }));
    // 2.7.0: 読み取りだけの一覧。claudeCode を承認していないプロジェクトは permission_denied で、想定内。
    record(project, 'list_claude_jobs', await callTool('list_claude_jobs', { project, limit: 3 }));
    // 2.9.0: 読み取りだけの設定の取得。claudeCode が無効なプロジェクトでもエラーにならず enabled: false を返す。
    record(project, 'get_claude_code_settings', await callTool('get_claude_code_settings', { project }));
    if (branchName) {
      record(project, 'get_branch_details', await callTool('get_branch_details', { project, branch: branchName }));
      if (currentBranch) record(project, 'compare_branches', await callTool('compare_branches', { project, base: currentBranch, target: branchName }));
    } else {
      rows.push({ project, tool: 'get_branch_details / compare_branches', isError: false, status: '(省略)', errorClass: '', hidden: '', bytes: 0, milliseconds: 0, flag: '', note: 'ブランチ名が非公開（detailExposure.branchNames）か、比較できるブランチが無いため省略' });
    }
  }
} catch (error) {
  process.stdout.write(`点検を続けられませんでした: ${error.message}\n${stderr ? `サーバーの標準エラー出力:\n${stderr}\n` : ''}`);
  child.kill();
  process.exit(1);
}

child.stdin.end();
const columns = ['project', 'tool', 'status', 'errorClass', 'hidden', 'bytes', 'milliseconds', 'flag', 'note']; // 表示する列。
const widths = columns.map(column => Math.max(column.length, ...rows.map(row => String(row[column]).length))); // 列ごとの幅。
const render = row => columns.map((column, index) => String(row[column]).padEnd(widths[index])).join('  ');
process.stdout.write(`${render(Object.fromEntries(columns.map(column => [column, column])))}\n`);
for (const row of rows) process.stdout.write(`${render(row)}\n`);
const statusCounts = rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {}); // 状態ごとの件数。
process.stdout.write(`\n呼び出し ${rows.length} 件 / 状態 ${JSON.stringify(statusCounts)} / 想定外の失敗 ${unexpectedFailures} 件\n`);
if (stderr.trim()) process.stdout.write(`サーバーの標準エラー出力:\n${stderr}\n`);
process.stdout.write(unexpectedFailures === 0 ? 'TOOLS_SMOKE PASS\n' : `TOOLS_SMOKE FAIL (${unexpectedFailures})\n`);
process.exit(unexpectedFailures === 0 ? 0 : 1);
