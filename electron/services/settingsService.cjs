const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SETTINGS_FILE_NAME = 'settings.json';
const MAX_RECENT_PATHS = 5;
const SETTINGS_SCHEMA_VERSION = 1;

function getSettingsPath(documentsPath) {
  return path.join(documentsPath, '物业工作照片归档助手', SETTINGS_FILE_NAME);
}

function getDefaultSettings() {
  return {
    lastPhotoFolder: '',
    lastArchiveRoot: '',
    defaultPhotoFolder: '',
    defaultArchiveRoot: '',
    defaultArchivePackageRoot: '',
    rememberLastPaths: true,
    archivePackageSettings: {
      groupingRule: 'project/category/workContent',
      packageNamePrefix: '物业照片资料包',
      generateReadme: true,
      generateCatalog: true,
      promptOpenAfterGenerated: true
    },
    recentPhotoFolders: [],
    recentArchiveRoots: []
  };
}

async function loadSettings(documentsPath, options = {}) {
  const settingsPath = getSettingsPath(documentsPath);
  const settings = getDefaultSettings();

  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(content);
    const validation = validateStoredSettingsData(parsed);
    if (!validation.valid) {
      const invalidError = new Error('系统设置业务结构无效。');
      invalidError.code = validation.validationCode;
      throw invalidError;
    }
    Object.assign(settings, parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (options.strictBusinessSchema === true) throw error;
      return { ...settings, settingsPath, warning: `设置文件读取失败：${error.message}` };
    }
  }

  return {
    ...normalizeSettings(settings),
    settingsPath,
    pathStatus: getPathStatus(settings)
  };
}

async function saveSettings(documentsPath, nextSettings, options = {}) {
  const settingsPath = getSettingsPath(documentsPath);
  const settings = normalizeSettings(nextSettings);
  await writeJsonAtomically(settingsPath, {
    ...settings,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex')
  }, options);
  return {
    ...settings,
    settingsPath,
    pathStatus: getPathStatus(settings)
  };
}

async function updateLastPhotoFolder(documentsPath, folderPath) {
  const settings = await loadSettings(documentsPath);
  return saveSettings(documentsPath, {
    ...settings,
    lastPhotoFolder: folderPath,
    defaultPhotoFolder: folderPath,
    recentPhotoFolders: addRecentPath(settings.recentPhotoFolders, folderPath)
  });
}

async function updateLastArchiveRoot(documentsPath, folderPath) {
  const settings = await loadSettings(documentsPath);
  return saveSettings(documentsPath, {
    ...settings,
    lastArchiveRoot: folderPath,
    defaultArchiveRoot: folderPath,
    recentArchiveRoots: addRecentPath(settings.recentArchiveRoots, folderPath)
  });
}

async function setDefaultArchiveRoot(documentsPath, folderPath) {
  const settings = await loadSettings(documentsPath);
  return saveSettings(documentsPath, {
    ...settings,
    defaultArchiveRoot: folderPath,
    recentArchiveRoots: addRecentPath(settings.recentArchiveRoots, folderPath)
  });
}

async function validatePathExists(targetPath) {
  return Boolean(targetPath && fsSync.existsSync(targetPath));
}

function normalizeSettings(settings) {
  const defaults = getDefaultSettings();
  const packageSettings = {
    ...defaults.archivePackageSettings,
    ...(settings.archivePackageSettings || {})
  };
  return {
    lastPhotoFolder: String(settings.lastPhotoFolder || ''),
    lastArchiveRoot: String(settings.lastArchiveRoot || ''),
    defaultPhotoFolder: String(settings.defaultPhotoFolder || ''),
    defaultArchiveRoot: String(settings.defaultArchiveRoot || ''),
    defaultArchivePackageRoot: String(settings.defaultArchivePackageRoot || ''),
    rememberLastPaths: settings.rememberLastPaths !== false,
    archivePackageSettings: {
      groupingRule: String(packageSettings.groupingRule || defaults.archivePackageSettings.groupingRule),
      packageNamePrefix: String(packageSettings.packageNamePrefix || defaults.archivePackageSettings.packageNamePrefix),
      generateReadme: packageSettings.generateReadme !== false,
      generateCatalog: packageSettings.generateCatalog !== false,
      promptOpenAfterGenerated: packageSettings.promptOpenAfterGenerated !== false
    },
    recentPhotoFolders: normalizePathList(settings.recentPhotoFolders),
    recentArchiveRoots: normalizePathList(settings.recentArchiveRoots)
  };
}

