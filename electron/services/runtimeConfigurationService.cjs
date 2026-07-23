const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CONFIG_FILES,
  getConfigPaths,
  loadUserConfigs
} = require('./configService.cjs');
const {
  loadSettings,
  saveSettings
} = require('./settingsService.cjs');

const APP_FOLDER_NAME = '物业工作照片归档助手';
const RUNTIME_CONFIGURATION_SCHEMA_VERSION = 1;
const MIGRATION_MARKER_FILE = 'runtime-configuration-migration.json';
const migrationLocks = new Map();

async function loadRuntimeConfiguration(paths, options = {}) {
  const roots = normalizeStorageRoots(paths);
  const fileSystem = options.fs || fs;
  const migration = await withMigrationLock(roots.canonicalRoot, () => (
    migrateLegacyConfiguration(roots, { ...options, fs: fileSystem })
  ));
  const [configResult, settings] = await Promise.all([
    loadUserConfigs(roots.canonicalRoot),
    loadSettings(roots.canonicalRoot)
  ]);
  return buildRuntimeConfiguration({
    runtimeConfigs: configResult.runtimeConfigs,
    settings,
    migration
  });
}

async function loadRuntimeEditableConfigs(paths, options = {}) {
  const roots = normalizeStorageRoots(paths);
  await withMigrationLock(roots.canonicalRoot, () => migrateLegacyConfiguration(roots, options));
  return loadUserConfigs(roots.canonicalRoot);
}

async function saveRuntimeSettings(paths, nextSettings, options = {}) {
  const roots = normalizeStorageRoots(paths);
  await withMigrationLock(roots.canonicalRoot, () => migrateLegacyConfiguration(roots, options));
  await saveSettings(roots.canonicalRoot, nextSettings, options);
  return loadRuntimeConfiguration(roots, options);
}

async function saveRuntimeDirectory(paths, directoryKind, directoryPath, options = {}) {
  const roots = normalizeStorageRoots(paths);
  await withMigrationLock(roots.canonicalRoot, () => migrateLegacyConfiguration(roots, options));
  const settings = await loadSettings(roots.canonicalRoot);
  const normalizedPath = String(directoryPath || '').trim();
  const patch = {};
  if (directoryKind === 'photoSource') {
    patch.defaultPhotoFolder = normalizedPath;
    patch.lastPhotoFolder = normalizedPath;
    patch.recentPhotoFolders = addRecent(settings.recentPhotoFolders, normalizedPath);
  } else if (directoryKind === 'archiveRoot') {
    patch.defaultArchiveRoot = normalizedPath;
    patch.lastArchiveRoot = normalizedPath;
    patch.recentArchiveRoots = addRecent(settings.recentArchiveRoots, normalizedPath);
  } else if (directoryKind === 'archivePackage') {
    patch.defaultArchivePackageRoot = normalizedPath;
  } else {
    throw new TypeError('运行目录类型无效。');
  }
  return saveRuntimeSettings(roots, { ...settings, ...patch }, options);
}

function buildRuntimeConfiguration({ runtimeConfigs, settings, migration }) {
  const photoSourceDirectory = firstText(settings.defaultPhotoFolder, settings.lastPhotoFolder);
  const archiveRootDirectory = firstText(settings.defaultArchiveRoot, settings.lastArchiveRoot);
  const archivePackageDirectory = firstText(settings.defaultArchivePackageRoot);
  const stablePayload = {
    schemaVersion: RUNTIME_CONFIGURATION_SCHEMA_VERSION,
    photoSourceDirectory,
    archiveRootDirectory,
    archivePackageDirectory,
    configs: runtimeConfigs,
    settings: stripSettingsDiagnostics(settings)
  };
  return {
    ...stablePayload,
    revision: createRevision(stablePayload),
    loadedFrom: 'userData',
    migratedFrom: migration.migratedFrom,
    validationWarnings: [
      ...migration.validationWarnings,
      ...(settings.warning ? [{ code: 'settings_read_warning', message: '系统设置读取异常。' }] : [])
    ]
  };
}

