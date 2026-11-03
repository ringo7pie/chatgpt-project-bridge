#!/usr/bin/env node
// Local-only tests. No external endpoint, account, startup setting, or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, atomicWritePrivate, readPrivateJson, MAX_SNAPSHOT_BYTES } from './snapshot-common.mjs';
import {
  initRelay, loadRelayConfig, acceptSnapshot, readSourceRecord, revokeSource,
  pruneSnapshots, createIngestServer, runSnapshotTool, handleMcpRequest,
} from './snapshot-relay.mjs';

if (process.platform === 'win32') {
  process.stdout.write('SKIP snapshot relay: POSIX permissions are required.\n');
  process.exit(0);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-relay-selftest-'));
fs.chmodSync(temporary, 0o700);
const relayScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshot-relay.mjs');
let checks = 0;
let server;
const check = (message, operation) => { operation(); checks += 1; process.stdout.write('PASS ' + message + '\n'); };
const checkAsync = async (message, operation) => { await operation(); checks += 1; process.stdout.write('PASS ' + message + '\n'); };
const timestamp = milliseconds => new Date(milliseconds).toISOString();

function fixture(sourceId = 'desktop', capturedTime = Date.now() - 10000, text = '# Overview\nProject Alpha\n') {
  const capturedAt = timestamp(capturedTime);
  const statusText = '# Status\n## Issues\n- Repair the renderer\n## Done\n- Initial setup\n';
  const document = (documentPath, title, body) => ({ id: documentPath, path: documentPath, title, modified: capturedAt, text: body, sha256: sha256(body), truncated: false });
  return {
    schemaVersion: 1, kind: 'chatgpt-project-bridge-snapshot', sourceId,
    capturedAt, expiresAt: timestamp(capturedTime + 7 * 86400000),
    projects: [{
      name: 'Alpha', projectName: 'Project Alpha', capturedAt, exposureSha256: 'a'.repeat(64),
      contextFile: 'CONTEXT.md', statusFile: 'STATUS.md',
      documents: [document('CONTEXT.md', 'Overview', text), document('STATUS.md', 'Status', statusText)],
      git: { collectedAt: capturedAt, isGitRepository: true, branch: 'main', head: 'b'.repeat(40), aheadBehindOriginMain: '0\t0', worktree: { modified: 1, added: 0, deleted: 0, untracked: 0, other: 0 }, hidden: ['changedPaths', 'commitSubjects'], recentCommits: ['abc first', 'def second'] },
    }],
    unavailable: [],
  };
}
const bytesOf = snapshot => Buffer.from(JSON.stringify(snapshot));
function request(port, { method = 'PUT', sourceId = 'desktop', token, body, headers = {}, pathname, write = true }) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }), ...(method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }), ...headers };
    const outgoing = http.request({ host: '127.0.0.1', port, path: pathname ?? '/v1/snapshots/' + sourceId, method, headers: requestHeaders, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('selftest timeout')));
    if (write) outgoing.end(body);
    else outgoing.flushHeaders();
  });
}

