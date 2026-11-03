#!/usr/bin/env node
/* Linux固有のsymlink・hardlink公開逸脱を一時プロジェクトで検証する。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'); // 同梱MCP本体。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bridge-security-')); // この試験だけの削除対象。
const projectRoot = path.join(temporaryRoot, 'project'); // 模擬プロジェクトルート。
const outsideRoot = path.join(temporaryRoot, 'outside'); // 公開境界外の模擬領域。
const marker = 'OUTSIDE_DOCUMENT_MUST_NOT_BE_EXPOSED'; // 漏えい検出用の非秘密マーカー。
const approvalPath = path.join(temporaryRoot, 'approval.json'); // この試験だけの公開範囲承認ファイル。

// 現在の試験用設定を承認済みにする。
function approveCurrentExposure() {
  const configPath = path.join(projectRoot, '.chatgpt-project-bridge.json');
  const printed = JSON.parse(execFileSync(process.execPath, [serverPath, '--print-exposure', '--project-root', projectRoot, '--config', configPath], { encoding: 'utf8' })); // 公開範囲と指紋。
  // サーバーは所有者以外が書ける承認ファイル・置き場所を承認として扱わないため、approve と同じ 0700 / 0600 にする（未承認による拒否と取り違えないため）。
  fs.chmodSync(path.dirname(approvalPath), 0o700);
  fs.writeFileSync(approvalPath, JSON.stringify({ schemaVersion: 1, sha256: printed.sha256, exposure: printed.exposure }), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(approvalPath, 0o600);
}

// MCP初期化後の任意操作を挟み、同じサーバープロセスへ対象文書を要求する。
function callDocument(relativePath, afterInitialize = null) {
  return new Promise((resolve, reject) => {
    const configPath = path.join(projectRoot, '.chatgpt-project-bridge.json');
    const child = spawn(process.execPath, [serverPath, '--stdio', '--project-root', projectRoot, '--config', configPath, '--approval-file', approvalPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let initialized = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        const item = JSON.parse(line);
        if (item.id !== 1 || initialized) continue;
        initialized = true;
        try {
          if (afterInitialize) afterInitialize();
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_document', arguments: { path: relativePath } } }) + '\n');
          child.stdin.end();
        } catch (error) {
          child.kill();
          reject(error);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`MCPプロセス終了コード=${code}: ${stderr}`));
      const responses = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      resolve({ joined: stdout, response: responses.find(item => item.id === 2) });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'linux-security-selftest', version: '1' } } }) + '\n');
  });
}

// 失敗応答かつ境界外マーカーがないことを検査する。
function assertRejected(result, label) {
  if (result.joined.includes(marker) || result.response?.result?.isError !== true) {
    throw new Error(`${label}が拒否されませんでした: ${result.joined}`);
  }
  process.stdout.write(`PASS ${label}を拒否\n`);
}

try {
  if (process.platform !== 'linux') {
    process.stdout.write('SKIP Linuxセキュリティ自己試験（Linux以外）\n');
    process.exit(0);
  }
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'CHATGPT_PROJECT_CONTEXT.md'), '# Context\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'CHATGPT_PROJECT_STATUS.md'), '# Status\n', 'utf8');
  fs.writeFileSync(path.join(outsideRoot, 'secret.md'), marker + '\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.chatgpt-project-bridge.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: 'Linux Security Selftest',
    contextFile: 'CHATGPT_PROJECT_CONTEXT.md',
    statusFile: 'CHATGPT_PROJECT_STATUS.md',
    allowFiles: ['CHATGPT_PROJECT_CONTEXT.md', 'CHATGPT_PROJECT_STATUS.md', 'README.md'],
    allowDirectories: [],
    denyDirectories: ['.git'],
    maxDocumentBytes: 524288,
  }), 'utf8');
  approveCurrentExposure();

  // 承認が有効であることを先に確かめる（未承認による拒否を、リンクの拒否と取り違えないため）。
  const accepted = await callDocument('CHATGPT_PROJECT_CONTEXT.md'); // 通常の文書の応答。
  if (accepted.response?.result?.isError !== false) throw new Error(`承認済みの文書を読めません: ${accepted.joined}`);
  process.stdout.write('PASS 承認済みの文書を読める\n');

  fs.symlinkSync(path.join(outsideRoot, 'secret.md'), path.join(projectRoot, 'README.md'));
  assertRejected(await callDocument('README.md'), '外部file symlink');
  fs.unlinkSync(path.join(projectRoot, 'README.md'));

  fs.linkSync(path.join(outsideRoot, 'secret.md'), path.join(projectRoot, 'README.md'));
  assertRejected(await callDocument('README.md'), 'hardlink');
  fs.unlinkSync(path.join(projectRoot, 'README.md'));

  // rootで実行できる検証環境では、サーバー起動後に追加したbind mountも拒否する。
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const readmePath = path.join(projectRoot, 'README.md');
    fs.writeFileSync(readmePath, '# Safe before bind\n', 'utf8');
    let mounted = false;
    try {
      const result = await callDocument('README.md', () => {
        execFileSync('mount', ['--bind', path.join(outsideRoot, 'secret.md'), readmePath]);
        mounted = true;
      });
      assertRejected(result, '起動後のbind mount');
    } finally {
      if (mounted) execFileSync('umount', [readmePath]);
    }
  } else {
    process.stdout.write('SKIP 起動後bind mount試験（root以外）\n');
  }
  process.stdout.write('PROJECT_BRIDGE_LINUX_SECURITY_SELFTEST PASS\n');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
