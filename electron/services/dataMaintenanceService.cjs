const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { CONFIG_FILES, getConfigPaths, normalizeEditableConfigs } = require('./configService.cjs');
const { loadSettings } = require('./settingsService.cjs');

async function getDataMaintenanceReport(options = {}) {
  const documentsPath = options.documentsPath;
  const checkedAt = new Date();
  const configPaths = getConfigPaths(documentsPath);
  const settings = await safeLoadSettings(documentsPath);
  const appDataDir = settings?.settingsPath ? path.dirname(settings.settingsPath) : path.dirname(configPaths.settingsPath);

  const configStatus = await inspectConfigStatus(configPaths);
  const directoryStatus = await inspectDirectories({
    settings,
    configPaths,
    appDataDir
  });
  const ledgerStatus = await inspectLedgerStatus(settings);
  const sortProgressStatus = await inspectSortProgressStatus(appDataDir);
  const packageStatus = await inspectArchivePackageStatus(settings);
  const suggestions = buildSuggestions({
    settings,
    configStatus,
    directoryStatus,
    ledgerStatus,
    sortProgressStatus,
    packageStatus
  });
  const overview = buildOverview({
    configStatus,
    directoryStatus,
    ledgerStatus,
    sortProgressStatus,
    packageStatus,
    checkedAt
  });

  return {
    success: true,
    checkedAt: checkedAt.toISOString(),
    settings,
    configStatus,
    directoryStatus,
    ledgerStatus,
    sortProgressStatus,
    packageStatus,
    suggestions,
    overview,
    safetyNotice: '数据维护中心仅进行只读检查，不删除、不移动、不修改照片、台账、配置或资料包。'
  };
}

async function safeLoadSettings(documentsPath) {
  try {
    return await loadSettings(documentsPath);
  } catch (error) {
    return {
      lastPhotoFolder: '',
      lastArchiveRoot: '',
      defaultPhotoFolder: '',
      defaultArchiveRoot: '',
      defaultArchivePackageRoot: '',
      recentPhotoFolders: [],
      recentArchiveRoots: [],
      settingsPath: getConfigPaths(documentsPath).settingsPath,
      warning: `设置读取失败：${error.message}`
    };
  }
}

async function inspectConfigStatus(configPaths) {
  const files = await Promise.all(Object.entries(CONFIG_FILES).map(async ([key, fileName]) => {
    const userFile = path.join(configPaths.userConfigDir, fileName);
    const defaultFile = path.join(configPaths.defaultConfigDir, fileName);
    const userStatus = await inspectPath(userFile, 'file');
    const defaultStatus = await inspectPath(defaultFile, 'file');
    const targetPath = userStatus.exists ? userFile : defaultFile;
    let readableJson = false;
    let error = '';
    let itemCount = 0;

    if (targetPath) {
      try {
        const data = await readJson(targetPath);
        readableJson = true;
        itemCount = Array.isArray(data) ? data.length : Object.keys(data || {}).length;
      } catch (readError) {
        error = readError.message;
      }
    }

    return {
      key,
      fileName,
      path: targetPath,
      userPath: userFile,
      defaultPath: defaultFile,
      exists: userStatus.exists || defaultStatus.exists,
      readable: readableJson,
      source: userStatus.exists ? '用户配置' : '内置配置',
      itemCount,
      status: readableJson ? 'normal' : 'error',
      message: readableJson ? '配置文件可读取' : (error || '配置文件不可读取')
    };
  }));

  let editableConfigs = null;
  let stats = {
    enabledProjects: 0,
    enabledDepartments: 0,
    enabledCategories: 0,
    enabledWorkItems: 0,
    enabledKeywords: 0,
    enabledScenes: 0
  };
  let error = '';

  try {
    const rawConfigs = {};
    for (const [key, fileName] of Object.entries(CONFIG_FILES)) {
      const userFile = path.join(configPaths.userConfigDir, fileName);
      const defaultFile = path.join(configPaths.defaultConfigDir, fileName);
      const targetPath = fsSync.existsSync(userFile) ? userFile : defaultFile;
      rawConfigs[key] = await readJson(targetPath);
    }
    editableConfigs = normalizeEditableConfigs(rawConfigs);
    stats = {
      enabledProjects: countEnabled(editableConfigs.projects),
      enabledDepartments: countEnabled(editableConfigs.departments),
      enabledCategories: countEnabled(editableConfigs.watermarkCategories),
      enabledWorkItems: editableConfigs.watermarkCategories.reduce((total, category) => total + countEnabled(category.items), 0),
      enabledKeywords: countEnabled(editableConfigs.keywords),
      enabledScenes: 0
    };
  } catch (statsError) {
    error = statsError.message;
  }

  const missingCount = files.filter((item) => !item.exists || !item.readable).length;
  return {
    status: missingCount === 0 && !error ? 'normal' : 'warning',
    summary: missingCount === 0 && !error ? '配置文件可读取，基础数据结构正常。' : '部分配置文件需要在系统设置中检查。',
    paths: configPaths,
    files,
    stats,
    error
  };
}

