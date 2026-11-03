#!/usr/bin/env node
/*
  2.7.0: Claude Code のジョブを 1 件動かすランナー。bridge-claude-jobs.mjs（start_claude_job）が起動する。
  起動: node claude-job-runner.mjs <ジョブの記録のディレクトリ>
  - ChatGPT からの値は、サーバーが書いたジョブの記録（spec.json・prompt.txt・settings.json）を通してだけ受け取る。
  - Claude Code をシェルを介さずに起動し、依頼文を標準入力で渡す。stream-json の出力を events.jsonl に追記し、状態を status.json に書く。
  - 見張るもの: 停止の要求（cancel.request）、制限時間（maxMinutes）、親（ハブ）の消滅。どれかが起きたら、Claude Code を子プロセスごと止める。
    Windows は taskkill /T /F（絶対パス）、Linux は別のプロセスグループに SIGTERM、10 秒後に SIGKILL。
  - heartbeatAt を 5 秒ごとに更新する。サーバーは、更新が止まった動作中のジョブを interrupted と表示する。
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  JOB_FILES, JOB_SCHEMA_VERSION, HEARTBEAT_INTERVAL_MS, MAX_TEXT_CHARS, applyEventToStatus, makeRelativizer, readStatusFile, writeStatusFile,
} from './bridge-claude-jobs.mjs';
import { assertPrivateDirectory, readPrivateJson, readPrivateFile } from './snapshot-common.mjs';
import { redact } from './server.mjs';

const MAX_EVENTS_BYTES = 32 * 1024 * 1024; // events.jsonl に記録する上限。超えたら記録をやめる（最終結果は状態に残す）。
const MAX_PARSE_LINE_BYTES = 8 * 1024 * 1024; // 状態に反映するため解釈する 1 行の上限。
const MAX_STDERR_BYTES = 64 * 1024; // 残す標準エラー出力の末尾の大きさ。
const MAX_PROMPT_BYTES = 256 * 1024; // 依頼文を読む上限。
const KILL_GRACE_MS = 10000; // Linux で SIGTERM から SIGKILL までの猶予。
const WATCH_INTERVAL_MS = 1000; // 停止の要求・親の消滅を確かめる間隔。

// 引数のジョブの記録を検証して読む。形が違えば例外を投げる（何も起動しない）。
function loadSpec(jobDirectory) {
  assertPrivateDirectory(jobDirectory);
  const spec = readPrivateJson(path.join(jobDirectory, JOB_FILES.spec), 1024 * 1024); // ランナーへの指示。
  const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!spec || spec.schemaVersion !== JOB_SCHEMA_VERSION || typeof spec.jobId !== 'string' || !isStringArray(spec.command) || spec.command.length === 0
    || !path.isAbsolute(spec.command[0]) || !isStringArray(spec.args) || typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)
    || !spec.env || typeof spec.env !== 'object' || !Number.isInteger(spec.maxMinutes) || spec.maxMinutes < 1 || spec.maxMinutes > 180
    || !Number.isInteger(spec.timeLimitSeconds) || spec.timeLimitSeconds < 1 || spec.timeLimitSeconds > 180 * 60) {
    throw new Error('ジョブの指示（spec.json）の形が正しくありません。');
  }
  return spec;
}

// Claude Code を子プロセスごと止める。
function killTree(pid, signal) {
  if (!pid) return;
  if (process.platform === 'win32') {
    const systemRoot = /^[A-Za-z]:[\\/]/.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows'; // 作業フォルダーを探さないよう、taskkill を絶対パスで起動する。
    try {
      spawnSync(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } catch { /* 止められなくても、ランナーの終了時に Job object が閉じて止まる。 */ }
    return;
  }
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* すでに終わっている。 */ }
  }
}

