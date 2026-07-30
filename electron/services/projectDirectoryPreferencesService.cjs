const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'project-directory-preferences.json';
const DIRECTORY_TYPES = Object.freeze({
  archive_root: 'archiveRootDirectory',
  package_export: 'packageExportDirectory'
});
const preferencesWriteQueues = new Map();

class ProjectDirectoryPreferencesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectDirectoryPreferencesError';
    this.code = code;
  }
}

function getProjectDirectoryPreferencesPath(userDataPath) {
  const root = String(userDataPath || '').trim();
  if (!root) {
    throw new ProjectDirectoryPreferencesError(
      'project_directory_preferences_load_failed',
      '项目目录偏好存储位置无效。'
    );
  }
  return path.join(path.resolve(root), FILE_NAME);
}

async function withProjectDirectoryPreferencesWriteLock(filePath, action) {
  const normalizedPath = path.resolve(String(filePath || '').trim());
  const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  const previous = preferencesWriteQueues.get(key) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const queueTail = previous.catch(() => {}).then(() => current);
  preferencesWriteQueues.set(key, queueTail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    releaseCurrent();
    if (preferencesWriteQueues.get(key) === queueTail) {
      preferencesWriteQueues.delete(key);
    }
  }
}

async function loadProjectDirectoryPreferences(userDataPath, options = {}) {
  const fileSystem = options.fs || fs;
  const filePath = getProjectDirectoryPreferencesPath(userDataPath);
  let source;
  try {
    source = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyStore(options.now);
    throw new ProjectDirectoryPreferencesError(
      'project_directory_preferences_load_failed',
      '项目目录偏好读取失败。'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ProjectDirectoryPreferencesError(
      'project_directory_preferences_corrupt',
      '项目目录偏好文件已损坏。'
    );
  }
  return normalizeStore(parsed);
}

async function getProjectDirectoryPreferences(userDataPath, activeProject, options = {}) {
  const projectId = normalizeProjectId(activeProject);
  const store = await loadProjectDirectoryPreferences(userDataPath, options);
  const item = store.items.find((candidate) => candidate.projectId === projectId);
  return toPublicPreferences(item || createEmptyItem(projectId, options.now));
}

async function setProjectDirectoryPreference(
  userDataPath,
  activeProject,
  directoryType,
  directory,
  options = {}
) {
  const fileSystem = options.fs || fs;
  const projectId = normalizeProjectId(activeProject);
  const field = resolveDirectoryField(directoryType);
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedDirectory) {
    throw new ProjectDirectoryPreferencesError(
      directoryType === 'archive_root'
        ? 'project_archive_directory_invalid'
        : 'project_package_directory_invalid',
      directoryType === 'archive_root' ? '归档目录无效。' : '资料包输出目录无效。'
    );
  }

  const filePath = getProjectDirectoryPreferencesPath(userDataPath);
  return withProjectDirectoryPreferencesWriteLock(filePath, async () => {
    const store = await loadProjectDirectoryPreferences(userDataPath, options);
    const existing = store.items.find((candidate) => candidate.projectId === projectId)
      || createEmptyItem(projectId, options.now);
    const nextItem = {
      ...existing,
      [field]: normalizedDirectory,
      ...(directoryType === 'archive_root'
        ? {
            archiveRootHistory: uniqueDirectories([
              ...existing.archiveRootHistory,
              existing.archiveRootDirectory,
              normalizedDirectory
            ])
          }
        : {}),
      updatedAt: nowIso(options.now)
    };
    const nextStore = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(options.now),
      items: [
        ...store.items.filter((candidate) => candidate.projectId !== projectId),
        nextItem
      ].sort((left, right) => left.projectId.localeCompare(right.projectId))
    };
    await saveStore(userDataPath, nextStore, { ...options, fs: fileSystem });
    return toPublicPreferences(nextItem);
  });
}

async function clearProjectDirectoryPreference(
  userDataPath,
  activeProject,
  directoryType,
  options = {}
) {
  const projectId = normalizeProjectId(activeProject);
  const field = resolveDirectoryField(directoryType);
  const filePath = getProjectDirectoryPreferencesPath(userDataPath);
  return withProjectDirectoryPreferencesWriteLock(filePath, async () => {
    const store = await loadProjectDirectoryPreferences(userDataPath, options);
    const existing = store.items.find((candidate) => candidate.projectId === projectId);
    if (!existing || !existing[field]) {
      return toPublicPreferences(existing || createEmptyItem(projectId, options.now));
    }
    const nextItem = {
      ...existing,
      [field]: '',
      updatedAt: nowIso(options.now)
    };
    const nextStore = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(options.now),
      items: store.items.map((candidate) => (
        candidate.projectId === projectId ? nextItem : candidate
      ))
    };
    await saveStore(userDataPath, nextStore, options);
    return toPublicPreferences(nextItem);
  });
}

