/*
 * Claude Code の終了時スナップショット用 hook 登録。
 * import だけでは設定・ファイル・プロセスを変更しない。
 * 他の設定を保持し、自分の executable / argv が完全一致する項目だけを管理する。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SnapshotError, assertNoSymlinkPath, atomicWritePrivate, ensurePrivateDirectory,
  isRecord, sha256,
} from './snapshot-common.mjs';
import { readPublisherConfig } from './snapshot-publisher.mjs';

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MANAGED_MARKER = 'chatgpt-project-bridge-offline-v1';
const MANAGED_EVENTS = ['SessionEnd', 'SessionStart', 'Stop'];
const MINIMUM_CLAUDE_VERSION = '2.1.268';
const RECOMMENDED_CLAUDE_VERSION = '2.1.268';
const OFFLINE_SCRIPT = fileURLToPath(new URL('./offline-bridge.mjs', import.meta.url));
const BAD_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

function fail(code) {
  throw new SnapshotError(code);
}

function absolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || BAD_CHARACTERS.test(value)) fail('unsafe_path');
  return path.resolve(value);
}

// Claude Code が読み取り可能な 0644 の既存設定は許すが、他ユーザーが
// 書き換えられる設定・設定ディレクトリは使用しない。Windows ACL は別検証が必要。
// permissionCode: 権限違反の固定コード。offline-bridge.mjs 自身の検査では
// unsafe_script_permissions を渡し、設定ファイルの問題と区別する。
function checkSettingsOwnership(metadata, directory = false, permissionCode = 'unsafe_settings_permissions') {
  if (directory ? !metadata.isDirectory() : !metadata.isFile() || metadata.nlink !== 1) fail('unsafe_settings');
  if (process.platform !== 'win32'
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0)) fail(permissionCode);
}

function ensureSettingsDirectory(directory) {
  const absolute = assertNoSymlinkPath(directory, { allowMissing: true });
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(absolute);
  checkSettingsOwnership(fs.lstatSync(absolute), true);
  return absolute;
}

function settingsPathFrom(options) {
  if (options.settingsPath !== undefined) return absolutePath(options.settingsPath);
  const configDirectory = process.env.CLAUDE_CONFIG_DIR;
  const directory = configDirectory ? absolutePath(configDirectory) : path.join(os.homedir(), '.claude');
  return absolutePath(path.join(directory, 'settings.json'));
}

// JSON.parse が黙って先の値を落とす重複キーも拒否する。エラーに本文やキー名を
// 含めないため、settings 内の API key などが stderr に混入しない。
function parseSettings(bytes) {
  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    fail('invalid_settings_json');
  }
  if (!isRecord(parsed)) fail('invalid_settings_shape');
  let cursor = 0;
  function skipWhitespace() {
    while (cursor < text.length && /[\t\n\r ]/.test(text[cursor])) cursor += 1;
  }
  function readString() {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor++] === '"') return JSON.parse(text.slice(start, cursor));
    }
    fail('invalid_settings_json');
  }
  function value(depth) {
    if (depth > MAX_JSON_DEPTH) fail('settings_too_deep');
    skipWhitespace();
    if (text[cursor] === '"') {
      readString();
      return;
    }
    if (text[cursor] === '{') {
      cursor += 1;
      skipWhitespace();
      const names = new Set();
      if (text[cursor] === '}') { cursor += 1; return; }
      while (true) {
        skipWhitespace();
        const name = readString();
        if (names.has(name)) fail('duplicate_settings_key');
        names.add(name);
        skipWhitespace();
        cursor += 1; // ':'。構文は JSON.parse で検証済み。
        value(depth + 1);
        skipWhitespace();
        if (text[cursor++] === '}') return;
      }
    }
    if (text[cursor] === '[') {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === ']') { cursor += 1; return; }
      while (true) {
        value(depth + 1);
        skipWhitespace();
        if (text[cursor++] === ']') return;
      }
    }
    // JSON.parse 済みの数値・true・false・null。
    while (cursor < text.length && !/[\t\n\r ,\]}]/.test(text[cursor])) cursor += 1;
  }
  value(0);
  return parsed;
}

// 開いた fd と名前が同じ regular file であること、読取り中に変化していないことを確認。
function readSettings(filePath) {
  assertNoSymlinkPath(filePath, { allowMissing: true });
  checkSettingsOwnership(fs.lstatSync(path.dirname(filePath)), true);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(filePath);
    checkSettingsOwnership(opened);
    if (named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) fail('settings_changed');
    if (opened.size > MAX_SETTINGS_BYTES) fail('settings_too_large');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(descriptor, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor);
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('settings_changed');
    const original = bytes.subarray(0, count);
    return { exists: true, bytes: original, value: parseSettings(original), dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if (error.code === 'ENOENT' && descriptor === undefined) return { exists: false, bytes: null, value: {} };
    if (error.code === 'ENOENT') fail('settings_changed');
    if (error instanceof SnapshotError) throw error;
    fail('unsafe_settings');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ownHandler(handler, generated) {
  return isRecord(handler) && handler.type === 'command' && handler.command === generated.command
    && Array.isArray(handler.args) && handler.args.length === generated.args.length
    && handler.args.every((argument, index) => argument === generated.args[index]);
}

function handlerFor(configPath) {
  return {
    type: 'command',
    command: process.execPath,
    args: [OFFLINE_SCRIPT, 'hook', '--config', configPath, '--managed-by', MANAGED_MARKER],
    timeout: 20,
  };
}

function hasChangedManagedIdentity(settings, generated) {
  if (!isRecord(settings.hooks)) return false;
  for (const event of MANAGED_EVENTS) {
    for (const group of settings.hooks[event] || []) {
      for (const handler of group.hooks || []) {
        if (!isRecord(handler) || !Array.isArray(handler.args)) continue;
        const argumentsMatch = handler.args.length === generated.args.length
          && handler.args.slice(1).every((argument, index) => argument === generated.args[index + 1]);
        if (argumentsMatch && !ownHandler(handler, generated)) return true;
      }
    }
  }
  return false;
}

// own handler 以外は未知のキーを含めてそのまま残す。
// 未知のグループ設定がある場合は、空になってもグループ自体を保存する。
function mergeHooks(settings, generated, wantedEvents) {
  if (Object.hasOwn(settings, 'hooks') && !isRecord(settings.hooks)) fail('invalid_hooks_shape');
  const result = structuredClone(settings);
  if (!Object.hasOwn(result, 'hooks') && wantedEvents.length === 0) return { value: result, removed: 0 };
  if (!Object.hasOwn(result, 'hooks')) result.hooks = {};
  let removed = 0;
  for (const event of MANAGED_EVENTS) {
    if (!Object.hasOwn(result.hooks, event)) continue;
    if (!Array.isArray(result.hooks[event])) fail('invalid_hooks_shape');
    const removedBeforeEvent = removed;
    const keptGroups = [];
    for (const group of result.hooks[event]) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) fail('invalid_hooks_shape');
      if ((Object.hasOwn(group, 'matcher') && typeof group.matcher !== 'string')
          || group.hooks.some(handler => !isRecord(handler))) fail('invalid_hooks_shape');
      const keptHandlers = group.hooks.filter(handler => {
        if (!ownHandler(handler, generated)) return true;
        removed += 1;
        return false;
      });
      if (keptHandlers.length === group.hooks.length) keptGroups.push(group);
      else if (keptHandlers.length > 0 || Object.keys(group).some(key => key !== 'hooks' && key !== 'matcher')
          || (Object.hasOwn(group, 'matcher') && group.matcher !== '')) {
        keptGroups.push({ ...group, hooks: keptHandlers });
      }
    }
    if (removed !== removedBeforeEvent) {
      if (keptGroups.length > 0) result.hooks[event] = keptGroups;
      else delete result.hooks[event];
    }
  }
  for (const event of wantedEvents) {
    if (!Object.hasOwn(result.hooks, event)) result.hooks[event] = [];
    result.hooks[event].push({ hooks: [structuredClone(generated)] });
  }
  return { value: result, removed };
}

function assertSettingsUnchanged(filePath, before) {
  const current = readSettings(filePath);
  if (current.exists !== before.exists || (before.exists
      && (current.dev !== before.dev || current.ino !== before.ino || !current.bytes.equals(before.bytes)))) fail('settings_changed');
}

// 他の bridge インストーラーとの競合を防ぐ。Claude Code 自身はこの lock を見ないため、
// 置換直前にも内容を再検査する。別プロセスとの最後の瞬間の競合を完全には排除できない。
function withSettingsLock(filePath, callback) {
  const lockPath = path.join(path.dirname(filePath), '.bridge-hooks-' + sha256(filePath).slice(0, 16) + '.lock');
  let descriptor;
  let lockIdentity;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    lockIdentity = fs.fstatSync(descriptor);
    return callback();
  } catch (error) {
    if (error.code === 'EEXIST') fail('settings_locked');
    throw error;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
      try {
        const current = fs.lstatSync(lockPath);
        if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino && !current.isSymbolicLink()) fs.unlinkSync(lockPath);
      } catch { /* 削除された lock はそのままにする。 */ }
    }
  }
}