async function inspectDirectories({ settings, configPaths, appDataDir }) {
  const directories = [
    {
      key: 'sortDrafts',
      label: '分拣进度保存目录',
      path: path.join(appDataDir, 'sort-drafts'),
      source: '本地草稿目录',
      writeRequired: true,
      lazyCreate: true
    },
    {
      key: 'configBackup',
      label: '设置备份目录',
      path: configPaths.backupDir,
      source: '系统配置',
      writeRequired: true,
      lazyCreate: true
    }
  ];

  const items = await Promise.all(directories.map(async (directory) => {
    const status = await inspectPath(directory.path, 'directory');
    return {
      ...directory,
      ...status,
      status: getDirectoryHealth(directory, status),
      message: getDirectoryMessage(directory, status)
    };
  }));

  return {
    status: items.some((item) => item.status === 'error') ? 'warning' : 'normal',
    items
  };
}

async function inspectLedgerStatus() {
  return {
    status: 'project_managed',
    archiveRoot: '',
    ledgerPath: '',
    total: 0,
    existsCount: 0,
    missingCount: 0,
    missingPathCount: 0,
    latestDate: '',
    projectCount: 0,
    categoryCount: 0,
    message: '归档台账按当前项目在归档记录页检查。'
  };
}

async function inspectSortProgressStatus(appDataDir) {
  const draftsDir = path.join(appDataDir, 'sort-drafts');
  const dirStatus = await inspectPath(draftsDir, 'directory');
  if (!dirStatus.exists) {
    return {
      status: 'info',
      draftsDir,
      directoryExists: false,
      directoryReadable: false,
      count: 0,
      latestFile: '',
      latestTime: '',
      staleCount: 0,
      message: '尚未生成分拣草稿；首次保存或加载草稿时会自动创建目录。'
    };
  }

  const files = await listDirectFiles(draftsDir, (file) => file.toLowerCase().endsWith('.json'));
  const sorted = files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const staleBorder = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return {
    status: sorted.length > 0 ? 'normal' : 'info',
    draftsDir,
    directoryExists: true,
    directoryReadable: dirStatus.readable,
    count: sorted.length,
    latestFile: sorted[0]?.name || '',
    latestTime: sorted[0] ? new Date(sorted[0].mtimeMs).toISOString() : '',
    staleCount: sorted.filter((file) => file.mtimeMs < staleBorder).length,
    message: sorted.length > 0 ? `发现 ${sorted.length} 个分拣草稿文件。` : '目录可用，尚未保存分拣草稿。'
  };
}

async function inspectArchivePackageStatus() {
  return {
    status: 'project_managed',
    root: '',
    exists: false,
    readable: false,
    writable: false,
    packageCount: 0,
    latestPackage: '',
    latestTime: '',
    message: '资料包输出目录按当前项目在归档记录页管理。'
  };
}

function buildOverview({ configStatus, directoryStatus, ledgerStatus, sortProgressStatus, packageStatus, checkedAt }) {
  return [
    {
      key: 'config',
      label: '系统配置状态',
      status: configStatus.status,
      summary: configStatus.summary
    },
    {
      key: 'photoDir',
      label: '本地照片来源目录',
      status: 'project_managed',
      summary: '由照片分拣工作台按当前项目管理。'
    },
    {
      key: 'archiveRoot',
      label: '项目归档目录',
      status: 'project_managed',
      summary: '由照片分拣工作台和归档记录页按当前项目管理。'
    },
    {
      key: 'ledger',
      label: '归档台账状态',
      status: ledgerStatus.status,
      summary: ledgerStatus.message
    },
    {
      key: 'sortDraft',
      label: '分拣进度状态',
      status: sortProgressStatus.status,
      summary: sortProgressStatus.message
    },
    {
      key: 'packageRoot',
      label: '项目资料包输出目录',
      status: packageStatus.status,
      summary: packageStatus.message
    },
    {
      key: 'checkedAt',
      label: '最近检查时间',
      status: 'normal',
      summary: formatDateTime(checkedAt)
    }
  ];
}