// 親のプロセスが生きているかを返す。
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function main() {
  const jobDirectory = path.resolve(String(process.argv[2] || '')); // ジョブの記録。
  const statusPath = path.join(jobDirectory, JOB_FILES.status); // 状態ファイル。
  let spec; // ランナーへの指示。
  try {
    spec = loadSpec(jobDirectory);
  } catch (error) {
    try { writeStatusFile(statusPath, { schemaVersion: JOB_SCHEMA_VERSION, state: 'failed', endedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), errorMessage: String(error?.message || error) }); } catch { /* 書けなければ heartbeat が古くなる。 */ }
    process.exit(1);
  }
  const status = { ...(readStatusFile(statusPath) || {}), schemaVersion: JOB_SCHEMA_VERSION, jobId: spec.jobId }; // 状態（このランナーが書き換える）。
  const timestamp = () => new Date().toISOString(); // いまの時刻。
  const save = () => {
    status.heartbeatAt = timestamp();
    try { writeStatusFile(statusPath, status); } catch { /* 次の機会に書く。 */ }
  };
  const cancelPath = path.join(jobDirectory, JOB_FILES.cancel); // 停止の要求。
  if (fs.existsSync(cancelPath)) {
    Object.assign(status, { state: 'cancelled', endedAt: timestamp(), errorMessage: '開始前に停止が要求されました。' });
    save();
    process.exit(0);
  }
  let prompt; // 依頼文。
  try {
    prompt = readPrivateFile(path.join(jobDirectory, JOB_FILES.prompt), MAX_PROMPT_BYTES).toString('utf8');
  } catch {
    Object.assign(status, { state: 'failed', endedAt: timestamp(), errorMessage: '依頼文を読めませんでした。' });
    save();
    process.exit(1);
  }
  const eventsDescriptor = fs.openSync(path.join(jobDirectory, JOB_FILES.events), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600); // 経過の記録。
  const toRelative = makeRelativizer(spec.cwd); // パスをプロジェクト相対にする関数。
  Object.assign(status, { state: 'running', runnerPid: process.pid, startedAt: timestamp(), eventCount: 0, logBytes: 0, logTruncated: false });
  save();

  const parentPid = process.ppid; // 起動した親（ハブ）。
  let child; // Claude Code。
  try {
    child = spawn(spec.command[0], [...spec.command.slice(1), ...spec.args], {
      cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      detached: process.platform !== 'win32', // Linux では別のプロセスグループにして、子プロセスごと止められるようにする。
    });
  } catch (error) {
    Object.assign(status, { state: 'failed', endedAt: timestamp(), errorMessage: `Claude Code を起動できませんでした（${error?.code || 'error'}）。` });
    save();
    process.exit(1);
  }
  status.claudePid = child.pid ?? null;

  let terminating = null; // 止める理由（cancelled・timeout・interrupted）。null なら自然に終わるのを待つ。
  let finished = false; // 終了処理を済ませたか。
  let pending = Buffer.alloc(0); // 改行待ちの標準出力。
  let skipping = false; // 大きすぎる行を読み飛ばしている途中か。
  let stderrTail = Buffer.alloc(0); // 標準エラー出力の末尾。
  const context = { toRelative, redact }; // 状態へ反映するときに使う関数。

  // 標準出力の 1 行を解釈して状態に反映する。
  const handleLine = line => {
    if (line.length === 0) return;
    status.eventCount += 1;
    try { applyEventToStatus(status, JSON.parse(line.toString('utf8')), context); } catch { /* 解釈できない行は数えるだけ。 */ }
  };

  // Claude Code を止める。
  const terminate = reason => {
    if (terminating || finished) return;
    terminating = reason;
    killTree(child.pid, 'SIGTERM');
    if (process.platform !== 'win32') setTimeout(() => killTree(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
  };

  child.stdout.on('data', chunk => {
    if (status.logBytes < MAX_EVENTS_BYTES) {
      const room = MAX_EVENTS_BYTES - status.logBytes; // 記録できる残り。
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk; // 記録する分。
      try { fs.writeSync(eventsDescriptor, part); } catch { /* 記録できなくても状態の反映は続ける。 */ }
      status.logBytes += part.length;
      if (part.length < chunk.length) status.logTruncated = true;
    } else {
      status.logTruncated = true;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline; // 改行の位置。
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, newline); // 1 行。
      if (skipping) skipping = false;
      else handleLine(line);
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > MAX_PARSE_LINE_BYTES) {
      skipping = true;
      pending = Buffer.alloc(0);
    }
  });
  child.stderr.on('data', chunk => {
    stderrTail = Buffer.concat([stderrTail, chunk]);
    if (stderrTail.length > MAX_STDERR_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - MAX_STDERR_BYTES);
  });
  child.stdin.on('error', () => { /* Claude Code が先に終わったときの書き込み失敗は無視する。 */ });
  child.stdin.end(prompt);

  const deadline = setTimeout(() => terminate('timeout'), spec.timeLimitSeconds * 1000); // 制限時間（通常は maxMinutes を秒にしたもの）。
  const heartbeat = setInterval(save, HEARTBEAT_INTERVAL_MS); // 生きていることの記録。
  const watcher = setInterval(() => {
    if (fs.existsSync(cancelPath)) terminate('cancelled');
    else if (process.ppid !== parentPid || !isAlive(parentPid)) terminate('interrupted');
  }, WATCH_INTERVAL_MS); // 停止の要求と親の消滅。

  // 終了の処理。状態を確定して書き、ランナーも終わる。
  const finish = (code, signal, spawnError = null) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearInterval(heartbeat);
    clearInterval(watcher);
    if (!skipping && pending.length > 0) handleLine(pending);
    try { fs.closeSync(eventsDescriptor); } catch { /* すでに閉じている。 */ }
    const stderrText = stderrTail.toString('utf8'); // 標準エラー出力の末尾。
    try {
      fs.writeFileSync(path.join(jobDirectory, JOB_FILES.stderr), redact(stderrText), { mode: 0o600 });
    } catch { /* 残せなくても状態は書く。 */ }
    status.exitCode = Number.isInteger(code) ? code : null;
    status.signal = typeof signal === 'string' ? signal : null;
    status.endedAt = timestamp();
    status.stderrTail = redact(stderrText).slice(-MAX_TEXT_CHARS);
    if (spawnError) {
      status.state = 'failed';
      status.errorMessage = `Claude Code を起動できませんでした（${spawnError.code || 'error'}）。claude の場所と導入を確認してください。`;
    } else if (terminating) {
      status.state = terminating;
      status.errorMessage = { cancelled: '停止の要求により止めました。', timeout: `制限時間（${spec.timeLimitSeconds >= 60 ? `${Math.round(spec.timeLimitSeconds / 60)} 分` : `${spec.timeLimitSeconds} 秒`}）を過ぎたため止めました。`, interrupted: 'ハブが止まったため、ジョブを止めました。' }[terminating];
    } else if (status.result && !status.result.isError && code === 0) {
      status.state = 'succeeded';
    } else {
      status.state = 'failed';
      if (!status.result) status.errorMessage = `Claude Code が結果を出さずに終了しました（終了コード ${status.exitCode ?? '不明'}）。`;
    }
    save();
    process.exit(0);
  };
  child.on('error', error => finish(null, null, error));
  child.on('close', (code, signal) => finish(code, signal));
}

main();
