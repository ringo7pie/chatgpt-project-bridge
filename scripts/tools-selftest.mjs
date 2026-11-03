#!/usr/bin/env node
/*
  2.5.0 で追加した読み取りツールの「共通部分」と「サーバーへの配線」を検証する。外部ネットワークなし。
  - bridge-tools-common.mjs: 応答の形式、引数の検証、ページング、応答サイズの上限、再試行制限
  - server.mjs: 新ツール 10 個（2.6.0 の 6 個の公開は source-tools-selftest.mjs）の公開（単一・ハブ）、既存ツールの定義が変わっていないこと、承認の指紋が変わらないこと、
    新モジュールが無くても既存ツールが動くこと、引数不備の分類付き応答、全ツールを呼んでもプロジェクトが変わらないこと
  Git の読み取り層と分析層そのものの試験は git-tools-selftest.mjs と analysis-selftest.mjs にある。
  データ・承認はこの試験専用の一時ディレクトリだけに作成し、実際のプロジェクトや資格情報は使わない。
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BridgeToolError, ERROR_CLASS, STATUS, SOURCE_KIND, TOOL_SCHEMA_VERSION, clampInteger, requireString, paginate, makeEnvelope,
  makeErrorEnvelope, describeSource, fitToBudget, createFailureGuard, countsAsOperationalFailure,
} from './bridge-tools-common.mjs';
import { DETAIL_TOOL_DEFINITIONS, DETAIL_TOOL_NAMES } from './bridge-tool-definitions.mjs';
import { createProjectContext } from './server.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url)); // この試験があるフォルダー。
const serverPath = path.join(scriptsDirectory, 'server.mjs'); // 同梱MCP本体。
// Windowsの Node は、パスを含まないコマンド名（git など）をPATHより先に作業フォルダーから探す。作業フォルダーを同梱スクリプトのフォルダーへ移す。
if (process.platform === 'win32') process.chdir(scriptsDirectory);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bridge-tools-selftest-')); // この試験だけの削除対象。
process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

// 2.4.3（コミット ad17756）の server.mjs が返した、既存ツールの名前・引数・注釈。2.5.0 で変えてはならない基準。
const LEGACY_TOOLS = JSON.parse(String.raw`{"single":[{"name":"get_project_context","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_project_status","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_recent_changes","inputSchema":{"type":"object","properties":{"days":{"type":"integer","minimum":1,"maximum":365,"default":14},"limit":{"type":"integer","minimum":1,"maximum":100,"default":20}},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_project_issues","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"list_documents","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_document","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"search","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50,"default":10}},"required":["query"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"fetch","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}],"hub":[{"name":"list_projects","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_project_context","inputSchema":{"type":"object","properties":{"project":{"type":"string","description":"list_projects が返したプロジェクト名"}},"required":["project"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_project_status","inputSchema":{"type":"object","properties":{"project":{"type":"string","description":"list_projects が返したプロジェクト名"}},"required":["project"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_recent_changes","inputSchema":{"type":"object","properties":{"project":{"type":"string","description":"list_projects が返したプロジェクト名"},"days":{"type":"integer","minimum":1,"maximum":365,"default":14},"limit":{"type":"integer","minimum":1,"maximum":100,"default":20}},"required":["project"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_project_issues","inputSchema":{"type":"object","properties":{"project":{"type":"string","description":"list_projects が返したプロジェクト名"}},"required":["project"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"list_documents","inputSchema":{"type":"object","properties":{"project":{"type":"string","description":"list_projects が返したプロジェクト名"}},"required":["project"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"get_document","inputSchema":{"type":"object","properties":{"project":{"type":"string","description":"list_projects が返したプロジェクト名"},"path":{"type":"string"}},"required":["project","path"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"search","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50,"default":10},"project":{"type":"string","description":"list_projects が返したプロジェクト名"}},"required":["query"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},{"name":"fetch","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}]}`);
const LEGACY_EXPOSURE_KEYS = ['schemaVersion', 'projectRoot', 'contextFile', 'statusFile', 'allowFiles', 'allowDirectories', 'denyDirectories', 'maxDocumentBytes', 'gitExposure']; // 2.4.x までの公開範囲の項目と順序。

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

// ---------- 共通部分の単体試験 ----------

function testEnvelope() {
  const base = makeEnvelope({ tool: 'x', collectedAt: '2026-01-01T00:00:00.000Z' });
  check(base.schemaVersion === TOOL_SCHEMA_VERSION && base.tool === 'x', '応答: schemaVersion と tool');
  check(base.meta.status === STATUS.OK && base.meta.errorClass === null && base.meta.errorReason === null && base.meta.retryable === false, '応答: 既定は ok・失敗なし');
  check(makeEnvelope({ tool: 'x', hidden: ['paths', 'paths'] }).meta.hidden.length === 1, '応答: hidden は重複を除く');
  check(makeEnvelope({ tool: 'x', hidden: ['paths'] }).meta.status === STATUS.PARTIAL, '応答: 隠した項目があれば partial');
  check(makeEnvelope({ tool: 'x', truncated: true }).meta.status === STATUS.PARTIAL, '応答: 切り詰めたら partial');
  check(makeEnvelope({ tool: 'x', warnings: ['注意'] }).meta.status === STATUS.OK, '応答: 注意事項だけでは ok のまま');
  const failed = makeEnvelope({ tool: 'x', errorClass: ERROR_CLASS.TIMEOUT });
  check(failed.meta.status === STATUS.UNAVAILABLE && failed.meta.retryable === true && failed.meta.errorReason.includes('特定できません'), '応答: timeout は unavailable・再試行可・原因を断定しない');
  check(makeEnvelope({ tool: 'x', errorClass: ERROR_CLASS.INVALID_ARGUMENT }).meta.retryable === false, '応答: 引数不備は再試行不可');
  const sources = [describeSource(SOURCE_KIND.LIVE_GIT, 'a'), describeSource(SOURCE_KIND.DOCUMENT, 'a', '2026-02-01T00:00:00.000Z'), describeSource(SOURCE_KIND.TEST_LOG, 'a', '2026-01-15T00:00:00.000Z')];
  const withSources = makeEnvelope({ tool: 'x', sources });
  check(sources[0].live === true && sources[1].live === false && sources[2].live === false, '応答: liveGit だけが live、保存された文書・記録は live ではない');
  check(withSources.meta.sourceUpdatedAt === '2026-02-01T00:00:00.000Z', '応答: sourceUpdatedAt は最も新しい情報源の更新日時');
  const errorEnvelope = makeErrorEnvelope('x', new BridgeToolError(ERROR_CLASS.PERMISSION_DENIED, '権限なし', { hidden: ['branchNames'] }));
  check(errorEnvelope.meta.errorClass === 'permission_denied' && errorEnvelope.meta.hidden[0] === 'branchNames' && errorEnvelope.meta.status === STATUS.UNAVAILABLE, '応答: BridgeToolError から失敗の応答を作る');
}

function testArguments() {
  const options = { min: 1, max: 10, fallback: 5 };
  check(clampInteger(undefined, 'n', options) === 5 && clampInteger(null, 'n', options) === 5, '引数: 未指定は既定値');
  check(clampInteger(0, 'n', options) === 1 && clampInteger(99, 'n', options) === 10 && clampInteger(3.9, 'n', options) === 3, '引数: 範囲外は収め、小数は切り捨てる');
  for (const bad of ['3', NaN, Infinity, true, {}, []]) {
    check(throwsClass(() => clampInteger(bad, 'n', options), ERROR_CLASS.INVALID_ARGUMENT), `引数: 整数以外（${JSON.stringify(bad) ?? String(bad)}）は invalid_argument`);
  }
  check(requireString('abc', 'name') === 'abc' && requireString(undefined, 'name', { fallback: 'x' }) === 'x', '引数: 文字列と既定値');
  check(throwsClass(() => requireString(undefined, 'name'), ERROR_CLASS.INVALID_ARGUMENT), '引数: 必須の文字列が無ければ invalid_argument');
  check(throwsClass(() => requireString('', 'name'), ERROR_CLASS.INVALID_ARGUMENT) && throwsClass(() => requireString(5, 'name'), ERROR_CLASS.INVALID_ARGUMENT), '引数: 空・非文字列は invalid_argument');
  check(throwsClass(() => requireString('a'.repeat(300), 'name'), ERROR_CLASS.INVALID_ARGUMENT), '引数: 長すぎる文字列は invalid_argument');
  check(throwsClass(() => requireString('a b', 'name', { pattern: /^\S+$/ }), ERROR_CLASS.INVALID_ARGUMENT), '引数: 形式に合わない文字列は invalid_argument');
}

function testPaging() {
  const items = Array.from({ length: 25 }, (unused, index) => index);
  const first = paginate(items, 0, 10);
  check(first.items.length === 10 && first.page.nextOffset === 10 && first.page.total === 25 && first.page.returned === 10, 'ページング: 先頭');
  const last = paginate(items, 20, 10);
  check(last.items.length === 5 && last.page.nextOffset === null, 'ページング: 最後は nextOffset が null');
  const beyond = paginate(items, 100, 10);
  check(beyond.items.length === 0 && beyond.page.nextOffset === null && beyond.page.returned === 0, 'ページング: 範囲外の offset は空');
  const exact = paginate(items, 15, 10);
  check(exact.items.length === 10 && exact.page.nextOffset === null, 'ページング: ちょうど末尾まで返したら nextOffset は null');
}

function testBudget() {
  const small = makeEnvelope({ tool: 'x', facts: { rows: [1, 2, 3] } });
  check(fitToBudget(small, 100000, 'rows') === small && small.meta.truncated === false, 'サイズ上限: 収まるなら何も削らない');
  const rows = Array.from({ length: 5000 }, (unused, index) => ({ index, label: `row-${index}-${'x'.repeat(40)}` }));
  const big = makeEnvelope({ tool: 'x', facts: { rows, other: [1, 2, 3] }, page: { offset: 0, limit: 5000, returned: 5000, total: 5000, nextOffset: null }, inferences: [{ claim: 'c' }], evidence: [{ type: 'file' }] });
  fitToBudget(big, 20000, 'rows');
  const size = Buffer.byteLength(JSON.stringify(big, null, 2), 'utf8');
  check(size <= 20000, `サイズ上限: 上限（20000）以内に収める（実測 ${size}）`);
  check(big.meta.truncated === true && big.meta.status === STATUS.PARTIAL && big.meta.warnings.length === 1, 'サイズ上限: truncated・partial・警告を付ける');
  check(big.page.returned === big.facts.rows.length && big.page.nextOffset === big.facts.rows.length, 'サイズ上限: page.returned と nextOffset を実際の件数に合わせる');
  check(big.facts.rows.length > 0 && big.facts.rows[0].index === 0, 'サイズ上限: 先頭から連続して残す');
  const noPage = makeEnvelope({ tool: 'x', facts: { rows: rows.slice(0, 2000) } });
  fitToBudget(noPage, 10000, null);
  check(Buffer.byteLength(JSON.stringify(noPage, null, 2), 'utf8') <= 10000 && noPage.meta.truncated === true, 'サイズ上限: ページング対象を指定しなくても最長の配列を削って収める');
}

function testFailureGuard() {
  let clock = 1000000; // 試験用の時計（ミリ秒）。
  const guard = createFailureGuard({ maxConsecutiveFailures: 3, cooldownMs: 30000, now: () => clock });
  guard.check('p|t');
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  guard.check('p|t');
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  check(throwsClass(() => guard.check('p|t'), ERROR_CLASS.TOO_MANY_FAILURES), '再試行制限: 3 回続けて失敗したら見合わせる');
  guard.check('other|t');
  guard.check('p|other');
  check(true, '再試行制限: 別のプロジェクト・別のツールには影響しない');
  clock += 31000;
  guard.check('p|t');
  check(true, '再試行制限: 冷却時間が過ぎたら再開する');
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  guard.recordSuccess('p|t');
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  guard.recordFailure('p|t', ERROR_CLASS.TIMEOUT);
  guard.check('p|t');
  check(true, '再試行制限: 成功すると数え直す');
  check(countsAsOperationalFailure(ERROR_CLASS.TIMEOUT) && countsAsOperationalFailure(ERROR_CLASS.OUTPUT_TOO_LARGE) && !countsAsOperationalFailure(ERROR_CLASS.INVALID_ARGUMENT) && !countsAsOperationalFailure(ERROR_CLASS.PERMISSION_DENIED), '再試行制限: 数えるのは運用上の失敗だけ（引数不備・権限は数えない）');
}

// ---------- サーバー配線の試験 ----------

// JSON-RPC の要求列を標準入力で渡してサーバーを 1 回走らせ、id ごとの応答を返す。
function runServer(serverArguments, requests, { script = serverPath } = {}) {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tools-selftest', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...requests,
  ].map(item => JSON.stringify(item)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [script, ...serverArguments], { input, encoding: 'utf8', timeout: 120000, windowsHide: true });
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

// 公開設定を指定して一時プロジェクトを作り、承認ファイルまで用意する。
function makeProject(name, { config = {}, git = false, files = {} } = {}) {
  const root = path.join(temporaryRoot, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_CONTEXT.md'), `# ${name} 概要\n\n## 目的\n\nフィクスチャーの目的。\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_STATUS.md'), `# ${name} 状態\n\n## 現在状態（CURATED）\n\n作業中。\n`, 'utf8');
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content, 'utf8');
  }
  const configPath = path.join(root, '.chatgpt-project-bridge.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1, projectName: name, contextFile: 'CHATGPT_PROJECT_CONTEXT.md', statusFile: 'CHATGPT_PROJECT_STATUS.md',
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md'], allowDirectories: [], denyDirectories: ['.git', 'private'], maxDocumentBytes: 524288, ...config,
  }, null, 2), 'utf8');
  if (git) {
    const runGit = args => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', ...args], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    runGit(['init', '-q', '-b', 'main']);
    runGit(['add', '-A']);
    runGit(['commit', '-q', '-m', 'initial']);
    runGit(['checkout', '-q', '-b', 'feature/one']);
    fs.writeFileSync(path.join(root, 'feature.txt'), 'feature\n', 'utf8');
    runGit(['add', '-A']);
    runGit(['commit', '-q', '-m', 'feature work']);
    runGit(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'dirty\n', 'utf8');
  }
  return { root, configPath, approvalFile: path.join(temporaryRoot, `${name}-approval.json`) };
}

// 公開範囲と指紋をサーバー自身に出させる。
function printExposure(project) {
  return JSON.parse(execFileSync(process.execPath, [serverPath, '--print-exposure', '--project-root', project.root, '--config', project.configPath], { encoding: 'utf8' }));
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

// 単一モードの起動引数。
function singleArguments(project) {
  return ['--stdio', '--project-root', project.root, '--config', project.configPath, '--approval-file', project.approvalFile];
}

// ディレクトリ配下の全ファイルを、相対パスと内容の hash の一覧にする（.git を含む）。読み取り専用の確認に使う。
function snapshotTree(root) {
  const entries = []; // [相対パス, 内容の hash]。
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) entries.push(`${path.relative(root, full)}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  return entries.sort().join('\n');
}

function testToolLists() {
  const project = makeProject('lists');
  approve(project);
  const single = runServer(singleArguments(project), [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const singleTools = single.byId.get(2)?.result?.tools ?? [];
  check(single.byId.get(1)?.result?.serverInfo?.version === '1.5.0', 'initialize: サーバーの版が 1.5.0（2.7.0 で Claude Code のジョブのツールを足した）');
  check(String(single.byId.get(1)?.result?.instructions).includes('meta.hidden') && String(single.byId.get(1)?.result?.instructions).includes('ビルドやテストはこのサーバーでは実行しません'), 'initialize: 新ツールの読み方（hidden・実行しない）を説明に含める');
  check(singleTools.length === LEGACY_TOOLS.single.length + 10 + 6 + 5 + 1, `単一モード: ツール数 ${LEGACY_TOOLS.single.length + 10 + 6 + 5 + 1}（既存 ${LEGACY_TOOLS.single.length} + 2.5.0 の 10 + 2.6.0 の 6 + 2.7.0 の 5 + 2.9.0 の 1。実測 ${singleTools.length}）`);
  for (const legacy of LEGACY_TOOLS.single) {
    const current = singleTools.find(tool => tool.name === legacy.name);
    check(current && JSON.stringify({ name: current.name, inputSchema: current.inputSchema, annotations: current.annotations }) === JSON.stringify(legacy), `単一モード: 既存ツール ${legacy.name} の名前・引数・注釈が 2.4.3 と同一`);
  }
  for (const definition of DETAIL_TOOL_DEFINITIONS) {
    const current = singleTools.find(tool => tool.name === definition.name);
    const expectedSchema = { type: 'object', properties: definition.properties, ...(definition.required.length > 0 ? { required: definition.required } : {}), additionalProperties: false };
    check(current && JSON.stringify(current.inputSchema) === JSON.stringify(expectedSchema) && current.annotations?.readOnlyHint === true && current.annotations?.destructiveHint === false, `単一モード: 新ツール ${definition.name} の引数スキーマと読み取り専用の注釈`);
  }
  check(DETAIL_TOOL_NAMES.length === 10 && new Set(DETAIL_TOOL_NAMES).size === 10, '新ツールは 10 個で名前が重複しない');

  const hubFile = path.join(temporaryRoot, 'lists-hub.json');
  fs.writeFileSync(hubFile, JSON.stringify({ schemaVersion: 1, projects: [{ name: 'lists', root: project.root, approvalFile: project.approvalFile }] }));
  const hub = runServer(['--stdio', '--hub', hubFile], [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const hubTools = hub.byId.get(2)?.result?.tools ?? [];
  check(hubTools.length === LEGACY_TOOLS.hub.length + 10 + 6 + 5 + 1, `ハブ: ツール数 ${LEGACY_TOOLS.hub.length + 10 + 6 + 5 + 1}（既存 ${LEGACY_TOOLS.hub.length} + 2.5.0 の 10 + 2.6.0 の 6 + 2.7.0 の 5 + 2.9.0 の 1。実測 ${hubTools.length}）`);
  for (const legacy of LEGACY_TOOLS.hub) {
    const current = hubTools.find(tool => tool.name === legacy.name);
    check(current && JSON.stringify({ name: current.name, inputSchema: current.inputSchema, annotations: current.annotations }) === JSON.stringify(legacy), `ハブ: 既存ツール ${legacy.name} の名前・引数・注釈が 2.4.3 と同一`);
  }
  for (const definition of DETAIL_TOOL_DEFINITIONS) {
    const current = hubTools.find(tool => tool.name === definition.name);
    const requiresProject = definition.needsProject;
    const required = current?.inputSchema?.required ?? [];
    const hasProject = current?.inputSchema?.properties?.project?.type === 'string';
    check(current && hasProject === requiresProject && (requiresProject ? required[0] === 'project' : !required.includes('project')), `ハブ: ${definition.name} は project 引数が${requiresProject ? '必須' : '不要'}`);
    if (current) {
      const { project: unused, ...rest } = current.inputSchema.properties;
      check(JSON.stringify(rest) === JSON.stringify(definition.properties), `ハブ: ${definition.name} の project 以外の引数は単一モードと同一スキーマ`);
    }
  }
}

function testExposureFingerprint() {
  const legacy = makeProject('fp-legacy');
  const legacyPrinted = printExposure(legacy);
  check(JSON.stringify(Object.keys(legacyPrinted.exposure)) === JSON.stringify(LEGACY_EXPOSURE_KEYS), '指紋: 既存の設定の公開範囲に detailExposure を足さない（項目と順序が 2.4.x と同じ）');
  const explicitFalse = makeProject('fp-legacy', { config: { detailExposure: { branchNames: false, diffExcerpts: false, sourceText: false } } });
  check(printExposure(explicitFalse).sha256 === legacyPrinted.sha256, '指紋: detailExposure をすべて false と明記しても、指紋は変わらない（既存の承認が有効なまま）');
  const nonBoolean = makeProject('fp-legacy', { config: { detailExposure: { branchNames: 'true', diffExcerpts: 1, sourceText: null, unknownKey: true } } });
  check(printExposure(nonBoolean).sha256 === legacyPrinted.sha256, '指紋: 真偽値でない値と未知のキーは非公開として扱い、指紋を変えない');
  const enabled = makeProject('fp-legacy', { config: { detailExposure: { branchNames: true } } });
  const enabledPrinted = printExposure(enabled);
  const enabledKeys = Object.keys(enabledPrinted.exposure);
  check(enabledPrinted.sha256 !== legacyPrinted.sha256, '指紋: 1 つでも許可すると指紋が変わり、再承認が必要になる');
  check(enabledKeys[enabledKeys.length - 1] === 'detailExposure' && JSON.stringify(enabledPrinted.exposure.detailExposure) === JSON.stringify({ branchNames: true, diffExcerpts: false, sourceText: false }), '指紋: 許可したときは末尾に detailExposure（3 項目すべて明記）');
  const unapproved = runServer(singleArguments(enabled), [callRequest(2, 'get_project_context')]); // 承認ファイルが無い（enabled は未承認）。
  check(toolResult(unapproved, 2).isError === true && toolResult(unapproved, 2).text.includes('承認'), '指紋: 許可を足した設定は、再承認するまで既存のツールも含めて応答しない');
}

function testModuleIsolation() {
  const project = makeProject('isolation', { git: true });
  approve(project);
  const copyDirectory = path.join(temporaryRoot, 'partial-install');
  fs.mkdirSync(copyDirectory);
  for (const file of ['server.mjs', 'bridge-tools-common.mjs', 'bridge-tool-definitions.mjs']) fs.copyFileSync(path.join(scriptsDirectory, file), path.join(copyDirectory, file));
  const requests = [
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    callRequest(3, 'get_project_context'),
    callRequest(4, 'get_git_branches'),
    callRequest(5, 'get_git_branches'),
    callRequest(6, 'get_git_branches'),
    callRequest(7, 'get_git_branches'),
    callRequest(8, 'get_project_overview'),
  ];
  const session = runServer(singleArguments(project), requests, { script: path.join(copyDirectory, 'server.mjs') });
  check((session.byId.get(2)?.result?.tools ?? []).length === 30, '新モジュールが無い導入: tools/list は 30 ツールのまま（定義は bridge-tool-definitions.mjs にある）');
  check(toolResult(session, 3).isError === false && toolResult(session, 3).text.includes('フィクスチャーの目的'), '新モジュールが無い導入: 既存ツールは通常どおり動く');
  const missing = toolResult(session, 4);
  check(missing.isError === true && missing.json?.meta?.errorClass === 'internal_error' && missing.text.includes('bridge-git.mjs'), '新モジュールが無い導入: 新ツールは「モジュールを読み込めない」と分類付きで返す');
  check(toolResult(session, 8).isError === true && toolResult(session, 8).text.includes('bridge-analysis.mjs'), '新モジュールが無い導入: 分析ツールも同様に返す');
  check(toolResult(session, 7).json?.meta?.errorClass === 'too_many_failures' && toolResult(session, 7).json?.meta?.retryable === true, '再試行制限: 同じ呼び出しが 3 回続けて失敗したら、4 回目は too_many_failures で見合わせる');
  check(toolResult(session, 6).json?.meta?.errorClass === 'internal_error', '再試行制限: 3 回目までは通常の失敗として返す');
}

function testToolsEndToEnd() {
  const branchProject = makeProject('e2e-git', {
    git: true,
    config: { gitExposure: { paths: true, commitSubjects: true }, detailExposure: { branchNames: true, diffExcerpts: true, sourceText: true } },
    files: { 'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'SHOULD_NOT_EXIST.txt\',\'x\')"' } }), 'src/index.js': '// TODO: 実装する\nconsole.log(1);\n' },
  });
  approve(branchProject);
  const before = snapshotTree(branchProject.root);
  const requests = [
    callRequest(2, 'get_git_branches'),
    callRequest(3, 'get_branch_details', { branch: 'feature/one' }),
    callRequest(4, 'compare_branches', { base: 'main', target: 'feature/one' }),
    callRequest(5, 'get_worktree_details'),
    callRequest(6, 'get_recent_activity', { days: 30 }),
    callRequest(7, 'get_project_overview'),
    callRequest(8, 'get_project_structure', { depth: 2 }),
    callRequest(9, 'get_project_tasks'),
    callRequest(10, 'get_project_validation'),
    callRequest(11, 'get_portfolio_summary'),
    callRequest(12, 'get_branch_details', {}),
    callRequest(13, 'get_branch_details', { branch: '--output=evil.txt' }),
    callRequest(14, 'get_git_branches', { limit: 'abc' }),
  ];
  const session = runServer(singleArguments(branchProject), requests);
  const names = { 2: 'get_git_branches', 3: 'get_branch_details', 4: 'compare_branches', 5: 'get_worktree_details', 6: 'get_recent_activity', 7: 'get_project_overview', 8: 'get_project_structure', 9: 'get_project_tasks', 10: 'get_project_validation', 11: 'get_portfolio_summary' };
  for (const [id, name] of Object.entries(names)) {
    const result = toolResult(session, Number(id));
    const expectedProject = name === 'get_portfolio_summary' ? undefined : 'e2e-git'; // 横断サマリーは複数のプロジェクトを返すので、トップレベルに project を持たない。
    check(result.isError === false && result.json?.tool === name && result.json?.schemaVersion === TOOL_SCHEMA_VERSION && result.json?.project === expectedProject, `全ツール通し: ${name} が成功し、共通の形式（schemaVersion・tool${expectedProject ? '・project' : ''}）で返る`);
    check(Boolean(result.json?.meta?.collectedAt) && ['ok', 'partial', 'unavailable'].includes(result.json?.meta?.status) && Array.isArray(result.json?.meta?.sources) && result.json?.meta?.sources.length > 0, `全ツール通し: ${name} に取得日時・状態・情報源が付く`);
    check(result.json?.meta?.status !== 'unavailable', `全ツール通し: ${name} の状態が unavailable ではない（状態 ${result.json?.meta?.status}、分類 ${result.json?.meta?.errorClass}）`);
  }
  const missingBranch = toolResult(session, 12);
  check(missingBranch.isError === true && missingBranch.json?.meta?.errorClass === 'invalid_argument' && missingBranch.json?.meta?.retryable === false, '引数不備: branch が無ければ isError で invalid_argument（再試行不可）');
  const injection = toolResult(session, 13);
  check(injection.isError === true && ['invalid_argument', 'ref_not_found'].includes(injection.json?.meta?.errorClass) && !fs.existsSync(path.join(branchProject.root, 'evil.txt')) && !fs.existsSync(path.join(scriptsDirectory, 'evil.txt')), '引数不備: オプション風のブランチ名は拒否され、ファイルも作られない');
  check(toolResult(session, 14).isError === true && toolResult(session, 14).json?.meta?.errorClass === 'invalid_argument', '引数不備: limit が整数でなければ invalid_argument');
  check(!fs.existsSync(path.join(branchProject.root, 'SHOULD_NOT_EXIST.txt')), '実行しない: package.json の scripts.test を実行していない');
  check(snapshotTree(branchProject.root) === before, '読み取り専用: 全ツールを呼んでも、.git を含むプロジェクトの全ファイルが変わらない');

  const closed = makeProject('e2e-closed', { git: true });
  approve(closed);
  const closedSession = runServer(singleArguments(closed), [callRequest(2, 'get_git_branches'), callRequest(3, 'get_branch_details', { branch: 'feature/one' }), callRequest(4, 'get_project_structure'), callRequest(5, 'get_worktree_details')]);
  const closedBranches = toolResult(closedSession, 2);
  check(closedBranches.isError === false && closedBranches.json?.meta?.hidden?.includes('branchNames') && closedBranches.json?.meta?.status === 'partial', '既定の権限: get_git_branches はブランチ名を隠し、hidden と partial で示す');
  check(!closedBranches.text.includes('feature/one'), '既定の権限: 現在のブランチ以外のブランチ名が応答に出ない');
  const closedDetails = toolResult(closedSession, 3);
  check(closedDetails.isError === true && closedDetails.json?.meta?.errorClass === 'permission_denied' && !closedDetails.text.includes('feature'), '既定の権限: get_branch_details は permission_denied（ブランチの存在も明かさない）');
  check(String(closedDetails.json?.meta?.errorReason).includes('detailExposure.branchNames') && !String(closedDetails.json?.meta?.errorReason).includes('gitExposure.branchNames'), '既定の権限: 権限エラーの文言が、許可するための設定キー（detailExposure.branchNames）を正しく案内する');
  check(!toolResult(closedSession, 4).text.includes('package.json') && !toolResult(closedSession, 4).text.includes('src/') && toolResult(closedSession, 4).json?.meta?.hidden?.includes('paths'), '既定の権限: get_project_structure はファイル名を出さず、hidden に paths を示す');
  check(!toolResult(closedSession, 5).text.includes('dirty.txt') && toolResult(closedSession, 5).json?.meta?.hidden?.includes('paths'), '既定の権限: get_worktree_details はファイル名を出さず、hidden に paths を示す');
}

function testWalkBoundary() {
  const project = makeProject('walk', {
    config: { detailExposure: { sourceText: true }, gitExposure: { paths: true, commitSubjects: false } },
    files: { 'z/inner.txt': 'z\n', 'src/main.js': 'x\n', 'readme.md': 'r\n' },
  });
  fs.mkdirSync(path.join(project.root, 'a', 'deep'), { recursive: true });
  for (let index = 0; index < 100; index += 1) fs.writeFileSync(path.join(project.root, 'a', 'deep', `f${index}.txt`), 'x\n', 'utf8');
  for (const directory of ['3rdparty', 'external', '.godot', 'cmake-build-debug', 'build-release', 'node_modules', 'normal_dir']) {
    fs.mkdirSync(path.join(project.root, directory), { recursive: true });
    fs.writeFileSync(path.join(project.root, directory, 'inside.txt'), 'x\n', 'utf8');
  }
  const context = createProjectContext(project.root, project.configPath, null); // 承認ファイルなし。境界そのものを直接調べる。
  const limited = context.analysisBoundary.walk({ maxDepth: 4, maxEntries: 30 });
  check(limited.truncated === true && limited.truncatedBy === 'entries', '走査: 上限に達したら truncated と truncatedBy を返す');
  check(limited.entries.some(entry => entry.path === 'z/inner.txt'), '走査: 幅優先なので、巨大なサブツリー（a/deep）が上限を使い切っても、同じ階層の別ディレクトリ（z）を見落とさない');
  const full = context.analysisBoundary.walk({ maxDepth: 5 });
  const byPath = new Map(full.entries.map(entry => [entry.path, entry]));
  for (const name of ['3rdparty', 'external', '.godot', 'cmake-build-debug', 'build-release', 'node_modules']) {
    check(byPath.get(name)?.excluded === true && !byPath.has(`${name}/inside.txt`), `走査: ${name} は一覧に載せるが中には降りない（excluded）`);
  }
  check(byPath.get('normal_dir')?.excluded === false && byPath.has('normal_dir/inside.txt'), '走査: 通常のディレクトリには降りる');
  check(!byPath.has('.chatgpt-project-bridge.json') && !full.entries.some(entry => entry.path.endsWith('.chatgpt-project-bridge.json')), '走査: この橋渡しの設定ファイル（.chatgpt-project-bridge.json）を一覧に出さない');
  check(throwsClass(() => context.analysisBoundary.readTextFile('.chatgpt-project-bridge.json'), ERROR_CLASS.PERMISSION_DENIED), '本文: sourceText を許可しても、橋渡しの設定ファイルは読めない');
  check(context.analysisBoundary.readTextFile('src/main.js').text === 'x\n', '本文: sourceText を許可すれば通常のファイルは読める');
  check(context.analysisBoundary.statFile('.chatgpt-project-bridge.json') === null, '本文: 橋渡しの設定ファイルは存在確認にも出ない');
  const closed = createProjectContext(project.root, makeProject('walk-closed', {}).configPath, null);
  check(throwsClass(() => closed.analysisBoundary.readTextFile('readme.md'), ERROR_CLASS.PERMISSION_DENIED), '本文: sourceText を許可していなければ読めない');
}

function testHubPortfolio() {
  const alpha = makeProject('hub-alpha', { git: true });
  const beta = makeProject('hub-beta');
  const gamma = makeProject('hub-gamma', { git: true });
  approve(alpha);
  approve(beta);
  // gamma は承認しない。
  const accessLog = path.join(temporaryRoot, 'hub-access.log');
  const hubFile = path.join(temporaryRoot, 'hub-portfolio.json');
  fs.writeFileSync(hubFile, JSON.stringify({
    schemaVersion: 1, accessLog, notifications: { start: false, access: false },
    projects: [alpha, beta, gamma].map(project => ({ name: path.basename(project.root), root: project.root, approvalFile: project.approvalFile })),
  }));
  const session = runServer(['--stdio', '--hub', hubFile], [
    callRequest(2, 'get_portfolio_summary'),
    callRequest(3, 'get_portfolio_summary', { limit: 1 }),
    callRequest(4, 'get_portfolio_summary', { offset: 1, limit: 1 }),
    callRequest(5, 'get_git_branches', { project: 'hub-alpha' }),
    callRequest(6, 'get_git_branches', { project: 'hub-gamma' }),
    callRequest(7, 'get_git_branches', {}),
    callRequest(8, 'get_project_overview', { project: 'hub-beta' }),
  ]);
  const all = toolResult(session, 2);
  const listed = (all.json?.facts?.projects ?? []).map(entry => entry.project).sort();
  check(all.isError === false && JSON.stringify(listed) === JSON.stringify(['hub-alpha', 'hub-beta']), 'ハブ横断: 承認済みのプロジェクトだけを返し、未承認の存在を明かさない');
  check(!all.text.includes('hub-gamma'), 'ハブ横断: 未承認プロジェクトの名前が応答に出ない');
  check(all.json?.page?.total === 2 && all.json?.page?.nextOffset === null, 'ハブ横断: page.total は承認済みの件数');
  const first = toolResult(session, 3);
  const second = toolResult(session, 4);
  check(first.json?.facts?.projects?.length === 1 && first.json?.page?.nextOffset === 1 && second.json?.facts?.projects?.length === 1 && second.json?.page?.nextOffset === null, 'ハブ横断: limit と offset でページングできる');
  check(first.json?.facts?.projects?.[0]?.project !== second.json?.facts?.projects?.[0]?.project, 'ハブ横断: ページ間で同じプロジェクトを返さない');
  for (const entry of all.json?.facts?.projects ?? []) {
    check(typeof entry.os === 'string' && entry.collection && ['ok', 'partial', 'unavailable'].includes(entry.collection.status), `ハブ横断: ${entry.project} の概要に os と collection.status が付く`);
  }
  check(toolResult(session, 5).isError === false && toolResult(session, 5).json?.project === 'hub-alpha', 'ハブ: project を指定した新ツールが成功する');
  check(toolResult(session, 6).isError === true && toolResult(session, 6).text.includes('使用できません') && !toolResult(session, 6).text.includes('承認されて'), 'ハブ: 未承認プロジェクトは既存と同じ文言で拒否する（新たな情報を足さない）');
  check(toolResult(session, 7).isError === true && toolResult(session, 7).text.includes('project は必須です'), 'ハブ: project が無ければ既存と同じ文言で拒否する');
  check(toolResult(session, 8).isError === false && toolResult(session, 8).json?.project === 'hub-beta', 'ハブ: Git の無いプロジェクトでも分析ツールが動く');
  const logLines = fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  check(logLines.some(entry => entry.tool === 'get_portfolio_summary' && entry.project === '(全プロジェクト)' && entry.ok === true), 'アクセス記録: 横断サマリーは「(全プロジェクト)」で記録する');
  check(logLines.some(entry => entry.tool === 'get_git_branches' && entry.project === 'hub-alpha' && entry.ok === true) && logLines.some(entry => entry.tool === 'get_git_branches' && entry.project === 'hub-gamma' && entry.ok === false), 'アクセス記録: 新ツールもプロジェクト別に成否を記録する');
}

testEnvelope();
testArguments();
testPaging();
testBudget();
testFailureGuard();
testToolLists();
testExposureFingerprint();
testModuleIsolation();
testToolsEndToEnd();
testWalkBoundary();
testHubPortfolio();

process.stdout.write(failures === 0 ? 'TOOLS_SELFTEST PASS\n' : `TOOLS_SELFTEST FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