async function migrateLegacyConfiguration(paths, options = {}) {
  const roots = normalizeStorageRoots(paths);
  const fileSystem = options.fs || fs;
  const canonicalAppDir = path.join(roots.canonicalRoot, APP_FOLDER_NAME);
  const legacyAppDir = path.join(roots.legacyRoot, APP_FOLDER_NAME);
  const markerPath = path.join(canonicalAppDir, MIGRATION_MARKER_FILE);
  const warnings = [];
  const marker = await readJsonIfPresent(fileSystem, markerPath);
  if (marker?.status === 'completed') {
    return {
      migratedFrom: marker.migratedFrom === 'documents' ? 'documents' : '',
      validationWarnings: []
    };
  }

  const canonicalFiles = listConfigurationFiles(canonicalAppDir);
  const legacyFiles = listConfigurationFiles(legacyAppDir);
  const [canonicalExisting, legacyExisting] = await Promise.all([
    existingFiles(fileSystem, canonicalFiles),
    existingFiles(fileSystem, legacyFiles)
  ]);

  if (legacyExisting.length === 0) {
    return { migratedFrom: '', validationWarnings: [] };
  }

  if (canonicalExisting.length > 0) {
    const differs = await configurationSetsDiffer(fileSystem, canonicalExisting, legacyExisting);
    if (differs) {
      warnings.push({
        code: 'runtime_configuration_migration_conflict',
        message: '检测到旧位置和正式位置均有配置，已保留正式位置配置。'
      });
    }
    await writeJsonAtomically(fileSystem, markerPath, {
      schemaVersion: 1,
      status: 'completed',
      migratedFrom: '',
      conflict: differs,
      completedAt: resolveNow(options).toISOString()
    });
    return { migratedFrom: '', validationWarnings: warnings };
  }

  await fileSystem.mkdir(canonicalAppDir, { recursive: true });
  const copied = [];
  try {
    for (const sourcePath of legacyExisting) {
      const relativePath = path.relative(legacyAppDir, sourcePath);
      const targetPath = path.join(canonicalAppDir, relativePath);
      await copyFileAtomically(fileSystem, sourcePath, targetPath);
      copied.push(targetPath);
    }
    await writeJsonAtomically(fileSystem, markerPath, {
      schemaVersion: 1,
      status: 'completed',
      migratedFrom: 'documents',
      conflict: false,
      completedAt: resolveNow(options).toISOString()
    });
  } catch (error) {
    for (const targetPath of copied) {
      await fileSystem.rm(targetPath, { force: true }).catch(() => {});
    }
    throw error;
  }
  return { migratedFrom: 'documents', validationWarnings: [] };
}

function getRuntimeConfigurationPaths(paths) {
  const roots = normalizeStorageRoots(paths);
  const canonicalConfigPaths = getConfigPaths(roots.canonicalRoot);
  return {
    canonicalRoot: roots.canonicalRoot,
    legacyRoot: roots.legacyRoot,
    canonicalAppDir: path.join(roots.canonicalRoot, APP_FOLDER_NAME),
    legacyAppDir: path.join(roots.legacyRoot, APP_FOLDER_NAME),
    migrationMarkerPath: path.join(roots.canonicalRoot, APP_FOLDER_NAME, MIGRATION_MARKER_FILE),
    ...canonicalConfigPaths
  };
}

function normalizeStorageRoots(paths) {
  const canonicalRoot = String(paths?.canonicalRoot || paths?.userDataPath || '').trim();
  const legacyRoot = String(paths?.legacyRoot || paths?.documentsPath || '').trim();
  if (!canonicalRoot || !legacyRoot) throw new TypeError('运行配置存储位置无效。');
  return {
    canonicalRoot: path.resolve(canonicalRoot),
    legacyRoot: path.resolve(legacyRoot)
  };
}

function listConfigurationFiles(appDir) {
  return [
    path.join(appDir, 'settings.json'),
    ...Object.values(CONFIG_FILES).map((fileName) => path.join(appDir, 'config', fileName))
  ];
}

async function existingFiles(fileSystem, filePaths) {
  const result = [];
  for (const filePath of filePaths) {
    try {
      const stat = await fileSystem.stat(filePath);
      if (stat.isFile()) result.push(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return result;
}

async function configurationSetsDiffer(fileSystem, leftPaths, rightPaths) {
  const left = await hashConfigurationSet(fileSystem, leftPaths);
  const right = await hashConfigurationSet(fileSystem, rightPaths);
  return left !== right;
}

async function hashConfigurationSet(fileSystem, filePaths) {
  const items = [];
  for (const filePath of [...filePaths].sort()) {
    items.push({
      name: path.basename(filePath),
      content: await fileSystem.readFile(filePath, 'utf8')
    });
  }
  return createRevision(items);
}

async function copyFileAtomically(fileSystem, sourcePath, targetPath) {
  await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = createTemporaryPath(targetPath);
  let handle;
  try {
    const content = await fileSystem.readFile(sourcePath);
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomically(fileSystem, targetPath, value) {
  await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = createTemporaryPath(targetPath);
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonIfPresent(fileSystem, filePath) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

function withMigrationLock(canonicalRoot, action) {
  const previous = migrationLocks.get(canonicalRoot) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  migrationLocks.set(canonicalRoot, current);
  return current.finally(() => {
    if (migrationLocks.get(canonicalRoot) === current) migrationLocks.delete(canonicalRoot);
  });
}

function stripSettingsDiagnostics(settings) {
  const {
    settingsPath,
    pathStatus,
    warning,
    ...persistedSettings
  } = settings || {};
  return persistedSettings;
}

function addRecent(items, value) {
  const text = String(value || '').trim();
  return Array.from(new Set([text, ...(Array.isArray(items) ? items : [])].filter(Boolean))).slice(0, 5);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function createRevision(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createTemporaryPath(targetPath) {
  return `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
}

function resolveNow(options) {
  const value = typeof options.now === 'function' ? options.now() : options.now;
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new TypeError('运行配置迁移时间无效。');
  return date;
}

module.exports = {
  APP_FOLDER_NAME,
  MIGRATION_MARKER_FILE,
  RUNTIME_CONFIGURATION_SCHEMA_VERSION,
  buildRuntimeConfiguration,
  getRuntimeConfigurationPaths,
  loadRuntimeConfiguration,
  loadRuntimeEditableConfigs,
  migrateLegacyConfiguration,
  saveRuntimeDirectory,
  saveRuntimeSettings
};
