/* Isolated settings-file tests. Does not run Claude Code or install real hooks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hook-test-'));
fs.chmodSync(temporaryRoot, 0o700);
let fixtureCount = 0;
let passedCount = 0;
const originalClaudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR;

// snapshot-hooks.mjs は offline-bridge.mjs 自身の権限を検査する。作業ツリーの権限
// （例: 664）に試験結果が左右されないよう、必要な .mjs を権限を固定した一時ディレクトリへ
// コピーし、そのコピーを読み込んで試験する。
const SCRIPT_NAMES = ['snapshot-hooks.mjs', 'snapshot-common.mjs', 'snapshot-publisher.mjs', 'server.mjs', 'bridge-tools-common.mjs', 'bridge-tool-definitions.mjs', 'offline-bridge.mjs'];
const scriptDirectory = path.join(temporaryRoot, 'scripts');
fs.mkdirSync(scriptDirectory, { mode: 0o755 });
fs.chmodSync(scriptDirectory, 0o755);
for (const name of SCRIPT_NAMES) {
  const copiedPath = path.join(scriptDirectory, name);
  fs.copyFileSync(fileURLToPath(new URL('./' + name, import.meta.url)), copiedPath);
  fs.chmodSync(copiedPath, 0o644);
  if (process.platform !== 'win32' && (fs.statSync(copiedPath).mode & 0o022) !== 0) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    process.stderr.write('FAIL 一時ディレクトリ（' + os.tmpdir() + '）が chmod を反映しないため、'
      + 'スクリプトの権限（group/other 書き込み不可）を固定できません。TMPDIR を chmod が効くディレクトリへ向けてください。\n');
    process.exit(1);
  }
}
const offlineScriptCopy = path.join(scriptDirectory, 'offline-bridge.mjs');
const { installHooks, uninstallHooks, hookStatus } = await import(pathToFileURL(path.join(scriptDirectory, 'snapshot-hooks.mjs')).href);

function privateJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.chmodSync(filePath, mode);
}

function fixture(label = 'project', overrides = {}) {
  fixtureCount += 1;
  const base = path.join(temporaryRoot, fixtureCount + '-' + label);
  const projectRoot = path.join(base, 'project');
  const stateDir = path.join(base, 'private-state');
  const settingsPath = path.join(base, 'claude-settings', 'settings.json');
  fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const bridgeConfig = path.join(projectRoot, '.chatgpt-project-bridge.json');
  privateJson(bridgeConfig, {});
  const configPath = path.join(stateDir, 'publisher.json');
  const config = {
    schemaVersion: 1,
    kind: 'chatgpt-project-bridge-publisher',
    sourceId: 'fixture-source',
    stateDir,
    endpoint: null,
    tokenFile: null,
    ttlHours: 168,
    staleHours: 24,
    includeGit: true,
    checkpointSeconds: 300,
    projects: [{
      name: 'fixture-project',
      root: projectRoot,
      configPath: bridgeConfig,
      approvalFile: path.join(stateDir, 'live-approval.json'),
      exposureSha256: 'a'.repeat(64),
      files: ['CHATGPT_PROJECT_CONTEXT.md'],
      enabled: true,
    }],
    ...overrides,
  };
  privateJson(configPath, config);
  return { base, config, configPath, settingsPath, projectRoot, stateDir };
}

function loadSettings(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function expectError(action, expectedCode) {
  assert.throws(action, error => {
    assert.match(error.code || '', expectedCode);
    assert.doesNotMatch(error.message || '', /DO-NOT-PRINT/);
    return true;
  });
}

function test(name, action) {
  action();
  passedCount += 1;
  process.stdout.write('PASS ' + name + '\n');
}

try {
  test('Import has no hook installation or process side effects', () => {
    const unusedConfigDirectory = path.join(temporaryRoot, 'unused-claude-config');
    const moduleUrl = pathToFileURL(path.join(scriptDirectory, 'snapshot-hooks.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(moduleUrl) + ');'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: unusedConfigDirectory },
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
    assert.equal(fs.existsSync(unusedConfigDirectory), false);
  });

  test('Default hooks use literal executable and argv, even with special paths', () => {
    const item = fixture("space ' dollar$ tick` (parentheses) 日本語");
    const result = installHooks(item);
    assert.equal(result.changed, true);
    assert.deepEqual(result.events, ['SessionEnd', 'SessionStart']);
    const settings = loadSettings(item.settingsPath);
    assert.equal(settings.hooks.Stop, undefined);
    const expectedScript = offlineScriptCopy;
    for (const event of result.events) {
      const hook = settings.hooks[event][0].hooks[0];
      assert.equal(hook.type, 'command');
      assert.equal(hook.command, process.execPath);
      assert.equal(path.isAbsolute(hook.command), true);
      assert.deepEqual(hook.args, [expectedScript, 'hook', '--config', item.configPath,
        '--managed-by', 'chatgpt-project-bridge-offline-v1']);
      assert.equal(hook.timeout, 20);
      assert.equal(hook.async, undefined);
      assert.equal(hook.shell, undefined);
    }
    assert.equal(result.claudeHookExecutionVerified, false);
    assert.equal(result.minimumClaudeVersion, '2.1.268');
    assert.equal(result.recommendedClaudeVersion, '2.1.268');
    if (process.platform !== 'win32') assert.equal(fs.statSync(item.settingsPath).mode & 0o777, 0o600);
  });

  test('Unrelated settings and hooks survive, and backups preserve original bytes privately', () => {
    const item = fixture('preservation');
    const userHook = { type: 'command', command: 'a-user-owned-command', args: ['DO-NOT-PRINT-HOOK-SETTINGS'], customHookField: { active: true } };
    const original = JSON.parse('{"permissions":{"allow":["Read"],"deny":["Bash(rm *)"]},"disableAllHooks":true,"custom":{"__proto__":{"retained":true}},"env":{"DUMMY_TEST_VALUE":"DO-NOT-PRINT-SETTING"}}');
    original.hooks = {
      Stop: [{ matcher: '', customGroup: 'retained', hooks: [userHook] }],
      PreCompact: [],
      FutureUnknownEvent: [{ preserveEverything: 'unchanged' }],
    };
    privateJson(item.settingsPath, original, 0o644);
    const originalBytes = fs.readFileSync(item.settingsPath);
    const result = installHooks(item);
    const updated = loadSettings(item.settingsPath);
    assert.deepEqual(updated.permissions, original.permissions);
    assert.deepEqual(updated.custom, original.custom);
    assert.deepEqual(updated.env, original.env);
    assert.equal(updated.disableAllHooks, true);
    assert.deepEqual(updated.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(updated.hooks.PreCompact, original.hooks.PreCompact);
    assert.deepEqual(updated.hooks.FutureUnknownEvent, original.hooks.FutureUnknownEvent);
    assert.ok(result.warnings.includes('disableAllHooks_is_enabled'));
    assert.equal(Object.prototype.retained, undefined);
    assert.ok(result.backupPath.startsWith(path.join(item.stateDir, 'hook-backups') + path.sep));
    assert.ok(fs.readFileSync(result.backupPath).equals(originalBytes));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(result.backupPath)).mode & 0o777, 0o700);
    }
    const beforeSecondInstall = fs.readFileSync(item.settingsPath);
    const secondResult = installHooks(item);
    assert.equal(secondResult.changed, false);
    assert.equal(secondResult.backupPath, null);
    assert.ok(fs.readFileSync(item.settingsPath).equals(beforeSecondInstall));
    uninstallHooks(item);
    assert.deepEqual(loadSettings(item.settingsPath), original);
  });

  test('Checkpoint toggles affect only matching owned handlers', () => {
    const item = fixture('checkpoints');
    const userStop = { type: 'command', command: 'another-user-hook' };
    privateJson(item.settingsPath, { hooks: { Stop: [{ hooks: [userStop] }] } });
    installHooks({ ...item, checkpoints: true });
    assert.equal(loadSettings(item.settingsPath).hooks.Stop.length, 2);
    installHooks({ ...item, checkpoints: false });
    assert.deepEqual(loadSettings(item.settingsPath).hooks.Stop, [{ hooks: [userStop] }]);
    assert.equal(installHooks(item).changed, false);
  });

  test('Uninstall preserves another config registration and does not create missing settings', () => {
    const first = fixture('first-config');
    const second = fixture('second-config');
    const absent = uninstallHooks(first);
    assert.equal(absent.changed, false);
    assert.equal(fs.existsSync(first.settingsPath), false);
    assert.equal(fs.existsSync(path.dirname(first.settingsPath)), false);
    installHooks(first);
    const firstHook = loadSettings(first.settingsPath).hooks.SessionEnd[0].hooks[0];
    installHooks({ ...second, settingsPath: first.settingsPath });
    uninstallHooks({ ...second, settingsPath: first.settingsPath });
    assert.deepEqual(loadSettings(first.settingsPath).hooks.SessionEnd, [{ hooks: [firstHook] }]);
  });

  test('Unknown group fields survive removal of their owned handler', () => {
    const item = fixture('unknown-group');
    installHooks(item);
    const settings = loadSettings(item.settingsPath);
    settings.hooks.SessionEnd[0].futureGroupOption = { meaning: 'must survive' };
    privateJson(item.settingsPath, settings);
    uninstallHooks(item);
    assert.deepEqual(loadSettings(item.settingsPath).hooks.SessionEnd, [
      { hooks: [], futureGroupOption: { meaning: 'must survive' } },
    ]);
  });

  test('Moved executable registrations are preserved with an explicit warning', () => {
    const item = fixture('moved-executable');
    installHooks(item);
    const settings = loadSettings(item.settingsPath);
    for (const event of ['SessionEnd', 'SessionStart']) settings.hooks[event][0].hooks[0].command += '-old';
    privateJson(item.settingsPath, settings);
    const result = uninstallHooks(item);
    assert.equal(result.changed, false);
    assert.equal(result.removed, 0);
    assert.ok(result.warnings.includes('no_matching_managed_hook_found'));
    assert.ok(result.warnings.includes('managed_hook_identity_changed_review_settings'));
    assert.deepEqual(loadSettings(item.settingsPath), settings);
  });

  test('CLAUDE_CONFIG_DIR selects the user settings directory', () => {
    const item = fixture('config-directory');
    const configuredDirectory = path.join(item.base, 'alternate-claude');
    process.env.CLAUDE_CONFIG_DIR = configuredDirectory;
    const result = installHooks({ configPath: item.configPath });
    assert.equal(result.settingsPath, path.join(configuredDirectory, 'settings.json'));
    if (originalClaudeConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDirectory;
  });

  test('Malformed, duplicate-key, invalid UTF-8, and non-object settings fail without modification', () => {
    const contents = [
      Buffer.from('{"env":{"DUMMY":"DO-NOT-PRINT"},'),
      Buffer.from('{"env":{"DUMMY":"DO-NOT-PRINT","DUMMY":"duplicate"}}'),
      Buffer.from('{"hooks":{"SessionEnd":{}}}'),
      Buffer.from('{"hooks":{"SessionEnd":[{"hooks":[null]}]}}'),
      Buffer.from('{"hooks":{"SessionEnd":[{"matcher":5,"hooks":[]}]}}'),
      Buffer.from('{"hooks":[]}'),
      Buffer.from('[]'),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]),
      Buffer.from('{"nested":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}'),
    ];
    for (const contentsItem of contents) {
      const item = fixture('bad-json');
      fs.mkdirSync(path.dirname(item.settingsPath), { mode: 0o700 });
      fs.writeFileSync(item.settingsPath, contentsItem, { mode: 0o600 });
      expectError(() => installHooks(item), /invalid_|duplicate_settings_key|settings_too_deep/);
      assert.ok(fs.readFileSync(item.settingsPath).equals(contentsItem));
    }
  });

  test('Oversized settings and invalid hook options are rejected', () => {
    const item = fixture('bounded');
    privateJson(item.settingsPath, { oversized: 'x'.repeat(2 * 1024 * 1024) });
    expectError(() => installHooks(item), /settings_too_large/);
    expectError(() => installHooks({ ...item, checkpoints: 'yes' }), /invalid_hook_options/);
    expectError(() => installHooks({ ...item, settingsPath: 'bad\npath' }), /unsafe_path/);
    expectError(() => installHooks({ ...item, settingsPath: item.configPath }), /unsafe_settings_path/);
  });

  test('Existing settings lock prevents conflicting installer writes', () => {
    const item = fixture('lock');
    privateJson(item.settingsPath, { retained: true });
    const before = fs.readFileSync(item.settingsPath);
    const identity = crypto.createHash('sha256').update(item.settingsPath).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(path.dirname(item.settingsPath), '.bridge-hooks-' + identity + '.lock'), '', { mode: 0o600 });
    expectError(() => installHooks(item), /settings_locked/);
    assert.ok(fs.readFileSync(item.settingsPath).equals(before));
  });

  test('Invalid publisher configuration is refused without changing settings', () => {
    const item = fixture('bad-publisher', { schemaVersion: 99 });
    privateJson(item.settingsPath, { preserved: true });
    const before = fs.readFileSync(item.settingsPath);
    expectError(() => installHooks(item), /invalid_|unsafe_/);
    assert.ok(fs.readFileSync(item.settingsPath).equals(before));
  });

  test('hook-status reports registered hooks and stays read-only', () => {
    const item = fixture('status-registered');
    installHooks({ ...item, checkpoints: true });
    const before = fs.readFileSync(item.settingsPath);
    const beforeTime = fs.statSync(item.settingsPath).mtimeMs;
    const settingsEntries = fs.readdirSync(path.dirname(item.settingsPath)).sort();
    const stateEntries = fs.readdirSync(item.stateDir).sort();
    const status = hookStatus(item);
    assert.equal(status.configPath, item.configPath);
    assert.equal(status.settingsPath, item.settingsPath);
    assert.equal(status.minimumClaudeVersion, '2.1.268');
    assert.equal(status.claudeHookExecutionVerified, false);
    for (const event of ['SessionEnd', 'SessionStart', 'Stop']) {
      assert.deepEqual(status.events[event], { registered: true, commandExists: true, scriptExists: true,
        commandMatchesCurrentNode: true }, event);
    }
    assert.deepEqual(status.warnings.filter(code => code !== 'windows_acl_not_verified'), []);
    assert.ok(fs.readFileSync(item.settingsPath).equals(before));
    assert.equal(fs.statSync(item.settingsPath).mtimeMs, beforeTime);
    assert.deepEqual(fs.readdirSync(path.dirname(item.settingsPath)).sort(), settingsEntries);
    assert.deepEqual(fs.readdirSync(item.stateDir).sort(), stateEntries);
    // 既定の install（Stop 無し）では Stop だけが未登録で、警告にはならない。
    const second = fixture('status-default');
    installHooks(second);
    const defaultStatus = hookStatus(second);
    assert.equal(defaultStatus.events.Stop.registered, false);
    assert.equal(defaultStatus.events.SessionEnd.registered, true);
    assert.equal(defaultStatus.warnings.includes('no_managed_hook_registered'), false);
  });

  test('hook-status handles missing settings, other configs, a missing node, and a missing script', () => {
    const missing = fixture('status-missing');
    const absent = hookStatus(missing);
    for (const event of ['SessionEnd', 'SessionStart', 'Stop']) {
      assert.deepEqual(absent.events[event], { registered: false, commandExists: false, scriptExists: false,
        commandMatchesCurrentNode: false }, event);
    }
    assert.ok(absent.warnings.includes('no_managed_hook_registered'));
    assert.equal(fs.existsSync(path.dirname(missing.settingsPath)), false);
    assert.deepEqual(fs.readdirSync(missing.stateDir), ['publisher.json']);

    // 別の保存設定に対応する登録は、この設定の登録として数えない。
    const other = fixture('status-other');
    installHooks({ ...other, settingsPath: missing.settingsPath });
    assert.equal(hookStatus(missing).events.SessionEnd.registered, false);

    const brokenNode = fixture('status-node');
    installHooks(brokenNode);
    const nodeSettings = loadSettings(brokenNode.settingsPath);
    nodeSettings.hooks.SessionEnd[0].hooks[0].command += '-missing';
    privateJson(brokenNode.settingsPath, nodeSettings);
    const nodeStatus = hookStatus(brokenNode);
    assert.deepEqual(nodeStatus.events.SessionEnd, { registered: true, commandExists: false, scriptExists: true,
      commandMatchesCurrentNode: false });
    assert.ok(nodeStatus.warnings.includes('managed_hook_node_path_missing'));

    const brokenScript = fixture('status-script');
    installHooks(brokenScript);
    const scriptSettings = loadSettings(brokenScript.settingsPath);
    scriptSettings.hooks.SessionStart[0].hooks[0].args[0] += '-missing';
    privateJson(brokenScript.settingsPath, scriptSettings);
    const scriptStatus = hookStatus(brokenScript);
    assert.deepEqual(scriptStatus.events.SessionStart, { registered: true, commandExists: true, scriptExists: false,
      commandMatchesCurrentNode: true });
    assert.ok(scriptStatus.warnings.includes('managed_hook_script_missing'));

    // Node の場所が別でも実在すれば、現在の Node との差だけを警告する。
    const otherNode = fixture('status-other-node');
    installHooks(otherNode);
    const otherSettings = loadSettings(otherNode.settingsPath);
    otherSettings.hooks.SessionEnd[0].hooks[0].command = fileURLToPath(import.meta.url);
    privateJson(otherNode.settingsPath, otherSettings);
    const otherStatus = hookStatus(otherNode);
    assert.equal(otherStatus.events.SessionEnd.commandExists, true);
    assert.equal(otherStatus.events.SessionEnd.commandMatchesCurrentNode, false);
    assert.ok(otherStatus.warnings.includes('managed_hook_node_differs_from_current'));
    assert.doesNotMatch(JSON.stringify(otherStatus), /DO-NOT-PRINT/);
  });

  test('CLI hook-status prints JSON without writing, and failures show a Japanese remedy outside hooks', () => {
    const item = fixture('status-cli');
    installHooks(item);
    const before = fs.readFileSync(item.settingsPath);
    const environment = { ...process.env, CLAUDE_CONFIG_DIR: path.dirname(item.settingsPath) };
    const status = spawnSync(process.execPath, [offlineScriptCopy, 'hook-status', '--config', item.configPath],
      { encoding: 'utf8', timeout: 10000, env: environment });
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).events.SessionEnd.registered, true);
    assert.ok(fs.readFileSync(item.settingsPath).equals(before));
    const relative = spawnSync(process.execPath, [offlineScriptCopy, 'hook-status', '--config', 'relative.json'],
      { encoding: 'utf8', timeout: 10000, env: environment });
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /^Project Bridge: invalid_config\n/);
    assert.match(relative.stderr, /[぀-ヿ一-鿿]/);
    // hook の経路は、固定コードの 1 行だけを維持する。
    const hook = spawnSync(process.execPath, [offlineScriptCopy, 'hook', '--config', 'relative.json',
      '--managed-by', 'chatgpt-project-bridge-offline-v1'], { encoding: 'utf8', timeout: 10000, input: '{}' });
    assert.equal(hook.status, 1);
    assert.equal(hook.stderr, 'Project Bridge: invalid_config\n');
  });

  if (process.platform !== 'win32') {
    test('A group-writable offline-bridge.mjs is refused with unsafe_script_permissions and a remedy', () => {
      const item = fixture('writable-script');
      fs.chmodSync(offlineScriptCopy, 0o664);
      try {
        expectError(() => installHooks(item), /^unsafe_script_permissions$/);
        assert.equal(fs.existsSync(item.settingsPath), false);
        const result = spawnSync(process.execPath, [offlineScriptCopy, 'install-hook', '--config', item.configPath,
          '--settings', item.settingsPath], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /^Project Bridge: unsafe_script_permissions\n.*chmod go-w/);
      } finally {
        fs.chmodSync(offlineScriptCopy, 0o644);
      }
    });
  }

  if (process.platform !== 'win32') {
    test('Group-writable files/directories and hardlinks are refused', () => {
      const writableFile = fixture('writable-file');
      privateJson(writableFile.settingsPath, { retained: true }, 0o664);
      expectError(() => installHooks(writableFile), /unsafe_settings_permissions/);
      const writableDirectory = fixture('writable-directory');
      privateJson(writableDirectory.settingsPath, { retained: true });
      fs.chmodSync(path.dirname(writableDirectory.settingsPath), 0o777);
      expectError(() => installHooks(writableDirectory), /unsafe_settings_permissions/);
      const hardlink = fixture('hardlink');
      privateJson(hardlink.settingsPath, { retained: true });
      fs.linkSync(hardlink.settingsPath, path.join(hardlink.base, 'same-inode.json'));
      expectError(() => installHooks(hardlink), /unsafe_settings/);
    });

    test('Symlinked settings, ancestors, config, and backup directory are refused', () => {
      const linkedTarget = fixture('linked-target');
      const realSettings = path.join(linkedTarget.base, 'real-settings.json');
      privateJson(realSettings, { retained: true });
      fs.mkdirSync(path.dirname(linkedTarget.settingsPath), { mode: 0o700 });
      fs.symlinkSync(realSettings, linkedTarget.settingsPath);
      expectError(() => installHooks(linkedTarget), /unsafe_/);
      assert.deepEqual(loadSettings(realSettings), { retained: true });

      const linkedAncestor = fixture('linked-ancestor');
      const actualDirectory = path.join(linkedAncestor.base, 'real-claude');
      fs.mkdirSync(actualDirectory, { mode: 0o700 });
      fs.symlinkSync(actualDirectory, path.dirname(linkedAncestor.settingsPath));
      expectError(() => installHooks(linkedAncestor), /unsafe_/);
      assert.deepEqual(fs.readdirSync(actualDirectory), []);

      const linkedConfig = fixture('linked-config');
      const configLink = path.join(linkedConfig.stateDir, 'linked.json');
      fs.symlinkSync(linkedConfig.configPath, configLink);
      expectError(() => installHooks({ ...linkedConfig, configPath: configLink }), /unsafe_/);

      const linkedBackup = fixture('linked-backup');
      privateJson(linkedBackup.settingsPath, { retained: true });
      const backupTarget = path.join(linkedBackup.base, 'backup-target');
      fs.mkdirSync(backupTarget, { mode: 0o700 });
      fs.symlinkSync(backupTarget, path.join(linkedBackup.stateDir, 'hook-backups'));
      expectError(() => installHooks(linkedBackup), /unsafe_/);
      assert.deepEqual(loadSettings(linkedBackup.settingsPath), { retained: true });
      assert.deepEqual(fs.readdirSync(backupTarget), []);
    });
  }
  process.stdout.write('snapshot-hooks-selftest: ' + passedCount + ' tests passed. Claude Code runtime dispatch and Windows ACLs are not tested.\n');
} finally {
  if (originalClaudeConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDirectory;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