function writeSettings(filePath, bytes, before) {
  const directory = path.dirname(filePath);
  assertNoSymlinkPath(directory);
  checkSettingsOwnership(fs.lstatSync(directory), true);
  const temporary = path.join(directory, '.bridge-settings-' + crypto.randomBytes(16).toString('hex'));
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertSettingsUnchanged(filePath, before);
    assertNoSymlinkPath(filePath, { allowMissing: true });
    if (before.exists) fs.renameSync(temporary, filePath);
    else {
      // 新規作成時は、同時に作られた設定を上書きしない。
      fs.linkSync(temporary, filePath);
      fs.unlinkSync(temporary);
    }
    if (process.platform !== 'win32') {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    }
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    fail(error.code === 'EEXIST' ? 'settings_changed' : 'settings_write_failed');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* 置換済み。 */ }
  }
}

function readHookConfig(configPath) {
  // publisher と同じ型・パス・private permission 検査を使う。
  // 未承認 draft の登録は可。収集・送信時の承認検査は publisher が必ず実施する。
  const config = readPublisherConfig(configPath);
  const stateDirectory = ensurePrivateDirectory(config.stateDir);
  return { config, stateDirectory };
}

function changeHooks(options, installing) {
  if (!isRecord(options) || (options.checkpoints !== undefined && typeof options.checkpoints !== 'boolean')) fail('invalid_hook_options');
  const configPath = absolutePath(options.configPath);
  const { stateDirectory } = readHookConfig(configPath);
  const settingsPath = settingsPathFrom(options);
  const relativeToState = path.relative(stateDirectory, settingsPath);
  if (relativeToState === '' || (!relativeToState.startsWith('..' + path.sep)
      && relativeToState !== '..' && !path.isAbsolute(relativeToState))) fail('unsafe_settings_path');
  assertNoSymlinkPath(settingsPath, { allowMissing: true });
  if (!installing && !fs.existsSync(path.dirname(settingsPath))) {
    return {
      changed: false, settingsPath, backupPath: null, events: [], removed: 0,
      warnings: ['no_matching_managed_hook_found', ...(process.platform === 'win32' ? ['windows_acl_not_verified'] : [])],
      minimumClaudeVersion: MINIMUM_CLAUDE_VERSION, recommendedClaudeVersion: RECOMMENDED_CLAUDE_VERSION,
      claudeHookExecutionVerified: false,
    };
  }
  ensureSettingsDirectory(path.dirname(settingsPath));
  if (installing) {
    assertNoSymlinkPath(OFFLINE_SCRIPT);
    checkSettingsOwnership(fs.lstatSync(OFFLINE_SCRIPT), false, 'unsafe_script_permissions');
  }
  const generated = handlerFor(configPath);
  const events = installing ? ['SessionEnd', 'SessionStart', ...(options.checkpoints ? ['Stop'] : [])] : [];
  return withSettingsLock(settingsPath, () => {
    const before = readSettings(settingsPath);
    const { value, removed } = mergeHooks(before.value, generated, events);
    const warnings = [];
    if (before.value.disableAllHooks === true) warnings.push('disableAllHooks_is_enabled');
    if (before.value.allowManagedHooksOnly === true) warnings.push('allowManagedHooksOnly_is_enabled');
    if (process.platform === 'win32') warnings.push('windows_acl_not_verified');
    if (!installing && removed === 0) warnings.push('no_matching_managed_hook_found');
    if (hasChangedManagedIdentity(before.value, generated)) warnings.push('managed_hook_identity_changed_review_settings');
    const changed = JSON.stringify(before.value) !== JSON.stringify(value);
    let backupPath = null;
    if (changed) {
      if (before.exists) {
        const backupDirectory = ensurePrivateDirectory(path.join(stateDirectory, 'hook-backups'));
        backupPath = path.join(backupDirectory, 'settings-' + sha256(settingsPath).slice(0, 16)
          + '-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.json');
        atomicWritePrivate(backupPath, before.bytes, { overwrite: false });
      }
      const encoded = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      if (encoded.length > MAX_SETTINGS_BYTES) fail('settings_too_large');
      writeSettings(settingsPath, encoded, before);
    }
    return {
      changed, settingsPath, backupPath, events, removed, warnings,
      minimumClaudeVersion: MINIMUM_CLAUDE_VERSION, recommendedClaudeVersion: RECOMMENDED_CLAUDE_VERSION,
      claudeHookExecutionVerified: false,
    };
  });
}

