const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CONFIG_FILES,
  getConfigPaths,
  loadUserConfigs,
  validateStoredConfigData
} = require('./configService.cjs');
const {
  loadSettings,
  saveSettings,
  validateStoredSettingsData
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
    loadSettings(roots.canonicalRoot, { strictBusinessSchema: true })
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
  const settings = await loadSettings(roots.canonicalRoot, { strictBusinessSchema: true });
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
  await fileSystem.mkdir(canonicalAppDir, { recursive: true });
  const fileResults = {};
  let migratedCount = 0;
  const completedAt = resolveNow(options).toISOString();
  for (const canonicalPath of listConfigurationFiles(canonicalAppDir)) {
    const relativePath = path.relative(canonicalAppDir, canonicalPath).replaceAll('\\', '/');
    const legacyPath = path.join(legacyAppDir, ...relativePath.split('/'));
    const [canonicalState, legacyState] = await Promise.all([
      inspectJsonConfigurationFile(fileSystem, canonicalPath, relativePath),
      inspectJsonConfigurationFile(fileSystem, legacyPath, relativePath)
    ]);
    const result = {
      fileName: relativePath,
      canonicalStatus: canonicalState.status,
      legacyStatus: legacyState.status,
      action: 'none',
      conflict: false,
      sourceSha256: legacyState.hash,
      targetSha256: canonicalState.hash,
      completedAt,
      validationCode: canonicalState.status === 'missing'
        ? legacyState.validationCode
        : canonicalState.validationCode
    };

    if (canonicalState.status === 'valid') {
      result.action = 'preserved_canonical';
      result.conflict = legacyState.status === 'valid'
        && canonicalState.hash !== legacyState.hash;
      if (result.conflict) {
        warnings.push({
          code: 'runtime_configuration_migration_conflict',
          message: `${relativePath} 的正式配置与旧配置不同，已保留正式配置。`
        });
      }
    } else if (canonicalState.status === 'missing' && legacyState.status === 'valid') {
      await copyFileAtomically(fileSystem, legacyPath, canonicalPath);
      const migratedState = await inspectJsonConfigurationFile(
        fileSystem,
        canonicalPath,
        relativePath
      );
      if (migratedState.status !== 'valid' || migratedState.hash !== legacyState.hash) {
        throw new Error(`运行配置迁移校验失败：${relativePath}`);
      }
      result.canonicalStatus = migratedState.status;
      result.targetSha256 = migratedState.hash;
      result.validationCode = migratedState.validationCode;
      result.action = 'migrated_from_documents';
      migratedCount += 1;
    } else if (canonicalState.status === 'corrupt_json') {
      result.action = 'blocked_canonical_corrupt_json';
      warnings.push({
        code: 'runtime_configuration_canonical_corrupt_json',
        message: `${relativePath} 的正式配置损坏，已拒绝使用旧配置覆盖。`
      });
    } else if (canonicalState.status === 'invalid_business_schema') {
      result.action = 'blocked_canonical_invalid_business_schema';
      warnings.push({
        code: 'runtime_configuration_canonical_invalid_business_schema',
        message: `${relativePath} 的正式配置业务结构无效，已拒绝使用旧配置覆盖。`
      });
    } else if (legacyState.status === 'corrupt_json') {
      result.action = 'blocked_legacy_corrupt_json';
      warnings.push({
        code: 'runtime_configuration_legacy_corrupt_json',
        message: `${relativePath} 的旧配置损坏，未执行迁移。`
      });
    } else if (legacyState.status === 'invalid_business_schema') {
      result.action = 'blocked_legacy_invalid_business_schema';
      warnings.push({
        code: 'runtime_configuration_legacy_invalid_business_schema',
        message: `${relativePath} 的旧配置业务结构无效，未执行迁移。`
      });
    } else {
      result.action = 'not_present';
    }
    fileResults[relativePath] = result;
  }
  const migratedFrom = migratedCount > 0 || marker?.migratedFrom === 'documents'
    ? 'documents'
    : '';
  await writeJsonAtomically(fileSystem, markerPath, {
    schemaVersion: 2,
    status: warnings.length > 0 ? 'completed_with_warnings' : 'completed',
    migratedFrom,
    upgradedFromSchemaVersion: Number(marker?.schemaVersion) === 1 ? 1 : 0,
    fileResults,
    completedAt
  });
  return { migratedFrom, validationWarnings: warnings };
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

async function inspectJsonConfigurationFile(fileSystem, filePath, relativePath) {
  let content;
  try {
    content = await fileSystem.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        status: 'missing',
        hash: '',
        validationCode: 'configuration_file_missing'
      };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    const validation = validateConfigurationBusinessSchema(relativePath, parsed);
    if (!validation.valid) {
      return {
        status: 'invalid_business_schema',
        hash: crypto.createHash('sha256').update(content).digest('hex'),
        validationCode: validation.validationCode
      };
    }
    return {
      status: 'valid',
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      validationCode: validation.validationCode
    };
  } catch {
    return {
      status: 'corrupt_json',
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      validationCode: 'configuration_json_parse_failed'
    };
  }
}

function validateConfigurationBusinessSchema(relativePath, parsed) {
  if (relativePath === 'settings.json') {
    return validateStoredSettingsData(parsed);
  }
  const fileName = path.basename(relativePath);
  const configName = Object.entries(CONFIG_FILES)
    .find(([, configuredFileName]) => configuredFileName === fileName)?.[0];
  return configName
    ? validateStoredConfigData(configName, parsed)
    : { valid: false, validationCode: 'unknown_configuration_file' };
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
