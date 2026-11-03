/*
 * Offline snapshots: strict wire format and private local file operations.
 * No network, subprocess, startup, or credential output on import.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BAD_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const DAY_MS = 86400000;
const UNAVAILABLE_CODES = new Set(['unapproved', 'exposure_changed', 'capture_failed', 'disabled', 'limit_exceeded']);
const SENSITIVE_DIRECTORIES = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.claude', '.codex']);
const SENSITIVE_NAME = /(?:^\.env(?:\.|$)|\.(?:pem|key|pfx|p12|ppk|kdbx)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials)$|credential|secret)/i;

export class SnapshotError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireValue(condition, code = 'invalid_snapshot') {
  if (!condition) throw new SnapshotError(code);
}

export function assertIdentifier(value, label = 'identifier') {
  requireValue(typeof value === 'string' && SOURCE_ID_PATTERN.test(value), 'invalid_' + label);
  return value;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function assertKeys(value, required, optional = []) {
  requireValue(isRecord(value));
  const allowed = new Set([...required, ...optional]);
  requireValue(Object.keys(value).every(key => allowed.has(key)));
  requireValue(required.every(key => Object.hasOwn(value, key)));
}

function plainText(value, maxBytes, allowLines = false) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= maxBytes);
  if (!allowLines) requireValue(!BAD_CHARACTERS.test(value));
  else requireValue(!value.includes('\0'));
}

function isoTime(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  const milliseconds = Date.parse(value);
  requireValue(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value);
  return milliseconds;
}

// Canonical relative names only. Never use snapshot document IDs as disk paths.
export function assertDocumentPath(value) {
  plainText(value, 1024);
  requireValue(value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/'));
  const segments = value.split('/');
  requireValue(segments.every(segment => segment && segment !== '.' && segment !== '..'
    && !/[. ]$/.test(segment) && !/~[0-9]/.test(segment)
    && !SENSITIVE_DIRECTORIES.has(segment.toLowerCase())));
  requireValue(!SENSITIVE_NAME.test(segments.at(-1)));
  return value;
}

function stringArray(value, maximum, maxBytes) {
  requireValue(Array.isArray(value) && value.length <= maximum);
  for (const item of value) plainText(item, maxBytes, true);
}

function validateGit(git) {
  if (git === null) return;
  assertKeys(git,
    ['collectedAt', 'isGitRepository', 'branch', 'head', 'aheadBehindOriginMain', 'worktree', 'hidden'],
    ['gitUnavailableReason', 'changedPaths', 'recentCommits', 'submodules']);
  isoTime(git.collectedAt);
  requireValue(typeof git.isGitRepository === 'boolean');
  for (const key of ['branch', 'head', 'aheadBehindOriginMain']) plainText(git[key], 16384, true);
  if (git.gitUnavailableReason !== undefined) plainText(git.gitUnavailableReason, 2048, true);
  assertKeys(git.worktree, ['modified', 'added', 'deleted', 'untracked', 'other']);
  for (const count of Object.values(git.worktree)) requireValue(Number.isSafeInteger(count) && count >= 0 && count <= 1000000000);
  stringArray(git.hidden, 20, 100);
  if (git.changedPaths !== undefined) stringArray(git.changedPaths, 200, 4096);
  if (git.recentCommits !== undefined) stringArray(git.recentCommits, 100, 16384);
  if (git.submodules !== undefined) stringArray(git.submodules, 200, 4096);
}

// Validation is intentionally allowlisted, including fields, so transcripts,
// environment dumps, paths to the PC, arbitrary commands and extra records
// cannot accidentally become part of the wire format.
export function validateSnapshot(snapshot, { now = Date.now(), allowExpired = false } = {}) {
  assertKeys(snapshot, ['schemaVersion', 'kind', 'sourceId', 'capturedAt', 'expiresAt', 'projects', 'unavailable']);
  requireValue(snapshot.schemaVersion === 1 && snapshot.kind === 'chatgpt-project-bridge-snapshot');
  assertIdentifier(snapshot.sourceId, 'source_id');
  const capturedTime = isoTime(snapshot.capturedAt);
  const expiresTime = isoTime(snapshot.expiresAt);
  requireValue(capturedTime <= now + 120000, 'future_snapshot');
  requireValue(expiresTime > capturedTime && expiresTime - capturedTime <= 30 * DAY_MS, 'invalid_expiry');
  requireValue(allowExpired || expiresTime > now, 'expired_snapshot');
  requireValue(Array.isArray(snapshot.projects) && snapshot.projects.length <= 100);
  requireValue(Array.isArray(snapshot.unavailable) && snapshot.unavailable.length <= 100);
  const names = new Set();
  let documentCount = 0;
  for (const project of snapshot.projects) {
    assertKeys(project, ['name', 'projectName', 'capturedAt', 'exposureSha256', 'contextFile', 'statusFile', 'documents', 'git']);
    assertIdentifier(project.name, 'project_name');
    requireValue(!names.has(project.name.toLowerCase()));
    names.add(project.name.toLowerCase());
    plainText(project.projectName, 512);
    requireValue(isoTime(project.capturedAt) === capturedTime);
    requireValue(typeof project.exposureSha256 === 'string' && SHA256_PATTERN.test(project.exposureSha256));
    requireValue(Array.isArray(project.documents) && project.documents.length <= 500);
    documentCount += project.documents.length;
    requireValue(documentCount <= 1000, 'limit_exceeded');
    const documentIds = new Set();
    for (const document of project.documents) {
      assertKeys(document, ['id', 'path', 'title', 'modified', 'text', 'sha256', 'truncated']);
      assertDocumentPath(document.id);
      requireValue(document.path === document.id && !documentIds.has(document.id.toLowerCase()));
      documentIds.add(document.id.toLowerCase());
      plainText(document.title, 2048);
      isoTime(document.modified);
      plainText(document.text, MAX_DOCUMENT_BYTES, true);
      requireValue(typeof document.truncated === 'boolean');
      requireValue(typeof document.sha256 === 'string' && SHA256_PATTERN.test(document.sha256)
        && sha256(document.text) === document.sha256, 'document_hash_mismatch');
    }
    for (const kind of ['contextFile', 'statusFile']) {
      if (project[kind] !== null) {
        assertDocumentPath(project[kind]);
        requireValue(project.documents.some(document => document.id === project[kind]));
      }
    }
    validateGit(project.git);
  }
  for (const unavailable of snapshot.unavailable) {
    assertKeys(unavailable, ['name', 'code']);
    assertIdentifier(unavailable.name, 'project_name');
    requireValue(!names.has(unavailable.name.toLowerCase()) && UNAVAILABLE_CODES.has(unavailable.code));
    names.add(unavailable.name.toLowerCase());
  }
  requireValue(names.size <= 100 && Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES, 'limit_exceeded');
  return snapshot;
}

// Refuse links in every existing ancestor, including Windows junctions
// reported by Node as symbolic links. ACLs on Windows need separate review.
export function assertNoSymlinkPath(filePath, { allowMissing = false } = {}) {
  requireValue(typeof filePath === 'string' && path.isAbsolute(filePath) && !BAD_CHARACTERS.test(filePath), 'unsafe_path');
  const absolute = path.resolve(filePath);
  const root = path.parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let metadata;
    try { metadata = fs.lstatSync(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw new SnapshotError('unsafe_path');
    }
    requireValue(!metadata.isSymbolicLink(), 'unsafe_path');
    if (index < components.length - 1) requireValue(metadata.isDirectory(), 'unsafe_path');
  }
  return absolute;
}

export function assertPrivateDirectory(directory) {
  const absolute = assertNoSymlinkPath(directory);
  const metadata = fs.lstatSync(absolute);
  requireValue(metadata.isDirectory(), 'unsafe_directory');
  if (process.platform !== 'win32') {
    requireValue(metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0, 'unsafe_directory');
  }
  return absolute;
}

export function ensurePrivateDirectory(directory) {
  const absolute = assertNoSymlinkPath(directory, { allowMissing: true });
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return assertPrivateDirectory(absolute);
}

export function readPrivateFile(filePath, maxBytes = MAX_SNAPSHOT_BYTES) {
  const absolute = assertNoSymlinkPath(filePath);
  assertPrivateDirectory(path.dirname(absolute));
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(absolute);
    requireValue(opened.isFile() && opened.nlink === 1 && !named.isSymbolicLink()
      && opened.dev === named.dev && opened.ino === named.ino, 'unsafe_file');
    if (process.platform !== 'win32') {
      requireValue(opened.uid === process.getuid() && (opened.mode & 0o077) === 0, 'unsafe_file');
    }
    requireValue(opened.size <= maxBytes, 'file_too_large');
    const bytes = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
    let totalRead = 0;
    while (totalRead < bytes.length) {
      const read = fs.readSync(descriptor, bytes, totalRead, bytes.length - totalRead, totalRead);
      if (read === 0) break;
      totalRead += read;
    }
    requireValue(totalRead <= maxBytes, 'file_too_large');
    const after = fs.fstatSync(descriptor);
    requireValue(after.size === opened.size && after.mtimeMs === opened.mtimeMs
      && totalRead === opened.size, 'file_changed');
    return bytes.subarray(0, totalRead);
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(error?.code === 'ENOENT' ? 'file_missing' : 'unsafe_file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readPrivateJson(filePath, maxBytes = MAX_SNAPSHOT_BYTES) {
  const bytes = readPrivateFile(filePath, maxBytes);
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new SnapshotError('invalid_json'); }
}

// Data lands in a private, unpredictable same-directory temporary file.
// fsync + rename protects the previous complete snapshot on interruptions.
export function atomicWritePrivate(filePath, contents, { overwrite = true } = {}) {
  const absolute = assertNoSymlinkPath(filePath, { allowMissing: true });
  const directory = assertPrivateDirectory(path.dirname(absolute));
  if (fs.existsSync(absolute)) {
    requireValue(overwrite, 'file_exists');
    readPrivateFile(absolute, Math.max(MAX_SNAPSHOT_BYTES * 3, Buffer.byteLength(contents)));
  }
  const temporary = path.join(directory, '.snapshot-tmp-' + crypto.randomBytes(16).toString('hex'));
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!overwrite) {
      // link(2) is no-clobber. Remove the temporary name immediately.
      fs.linkSync(temporary, absolute);
      fs.unlinkSync(temporary);
    } else {
      assertNoSymlinkPath(absolute, { allowMissing: true });
      fs.renameSync(temporary, absolute);
    }
    if (process.platform !== 'win32') {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    }
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(error?.code === 'EEXIST' ? 'file_exists' : 'write_failed');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* Already renamed or absent. */ }
  }
}