try {
  const initialized = initRelay(path.join(temporary, 'state'), 'desktop');
  const configFile = initialized.configFile;
  let config = loadRelayConfig(configFile);
  const token = fs.readFileSync(initialized.writerTokenFile, 'utf8').trim();
  check('init writes private files and never returns the token', () => {
    assert.equal(fs.statSync(config.stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(initialized.writerTokenFile).mode & 0o777, 0o600);
    assert.match(token, /^[A-Za-z0-9_-]{64}$/);
    assert(!JSON.stringify(initialized).includes(token));
    assert.throws(() => initRelay(config.stateDir, 'desktop'));
    assert.throws(() => initRelay(config.stateDir, '../escape'));
  });
  check('missing snapshots return honest status without projects', () => {
    const result = runSnapshotTool(config, 'list_projects');
    assert.deepEqual(result.projects, []);
    assert.equal(result.sources[0].state, 'missing');
    assert.equal(result.liveVerified, false);
  });
  const initialSnapshot = fixture();
  const initialBytes = bytesOf(initialSnapshot);
  const initialAck = acceptSnapshot(config, 'desktop', initialBytes);
  check('accepted raw bytes have an exact SHA-256 receipt and round trip', () => {
    assert.equal(initialAck.sha256, sha256(initialBytes));
    assert.equal(initialAck.capturedAt, initialSnapshot.capturedAt);
    assert.deepEqual(readSourceRecord(config, 'desktop').snapshot, initialSnapshot);
    assert.deepEqual(acceptSnapshot(config, 'desktop', initialBytes), initialAck);
  });
  check('invalid, oversized, source-swapped, stale and replayed data preserve old state', () => {
    const invalid = structuredClone(initialSnapshot);
    invalid.projects[0].documents[0].text = 'tampered without a matching digest';
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(invalid)));
    assert.throws(() => acceptSnapshot(config, 'desktop', Buffer.alloc(MAX_SNAPSHOT_BYTES + 1)));
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(fixture('other'))));
    assert.throws(() => acceptSnapshot(config, 'desktop', Buffer.from('{"schemaVersion":1,"extra":true}')));
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(fixture('desktop', Date.now() - 2 * 86400000))));
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(fixture('desktop', Date.parse(initialSnapshot.capturedAt) - 1))));
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(fixture('desktop', Date.parse(initialSnapshot.capturedAt), '# Different bytes\n'))));
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(fixture('desktop', Date.now() + 180001))));
    const expired = fixture('desktop', Date.now() - 2 * 86400000);
    expired.expiresAt = timestamp(Date.now() - 86400000);
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(expired)));
    assert.equal(readSourceRecord(config, 'desktop').sha256, initialAck.sha256);
  });
  check('snapshot MCP keeps identity, timestamps and saved Git separate from live state', () => {
    const listed = runSnapshotTool(config, 'list_projects');
    assert.equal(listed.projects[0].project, 'desktop::Alpha');
    const context = runSnapshotTool(config, 'get_project_context', { project: 'desktop::Alpha' });
    assert.equal(context.capturedAt, initialSnapshot.capturedAt);
    assert.equal(context.receivedAt, initialAck.receivedAt);
    assert.equal(context.sourceMode, 'snapshot');
    assert.equal(context.liveVerified, false);
    assert.equal(context.stale, false);
    const status = runSnapshotTool(config, 'get_project_status', { project: 'desktop::Alpha' });
    assert.deepEqual(status.savedGit, initialSnapshot.projects[0].git);
    assert.equal(status.liveGit, undefined);
    assert.equal(runSnapshotTool(config, 'get_recent_changes', { project: 'desktop::Alpha', limit: 1 }).savedGit.recentCommits.length, 1);
    assert.equal(runSnapshotTool(config, 'get_recent_changes', { project: 'desktop::Alpha', days: 365 }).daysFilterApplied, false);
    assert.match(runSnapshotTool(config, 'get_project_issues', { project: 'desktop::Alpha' }).sections[0], /Repair/);
    assert.equal(runSnapshotTool(config, 'list_documents', { project: 'desktop::Alpha' }).items[0].text, undefined);
    const search = runSnapshotTool(config, 'search', { query: 'Alpha' });
    assert.equal(search.results[0].id, 'desktop::Alpha::CONTEXT.md');
    assert.equal(runSnapshotTool(config, 'fetch', { id: search.results[0].id }).text, context.text);
    assert.throws(() => runSnapshotTool(config, 'get_document', { project: 'desktop::Alpha', path: '../../relay.json' }));
    assert.throws(() => runSnapshotTool(config, 'get_project_context', { project: 'Alpha' }));
    assert.throws(() => runSnapshotTool(config, 'search', { query: 'Alpha', injected: 'command' }));
  });
  check('MCP initialization and errors do not disclose paths, tokens or unchecked input', () => {
    const initializedRpc = handleMcpRequest(configFile, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(initializedRpc.result.protocolVersion, '2025-06-18');
    assert.match(initializedRpc.result.instructions, /外部由来/);
    const tools = handleMcpRequest(configFile, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(tools.result.tools.length, 10);
    assert(tools.result.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    const denied = handleMcpRequest(configFile, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch', arguments: { id: configFile + token } } });
    assert.equal(denied.result.isError, true);
    assert(!JSON.stringify(denied).includes(configFile));
    assert(!JSON.stringify(denied).includes(token));
  });
  check('DELETE clears documents and retains a replay watermark', () => {
    const revoked = revokeSource(config, 'desktop');
    assert.equal(revoked.receivedAt, revoked.revokedAt);
    assert.equal(readSourceRecord(config, 'desktop').kind, 'tombstone');
    assert.deepEqual(runSnapshotTool(config, 'list_projects').projects, []);
    assert.throws(() => acceptSnapshot(config, 'desktop', initialBytes));
    assert(!fs.readFileSync(path.join(config.dataDir, 'desktop.json'), 'utf8').includes('raw'));
  });
  const replacement = fixture('desktop', Date.now() + 1000, '# Replacement\nProject Alpha\n');
  acceptSnapshot(config, 'desktop', bytesOf(replacement));
  check('a full empty replacement removes all previously published projects', () => {
    const empty = fixture('desktop', Date.parse(replacement.capturedAt) + 1);
    empty.projects = [];
    empty.unavailable = [{ name: 'Alpha', code: 'unapproved' }];
    acceptSnapshot(config, 'desktop', bytesOf(empty));
    const listed = runSnapshotTool(config, 'list_projects');
    assert.deepEqual(listed.projects, []);
    assert.equal(listed.unavailable[0].code, 'unapproved');
    assert.throws(() => runSnapshotTool(config, 'get_project_context', { project: 'desktop::Alpha' }));
  });
  initRelay(config.stateDir, 'expired');
  config = loadRelayConfig(configFile);
  const pastTime = Date.now() - 2 * 86400000;
  const past = fixture('expired', pastTime);
  past.expiresAt = timestamp(pastTime + 86400000);
  acceptSnapshot(config, 'expired', bytesOf(past), pastTime + 1000);
  check('expiry blocks reads before physical pruning and prevents replay after pruning', () => {
    assert.equal(runSnapshotTool(config, 'get_snapshot_status', { sourceId: 'expired' }).sources[0].state, 'expired');
    assert.throws(() => runSnapshotTool(config, 'get_project_context', { project: 'expired::Alpha' }));
    assert.equal(pruneSnapshots(config).pruned, 1);
    assert.equal(readSourceRecord(config, 'expired').kind, 'tombstone');
    assert.throws(() => acceptSnapshot(config, 'expired', bytesOf(past)));
  });
  check('owner-only config, token hardlinks and symlinked state fail closed', () => {
    fs.chmodSync(configFile, 0o644);
    assert.throws(() => loadRelayConfig(configFile));
    fs.chmodSync(configFile, 0o600);
    const original = path.join(config.dataDir, 'desktop.json');
    const saved = original + '.saved';
    const sentinel = path.join(temporary, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'do not overwrite', { mode: 0o600 });
    fs.renameSync(original, saved);
    fs.symlinkSync(sentinel, original);
    assert.throws(() => acceptSnapshot(config, 'desktop', bytesOf(fixture('desktop', Date.now() + 2000))));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not overwrite');
    fs.unlinkSync(original);
    fs.renameSync(saved, original);
    const lock = path.join(config.dataDir, 'desktop.lock');
    fs.symlinkSync(sentinel, lock);
    assert.throws(() => revokeSource(config, 'desktop'));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not overwrite');
    fs.unlinkSync(lock);
  });
  const diskConfig = readPrivateJson(configFile);
  diskConfig.maxSnapshotBytes = 4096;
  atomicWritePrivate(configFile, JSON.stringify(diskConfig));
  config = loadRelayConfig(configFile);
  check('public plain HTTP is forbidden and TLS requires both key and certificate', () => {
    const publicConfig = { ...diskConfig, listen: { host: '0.0.0.0', port: 8787 } };
    atomicWritePrivate(configFile, JSON.stringify(publicConfig));
    assert.throws(() => createIngestServer(configFile), /public_http_forbidden/);
    atomicWritePrivate(configFile, JSON.stringify(diskConfig));
    assert.throws(() => createIngestServer(configFile, { tlsCert: '/no/such/cert' }), /tls_pair_required/);
  });
  server = createIngestServer(configFile);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await checkAsync('HTTP authenticates and scopes writer keys before reading a request body', async () => {
    const noAuth = await request(port, { headers: { 'Content-Length': '100' }, write: false });
    assert.equal(noAuth.status, 401);
    const unknown = await request(port, { sourceId: 'unknown', token, headers: { 'Content-Length': '100' }, write: false });
    const bad = await request(port, { token: 'z'.repeat(64), headers: { 'Content-Length': '100' }, write: false });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, bad.body);
    const crossSource = await request(port, { sourceId: 'expired', token, body: bytesOf(fixture('expired')) });
    assert.equal(crossSource.status, 401);
    assert.equal(noAuth.headers['cache-control'], 'no-store, max-age=0');
    assert.equal(noAuth.headers['x-content-type-options'], 'nosniff');
    assert.equal(noAuth.headers['access-control-allow-origin'], undefined);
    let continued = false;
    const refused = await new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/v1/snapshots/desktop', headers: { Authorization: 'Bearer ' + 'z'.repeat(64), 'Content-Type': 'application/json', 'Content-Length': '100', Expect: '100-continue' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      outgoing.on('continue', () => { continued = true; });
      outgoing.on('error', reject);
      outgoing.flushHeaders();
    });
    assert.equal(refused, 401);
    assert.equal(continued, false);
  });
  await checkAsync('HTTP rejects browsers, arbitrary retrieval, encoding changes and oversized bodies', async () => {
    assert.equal((await request(port, { token, headers: { Origin: 'https://evil.invalid' }, body: initialBytes })).status, 403);
    assert.equal((await request(port, { token, method: 'GET' })).status, 404);
    assert.equal((await request(port, { token, pathname: '/v1/snapshots/desktop?token=ignored', body: initialBytes })).status, 404);
    assert.equal((await request(port, { token, headers: { 'Content-Encoding': 'gzip' }, body: initialBytes })).status, 415);
    assert.equal((await request(port, { token, headers: { 'Content-Type': 'text/plain' }, body: initialBytes })).status, 415);
    assert.equal((await request(port, { token, headers: { 'Content-Length': '4097' }, write: false })).status, 413);
    assert.equal((await request(port, { token, headers: { 'Transfer-Encoding': 'chunked' }, body: Buffer.alloc(4097) })).status, 413);
  });
  await checkAsync('HTTP upload verifies raw bytes, rejects replay and acknowledges idempotent retries', async () => {
    const fresh = fixture('desktop', Date.now() + 3000);
    const freshBytes = bytesOf(fresh);
    const accepted = await request(port, { token, body: freshBytes });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.sha256, sha256(freshBytes));
    assert.deepEqual((await request(port, { token, body: freshBytes })).body, accepted.body);
    assert.equal((await request(port, { token, body: initialBytes })).status, 409);
    assert.equal((await request(port, { token, body: Buffer.from([0xff, 0xfe, 0x00]) })).status, 400);
    assert.equal(readSourceRecord(loadRelayConfig(configFile), 'desktop').sha256, accepted.body.sha256);
  });
  await checkAsync('token rotation during an upload cancels storage at commit time', async () => {
    const bytes = bytesOf(fixture('desktop', Date.now() + 4000));
    const originalDigest = readSourceRecord(loadRelayConfig(configFile), 'desktop').sha256;
    const status = await new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/v1/snapshots/desktop', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': bytes.length, Expect: '100-continue' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      outgoing.on('continue', () => {
        atomicWritePrivate(initialized.writerTokenFile, 'q'.repeat(64) + '\n');
        outgoing.end(bytes);
      });
      outgoing.on('error', reject);
      outgoing.flushHeaders();
    });
    assert.equal(status, 401);
    assert.equal(readSourceRecord(loadRelayConfig(configFile), 'desktop').sha256, originalDigest);
    atomicWritePrivate(initialized.writerTokenFile, token + '\n');
  });
  await checkAsync('hardlinked writer credentials fail authentication without leaking details', async () => {
    const alias = path.join(config.tokenDir, 'alias.token');
    fs.linkSync(initialized.writerTokenFile, alias);
    try { assert.equal((await request(port, { token, body: initialBytes })).status, 401); }
    finally { fs.unlinkSync(alias); }
  });
  await checkAsync('HTTP DELETE is source scoped and returns a receipt without exposing content', async () => {
    const deleted = await request(port, { method: 'DELETE', token });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.sourceId, 'desktop');
    assert.equal(deleted.body.receivedAt, deleted.body.revokedAt);
    assert.deepEqual(runSnapshotTool(loadRelayConfig(configFile), 'list_projects').projects, []);
  });
  check('stdio MCP emits only JSON-RPC and limits unterminated input', () => {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    const child = spawnSync(process.execPath, [relayScript, 'mcp', '--config', configFile], { input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3]);
    assert.equal(replies[2].result.isError, false);
    assert(!child.stdout.includes(token));
  });
  const runMcpChild = input => spawnSync(process.execPath, [relayScript, 'mcp', '--config', configFile], { input, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  const parseReplies = output => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const pingLine = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n';
  check('stdio MCP answers an oversized line with one fixed error and keeps running', () => {
    const child = runMcpChild('x'.repeat(65537) + '\n' + pingLine(7));
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const replies = parseReplies(child.stdout);
    assert.equal(replies.length, 2);
    assert.equal(replies[0].id, null);
    assert.equal(replies[0].error.code, -32600);
    assert(!child.stdout.includes('xxxxxxxx'));
    assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 7, result: {} });
    // 改行が来ないまま複数chunkにまたがる入力も、1回だけのエラーで読み捨てて続行する。
    const long = runMcpChild('x'.repeat(300000) + '\n' + pingLine(8));
    assert.equal(long.status, 0, long.stderr);
    const longReplies = parseReplies(long.stdout);
    assert.deepEqual(longReplies.map(reply => reply.id), [null, 8]);
    // 改行なしのまま入力が終わっても、プロセスは正常終了する。
    const unterminated = runMcpChild('x'.repeat(70000));
    assert.equal(unterminated.status, 0, unterminated.stderr);
    assert.equal(parseReplies(unterminated.stdout).length, 1);
  });
  check('stdio MCP rejects requests over the queue limit with an id-bearing error', () => {
    let input = '';
    for (let index = 1; index <= 400; index += 1) input += pingLine(index);
    const child = runMcpChild(input);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const replies = parseReplies(child.stdout);
    assert.deepEqual(replies.map(reply => reply.id).sort((left, right) => left - right), Array.from({ length: 400 }, (_, index) => index + 1));
    const rejected = replies.filter(reply => reply.error);
    assert(rejected.length > 0);
    assert(rejected.every(reply => reply.error.code === -32000 && reply.error.message === 'server busy'));
    assert(replies.some(reply => reply.result));
  });
  check('relay entry point also works through a symlinked script path', () => {
    const linkDirectory = path.join(temporary, 'link');
    fs.mkdirSync(linkDirectory);
    const linkedScript = path.join(linkDirectory, 'relay.mjs');
    fs.symlinkSync(relayScript, linkedScript);
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n';
    const child = spawnSync(process.execPath, [linkedScript, 'mcp', '--config', configFile], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(parseReplies(child.stdout)[0].id, 1);
    const unknown = spawnSync(process.execPath, [linkedScript, 'bogus'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /usage_init_serve_mcp_prune/);
  });
  check('prune removes data from a removed source but keeps its watermark', () => {
    const future = fixture('expired', Date.now() + 1000);
    acceptSnapshot(loadRelayConfig(configFile), 'expired', bytesOf(future));
    const disk = readPrivateJson(configFile);
    disk.sources = disk.sources.filter(source => source.sourceId !== 'expired');
    atomicWritePrivate(configFile, JSON.stringify(disk));
    const newConfig = loadRelayConfig(configFile);
    assert.equal(pruneSnapshots(newConfig).pruned, 1);
    assert.equal(readSourceRecord(newConfig, 'expired').reason, 'source_removed');
  });
  check('prune removes only old private orphan temporaries and preserves recent files', () => {
    const older = path.join(config.dataDir, '.snapshot-tmp-' + 'a'.repeat(32));
    const recent = path.join(config.dataDir, '.snapshot-tmp-' + 'b'.repeat(32));
    const unknown = path.join(config.dataDir, 'not-a-bridge-temporary');
    fs.writeFileSync(older, 'old unfinished write', { mode: 0o600 });
    fs.writeFileSync(recent, 'new write', { mode: 0o600 });
    fs.writeFileSync(unknown, 'do not delete', { mode: 0o600 });
    const oldTime = new Date(Date.now() - 2 * 3600000);
    fs.utimesSync(older, oldTime, oldTime);
    assert.equal(pruneSnapshots(loadRelayConfig(configFile)).orphanedTemporariesRemoved, 1);
    assert.equal(fs.existsSync(older), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(unknown), true);
  });
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const addSource = sourceId => {
    const added = initRelay(config.stateDir, sourceId);
    return { config: loadRelayConfig(configFile), token: fs.readFileSync(added.writerTokenFile, 'utf8').trim() };
  };
  const conflictCode = { code: 'snapshot_conflict' };
  check('expiry prune keeps the accepted capturedAt as watermark even when the receiver clock runs ahead', () => {
    const { config: clockConfig } = addSource('clock');
    const pastCapture = Date.now() - 3 * 86400000;
    const expiring = fixture('clock', pastCapture);
    expiring.expiresAt = timestamp(pastCapture + 86400000);
    acceptSnapshot(clockConfig, 'clock', bytesOf(expiring), pastCapture + 1000);
    const farFuture = Date.now() + 10 * 86400000;
    pruneSnapshots(clockConfig, farFuture);
    const tombstone = readSourceRecord(clockConfig, 'clock');
    assert.equal(tombstone.kind, 'tombstone');
    assert.equal(tombstone.reason, 'expired');
    assert.equal(tombstone.watermark, expiring.capturedAt);
    assert.equal(tombstone.revokedAt, timestamp(farFuture));
    assert.throws(() => acceptSnapshot(clockConfig, 'clock', bytesOf(fixture('clock', pastCapture - 1000)), pastCapture + 1000), conflictCode);
    const renewed = fixture('clock', Date.now() - 10000, '# Renewed\n');
    assert.equal(acceptSnapshot(clockConfig, 'clock', bytesOf(renewed)).capturedAt, renewed.capturedAt);
    assert.equal(readSourceRecord(clockConfig, 'clock').kind, 'snapshot');
  });
  check('DELETE with a receiver clock ahead still accepts newer snapshots and refuses the revoked one', () => {
    const { config: deleteConfig } = addSource('clockdel');
    const original = fixture('clockdel', Date.now() - 20000);
    acceptSnapshot(deleteConfig, 'clockdel', bytesOf(original));
    const farFuture = Date.now() + 10 * 86400000;
    const revoked = revokeSource(deleteConfig, 'clockdel', farFuture);
    assert.equal(revoked.revokedAt, timestamp(farFuture));
    assert.equal(readSourceRecord(deleteConfig, 'clockdel').watermark, original.capturedAt);
    assert.throws(() => acceptSnapshot(deleteConfig, 'clockdel', bytesOf(original)), conflictCode);
    assert.throws(() => acceptSnapshot(deleteConfig, 'clockdel', bytesOf(fixture('clockdel', Date.now() - 30000))), conflictCode);
    const newer = fixture('clockdel', Date.now() - 10000);
    assert.equal(acceptSnapshot(deleteConfig, 'clockdel', bytesOf(newer)).capturedAt, newer.capturedAt);
  });
  check('an unexpired snapshot is refused by the watermark alone after DELETE, while a newer one is accepted', () => {
    const { config: aloneConfig } = addSource('wmalone');
    const original = fixture('wmalone', Date.now() - 30000);
    acceptSnapshot(aloneConfig, 'wmalone', bytesOf(original));
    revokeSource(aloneConfig, 'wmalone');
    const tombstone = readSourceRecord(aloneConfig, 'wmalone');
    assert.equal(tombstone.watermark, original.capturedAt);
    assert.equal(Date.parse(original.expiresAt) > Date.now(), true);
    assert.throws(() => acceptSnapshot(aloneConfig, 'wmalone', bytesOf(original)), conflictCode);
    assert.throws(() => acceptSnapshot(aloneConfig, 'wmalone', bytesOf(fixture('wmalone', Date.now() - 40000))), conflictCode);
    const newer = fixture('wmalone', Date.parse(original.capturedAt) + 1);
    assert.equal(acceptSnapshot(aloneConfig, 'wmalone', bytesOf(newer)).capturedAt, newer.capturedAt);
  });
  check('DELETE on a source that never received data uses the epoch watermark', () => {
    const { config: neverConfig } = addSource('wmnever');
    revokeSource(neverConfig, 'wmnever');
    assert.equal(readSourceRecord(neverConfig, 'wmnever').watermark, EPOCH);
    assert.equal(acceptSnapshot(neverConfig, 'wmnever', bytesOf(fixture('wmnever', Date.now() - 10000))).ok, true);
  });
  const writeLock = (sourceId, contents, ageSeconds) => {
    const lockFile = path.join(config.dataDir, sourceId + '.lock');
    fs.writeFileSync(lockFile, contents, { mode: 0o600 });
    const aged = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(lockFile, aged, aged);
    return lockFile;
  };
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const lockedCode = { code: 'state_locked' };
  check('stale locks are reclaimed once for PUT and DELETE, live or fresh locks are not stolen', () => {
    const { config: lockConfig } = addSource('locks');
    acceptSnapshot(lockConfig, 'locks', bytesOf(fixture('locks', Date.now() - 20000)));
    // 60秒を超え、PIDが死んでいるlockは回収される。
    const deadLock = writeLock('locks', String(deadPid) + '\n', 120);
    assert.equal(revokeSource(lockConfig, 'locks').ok, true);
    assert.equal(fs.existsSync(deadLock), false);
    assert.equal(readSourceRecord(lockConfig, 'locks').kind, 'tombstone');
    // PIDが書かれていないlockは、60秒超だけで回収される。
    const emptyLock = writeLock('locks', '', 120);
    assert.equal(acceptSnapshot(lockConfig, 'locks', bytesOf(fixture('locks', Date.now() - 15000))).ok, true);
    assert.equal(fs.existsSync(emptyLock), false);
    // 生存プロセスのlockは、古くても奪わない。
    const liveLock = writeLock('locks', String(process.pid) + '\n', 120);
    assert.throws(() => revokeSource(lockConfig, 'locks'), lockedCode);
    assert.throws(() => acceptSnapshot(lockConfig, 'locks', bytesOf(fixture('locks', Date.now() - 10000))), lockedCode);
    assert.equal(fs.existsSync(liveLock), true);
    assert.equal(readSourceRecord(lockConfig, 'locks').kind, 'snapshot');
    fs.unlinkSync(liveLock);
    // 60秒以内のlockは、PIDが死んでいても奪わない。
    const freshLock = writeLock('locks', String(deadPid) + '\n', 1);
    assert.throws(() => revokeSource(lockConfig, 'locks'), lockedCode);
    assert.equal(fs.existsSync(freshLock), true);
    fs.unlinkSync(freshLock);
  });
  await checkAsync('HTTP DELETE succeeds past a stale lock and stays 409 on a live lock', async () => {
    const added = addSource('lockhttp');
    acceptSnapshot(added.config, 'lockhttp', bytesOf(fixture('lockhttp', Date.now() - 20000)));
    const liveLock = writeLock('lockhttp', String(process.pid) + '\n', 300);
    assert.equal((await request(port, { method: 'DELETE', sourceId: 'lockhttp', token: added.token })).status, 409);
    fs.unlinkSync(liveLock);
    writeLock('lockhttp', String(deadPid) + '\n', 300);
    assert.equal((await request(port, { method: 'DELETE', sourceId: 'lockhttp', token: added.token })).status, 200);
    assert.equal(readSourceRecord(added.config, 'lockhttp').kind, 'tombstone');
  });
  check('DELETE replaces a corrupt stored record with a tombstone and later snapshots are accepted', () => {
    const { config: brokenConfig } = addSource('broken');
    const recordFile = path.join(brokenConfig.dataDir, 'broken.json');
    fs.writeFileSync(recordFile, '{ this is not json', { mode: 0o600 });
    assert.throws(() => readSourceRecord(brokenConfig, 'broken'));
    assert.throws(() => acceptSnapshot(brokenConfig, 'broken', bytesOf(fixture('broken', Date.now() - 10000))));
    assert.equal(runSnapshotTool(brokenConfig, 'get_snapshot_status', { sourceId: 'broken' }).sources[0].state, 'unavailable');
    assert.throws(() => runSnapshotTool(brokenConfig, 'get_project_context', { project: 'broken::Alpha' }));
    assert.equal(revokeSource(brokenConfig, 'broken').ok, true);
    const tombstone = readSourceRecord(brokenConfig, 'broken');
    assert.equal(tombstone.kind, 'tombstone');
    assert.equal(tombstone.reason, 'deleted');
    assert.equal(tombstone.watermark, EPOCH);
    assert.equal(acceptSnapshot(brokenConfig, 'broken', bytesOf(fixture('broken', Date.now() - 10000))).ok, true);
  });
  await checkAsync('HTTP DELETE on a schema-invalid stored record returns 200 instead of 503', async () => {
    const added = addSource('broken2');
    fs.writeFileSync(path.join(added.config.dataDir, 'broken2.json'), '{"schemaVersion":1,"kind":"snapshot"}\n', { mode: 0o600 });
    assert.equal((await request(port, { method: 'DELETE', sourceId: 'broken2', token: added.token })).status, 200);
    assert.equal(readSourceRecord(added.config, 'broken2').watermark, EPOCH);
  });
  process.stdout.write('snapshot-relay-selftest: ' + checks + ' checks passed\n');
} finally {
  if (server) {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