function samePathText(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// この設定に対応する管理ハンドラ（command・args の形と印・--config が一致するもの）を探す。
// 読み取り専用の診断用で、installer の ownHandler のような完全一致は要求しない。
function findManagedHandler(settings, event, configPath) {
  if (!isRecord(settings.hooks) || !Array.isArray(settings.hooks[event])) return null;
  for (const group of settings.hooks[event]) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) {
      if (!isRecord(handler) || handler.type !== 'command' || !Array.isArray(handler.args)) continue;
      const args = handler.args;
      const markerIndex = args.indexOf('--managed-by');
      const configIndex = args.indexOf('--config');
      if (args[1] === 'hook' && markerIndex !== -1 && args[markerIndex + 1] === MANAGED_MARKER
          && configIndex !== -1 && typeof args[configIndex + 1] === 'string'
          && samePathText(args[configIndex + 1], configPath)) return handler;
    }
  }
  return null;
}

function fileExists(candidate) {
  try { return typeof candidate === 'string' && fs.statSync(candidate).isFile(); } catch { return false; }
}

// 登録の状態を調べるだけ。設定・ディレクトリ・lock を作らない。
// 値には command / script のパスや本文を載せず、真偽値と固定コードだけを返す。
export function hookStatus(options) {
  if (!isRecord(options)) fail('invalid_hook_options');
  const configPath = absolutePath(options.configPath);
  const settingsPath = settingsPathFrom(options);
  assertNoSymlinkPath(settingsPath, { allowMissing: true });
  let settings = {};
  try {
    fs.lstatSync(path.dirname(settingsPath));
    settings = readSettings(settingsPath).value;
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error.code !== 'ENOENT') fail('unsafe_settings');
  }
  const events = {};
  const warnings = [];
  for (const event of MANAGED_EVENTS) {
    const handler = findManagedHandler(settings, event, configPath);
    const status = { registered: handler !== null, commandExists: false, scriptExists: false,
      commandMatchesCurrentNode: false };
    if (handler !== null) {
      status.commandExists = fileExists(handler.command);
      status.scriptExists = fileExists(handler.args[0]);
      status.commandMatchesCurrentNode = typeof handler.command === 'string'
        && samePathText(handler.command, process.execPath);
      if (!status.commandExists) warnings.push('managed_hook_node_path_missing');
      else if (!status.commandMatchesCurrentNode) warnings.push('managed_hook_node_differs_from_current');
      if (!status.scriptExists) warnings.push('managed_hook_script_missing');
    }
    events[event] = status;
  }
  // Stop は --checkpoints を付けたときだけの任意登録なので、未登録を警告にしない。
  if (!events.SessionEnd.registered || !events.SessionStart.registered) warnings.unshift('no_managed_hook_registered');
  if (process.platform === 'win32') warnings.push('windows_acl_not_verified');
  return {
    configPath, settingsPath, events, warnings: [...new Set(warnings)],
    minimumClaudeVersion: MINIMUM_CLAUDE_VERSION, claudeHookExecutionVerified: false,
  };
}

export function installHooks(options) {
  return changeHooks(options, true);
}

export function uninstallHooks(options) {
  return changeHooks(options, false);
}
