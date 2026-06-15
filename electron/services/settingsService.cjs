const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE_NAME = 'settings.json';
const MAX_RECENT_PATHS = 5;

function getSettingsPath(documentsPath) {
  return path.join(documentsPath, '物业工作照片归档助手', SETTINGS_FILE_NAME);
}

function getDefaultSettings() {
  return {
    lastPhotoFolder: '',
    lastArchiveRoot: '',
    defaultArchiveRoot: '',
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

async function saveSettings(documentsPath, nextSettings) {
  const settingsPath = getSettingsPath(documentsPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const settings = normalizeSettings(nextSettings);
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
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
    recentPhotoFolders: addRecentPath(settings.recentPhotoFolders, folderPath)
  });
}

async function updateLastArchiveRoot(documentsPath, folderPath) {
  const settings = await loadSettings(documentsPath);
  return saveSettings(documentsPath, {
    ...settings,
    lastArchiveRoot: folderPath,
    defaultArchiveRoot: settings.defaultArchiveRoot || folderPath,
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
  return {
    lastPhotoFolder: String(settings.lastPhotoFolder || ''),
    lastArchiveRoot: String(settings.lastArchiveRoot || ''),
    defaultArchiveRoot: String(settings.defaultArchiveRoot || ''),
    recentPhotoFolders: normalizePathList(settings.recentPhotoFolders),
    recentArchiveRoots: normalizePathList(settings.recentArchiveRoots)
  };
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
    defaultArchiveRootExists: pathExists(settings.defaultArchiveRoot),
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
  loadSettings,
  saveSettings,
  updateLastPhotoFolder,
  updateLastArchiveRoot,
  setDefaultArchiveRoot,
  validatePathExists
};
