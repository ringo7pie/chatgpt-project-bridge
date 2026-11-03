/*
 * Publisher / hook / TLS relay integration tests, using disposable fixtures only.
 * Requires Node.js, git, and openssl. No external network or real user settings.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProjectContext } from './server.mjs';
import {
  initializePublisher, readPublisherConfig, approvePublisher, reviewPublisher,
  buildSnapshot, storeSnapshot, synchronizeSnapshot, revokeRemote, publisherStatus,
  policyHash, sendSnapshot, withPublisherLock,
} from './snapshot-publisher.mjs';
import { atomicWritePrivate, readPrivateJson, readPrivateFile, sha256, validateSnapshot } from './snapshot-common.mjs';
import { initRelay, createIngestServer, loadRelayConfig, runSnapshotTool } from './snapshot-relay.mjs';

const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bridge-publisher-test-'));
fs.chmodSync(temporaryRoot, 0o700);
const cliPath = fileURLToPath(new URL('./offline-bridge.mjs', import.meta.url));
const relayPath = fileURLToPath(new URL('./snapshot-relay.mjs', import.meta.url));
const servers = [];
let fixtureCount = 0;
let passedCount = 0;

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function expectError(action, codes) {
  assert.throws(action, error => codes.test(error.code || ''));
}

async function expectRejection(action, codes) {
  await assert.rejects(action, error => codes.test(error.code || ''));
}

async function test(name, action) {
  await action();
  passedCount += 1;
  process.stdout.write('PASS ' + name + '\n');
}

function makeFixture({ approvedLive = true, maxDocumentBytes = 524288 } = {}) {
  fixtureCount += 1;
  const base = path.join(temporaryRoot, 'case-' + fixtureCount);
  const root = path.join(base, 'project');
  const stateDir = path.join(base, 'publisher-state');
  const approvalFile = path.join(base, 'live-authority', 'approval.json');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(approvalFile), { recursive: true, mode: 0o700 });
  const liveConfigPath = path.join(root, '.chatgpt-project-bridge.json');
  const liveConfig = {
    projectName: 'Fixture project', contextFile: 'CHATGPT_PROJECT_CONTEXT.md',
    statusFile: 'CHATGPT_PROJECT_STATUS.md',
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md', 'ARCHITECTURE.md'],
    allowDirectories: [], denyDirectories: ['.git', '.claude', '.codex'], maxDocumentBytes,
    gitExposure: { paths: false, commitSubjects: false },
  };
  writeJson(liveConfigPath, liveConfig);
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_CONTEXT.md'), '# Project context\nOffline fixture CONTEXT-V1\napi_key = sk-' + 'A'.repeat(32) + '\n');
  fs.writeFileSync(path.join(root, 'CHATGPT_PROJECT_STATUS.md'), '# Status\nProgress fixture\n## Issues\n- Review next change\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Readme\nPublicly selected fixture readme\n');
  fs.writeFileSync(path.join(root, 'ARCHITECTURE.md'), '# Architecture\nLIVE-ONLY-DOCUMENT\n');
  fs.writeFileSync(path.join(root, '.env'), 'DO-NOT-COLLECT-ENV=fixture\n');
  fs.mkdirSync(path.join(root, '.claude'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.claude', 'transcript.jsonl'), 'DO-NOT-COLLECT-TRANSCRIPT\n');
  const live = createProjectContext(root, liveConfigPath, null);
  if (approvedLive) writeJson(approvalFile, { schemaVersion: 1, sha256: live.exposureSha256, approvedAt: new Date().toISOString(), exposure: live.exposure });
  const result = initializePublisher({ stateDir, sourceId: 'source-' + fixtureCount,
    projectRoot: root, approvalFile, projectName: 'fixture-project' });
  return { base, root, stateDir, approvalFile, liveConfigPath, liveConfig, ...result };
}

function configure(item, mutate, approve = true) {
  const config = readPublisherConfig(item.configPath);
  mutate(config);
  atomicWritePrivate(item.configPath, JSON.stringify(config, null, 2) + '\n');
  if (approve) approvePublisher(item.configPath, policyHash(readPublisherConfig(item.configPath)));
  return approve ? readPublisherConfig(item.configPath) : config;
}

function approve(item) {
  return approvePublisher(item.configPath, reviewPublisher(item.configPath).policySha256);
}

// hook・手動 CLI の試験が共通して使う、状態ファイル（sync-status.json）の読み書き。
function statePath(item) {
  return path.join(item.stateDir, 'sync-status.json');
}

function seedState(item, values) {
  atomicWritePrivate(statePath(item), JSON.stringify({ schemaVersion: 1, ...values }, null, 2) + '\n');
}

function ageCapture(item, seconds = 3600) {
  const state = readPrivateJson(statePath(item));
  atomicWritePrivate(statePath(item), JSON.stringify({ ...state,
    capturedAt: new Date(Date.now() - seconds * 1000).toISOString() }, null, 2) + '\n');
}

// 到達できない送信先（127.0.0.1:9）を承認済みの設定として持たせる。
// 送信を試みれば、必ず network_error が状態に記録される。
function configureUnreachableRemote(item) {
  const tokenFile = path.join(item.stateDir, 'writer.token');
  fs.writeFileSync(tokenFile, 'B'.repeat(64) + '\n', { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  configure(item, config => {
    config.endpoint = 'https://127.0.0.1:9/v1/snapshots/' + config.sourceId;
    config.tokenFile = tokenFile;
  });
}

function save(item) {
  const snapshot = buildSnapshot(item.configPath);
  storeSnapshot(item.configPath, snapshot);
  return snapshot;
}

function childProcess(script, args, input = '', extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: temporaryRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture_child_timeout')); }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 12 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 64 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function hook(item, event, cwd = item.root, extra = {}) {
  return childProcess(cliPath, ['hook', '--config', item.configPath, '--managed-by', 'chatgpt-project-bridge-offline-v1'],
    JSON.stringify({ hook_event_name: event, cwd, ...extra }), { FIXTURE_NO_EXPORT: 'DO-NOT-COLLECT-ENV-VARIABLE' });
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
}

function certificate() {
  const directory = path.join(temporaryRoot, 'tls');
  fs.mkdirSync(directory, { mode: 0o700 });
  const key = path.join(directory, 'server.key');
  const cert = path.join(directory, 'server.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 });
  fs.chmodSync(key, 0o600);
  fs.chmodSync(cert, 0o600);
  return { key, cert };
}

async function mcp(configFile, tool, args = {}) {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } },
  ];
  const response = await childProcess(relayPath, ['mcp', '--config', configFile], requests.map(JSON.stringify).join('\n') + '\n');
  assert.equal(response.code, 0, 'stdio MCP should exit successfully');
  const records = response.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.find(record => record.id === 1).result.serverInfo.name, 'project-bridge-snapshot-relay');
  assert.ok(records.find(record => record.id === 2).result.tools.every(entry => entry.annotations.readOnlyHint));
  const result = records.find(record => record.id === 3).result;
  return { isError: result.isError, value: JSON.parse(result.content[0].text) };
}

try {
  await test('Initialization is an unapproved draft and performs no capture, upload, or hook installation', async () => {
    const item = makeFixture();
    assert.equal(item.approved, false);
    assert.equal(item.remoteConfigured, false);
    assert.equal(item.includedProjects, 1);
    assert.deepEqual(fs.readdirSync(item.stateDir), ['publisher.json']);
    assert.equal(fs.existsSync(path.join(item.root, '.claude', 'settings.json')), false);
    expectError(() => buildSnapshot(item.configPath), /^not_approved$/);
    const failed = await childProcess(cliPath, ['capture', '--config', item.configPath]);
    assert.equal(failed.code, 1);
    assert.equal(fs.existsSync(path.join(item.stateDir, 'latest.snapshot.json')), false);
    assert.equal(publisherStatus(item.configPath).approved, false);
    const excluded = makeFixture({ approvedLive: false });
    assert.equal(excluded.includedProjects, 0);
    assert.equal(excluded.excludedUnapprovedCount, 1);
  });

  await test('Explicit approval captures JSON and Markdown with selected documents and secret masking', async () => {
    const item = makeFixture();
    approve(item);
    const result = await childProcess(cliPath, ['capture', '--config', item.configPath]);
    assert.equal(result.code, 0);
    const reported = JSON.parse(result.stdout);
    assert.equal(reported.saved, true);
    assert.equal(reported.sent, false);
    const snapshot = readPrivateJson(path.join(item.stateDir, 'latest.snapshot.json'));
    validateSnapshot(snapshot);
    assert.deepEqual(snapshot.projects[0].documents.map(document => document.path).sort(),
      ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'].sort());
    const output = JSON.stringify(snapshot) + fs.readFileSync(path.join(item.stateDir, 'latest.md'), 'utf8');
    assert.match(output, /REDACTED/);
    assert.doesNotMatch(output, /sk-A{32}|DO-NOT-COLLECT|LIVE-ONLY-DOCUMENT/);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(item.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(publisherStatus(item.configPath).liveVerified, false);
    assert.equal(publisherStatus(item.configPath).currentSnapshotSynced, false);
    if (process.platform !== 'win32') {
      for (const filename of ['latest.snapshot.json', 'latest.md', 'sync-status.json']) assert.equal(fs.statSync(path.join(item.stateDir, filename)).mode & 0o777, 0o600);
    }
  });

  await test('Offline file scope, endpoint changes, and includeGit=false are enforced again at storage', () => {
    const item = makeFixture();
    execFileSync('git', ['init', '--initial-branch=main', item.root], { stdio: 'ignore', timeout: 5000 });
    approve(item);
    const withGit = buildSnapshot(item.configPath);
    assert.ok(withGit.projects[0].git !== null);
    configure(item, config => { config.includeGit = false; });
    expectError(() => storeSnapshot(item.configPath, withGit), /^approval_changed$/);
    const noGit = save(item);
    assert.equal(noGit.projects[0].git, null);
    const originalConfig = readPublisherConfig(item.configPath);
    configure(item, config => { config.projects[0].files.push('ARCHITECTURE.md'); }, false);
    expectError(() => buildSnapshot(item.configPath), /^policy_changed$/);
    atomicWritePrivate(item.configPath, JSON.stringify(originalConfig));
    configure(item, config => { config.endpoint = 'https://127.0.0.1:9/v1/snapshots/' + config.sourceId; config.tokenFile = path.join(item.stateDir, 'writer.token'); }, false);
    expectError(() => buildSnapshot(item.configPath), /^policy_changed$/);
    atomicWritePrivate(item.configPath, JSON.stringify(originalConfig));
    configure(item, config => { config.projects[0].files.push('.env'); }, false);
    expectError(() => readPublisherConfig(item.configPath), /^invalid_/);
  });

  await test('Revoked live exposure removes the body and stale queued uploads fail closed', async () => {
    const item = makeFixture();
    configure(item, config => { config.endpoint = 'https://127.0.0.1:9/v1/snapshots/' + config.sourceId; config.tokenFile = path.join(item.stateDir, 'writer.token'); });
    const original = save(item);
    assert.equal(original.projects.length, 1);
    fs.unlinkSync(item.approvalFile);
    await expectRejection(() => synchronizeSnapshot(item.configPath), /^unapproved$/);
    const unavailable = save(item);
    assert.deepEqual(unavailable.projects, []);
    assert.deepEqual(unavailable.unavailable, [{ name: 'fixture-project', code: 'unapproved' }]);
    assert.doesNotMatch(fs.readFileSync(path.join(item.stateDir, 'latest.md'), 'utf8'), /CONTEXT-V1/);
    const changed = makeFixture();
    approve(changed);
    changed.liveConfig.allowFiles.push('ANOTHER.md');
    writeJson(changed.liveConfigPath, changed.liveConfig);
    const result = buildSnapshot(changed.configPath);
    assert.deepEqual(result.projects, []);
    assert.equal(result.unavailable[0].code, 'exposure_changed');
  });

  await test('Hash mismatches, expiry, document tampering, and truncation are observable', async () => {
    const item = makeFixture({ maxDocumentBytes: 1024 });
    fs.writeFileSync(path.join(item.root, 'README.md'), '# Large fixture\n' + 'z'.repeat(4096));
    configure(item, config => { config.endpoint = 'https://127.0.0.1:9/v1/snapshots/' + config.sourceId; config.tokenFile = path.join(item.stateDir, 'writer.token'); });
    const snapshot = save(item);
    assert.equal(snapshot.projects[0].documents.find(document => document.path === 'README.md').truncated, true);
    const corrupted = structuredClone(snapshot);
    corrupted.projects[0].documents[0].text += 'TAMPERED';
    expectError(() => validateSnapshot(corrupted), /^document_hash_mismatch$/);
    const snapshotPath = path.join(item.stateDir, 'latest.snapshot.json');
    atomicWritePrivate(snapshotPath, fs.readFileSync(snapshotPath, 'utf8') + ' ');
    await expectRejection(() => synchronizeSnapshot(item.configPath), /^pending_hash_mismatch$/);
    assert.equal(publisherStatus(item.configPath).currentSnapshotMatches, false);
    const expired = structuredClone(snapshot);
    expired.capturedAt = new Date(Date.now() - 7200000).toISOString();
    expired.expiresAt = new Date(Date.now() - 3600000).toISOString();
    for (const project of expired.projects) project.capturedAt = expired.capturedAt;
    expectError(() => storeSnapshot(item.configPath, expired), /^expired_snapshot$/);
    const expiredBytes = Buffer.from(JSON.stringify(expired));
    atomicWritePrivate(snapshotPath, expiredBytes);
    const statePath = path.join(item.stateDir, 'sync-status.json');
    const state = readPrivateJson(statePath);
    atomicWritePrivate(statePath, JSON.stringify({ ...state, snapshotSha256: sha256(expiredBytes), capturedAt: expired.capturedAt, expiresAt: expired.expiresAt }));
    await expectRejection(() => synchronizeSnapshot(item.configPath), /^expired_snapshot$/);
    assert.equal(publisherStatus(item.configPath).expired, true);
  });

  await test('Private state rejects unsafe permissions, links, and project-root aliases', () => {
    const item = makeFixture();
    expectError(() => initializePublisher({ stateDir: path.join(item.root, 'bad-state'), sourceId: 'invalid', projectRoot: item.root,
      approvalFile: item.approvalFile, projectName: 'fixture-project' }), /^invalid_config$/);
    assert.equal(fs.existsSync(path.join(item.root, 'bad-state')), false);
    if (process.platform !== 'win32') {
      fs.chmodSync(item.configPath, 0o644);
      expectError(() => readPublisherConfig(item.configPath), /^unsafe_file$/);
      fs.chmodSync(item.configPath, 0o600);
      const linked = path.join(item.stateDir, 'linked-publisher.json');
      fs.symlinkSync(item.configPath, linked);
      expectError(() => readPublisherConfig(linked), /^unsafe_path$/);
      const alias = path.join(item.base, 'root-alias');
      fs.symlinkSync(item.root, alias);
      expectError(() => initializePublisher({ stateDir: path.join(item.root, 'alias-state'), sourceId: 'alias-source', projectRoot: alias,
        approvalFile: item.approvalFile, projectName: 'fixture-project' }), /^invalid_config$/);
      assert.equal(fs.existsSync(path.join(item.root, 'alias-state')), false);
      configure(item, config => { config.projects[0].root = alias; config.projects[0].configPath = path.join(alias, '.chatgpt-project-bridge.json'); }, false);
      expectError(() => readPublisherConfig(item.configPath), /^unsafe_path$/);
    }
  });

  await test('CLI hook ignores unregistered cwd and transcript fields, throttles Stop, and reports failures', async () => {
    const item = makeFixture();
    approve(item);
    const outside = await hook(item, 'SessionEnd', temporaryRoot);
    assert.equal(outside.code, 0);
    assert.equal(outside.stdout, '');
    assert.equal(fs.existsSync(path.join(item.stateDir, 'latest.snapshot.json')), false);
    const valid = await hook(item, 'SessionEnd', item.root, {
      transcript_path: path.join(item.root, '.claude', 'transcript.jsonl'),
      last_assistant_message: 'DO-NOT-COLLECT-LAST-RESPONSE', prompt: 'DO-NOT-COLLECT-PROMPT',
    });
    assert.equal(valid.code, 0);
    assert.equal(valid.stdout, '');
    assert.equal(valid.stderr, '');
    const snapshotPath = path.join(item.stateDir, 'latest.snapshot.json');
    const before = fs.readFileSync(snapshotPath);
    assert.doesNotMatch(before.toString(), /DO-NOT-COLLECT/);
    fs.appendFileSync(path.join(item.root, 'CHATGPT_PROJECT_STATUS.md'), '\nA new fixture update\n');
    assert.equal((await hook(item, 'Stop')).code, 0);
    assert.ok(fs.readFileSync(snapshotPath).equals(before));
    // SessionEnd は 30 秒以内の収集を再収集しない。古い収集として扱わせてから確認する。
    ageCapture(item);
    assert.equal((await hook(item, 'SessionEnd')).code, 0);
    assert.equal(fs.readFileSync(snapshotPath).equals(before), false);
    const invalid = await hook(item, 'UnsupportedEvent');
    assert.equal(invalid.code, 0);
    assert.match(invalid.stderr, /invalid_hook_input/);
    assert.equal(publisherStatus(item.configPath).lastErrorCode, 'invalid_hook_input');
  });

  await test('Hook ignores unregistered cwd before approval and records no failure; approval precedes collection', async () => {
    const item = makeFixture();
    const outside = await hook(item, 'SessionEnd', temporaryRoot);
    assert.equal(outside.code, 0);
    assert.equal(outside.stdout, '');
    assert.equal(outside.stderr, '');
    assert.equal(fs.existsSync(statePath(item)), false);
    assert.equal(fs.existsSync(path.join(item.stateDir, 'latest.snapshot.json')), false);
    // 登録済みの cwd でも未承認なら、収集・保存はせず固定コードだけを残す。
    const registered = await hook(item, 'SessionEnd');
    assert.equal(registered.code, 0);
    assert.match(registered.stderr, /not_approved/);
    assert.equal(fs.existsSync(path.join(item.stateDir, 'latest.snapshot.json')), false);
  });

  await test('SessionStart skips clear/compact/fork and collects for startup/resume/unknown sources', async () => {
    for (const source of ['clear', 'compact', 'fork']) {
      const item = makeFixture();
      approve(item);
      const skipped = await hook(item, 'SessionStart', item.root, { source });
      assert.equal(skipped.code, 0);
      assert.equal(skipped.stdout, '');
      assert.equal(skipped.stderr, '');
      assert.equal(fs.existsSync(path.join(item.stateDir, 'latest.snapshot.json')), false, source);
      assert.equal(fs.existsSync(statePath(item)), false, source);
    }
    for (const source of ['startup', 'resume', 'not-a-source', 42, null, undefined]) {
      const item = makeFixture();
      approve(item);
      const started = await hook(item, 'SessionStart', item.root, source === undefined ? {} : { source });
      assert.equal(started.code, 0);
      assert.equal(started.stdout, '');
      assert.equal(started.stderr, '');
      assert.equal(fs.existsSync(path.join(item.stateDir, 'latest.snapshot.json')), true, String(source));
    }
  });

  await test('SessionEnd skips a capture made within 30 seconds and collects an older one', async () => {
    const item = makeFixture();
    approve(item);
    const snapshotPath = path.join(item.stateDir, 'latest.snapshot.json');
    assert.equal((await hook(item, 'SessionEnd', item.root, { reason: 'other' })).code, 0);
    const first = fs.readFileSync(snapshotPath);
    fs.appendFileSync(path.join(item.root, 'CHATGPT_PROJECT_STATUS.md'), '\nSecond fixture update\n');
    const recent = await hook(item, 'SessionEnd', item.root, { reason: 'clear' });
    assert.equal(recent.code, 0);
    assert.equal(recent.stderr, '');
    assert.ok(fs.readFileSync(snapshotPath).equals(first));
    ageCapture(item, 31);
    assert.equal((await hook(item, 'SessionEnd', item.root, { reason: 'prompt_input_exit' })).code, 0);
    assert.equal(fs.readFileSync(snapshotPath).equals(first), false);
  });

  await test('Stop does not retry a failing capture while lastAttemptAt is recent', async () => {
    const item = makeFixture();
    approve(item);
    const snapshotPath = path.join(item.stateDir, 'latest.snapshot.json');
    const lastAttemptAt = new Date(Date.now() - 5000).toISOString();
    seedState(item, { capturedAt: new Date(Date.now() - 3600000).toISOString(), lastAttemptAt,
      lastErrorCode: 'capture_failed' });
    const suppressed = await hook(item, 'Stop');
    assert.equal(suppressed.code, 0);
    assert.equal(suppressed.stderr, '');
    assert.equal(fs.existsSync(snapshotPath), false);
    assert.equal(readPrivateJson(statePath(item)).lastAttemptAt, lastAttemptAt);
    // 失敗からも checkpointSeconds（既定 300 秒）を過ぎれば再試行する。
    seedState(item, { capturedAt: new Date(Date.now() - 3600000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 3600000).toISOString(), lastErrorCode: 'capture_failed' });
    assert.equal((await hook(item, 'Stop')).code, 0);
    assert.equal(fs.existsSync(snapshotPath), true);
  });

  await test('Hook backs off sending after a recent network failure, but manual run does not', async () => {
    const item = makeFixture();
    configureUnreachableRemote(item);
    const snapshotPath = path.join(item.stateDir, 'latest.snapshot.json');
    const old = new Date(Date.now() - 3600000).toISOString();
    for (const code of ['network_timeout', 'network_error', 'http_rejected', 'invalid_receipt']) {
      const lastAttemptAt = new Date(Date.now() - 20000).toISOString();
      fs.rmSync(snapshotPath, { force: true });
      seedState(item, { capturedAt: old, lastAttemptAt, lastErrorCode: code, pending: true });
      const started = Date.now();
      const backedOff = await hook(item, 'SessionEnd');
      assert.equal(backedOff.code, 0);
      assert.equal(backedOff.stderr, '', code);
      assert.ok(Date.now() - started < 9000);
      assert.equal(fs.existsSync(snapshotPath), true, code);
      const state = readPrivateJson(statePath(item));
      assert.notEqual(state.capturedAt, old, code);
      // 送信を試みていれば lastErrorCode は network_error に、lastAttemptAt は新しくなる。
      assert.equal(state.lastErrorCode, code);
      assert.equal(state.lastAttemptAt, lastAttemptAt);
      assert.equal(state.pending, true);
    }
    // 600 秒より古い失敗、または通信以外の失敗ではバックオフしない。
    for (const [code, ageSeconds] of [['network_timeout', 700], ['capture_failed', 20]]) {
      const lastAttemptAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
      seedState(item, { capturedAt: old, lastAttemptAt, lastErrorCode: code, pending: true });
      const attempted = await hook(item, 'SessionEnd');
      assert.equal(attempted.code, 0);
      assert.match(attempted.stderr, /network_error/, code);
      const state = readPrivateJson(statePath(item));
      assert.equal(state.lastErrorCode, 'network_error', code);
      assert.notEqual(state.lastAttemptAt, lastAttemptAt, code);
    }
    // 手動の run には適用しない。
    const recentAttempt = new Date(Date.now() - 20000).toISOString();
    seedState(item, { capturedAt: old, lastAttemptAt: recentAttempt, lastErrorCode: 'network_timeout', pending: true });
    const manual = await childProcess(cliPath, ['run', '--config', item.configPath]);
    assert.equal(manual.code, 1);
    assert.match(manual.stderr, /network_error/);
    const state = readPrivateJson(statePath(item));
    assert.equal(state.lastErrorCode, 'network_error');
    assert.notEqual(state.lastAttemptAt, recentAttempt);
  });

  await test('Publisher lock: dead-PID locks recover after 20 seconds, live-PID locks stay busy', async () => {
    const item = makeFixture();
    const lockFile = path.join(item.stateDir, 'publisher.lock');
    const deadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    const writeLock = (pid, ageSeconds) => {
      fs.writeFileSync(lockFile, JSON.stringify({ pid, createdAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
        lockId: 'a'.repeat(32) }), { mode: 0o600 });
      fs.chmodSync(lockFile, 0o600);
    };
    writeLock(deadPid, 10);
    await expectRejection(() => withPublisherLock(item.configPath, async () => 'unreachable'), /^busy$/);
    assert.equal(fs.existsSync(lockFile), true);
    writeLock(deadPid, 60);
    assert.equal(await withPublisherLock(item.configPath, async () => 'recovered'), 'recovered');
    assert.equal(fs.existsSync(lockFile), false);
    writeLock(process.pid, 3600);
    await expectRejection(() => withPublisherLock(item.configPath, async () => 'unreachable'), /^busy$/);
    assert.equal(fs.existsSync(lockFile), true);
    // busy は状態ファイルを書かない。
    assert.equal(fs.existsSync(statePath(item)), false);
  });

  if (process.platform === 'win32') {
    process.stdout.write('SKIP symlinked CLI entry point: creating symlinks needs elevated rights on Windows.\n');
  } else {
    await test('CLI starts when invoked through a symlink', async () => {
      const link = path.join(temporaryRoot, 'linked-offline-bridge.mjs');
      fs.symlinkSync(cliPath, link);
      const result = await childProcess(link, ['help']);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /ChatGPT Project Bridge/);
    });
  }

  if (process.platform === 'win32') {
    process.stdout.write('SKIP TLS relay integration: relay intentionally requires POSIX permissions.\n');
  } else {
    const tls = certificate();
    await test('Real TLS receipt and stdio MCP remain usable when the source project is offline; DELETE revokes', async () => {
      const item = makeFixture();
      const sourceId = readPublisherConfig(item.configPath).sourceId;
      const relay = initRelay(path.join(item.base, 'relay-state'), sourceId);
      const server = createIngestServer(relay.configFile, { tlsCert: tls.cert, tlsKey: tls.key });
      const port = await listen(server);
      configure(item, config => {
        config.endpoint = 'https://127.0.0.1:' + port + '/v1/snapshots/' + sourceId;
        config.tokenFile = relay.writerTokenFile; config.caFile = tls.cert;
      });
      const snapshot = save(item);
      const receipt = await synchronizeSnapshot(item.configPath);
      assert.equal(receipt.sent, true);
      assert.equal(receipt.sha256, sha256(readPrivateFile(path.join(item.stateDir, 'latest.snapshot.json'))));
      assert.equal(publisherStatus(item.configPath).currentSnapshotSynced, true);
      const projectKey = sourceId + '::fixture-project';
      const online = await mcp(relay.configFile, 'get_project_context', { project: projectKey });
      assert.equal(online.isError, false);
      assert.match(online.value.text, /CONTEXT-V1/);
      assert.equal(online.value.liveVerified, false);
      assert.equal(online.value.sourceMode, 'snapshot');
      assert.equal(online.value.capturedAt, snapshot.capturedAt);
      assert.equal(online.value.receivedAt, receipt.receivedAt);
      fs.renameSync(item.root, item.root + '-powered-off');
      const offline = await mcp(relay.configFile, 'get_project_context', { project: projectKey });
      assert.equal(offline.isError, false);
      assert.equal(offline.value.text, online.value.text);
      assert.equal(offline.value.capturedAt, online.value.capturedAt);
      const search = runSnapshotTool(loadRelayConfig(relay.configFile), 'search', { query: 'CONTEXT-V1' });
      assert.equal(search.results.length, 1);
      const fetched = await mcp(relay.configFile, 'fetch', { id: search.results[0].id });
      assert.equal(fetched.value.text, online.value.text);
      const cancelled = await revokeRemote(item.configPath);
      assert.equal(cancelled.revoked, true);
      const revoked = await mcp(relay.configFile, 'get_project_context', { project: projectKey });
      assert.equal(revoked.isError, true);
      const status = runSnapshotTool(loadRelayConfig(relay.configFile), 'get_snapshot_status', { sourceId });
      assert.equal(status.sources[0].state, 'deleted');
      assert.equal(status.projects.length, 0);
      assert.equal(publisherStatus(item.configPath).currentSnapshotSynced, false);
      await close(server);
    });

    await test('TLS verification, redirect refusal, bad hash receipts, and failed sends preserve pending state', async () => {
      const item = makeFixture();
      const sourceId = readPublisherConfig(item.configPath).sourceId;
      const tokenFile = path.join(item.stateDir, 'writer.token');
      fs.writeFileSync(tokenFile, 'B'.repeat(64) + '\n', { mode: 0o600 });
      let mode = 'redirect';
      let unexpectedRequests = 0;
      const server = https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, (request, response) => {
        request.resume();
        if (request.url === '/redirected') unexpectedRequests += 1;
        if (mode === 'redirect') { response.writeHead(302, { Location: 'https://127.0.0.1:' + server.address().port + '/redirected' }); response.end(); }
        else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, sourceId,
          sha256: '0'.repeat(64), capturedAt: readPrivateJson(path.join(item.stateDir, 'latest.snapshot.json')).capturedAt,
          receivedAt: new Date().toISOString() })); }
      });
      const port = await listen(server);
      configure(item, config => { config.endpoint = 'https://127.0.0.1:' + port + '/v1/snapshots/' + sourceId;
        config.tokenFile = tokenFile; config.caFile = tls.cert; });
      save(item);
      const bytes = readPrivateFile(path.join(item.stateDir, 'latest.snapshot.json'));
      const config = readPublisherConfig(item.configPath);
      await expectRejection(() => sendSnapshot({ ...config, caFile: null }, bytes), /^network_error$/);
      await expectRejection(() => synchronizeSnapshot(item.configPath), /^http_rejected$/);
      assert.equal(unexpectedRequests, 0);
      assert.equal(publisherStatus(item.configPath).currentSnapshotSynced, false);
      mode = 'bad-receipt';
      await expectRejection(() => synchronizeSnapshot(item.configPath), /^invalid_receipt$/);
      assert.equal(publisherStatus(item.configPath).pending, true);
      assert.equal(publisherStatus(item.configPath).lastSuccessAt, null);
      await close(server);
      const failed = await childProcess(cliPath, ['sync', '--config', item.configPath]);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /network_error/);
      const status = publisherStatus(item.configPath);
      assert.equal(status.pending, true);
      assert.equal(status.currentSnapshotSynced, false);
      assert.equal(status.lastErrorCode, 'network_error');
      assert.ok(readPrivateFile(path.join(item.stateDir, 'latest.snapshot.json')).equals(bytes));
    });
  }
  process.stdout.write('snapshot-publisher-selftest: ' + passedCount + ' tests passed. Claude runtime hook dispatch and Windows ACLs remain unverified.\n');
} finally {
  await Promise.all(servers.map(close));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
