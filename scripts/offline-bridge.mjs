#!/usr/bin/env node
/* Cross-platform offline bridge CLI. No hook or network setup on import. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  initializePublisher, readPublisherConfig, assertPublisherApproval, reviewPublisher, approvePublisher,
  buildSnapshot, storeSnapshot, synchronizeSnapshot, revokeRemote, publisherStatus, recordFailure,
  withPublisherLock, safeErrorCode, withinDirectory, HOOK_SEND_TIMEOUT_MS, MANUAL_SEND_TIMEOUT_MS,
} from './snapshot-publisher.mjs';
import { MAX_SNAPSHOT_BYTES, SnapshotError, isRecord, validateSnapshot } from './snapshot-common.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FLAGS = new Set(['config', 'state-dir', 'source-id', 'hub', 'endpoint', 'token-file',
  'project-root', 'approval-file', 'project-name', 'fingerprint', 'settings', 'managed-by', 'checkpoints']);
const HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd', 'Stop']);
// hook の stdin から読む列挙値。許可リストに無い値は null として扱う。
const SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);
const SESSION_END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit', 'other']);
// 同じ会話の続きや要約で再発火する SessionStart は、新しい情報を持たないため何もしない。
const SESSION_START_SKIPPED_SOURCES = new Set(['clear', 'compact', 'fork']);
// SessionEnd は直近にこの秒数以内の収集があれば再収集しない。
const RECENT_CAPTURE_SECONDS = 30;
// 直前の送信がこれらの通信失敗で終わっていれば、この秒数のあいだ hook からの送信を省く。
const NETWORK_BACKOFF_SECONDS = 600;
const NETWORK_BACKOFF_CODES = new Set(['network_error', 'network_timeout', 'http_rejected', 'invalid_receipt']);
// 固定コードに対応する CLI（hook 以外）向けの対処。hook の経路では表示しない。
const CLI_REMEDIES = {
  unsafe_script_permissions: 'offline-bridge.mjs が group/other から書き込めるか、所有者が別ユーザーです。'
    + 'scripts フォルダーの .mjs に `chmod go-w` を実行して直してください。',
  unsafe_settings_permissions: 'Claude の設定ファイルまたは設定ディレクトリが group/other から書き込めます。'
    + '`chmod go-w` で直してください。',
  invalid_config: '引数または保存設定が不正です。--config は絶対パスで指定し、オプション名と値を確認してください。',
  not_approved: 'review の内容を確認し、approve --fingerprint で承認してください。',
  no_endpoint: '送信先が設定されていません。init の --endpoint と --token-file を指定し、承認し直してください。',
  busy: '別の保存処理が稼働中です。終了後に再実行してください。',
};
const HELP = [
  'ChatGPT Project Bridge 2.4.1 — 終了時保存 / PC停止中の参照',
  '',
  'node scripts/offline-bridge.mjs <action> [options]',
  '',
  'init --state-dir DIR --source-id desktop --hub HUB_JSON',
  '  現在承認済みのhubから保存設定の下書きを作成。外部送信・hook登録・承認は行いません。',
  '  1プロジェクトの場合: --project-root ROOT --approval-file FILE --project-name NAME',
  '  任意: --endpoint https://host/v1/snapshots/desktop --token-file FILE',
  'review --config FILE',
  '  保存対象・送信先・保持期限と、その設定全体のSHA-256を表示。',
  'approve --config FILE --fingerprint SHA256',
  '  reviewの内容を読んだ本人が実行。設定全体が一致した場合だけ保存を承認。',
  'capture --config FILE',
  '  承認済み情報をローカルのlatest.snapshot.jsonとlatest.mdへ保存。',
  'sync --config FILE',
  '  未送信データの承認・完全性を再確認してHTTPS送信。転送先のSHA-256応答を確認。',
  'run --config FILE',
  '  最新情報の保存と送信を連続実行。送信先なしならローカル保存のみ。',
  'status --config FILE',
  '  収集日時、送信日時、期限、未送信と失敗コードを表示。',
  'install-hook --config FILE [--settings FILE] [--checkpoints]',
  '  SessionEnd/SessionStartを追加。--checkpointsで応答完了時も間隔を置いて保存。',
  'uninstall-hook --config FILE [--settings FILE]',
  '  この保存設定に対応するhookだけ削除。他の設定やhookを保持。',
  'hook-status --config FILE [--settings FILE]',
  '  この保存設定に対応するhookの登録状況を表示（読み取り専用。何も書き込みません）。',
  'revoke-remote --config FILE',
  '  このsourceIdの受信側snapshotを削除。まずuninstall-hookで再送信も停止してください。',
  '',
  'PC停止中の取得には、別の稼働ホストでsnapshot-relay.mjsと専用Tunnelが必要です。',
  '終了hookの実行と通信には時間制限があり、強制終了・停電時の送達保証はありません。',
  '会話の意味を自動要約する機能ではありません。文書はClaude Code側で更新してください。',
].join('\n');

function parseArguments(argv) {
  const [action = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--') || !FLAGS.has(argument.slice(2))) throw new SnapshotError('invalid_config');
    const key = argument.slice(2);
    if (Object.hasOwn(options, key)) throw new SnapshotError('invalid_config');
    if (key === 'checkpoints') options[key] = true;
    else {
      const value = rest[++index];
      if (typeof value !== 'string' || value.startsWith('--')) throw new SnapshotError('invalid_config');
      options[key] = value;
    }
  }
  return { action, options };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function captureInWorker(configPath, timeoutMs = 45000) {
  // The child keeps synchronous Git / file operations from defeating the
  // parent's wall-clock deadline. No shell and no untrusted executable path.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, 'worker-capture', '--config', path.resolve(configPath)], {
      cwd: path.dirname(SCRIPT_PATH), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks = [];
    let size = 0;
    let failure = null;
    const timer = setTimeout(() => {
      failure = new SnapshotError('capture_timeout');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SNAPSHOT_BYTES + 1024) {
        failure = new SnapshotError('limit_exceeded');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    // Child errors may contain paths. Never forward stderr or put it in a
    // snapshot. A bounded, fixed status code is enough for the parent.
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new SnapshotError('capture_failed'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) { reject(failure || new SnapshotError('capture_failed')); return; }
      try { resolve(validateSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch { reject(new SnapshotError('capture_failed')); }
    });
  });
}

// ISO 8601 文字列からの経過秒。解釈できない値・未来の値は「ずっと前」（Infinity）として扱う。
function secondsSince(isoText) {
  const time = Date.parse(isoText);
  if (!Number.isFinite(time)) return Infinity;
  const elapsed = (Date.now() - time) / 1000;
  return elapsed < 0 ? Infinity : elapsed;
}

// hook からの送信を省くべきか。直前の状態を見るので、状態を作り直す storeSnapshot より前に呼ぶ。
function inNetworkBackoff(state) {
  return NETWORK_BACKOFF_CODES.has(state.lastErrorCode)
    && secondsSince(state.lastAttemptAt) < NETWORK_BACKOFF_SECONDS;
}

async function captureAndMaybeSend(configPath, { send = false, hook = false } = {}) {
  return withPublisherLock(configPath, async config => {
    assertPublisherApproval(configPath, config);
    const snapshot = await captureInWorker(configPath, hook ? 9000 : 45000);
    // バックオフは hook だけに適用する。手動の run は常に送信を試みる。
    const backoff = Boolean(hook && send && config.endpoint && inNetworkBackoff(publisherStatus(configPath)));
    const state = storeSnapshot(configPath, snapshot, { carryFailure: backoff });
    if (backoff) return { ...state, saved: true, sent: false, remoteConfigured: true, backoff: true };
    if (send && config.endpoint) {
      return { ...state, ...await synchronizeSnapshot(configPath,
        { timeoutMs: hook ? HOOK_SEND_TIMEOUT_MS : MANUAL_SEND_TIMEOUT_MS }) };
    }
    return { ...state, saved: true, sent: false, remoteConfigured: Boolean(config.endpoint) };
  });
}

async function readHookInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      process.stdin.pause();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new SnapshotError('hook_input_timeout')), 1000);
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) { finish(new SnapshotError('invalid_hook_input')); return; }
      chunks.push(chunk);
    });
    process.stdin.on('error', () => finish(new SnapshotError('invalid_hook_input')));
    process.stdin.on('end', () => {
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { finish(new SnapshotError('invalid_hook_input')); return; }
      if (!isRecord(input) || !HOOK_EVENTS.has(input.hook_event_name)
        || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || input.cwd.length > 4096) {
        finish(new SnapshotError('invalid_hook_input')); return;
      }
      // Never open transcript_path or read prompt / assistant-message fields.
      // Only the enumerated source / reason values are read, and only from the allowlist.
      const source = input.hook_event_name === 'SessionStart' && typeof input.source === 'string'
        && SESSION_START_SOURCES.has(input.source) ? input.source : null;
      const reason = input.hook_event_name === 'SessionEnd' && typeof input.reason === 'string'
        && SESSION_END_REASONS.has(input.reason) ? input.reason : null;
      finish(null, { event: input.hook_event_name, cwd: input.cwd, source, reason });
    });
  });
}

async function runHook(options) {
  if (options['managed-by'] !== 'chatgpt-project-bridge-offline-v1') throw new SnapshotError('invalid_hook_input');
  const input = await readHookInput();
  // 順序: 登録済み cwd の判定（承認前・読み取りのみ）→ 抑制規則 → 承認の確認 → 収集・保存・送信。
  // 承認は収集・保存・送信より前に必ず確認する。登録外 cwd では失敗も記録しない。
  const config = readPublisherConfig(options.config);
  let workingDirectory;
  try { workingDirectory = fs.realpathSync(input.cwd); } catch { return; }
  const registered = config.projects.some(project => {
    // Disabled projects still trigger a refresh so their old remote body is
    // removed by the next full snapshot. Cwd grants no new reading authority.
    try { return withinDirectory(fs.realpathSync(project.root), workingDirectory); } catch { return false; }
  });
  if (!registered) return;
  if (input.event === 'SessionStart' && SESSION_START_SKIPPED_SOURCES.has(input.source)) return;
  if (input.event === 'SessionEnd') {
    if (secondsSince(publisherStatus(options.config).capturedAt) < RECENT_CAPTURE_SECONDS) return;
  } else if (input.event === 'Stop') {
    // 収集が失敗し続けても毎ターン再試行しないよう、失敗の試行時刻も基準に含める。
    const state = publisherStatus(options.config);
    if (Math.min(secondsSince(state.capturedAt), secondsSince(state.lastAttemptAt)) < config.checkpointSeconds) return;
  }
  assertPublisherApproval(options.config, config);
  await captureAndMaybeSend(options.config, { send: true, hook: true });
}

export async function main(argv = process.argv.slice(2)) {
  const { action, options } = parseArguments(argv);
  if (action === 'help' || action === '--help') { process.stdout.write(HELP + '\n'); return; }
  if (action === 'init') {
    printJson(initializePublisher({
      stateDir: options['state-dir'], sourceId: options['source-id'], hubPath: options.hub,
      endpoint: options.endpoint || null, tokenFile: options['token-file'] || null,
      projectRoot: options['project-root'] || null, approvalFile: options['approval-file'] || null,
      projectName: options['project-name'] || null,
    }));
    return;
  }
  if (!options.config || !path.isAbsolute(options.config)) throw new SnapshotError('invalid_config');
  if (action === 'review') { printJson(reviewPublisher(options.config)); return; }
  if (action === 'approve') { printJson(approvePublisher(options.config, options.fingerprint)); return; }
  if (action === 'worker-capture') {
    process.stdout.write(JSON.stringify(buildSnapshot(options.config)));
    return;
  }
  if (action === 'status') { printJson(publisherStatus(options.config)); return; }
  if (action === 'install-hook' || action === 'uninstall-hook') {
    const hooks = await import('./snapshot-hooks.mjs');
    const operation = action === 'install-hook' ? hooks.installHooks : hooks.uninstallHooks;
    printJson(await operation({ configPath: options.config, settingsPath: options.settings,
      checkpoints: options.checkpoints === true }));
    return;
  }
  if (action === 'hook-status') {
    const hooks = await import('./snapshot-hooks.mjs');
    printJson(hooks.hookStatus({ configPath: options.config, settingsPath: options.settings }));
    return;
  }
  if (action === 'hook') {
    try { await runHook(options); }
    catch (error) {
      // Exiting Claude is never blocked or reported as a successful upload.
      // No JSON output enters a new Claude session as instructions.
      if (error.code !== 'busy') recordFailure(options.config, error);
      process.stderr.write('Project Bridge: ' + safeErrorCode(error) + '\n');
    }
    return;
  }
  try {
    if (action === 'capture' || action === 'run') {
      printJson(await captureAndMaybeSend(options.config, { send: action === 'run' }));
    } else if (action === 'sync') {
      printJson(await withPublisherLock(options.config,
        () => synchronizeSnapshot(options.config, { timeoutMs: MANUAL_SEND_TIMEOUT_MS })));
    } else if (action === 'revoke-remote') {
      printJson(await withPublisherLock(options.config,
        () => revokeRemote(options.config, { timeoutMs: MANUAL_SEND_TIMEOUT_MS })));
    } else throw new SnapshotError('invalid_config');
  } catch (error) {
    if (error.code !== 'busy') recordFailure(options.config, error);
    throw error;
  }
}

// Windowsではファイルシステムと同様に大文字小文字を区別せず比較する。
function comparisonPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

// symlink 経由の起動でも動くよう、両辺を realpath で比べる（server.mjs と同じ方式）。
// ライブラリーとして import された場合は何も起動しない。
function invokedAsEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return comparisonPath(fs.realpathSync(path.resolve(process.argv[1]))) === comparisonPath(fs.realpathSync(SCRIPT_PATH));
  } catch {
    return false;
  }
}

if (invokedAsEntryPoint()) {
  main().catch(error => {
    const code = safeErrorCode(error);
    process.stderr.write('Project Bridge: ' + code + '\n');
    // hook の経路は固定コードの 1 行だけを出す。対処の案内は手動 CLI だけに足す。
    if (process.argv[2] !== 'hook' && Object.hasOwn(CLI_REMEDIES, code)) process.stderr.write(CLI_REMEDIES[code] + '\n');
    process.exitCode = 1;
  });
}