function validateStoredSettingsData(data) {
  try {
    if (!isPlainObject(data)) throw new Error('设置根节点无效');
    const businessKeys = new Set([
      'lastPhotoFolder',
      'lastArchiveRoot',
      'defaultPhotoFolder',
      'defaultArchiveRoot',
      'defaultArchivePackageRoot',
      'rememberLastPaths',
      'archivePackageSettings',
      'recentPhotoFolders',
      'recentArchiveRoots'
    ]);
    if (!Object.keys(data).some((key) => businessKeys.has(key))) {
      throw new Error('设置不包含业务字段');
    }
    for (const key of [
      'lastPhotoFolder',
      'lastArchiveRoot',
      'defaultPhotoFolder',
      'defaultArchiveRoot',
      'defaultArchivePackageRoot'
    ]) {
      if (data[key] !== undefined && typeof data[key] !== 'string') {
        throw new Error('设置路径字段无效');
      }
    }
    if (data.rememberLastPaths !== undefined && typeof data.rememberLastPaths !== 'boolean') {
      throw new Error('设置布尔字段无效');
    }
    for (const key of ['recentPhotoFolders', 'recentArchiveRoots']) {
      if (
        data[key] !== undefined
        && (
          !Array.isArray(data[key])
          || data[key].some((item) => typeof item !== 'string')
        )
      ) {
        throw new Error('最近目录字段无效');
      }
    }
    if (
      data.archivePackageSettings !== undefined
      && !isPlainObject(data.archivePackageSettings)
    ) {
      throw new Error('归档包设置无效');
    }
    if (data.archivePackageSettings !== undefined) {
      for (const key of ['groupingRule', 'packageNamePrefix']) {
        if (
          data.archivePackageSettings[key] !== undefined
          && typeof data.archivePackageSettings[key] !== 'string'
        ) {
          throw new Error('归档包文本设置无效');
        }
      }
      for (const key of ['generateReadme', 'generateCatalog', 'promptOpenAfterGenerated']) {
        if (
          data.archivePackageSettings[key] !== undefined
          && typeof data.archivePackageSettings[key] !== 'boolean'
        ) {
          throw new Error('归档包布尔设置无效');
        }
      }
    }
    if (
      data.schemaVersion !== undefined
      && (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1)
    ) {
      throw new Error('设置版本无效');
    }
    if (data.revision !== undefined && typeof data.revision !== 'string') {
      throw new Error('设置修订标识无效');
    }
    normalizeSettings(data);
    return { valid: true, validationCode: 'business_schema_valid' };
  } catch {
    return { valid: false, validationCode: 'invalid_settings_business_schema' };
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function writeJsonAtomically(filePath, value, options = {}) {
  const fileSystem = options.fs || fs;
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const backupPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.bak`;
  let handle;
  let movedExisting = false;
  try {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (typeof options.beforeInstall === 'function') await options.beforeInstall();
    try {
      await fileSystem.rename(filePath, backupPath);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fileSystem.rename(temporaryPath, filePath);
    if (movedExisting) await fileSystem.rm(backupPath, { force: true });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    if (movedExisting) {
      await fileSystem.rm(filePath, { force: true }).catch(() => {});
      await fileSystem.rename(backupPath, filePath).catch(() => {});
    }
    throw error;
  }
}

function normalizePathList(paths) {
  return Array.from(new Set((Array.isArray(paths) ? paths : []).map((item) => String(item || '').trim()).filter(Boolean))).slice(0, MAX_RECENT_PATHS);
}

function addRecentPath(paths, targetPath) {
  if (!targetPath) return normalizePathList(paths);
  return normalizePathList([targetPath, ...(Array.isArray(paths) ? paths : [])]);
}

function getPathStatus(settings) {
  return {
    lastPhotoFolderExists: pathExists(settings.lastPhotoFolder),
    lastArchiveRootExists: pathExists(settings.lastArchiveRoot),
    defaultPhotoFolderExists: pathExists(settings.defaultPhotoFolder),
    defaultArchiveRootExists: pathExists(settings.defaultArchiveRoot),
    defaultArchivePackageRootExists: pathExists(settings.defaultArchivePackageRoot),
    recentPhotoFolders: settings.recentPhotoFolders.map((folderPath) => ({ path: folderPath, exists: pathExists(folderPath) })),
    recentArchiveRoots: settings.recentArchiveRoots.map((folderPath) => ({ path: folderPath, exists: pathExists(folderPath) }))
  };
}

function pathExists(targetPath) {
  try {
    return Boolean(targetPath && fsSync.existsSync(targetPath) && fsSync.statSync(targetPath).isDirectory());
  } catch {
    return false;
  }
}

module.exports = {
  SETTINGS_SCHEMA_VERSION,
  getSettingsPath,
  getDefaultSettings,
  loadSettings,
  normalizeSettings,
  validateStoredSettingsData,
  saveSettings,
  updateLastPhotoFolder,
  updateLastArchiveRoot,
  setDefaultArchiveRoot,
  validatePathExists
};
