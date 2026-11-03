#!/usr/bin/env node
/* 読み取り専用MCPのstdio経路を、外部ネットワークなしで検証する。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

// CLI引数から指定名の値を取得する。
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const projectRoot = path.resolve(argument('--project-root') || process.cwd()); // 検査対象プロジェクト。
const configPath = path.resolve(argument('--config') || path.join(projectRoot, '.chatgpt-project-bridge.json')); // 公開設定。
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'); // 同梱MCP本体。
const requiredTools = ['get_project_context', 'get_project_status', 'get_recent_changes', 'get_project_issues', 'list_documents', 'get_document', 'search', 'fetch']; // 必須ツール。
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'project-bridge-selftest', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project_context', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_project_status', arguments: {} } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_recent_changes', arguments: { days: 30, limit: 10 } } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_project_issues', arguments: {} } },
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_documents', arguments: {} } },
  { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_document', arguments: { path: 'CHATGPT_PROJECT_CONTEXT.md' } } },
  { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_document', arguments: { path: '../outside.txt' } } },
  { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_document', arguments: { path: 'package.json' } } },
  { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'search', arguments: { query: 'プロジェクト' } } },
  { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fetch', arguments: { id: 'CHATGPT_PROJECT_STATUS.md' } } },
]; // ChatGPTの発見・読取経路を模した要求。

let failures = 0; // 合格しなかった検査数。

// 判定を表示して失敗数へ反映する。
function check(condition, label) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'} ${label}\n`);
  if (!condition) failures += 1;
}

// 試験専用の一時承認ファイルを作る。利用者の本物の承認ファイルには触れない。
function writeTemporaryApproval(directory) {
  const printed = JSON.parse(execFileSync(process.execPath, [serverPath, '--print-exposure', '--project-root', projectRoot, '--config', configPath], { encoding: 'utf8' })); // 現在設定の公開範囲と指紋。
  const approvalPath = path.join(directory, 'approval.json'); // 一時承認ファイルの場所。
  // サーバーは所有者以外が書ける承認ファイル・置き場所を承認として扱わないため、approve と同じ 0700 / 0600 にする（umask 0002 でも崩れないよう chmod で揃える）。
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(approvalPath, JSON.stringify({ schemaVersion: 1, sha256: printed.sha256, approvedAt: new Date().toISOString(), exposure: printed.exposure }), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(approvalPath, 0o600);
  return approvalPath;
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bridge-selftest-')); // 試験後に削除する一時領域。
process.on('exit', () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
const approvalPath = writeTemporaryApproval(temporaryDirectory); // 試験用の承認ファイル。
const child = spawn(process.execPath, [serverPath, '--stdio', '--project-root', projectRoot, '--config', configPath, '--approval-file', approvalPath], { stdio: ['pipe', 'pipe', 'pipe'] }); // 実際の起動コマンドと同じstdio子プロセス。
const responses = []; // 受信したJSON-RPC応答。
let stdout = ''; // 改行単位へ分割する途中バッファ。
let stderr = ''; // 起動失敗時だけ表示する診断。

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk;
  let newline;
  while ((newline = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (line) responses.push(JSON.parse(line));
  }
});
child.stderr.on('data', chunk => { stderr += chunk; });

for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
child.stdin.end();

const exitCode = await Promise.race([
  new Promise(resolve => child.once('exit', code => resolve(code ?? 1))),
  new Promise(resolve => setTimeout(() => { child.kill(); resolve(124); }, 15000)),
]); // 固着時は15秒で終了する。

if (stderr.trim()) process.stderr.write(stderr);
const byId = new Map(responses.map(response => [response.id, response]));
const toolResult = id => byId.get(id)?.result;
const toolText = id => toolResult(id)?.content?.[0]?.text || '';

if (exitCode !== 0 || responses.length === 0) {
  // 失敗の原因を切り分けるための診断。124 は15秒の時間切れ、2 は起動時の設定不備。
  process.stdout.write(`診断: MCPプロセスの終了コード=${exitCode}${exitCode === 124 ? '（15秒で時間切れ）' : ''}、受信した応答=${responses.length}件、Node.js=${process.execPath} ${process.version}\n`);
  process.stdout.write(`診断: プロジェクト=${projectRoot}、設定=${configPath}\n`);
  process.stdout.write(`診断: MCPプロセスのエラー出力=${stderr.trim() || '(なし)'}\n`);
}
check(exitCode === 0, 'MCPプロセスが正常終了');
check(byId.get(1)?.result?.serverInfo?.name?.startsWith('project-bridge-'), 'initialize');
const toolNames = (byId.get(2)?.result?.tools || []).map(tool => tool.name);
check(requiredTools.every(name => toolNames.includes(name)), `tools/list（${toolNames.length}ツール）`);
for (const [id, name] of [[3, 'get_project_context'], [4, 'get_project_status'], [5, 'get_recent_changes'], [6, 'get_project_issues'], [7, 'list_documents'], [8, 'get_document'], [11, 'search'], [12, 'fetch']]) {
  check(toolResult(id)?.isError === false && toolText(id).length > 0, name);
}
check(toolResult(9)?.isError === true, '親ディレクトリ参照を拒否');
check(toolResult(10)?.isError === true, '許可外ファイルを拒否');
check(!/(sk-[A-Za-z0-9_\-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(responses.map(JSON.stringify).join('\n')), '応答に代表的なcredentialパターンがない');

process.stdout.write(failures === 0 ? 'PROJECT_BRIDGE_SELFTEST PASS\n' : `PROJECT_BRIDGE_SELFTEST FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
