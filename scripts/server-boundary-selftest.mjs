#!/usr/bin/env node
/*
  公開境界・FIFO・走査量と、ライブラリーimportの副作用を検証する回帰試験。
  データ・承認はこの試験専用の一時ディレクトリだけに作成し、実際のプロジェクトや資格情報は使わない。
*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProjectContext, redact } from './server.mjs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-boundary-selftest-'));
const expectedExports = ['createProjectContext', 'hasForbiddenPathName', 'isSensitive', 'loadHub', 'normalizeRelative', 'readApprovalFile', 'redact'];
let checkCount = 0;
let skipCount = 0;

function passed(label) {
  checkCount += 1;
  process.stdout.write(`PASS ${label}\n`);
}

// 実行できなかった試験を数えて表示する。最終行の SKIP 件数に反映する。
function skipped(label) {
  skipCount += 1;
  process.stdout.write(`SKIP ${label}\n`);
}

// 単一モードのサーバーを標準入出力で起動し、ツールを1回呼んで結果の本文（JSON）を返す。
function callToolOnce(fixture, name, args = {}, hubName = null) {
  let serverArguments = ['--stdio', '--project-root', fixture.root, '--config', fixture.configPath, '--approval-file', fixture.approvalFile]; // 単一モードの起動引数。
  if (hubName) {
    const hubPath = path.join(temporaryRoot, `${hubName}-hub.json`); // ハブモードの設定ファイル。
    fs.writeFileSync(hubPath, JSON.stringify({ schemaVersion: 1, projects: [{ name: hubName, root: fixture.root, approvalFile: fixture.approvalFile }] }));
    serverArguments = ['--stdio', '--hub', hubPath];
    args = { ...args, project: hubName };
  }
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boundary-selftest', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [serverPath, ...serverArguments], { input: lines, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(item => item.id === 2);
  assert.equal(response.result.isError, false, response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

function makeFixture(name, overrides = {}) {
  const root = path.join(temporaryRoot, name);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'CONTEXT.md'), '# Fixture context\n');
  fs.writeFileSync(path.join(root, 'STATUS.md'), '# Fixture status\n');
  const configPath = path.join(root, '.chatgpt-project-bridge.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    projectName: name,
    contextFile: 'CONTEXT.md',
    statusFile: 'STATUS.md',
    allowFiles: ['CONTEXT.md', 'STATUS.md'],
    allowDirectories: [],
    denyDirectories: ['private'],
    maxDocumentBytes: 1024,
    ...overrides,
  }));
  const approvalFile = path.join(temporaryRoot, `${name}-approval.json`);
  const context = createProjectContext(root, configPath, approvalFile);
  fs.writeFileSync(approvalFile, JSON.stringify({ schemaVersion: 1, sha256: context.exposureSha256 }), { mode: 0o600 });
  assert.equal(context.readApprovalState().approved, true);
  return { root, configPath, approvalFile, context };
}

function testImport() {
  const code = `const bridge = await import(${JSON.stringify(pathToFileURL(serverPath).href)}); process.stdout.write(JSON.stringify(Object.keys(bridge).sort()));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: temporaryRoot, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expectedExports);
  passed('import は設定読取・標準入出力サーバー起動なしで終了する');
}

function testAliasesAndDeniedTraversal() {
  const fixture = makeFixture('boundaries', {
    allowDirectories: [{ path: 'allowed', recursive: true }, { path: 'alias-root', recursive: true }],
    denyDirectories: ['private', 'allowed/denied'],
  });
  for (const relative of ['allowed', 'private', '.ssh', 'allowed/denied', 'allowed/.git']) fs.mkdirSync(path.join(fixture.root, relative), { recursive: true });
  for (const relative of ['private/note.md', '.ssh/note.md', 'allowed/denied/note.md', 'allowed/.git/note.md']) {
    fs.writeFileSync(path.join(fixture.root, relative), 'NONSECRET_PRIVATE_FIXTURE_MARKER');
  }
  fs.writeFileSync(path.join(fixture.root, 'allowed', 'readable.md'), '# Allowed\n');
  const outside = path.join(temporaryRoot, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'note.md'), 'NONSECRET_OUTSIDE_FIXTURE_MARKER');
  let linkCount = 0;
  const links = [
    ['allowed/denied-alias', path.join(fixture.root, 'private')],
    ['allowed/sensitive-alias', path.join(fixture.root, '.ssh')],
    ['allowed/outside-alias', outside],
    ['alias-root', path.join(fixture.root, 'private')],
  ];
  for (const [relative, destination] of links) {
    try {
      fs.symlinkSync(destination, path.join(fixture.root, relative), process.platform === 'win32' ? 'junction' : 'dir');
      linkCount += 1;
      assert.throws(() => fixture.context.readDocument(`${relative}/note.md`));
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) continue;
      throw error;
    }
  }
  if (linkCount > 0) passed('中間ディレクトリのリンクで拒否領域・機微領域・外部領域を公開できない');
  else skipped('リンク作成権限が無いためWindowsのリンク試験');

  const originalOpenDirectory = fs.opendirSync;
  const inspectedDirectories = [];
  fs.opendirSync = function (directory, ...options) {
    inspectedDirectories.push(path.relative(fixture.root, directory).replace(/\\/g, '/'));
    return originalOpenDirectory.call(fs, directory, ...options);
  };
  let documents;
  try { documents = fixture.context.listDocuments(); }
  finally { fs.opendirSync = originalOpenDirectory; }
  assert.deepEqual(documents.map(document => document.path).sort(), ['CONTEXT.md', 'STATUS.md', 'allowed/readable.md'].sort());
  assert.deepEqual(inspectedDirectories, ['allowed']);
  assert.equal(fixture.context.readDocument('allowed/readable.md').text, '# Allowed\n');
  passed('拒否ディレクトリ・機微ディレクトリ・リンクを開く前に走査から除外する');
}

function testFifo() {
  if (process.platform === 'win32') {
    skipped('POSIX FIFO試験（Windows）');
    return;
  }
  const fixture = makeFixture('fifo', { allowFiles: ['CONTEXT.md', 'STATUS.md', 'pipe.md'] });
  const made = spawnSync('mkfifo', [path.join(fixture.root, 'pipe.md')], { encoding: 'utf8', timeout: 5000 });
  if (made.error?.code === 'ENOENT') {
    skipped('FIFO試験（mkfifo無し）');
    return;
  }
  assert.equal(made.status, 0, made.stderr);
  // 退行でopenが停止しても、試験全体が停止しないよう子プロセスに時間制限を付ける。
  const code = `const {createProjectContext} = await import(${JSON.stringify(pathToFileURL(serverPath).href)}); const context = createProjectContext(...JSON.parse(process.argv[1])); try { context.readDocument('pipe.md'); process.stdout.write('accepted'); } catch { process.stdout.write('rejected'); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([fixture.root, fixture.configPath, fixture.approvalFile])], { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' });
  assert.equal(result.error, undefined, 'FIFOを開く処理が停止した');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'rejected');
  passed('明示許可されたFIFOも待機せず拒否する');
}

function testDocumentLimits() {
  const names = Array.from({ length: 1005 }, (_, index) => `entry-${String(index).padStart(4, '0')}.md`);
  const explicit = makeFixture('explicit-limit', { allowFiles: names });
  for (const name of names) fs.writeFileSync(path.join(explicit.root, name), '# Explicit\n');
  assert.equal(explicit.context.listDocuments().length, 1000);
  passed('明示ファイルだけでも1000文書上限を守る');

  const directory = makeFixture('directory-limit', { allowFiles: [], allowDirectories: [{ path: 'allowed', recursive: true }] });
  fs.mkdirSync(path.join(directory.root, 'allowed'));
  for (const name of names) fs.writeFileSync(path.join(directory.root, 'allowed', name), '# Directory\n');
  assert.equal(directory.context.listDocuments().length, 1000);
  passed('同一ディレクトリに大量の文書があっても1000文書上限を守る');
}

function testTraversalLimit() {
  const fixture = makeFixture('entry-limit', { allowFiles: [], allowDirectories: [{ path: 'allowed', recursive: true }] });
  const directory = path.join(fixture.root, 'allowed');
  fs.mkdirSync(directory);
  for (let index = 0; index < 10005; index += 1) fs.writeFileSync(path.join(directory, `ignored-${index}.txt`), '');
  const originalOpenDirectory = fs.opendirSync;
  let entryReads = 0;
  fs.opendirSync = function (...options) {
    const handle = originalOpenDirectory.apply(fs, options);
    const originalRead = handle.readSync.bind(handle);
    handle.readSync = () => { entryReads += 1; return originalRead(); };
    return handle;
  };
  try { assert.deepEqual(fixture.context.listDocuments(), []); }
  finally { fs.opendirSync = originalOpenDirectory; }
  assert.equal(entryReads, 10000);
  passed('公開文書が無い場合も10000エントリーで走査を打ち切る');
}

function testLiveScopeRevocation() {
  const fixture = makeFixture('live-revocation', { allowDirectories: [{ path: 'allowed', recursive: true }] });
  fs.mkdirSync(path.join(fixture.root, 'allowed'));
  fs.writeFileSync(path.join(fixture.root, 'allowed', 'note.md'), '# Was allowed\n');
  assert.equal(fixture.context.readDocument('allowed/note.md').text, '# Was allowed\n');
  const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  config.denyDirectories.push('allowed');
  fs.writeFileSync(fixture.configPath, JSON.stringify(config));
  assert.equal(fixture.context.readApprovalState().approved, false);
  passed('起動済みcontextもdeny追加を検知して公開停止する');

  const reloaded = createProjectContext(fixture.root, fixture.configPath, fixture.approvalFile);
  fs.writeFileSync(fixture.approvalFile, JSON.stringify({ schemaVersion: 1, sha256: reloaded.exposureSha256 }), { mode: 0o600 });
  assert.equal(fixture.context.readApprovalState().approved, false);
  assert.equal(reloaded.readApprovalState().approved, true);
  assert.throws(() => reloaded.readDocument('allowed/note.md'));
  fs.writeFileSync(fixture.configPath, '{broken');
  assert.equal(reloaded.readApprovalState().approved, false);
  passed('新scopeの再承認で古いcontextを有効化せず、不正設定でも公開しない');
}

// 追加した秘密値マスクの規則が効くこと、普通の文章を伏せないことを検査する。値は試験用の架空のもの。
function testRedactionRules() {
  const alnum = length => 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'.repeat(2).slice(0, length); // 英数字のダミー値。
  const mustRedact = [
    ['AWS_SECRET_ACCESS_KEY=' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + alnum(10), 'wJalrXUtnFEMI'],
    ['access_key: ' + alnum(24), alnum(24)],
    ['gho_' + alnum(36), 'gho_'],
    ['ghs_' + alnum(36), 'ghs_'],
    ['ghu_' + alnum(36), 'ghu_'],
    ['ghr_' + alnum(36), 'ghr_'],
    ['glpat-' + alnum(20), 'glpat-'],
    ['npm_' + alnum(36), 'npm_'],
    ['sk_live_' + alnum(24), 'sk_live_'],
    ['sk_test_' + alnum(24), 'sk_test_'],
    ['pk_live_' + alnum(24), 'pk_live_'],
    ['rk_live_' + alnum(24), 'rk_live_'],
    ['ya29.' + alnum(40), 'ya29.'],
    ['key id ASIA' + 'ABCDEFGHIJKLMNOP' + ' end', 'ASIAABCDEFGHIJKLMNOP'],
    ['Authorization: Basic ' + 'dXNlcjpwYXNzd29yZDEyMw==', 'dXNlcjpwYXNzd29yZDEyMw'],
    ['"Authorization": "Basic ' + 'dXNlcjpwYXNzd29yZDEyMw==' + '"', 'dXNlcjpwYXNzd29yZDEyMw'],
    ['https://hooks.slack.com/services/' + 'T0123ABCD/B0123ABCD/' + alnum(24), 'T0123ABCD'],
    ['xoxe-' + alnum(30), 'xoxe-'],
    ['xoxo-' + alnum(30), 'xoxo-'],
  ];
  for (const [input, leaked] of mustRedact) {
    const output = redact(input);
    assert.ok(!output.includes(leaked), `伏せられていない: ${input.slice(0, 24)}… → ${output}`);
    assert.ok(output.includes('[REDACTED]'), `置換文字列が無い: ${output}`);
  }
  const mustKeep = [
    'the access key is stored in a vault',
    'use sk-learn for the model',
    'set npm_config values in the shell',
    'the pk_live flag is documented',
    'access_key_id=AKIA is not a value here',
    'Basic authentication is explained below',
    'Authorization header uses the Basic scheme',
    'ASIA-PACIFIC region',
    'see ya29 notes',
    'ghs_ prefix is used by GitHub',
    'hooks.slack.com is the host name',
  ];
  for (const text of mustKeep) assert.equal(redact(text), text, `誤って伏せた: ${text}`);
  assert.equal(redact('password=hunter2value'), 'password=[REDACTED]');
  assert.equal(redact('Bearer ' + alnum(30)), '[REDACTED]');
  passed('追加した秘密値マスクが効き、普通の文章は伏せない');
}

// リンクを拒否するときの文言に、プロジェクト内の相対パスだけを含め、絶対パスを出さないことを検査する。
function testLinkedDirectoryMessage() {
  const fixture = makeFixture('link-message', { allowDirectories: [{ path: 'allowed', recursive: true }] });
  fs.mkdirSync(path.join(fixture.root, 'allowed', 'real'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'allowed', 'real', 'note.md'), '# Real\n');
  try {
    fs.symlinkSync(path.join(fixture.root, 'allowed', 'real'), path.join(fixture.root, 'allowed', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      skipped('リンク作成権限が無いためリンク拒否の文言試験');
      return;
    }
    throw error;
  }
  assert.throws(() => fixture.context.readDocument('allowed/linked/note.md'), error => {
    assert.ok(error.message.includes('リンクされた公開パスは使用できません: allowed/linked'), error.message);
    assert.ok(!error.message.includes(fixture.root), '絶対パスを含んでいる');
    return true;
  });
  passed('リンクの拒否文言にプロジェクト内の相対パスだけを含める');
}

// 一覧が上限で途中のとき、truncated・limits・truncatedBy・notice を付けることを検査する（列挙内容は変えない）。
function testListingTruncationNotice() {
  const names = Array.from({ length: 1005 }, (_, index) => `entry-${String(index).padStart(4, '0')}.md`);
  const fixture = makeFixture('notice-documents', { allowFiles: [], allowDirectories: [{ path: 'allowed', recursive: true }] });
  fs.mkdirSync(path.join(fixture.root, 'allowed'));
  for (const name of names) fs.writeFileSync(path.join(fixture.root, 'allowed', name), '# Directory\n');
  const detail = fixture.context.listDocumentsDetailed();
  assert.equal(detail.documents.length, 1000);
  assert.equal(detail.truncated, true);
  assert.equal(detail.truncatedBy, 'documents');
  const output = callToolOnce(fixture, 'list_documents');
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedBy, 'documents');
  assert.deepEqual(output.limits, { maxDocuments: 1000, maxDirectoryEntries: 10000 });
  assert.equal(output.documents.length, 1000);
  assert.deepEqual(Object.keys(output.documents[0]).sort(), ['bytes', 'id', 'modified', 'path', 'title']);
  assert.ok(typeof output.notice === 'string' && output.notice.includes('途中'), output.notice);

  const entries = makeFixture('notice-entries', { allowFiles: [], allowDirectories: [{ path: 'allowed', recursive: true }] });
  fs.mkdirSync(path.join(entries.root, 'allowed'));
  for (let index = 0; index < 10005; index += 1) fs.writeFileSync(path.join(entries.root, 'allowed', `ignored-${index}.txt`), '');
  const entryDetail = entries.context.listDocumentsDetailed();
  assert.deepEqual(entryDetail.documents, []);
  assert.equal(entryDetail.truncated, true);
  assert.equal(entryDetail.truncatedBy, 'directoryEntries');
  passed('上限で一覧が途中のとき truncated・limits・truncatedBy・notice を付ける');
}

// 機微な名前のディレクトリが skippedSensitiveDirectories に載り、載っても取得の挙動は変わらないことを検査する。
function testSkippedSensitiveDirectories() {
  const fixture = makeFixture('skipped-sensitive', { allowDirectories: [{ path: 'allowed', recursive: true }] });
  for (const relative of ['allowed/.aws', 'allowed/sub/.ssh', 'allowed/sub']) fs.mkdirSync(path.join(fixture.root, relative), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'allowed', 'readable.md'), '# Readable\n');
  fs.writeFileSync(path.join(fixture.root, 'allowed', '.aws', 'note.md'), 'NONSECRET_AWS_DIR_MARKER');
  fs.writeFileSync(path.join(fixture.root, 'allowed', 'sub', '.ssh', 'note.md'), 'NONSECRET_SSH_DIR_MARKER');
  const messageBefore = (() => { try { fixture.context.readDocument('allowed/.aws/note.md'); return ''; } catch (error) { return error.message; } })();
  const detail = fixture.context.listDocumentsDetailed();
  assert.deepEqual(detail.skippedSensitiveDirectories.slice().sort(), ['allowed/.aws', 'allowed/sub/.ssh']);
  assert.equal(detail.truncated, false);
  assert.deepEqual(detail.documents.map(document => document.path).sort(), ['CONTEXT.md', 'STATUS.md', 'allowed/readable.md']);
  const messageAfter = (() => { try { fixture.context.readDocument('allowed/.aws/note.md'); return ''; } catch (error) { return error.message; } })();
  assert.notEqual(messageBefore, '', '機微ディレクトリ内の文書が取得できてしまう');
  assert.equal(messageAfter, messageBefore);
  const output = callToolOnce(fixture, 'list_documents');
  assert.deepEqual(output.skippedSensitiveDirectories.slice().sort(), ['allowed/.aws', 'allowed/sub/.ssh']);
  assert.ok(output.notice.includes('allowed/.aws'), output.notice);
  assert.equal(output.truncated, undefined);
  assert.equal(output.documents.length, 3);
  const hubOutput = callToolOnce(fixture, 'list_documents', {}, 'skippedsensitive');
  assert.equal(hubOutput.project, 'skippedsensitive');
  assert.equal(hubOutput.items.length, 3);
  assert.deepEqual(hubOutput.skippedSensitiveDirectories.slice().sort(), ['allowed/.aws', 'allowed/sub/.ssh']);
  assert.ok(hubOutput.notice.includes('機微'), hubOutput.notice);
  passed('機微名のディレクトリを skippedSensitiveDirectories に載せ、取得の挙動は変えない');
}

// 通知すべきことが無いとき、list_documents の戻り値はこれまでと同じ配列のままであることを検査する。
function testListingUnchangedWhenNothingToReport() {
  const fixture = makeFixture('plain-listing');
  const detail = fixture.context.listDocumentsDetailed();
  assert.equal(detail.truncated, false);
  assert.deepEqual(detail.skippedSensitiveDirectories, []);
  const output = callToolOnce(fixture, 'list_documents');
  assert.ok(Array.isArray(output), '配列ではない');
  assert.deepEqual(output.map(document => document.path), ['CONTEXT.md', 'STATUS.md']);
  assert.deepEqual(Object.keys(output[0]).sort(), ['bytes', 'id', 'modified', 'path', 'title']);
  const hubOutput = callToolOnce(fixture, 'list_documents', {}, 'plainlisting');
  assert.deepEqual(Object.keys(hubOutput).sort(), ['items', 'project']);
  passed('通知が無いときの list_documents は従来と同じ配列のまま');
}

try {
  testImport();
  testAliasesAndDeniedTraversal();
  testFifo();
  testDocumentLimits();
  testTraversalLimit();
  testLiveScopeRevocation();
  testRedactionRules();
  testLinkedDirectoryMessage();
  testListingTruncationNotice();
  testSkippedSensitiveDirectories();
  testListingUnchangedWhenNothingToReport();
  process.stdout.write(`PROJECT_BRIDGE_BOUNDARY_SELFTEST PASS (${checkCount}) SKIP (${skipCount})\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
