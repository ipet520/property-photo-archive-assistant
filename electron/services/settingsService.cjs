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

async function loadSettings(documentsPath) {
  const settingsPath = getSettingsPath(documentsPath);
  const settings = getDefaultSettings();

  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    Object.assign(settings, JSON.parse(content));
  } catch (error) {
    if (error.code !== 'ENOENT') {
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
  saveSettings,
  updateLastPhotoFolder,
  updateLastArchiveRoot,
  setDefaultArchiveRoot,
  validatePathExists
};