function buildSuggestions({ configStatus, directoryStatus, ledgerStatus, sortProgressStatus, packageStatus }) {
  const suggestions = [];
  if (configStatus.status !== 'normal') {
    suggestions.push({
      level: 'warning',
      title: '配置文件需要检查',
      text: '建议进入系统设置核对基础数据；如需恢复，可在“设置备份与导入”中导入此前导出的设置 JSON。',
      action: 'settings-base-data'
    });
  }
  const invalidDirectories = directoryStatus.items.filter((item) => item.status === 'error');
  invalidDirectories.forEach((item) => {
    suggestions.push(buildDirectorySuggestion(item));
  });
  if (ledgerStatus.missingCount > 0) {
    suggestions.push({
      level: 'warning',
      title: '台账中存在文件缺失记录',
      text: `当前台账有 ${ledgerStatus.missingCount} 条文件缺失记录，可能是归档照片被移动或目录发生变化。建议先核对路径，不建议直接删除台账记录。`,
      action: 'missing-files'
    });
  }
  if (sortProgressStatus.staleCount > 0) {
    suggestions.push({
      level: 'info',
      title: '存在较早的分拣草稿',
      text: `发现 ${sortProgressStatus.staleCount} 个超过 30 天未更新的草稿。本版仅提示，不提供自动清理。`,
      action: 'sort-workspace'
    });
  }
  if (suggestions.length === 0) {
    suggestions.push({
      level: 'success',
      title: '当前未发现明显维护风险',
      text: '配置、目录、台账和资料包状态暂未发现异常。建议定期进入本页刷新检查。'
    });
  }
  return suggestions;
}

function buildDirectorySuggestion(item) {
  const actionMap = {
    sortDrafts: 'sort-workspace',
    configBackup: 'settings-backup'
  };
  const reason = !item.exists
    ? '目录不存在'
    : (!item.readable ? '目录不可读取' : '目录不可写入');
  const textMap = {
    sortDrafts: `本地分拣草稿目录${reason}，请打开分拣工作台重新保存一次草稿；如仍失败，请检查目录权限。`,
    configBackup: `设置备份目录${reason}，请进入系统设置重新生成一次备份；如仍失败，请检查目录权限。`
  };
  return {
    level: 'warning',
    title: `${item.label}${reason === '目录不可写入' ? '不可写入' : '不可用'}`,
    text: textMap[item.key] || `当前${item.label}${reason}，建议到系统设置中重新选择可访问的目录。`,
    action: actionMap[item.key] || 'settings-base-data'
  };
}

async function inspectPath(targetPath, type) {
  const configured = Boolean(targetPath);
  if (!configured) {
    return { configured: false, exists: false, readable: false, writable: false, message: '未配置' };
  }
  try {
    const stat = await fs.stat(targetPath);
    const matchesType = type === 'file' ? stat.isFile() : stat.isDirectory();
    const readable = await canAccess(targetPath, fsSync.constants.R_OK);
    const writable = await canAccess(targetPath, fsSync.constants.W_OK);
    return {
      configured: true,
      exists: matchesType,
      readable,
      writable,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      message: matchesType ? '可访问' : '路径类型不匹配'
    };
  } catch (error) {
    return {
      configured: true,
      exists: false,
      readable: false,
      writable: false,
      message: error.code === 'ENOENT' ? '路径不存在' : error.message
    };
  }
}

async function canAccess(targetPath, mode) {
  try {
    await fs.access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function getDirectoryHealth(directory, status) {
  if (!directory.path) return 'unset';
  if (directory.lazyCreate && !status.exists) return 'info';
  if (!status.exists || !status.readable) {
    return 'error';
  }
  if (directory.writeRequired && !status.writable) return 'error';
  return 'normal';
}

function getDirectoryMessage(directory, status) {
  if (!directory.path) return '未配置';
  if (directory.lazyCreate && !status.exists) return '尚未生成，首次使用时自动创建';
  if (!status.exists) return '目录不可用';
  if (!status.readable) return '目录不可读取';
  if (directory.writeRequired && !status.writable) return '目录可读取，但不可写入';
  return '目录可访问';
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

function countEnabled(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => item.enabled !== false).length;
}

function uniqueCount(values) {
  return new Set(values.map((value) => String(value || '').trim()).filter(Boolean)).size;
}

function topCounts(values) {
  const counter = new Map();
  values.map((value) => String(value || '').trim()).filter(Boolean).forEach((value) => {
    counter.set(value, (counter.get(value) || 0) + 1);
  });
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));
}

async function listDirectFiles(dir, predicate = () => true) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !predicate(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.stat(fullPath);
      files.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    return files;
  } catch {
    return [];
  }
}

async function listDirectDirectories(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.stat(fullPath);
      dirs.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
    }
    return dirs;
  } catch {
    return [];
  }
}

async function countPackageMarkers(packagePath) {
  try {
    const entries = await fs.readdir(packagePath, { withFileTypes: true });
    return entries.filter((entry) => (
      entry.name.startsWith('01_')
      || entry.name.startsWith('02_')
      || entry.name.endsWith('.txt')
    )).length;
  } catch {
    return 0;
  }
}

function formatDateTime(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

module.exports = { getDataMaintenanceReport };