async function listProjectArchiveRoots(userDataPath, activeProject, options = {}) {
  const projectId = normalizeProjectId(activeProject);
  const store = await loadProjectDirectoryPreferences(userDataPath, options);
  const item = store.items.find((candidate) => candidate.projectId === projectId);
  if (!item) return [];
  return uniqueDirectories([
    item.archiveRootDirectory,
    ...item.archiveRootHistory
  ]);
}

async function saveStore(userDataPath, input, options = {}) {
  const fileSystem = options.fs || fs;
  const filePath = getProjectDirectoryPreferencesPath(userDataPath);
  const normalized = normalizeStore(input);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const backupPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.bak`;
  let handle;
  let movedExisting = false;
  try {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    if (typeof handle.sync === 'function') await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fileSystem.rename(filePath, backupPath);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fileSystem.rename(temporaryPath, filePath);
    const reread = await loadProjectDirectoryPreferences(userDataPath, { ...options, fs: fileSystem });
    if (JSON.stringify(reread) !== JSON.stringify(normalized)) {
      throw new Error('project_directory_preferences_verify_failed');
    }
    if (movedExisting) await fileSystem.rm(backupPath, { force: true });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    if (movedExisting) {
      await fileSystem.rm(filePath, { force: true }).catch(() => {});
      await fileSystem.rename(backupPath, filePath).catch(() => {});
    }
    if (error instanceof ProjectDirectoryPreferencesError) throw error;
    throw new ProjectDirectoryPreferencesError(
      'project_directory_preferences_save_failed',
      '项目目录偏好保存失败。'
    );
  }
}

function normalizeStore(input) {
  if (!isPlainObject(input) || Number(input.schemaVersion) !== SCHEMA_VERSION) {
    throw new ProjectDirectoryPreferencesError(
      'project_directory_preferences_invalid',
      '项目目录偏好结构无效。'
    );
  }
  const allowedRootKeys = new Set(['schemaVersion', 'updatedAt', 'items']);
  assertExactKeys(input, allowedRootKeys);
  if (!Array.isArray(input.items) || !isIsoTimestamp(input.updatedAt)) {
    throw invalidPreferences();
  }
  const seen = new Set();
  const items = input.items.map((item) => {
    if (!isPlainObject(item)) throw invalidPreferences();
    assertExactKeys(item, new Set([
      'projectId',
      'archiveRootDirectory',
      'packageExportDirectory',
      'archiveRootHistory',
      'updatedAt'
    ]));
    const projectId = String(item.projectId || '').trim();
    if (!projectId || seen.has(projectId) || !isIsoTimestamp(item.updatedAt)) {
      throw invalidPreferences();
    }
    seen.add(projectId);
    return {
      projectId,
      archiveRootDirectory: normalizeDirectory(item.archiveRootDirectory),
      packageExportDirectory: normalizeDirectory(item.packageExportDirectory),
      archiveRootHistory: uniqueDirectories(item.archiveRootHistory),
      updatedAt: item.updatedAt
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: input.updatedAt,
    items
  };
}

function createEmptyStore(now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(now),
    items: []
  };
}

function createEmptyItem(projectId, now) {
  return {
    projectId,
    archiveRootDirectory: '',
    packageExportDirectory: '',
    archiveRootHistory: [],
    updatedAt: nowIso(now)
  };
}

function toPublicPreferences(item) {
  return {
    projectId: item.projectId,
    archiveRootDirectory: item.archiveRootDirectory,
    packageExportDirectory: item.packageExportDirectory,
    updatedAt: item.updatedAt
  };
}

function normalizeProjectId(activeProject) {
  const projectId = String(activeProject?.projectId || '').trim();
  if (!projectId) {
    throw new ProjectDirectoryPreferencesError(
      'active_project_required',
      '请选择当前工作项目。'
    );
  }
  return projectId;
}

function resolveDirectoryField(directoryType) {
  const field = DIRECTORY_TYPES[String(directoryType || '').trim()];
  if (!field) {
    throw new ProjectDirectoryPreferencesError(
      'project_directory_preferences_invalid',
      '项目目录类型无效。'
    );
  }
  return field;
}

function normalizeDirectory(value) {
  const text = String(value || '').trim();
  return text ? path.normalize(path.resolve(text)) : '';
}

function uniqueDirectories(values) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  return source.reduce((result, value) => {
    const normalized = normalizeDirectory(value);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!normalized || seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function isIsoTimestamp(value) {
  const text = String(value || '');
  return Boolean(text && !Number.isNaN(Date.parse(text)));
}

function assertExactKeys(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalidPreferences();
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidPreferences() {
  return new ProjectDirectoryPreferencesError(
    'project_directory_preferences_invalid',
    '项目目录偏好结构无效。'
  );
}

module.exports = {
  DIRECTORY_TYPES,
  ProjectDirectoryPreferencesError,
  clearProjectDirectoryPreference,
  getProjectDirectoryPreferences,
  getProjectDirectoryPreferencesPath,
  listProjectArchiveRoots,
  loadProjectDirectoryPreferences,
  setProjectDirectoryPreference,
  withProjectDirectoryPreferencesWriteLock
};
