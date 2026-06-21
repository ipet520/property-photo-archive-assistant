const { getDataMaintenanceReport } = require('./dataMaintenanceService.cjs');
const { loadSettings } = require('./settingsService.cjs');
const { loadSummaryData } = require('./summaryService.cjs');

async function loadDashboardData({ documentsPath, projectRoot }) {
  const loadedAt = new Date().toISOString();
  const settingsResult = await settle(() => loadSettings(documentsPath));
  const settings = settingsResult.value || emptySettings();
  const archiveRoot = settings.defaultArchiveRoot || settings.lastArchiveRoot || '';

  const [maintenanceResult, summaryResult] = await Promise.all([
    settle(() => getDataMaintenanceReport({ documentsPath, projectRoot })),
    settle(() => loadSummaryData({ archiveRoot, documentsPath, projectRoot }))
  ]);

  const maintenance = maintenanceResult.value || {};
  const summary = summaryResult.value || {};
  const photoRecords = Array.isArray(summary.photoRecords) ? summary.photoRecords : [];
  const rectificationItems = Array.isArray(summary.rectificationItems) ? summary.rectificationItems : [];
  const archiveMetrics = buildArchiveMetrics(photoRecords, maintenance.ledgerStatus);
  const rectificationMetrics = buildRectificationMetrics(rectificationItems);

  return {
    success: true,
    loadedAt,
    settings,
    archiveRoot,
    ledgerPath: summary.ledgerPath || maintenance.ledgerStatus?.ledgerPath || '',
    archiveMetrics,
    rectificationMetrics,
    recentArchiveRecords: sortRecent(photoRecords, (item) => item.archivedAt || item.date).slice(0, 5),
    recentRectificationItems: sortRecent(rectificationItems, (item) => item.updatedAt || item.createdAt || item.deadline).slice(0, 5),
    healthAlerts: buildHealthAlerts({
      maintenance,
      archiveMetrics,
      rectificationMetrics,
      settings,
      errors: {
        settings: settingsResult.error,
        maintenance: maintenanceResult.error,
        summary: summaryResult.error || summary.rectificationError
      }
    }),
    systemStatus: buildSystemStatus({ maintenance, settings, summary }),
    errors: {
      settings: settingsResult.error,
      maintenance: maintenanceResult.error,
      summary: summaryResult.error,
      rectification: summary.rectificationError || ''
    },
    safetyNotice: '首页数据全部只读，不删除、不移动、不压缩、不修改任何照片、台账、整改事项或配置。'
  };
}

function buildArchiveMetrics(records, fallback = {}) {
  if (!records.length && Number(fallback?.total || 0) > 0) {
    return {
      total: fallback.total || 0,
      existsCount: fallback.existsCount || 0,
      missingCount: fallback.missingCount || 0,
      projectCount: fallback.projectCount || 0,
      categoryCount: fallback.categoryCount || 0,
      latestDate: fallback.latestDate || '',
      message: fallback.message || ''
    };
  }

  const latestRecord = sortRecent(records, (record) => record.archivedAt || record.date)[0];
  return {
    total: records.length,
    existsCount: records.filter((record) => record.fileExists).length,
    missingCount: records.filter((record) => !record.fileExists).length,
    projectCount: uniqueCount(records.map((record) => record.project)),
    categoryCount: uniqueCount(records.map((record) => record.watermarkCategory)),
    latestDate: dateOnly(latestRecord?.archivedAt || latestRecord?.date),
    message: records.length ? `已读取 ${records.length} 条归档记录。` : (fallback?.message || '当前暂无归档数据。')
  };
}

function buildRectificationMetrics(items) {
  const today = startOfToday();
  const overdueCount = items.filter((item) => {
    if (!['待整改', '整改中'].includes(item.status) || !item.deadline) return false;
    const deadline = new Date(`${item.deadline}T23:59:59`);
    return !Number.isNaN(deadline.getTime()) && deadline < today;
  }).length;

  return {
    total: items.length,
    pendingCount: items.filter((item) => item.status === '待整改').length,
    doingCount: items.filter((item) => item.status === '整改中').length,
    doneCount: items.filter((item) => item.status === '已完成').length,
    closedCount: items.filter((item) => item.status === '已关闭').length,
    overdueCount
  };
}

function buildHealthAlerts({ maintenance, archiveMetrics, rectificationMetrics, settings, errors }) {
  const alerts = [];
  if (errors.settings) addAlert(alerts, 'warning', '系统配置读取失败', '已使用默认配置兜底，请到系统设置中检查。', 'settings');
  if (!settings.defaultArchiveRoot) addAlert(alerts, 'warning', '未配置默认归档根目录', '请到系统设置中配置默认归档根目录。', 'settings');
  else if (settings.pathStatus && !settings.pathStatus.defaultArchiveRootExists) addAlert(alerts, 'warning', '默认归档根目录不存在', '请到系统设置中重新选择可访问的目录。', 'settings');
  if (maintenance.ledgerStatus?.status === 'error' || errors.summary) addAlert(alerts, 'warning', '归档台账读取失败', maintenance.ledgerStatus?.message || errors.summary, 'searchCenter');
  else if (!maintenance.ledgerStatus?.ledgerExists && archiveMetrics.total === 0) addAlert(alerts, 'info', '未找到归档台账', '完成一次归档后，首页将显示归档统计。', 'searchCenter');
  if (archiveMetrics.missingCount > 0) addAlert(alerts, 'warning', '台账中存在文件缺失', `当前有 ${archiveMetrics.missingCount} 条归档文件缺失记录。`, 'dataMaintenance');
  if (rectificationMetrics.overdueCount > 0) addAlert(alerts, 'warning', '存在逾期整改事项', `当前有 ${rectificationMetrics.overdueCount} 条待整改或整改中事项已逾期。`, 'rectificationCenter');
  if (maintenance.configStatus?.status && maintenance.configStatus.status !== 'normal') addAlert(alerts, 'warning', '配置文件需要检查', maintenance.configStatus.summary || '请到系统设置中检查基础配置。', 'settings');
  if (maintenance.packageStatus?.status && maintenance.packageStatus.status !== 'normal') addAlert(alerts, 'info', '资料包目录需要关注', maintenance.packageStatus.message || '请检查默认资料包导出目录。', 'dataMaintenance');
  if (errors.maintenance) addAlert(alerts, 'warning', '数据健康检查失败', errors.maintenance, 'dataMaintenance');
  return alerts.slice(0, 6);
}

function buildSystemStatus({ maintenance, settings, summary }) {
  const directoryItems = maintenance.directoryStatus?.items || [];
  const findDirectory = (key) => directoryItems.find((item) => item.key === key);
  return {
    photoFolder: settings.defaultPhotoFolder || settings.lastPhotoFolder || '',
    archiveRoot: settings.defaultArchiveRoot || settings.lastArchiveRoot || '',
    packageRoot: settings.defaultArchivePackageRoot || '',
    rectificationPath: summary.rectificationSourcePath || '',
    rectificationStatus: summary.rectificationError
      ? `读取失败：${summary.rectificationError}`
      : (summary.rectificationMissing ? '暂无整改事项数据文件' : '整改事项数据可读取'),
    sortDraftStatus: maintenance.sortProgressStatus?.message || '未检查分拣进度',
    sortDraftPath: maintenance.sortProgressStatus?.draftsDir || '',
    configStatus: maintenance.configStatus?.summary || settings.warning || '系统配置可读取',
    configPath: settings.settingsPath || '',
    photoFolderStatus: findDirectory('defaultPhotoFolder')?.message || '',
    archiveRootStatus: findDirectory('defaultArchiveRoot')?.message || '',
    packageRootStatus: findDirectory('defaultArchivePackageRoot')?.message || maintenance.packageStatus?.message || ''
  };
}

function addAlert(alerts, level, title, text, targetPage) {
  if (alerts.some((item) => item.title === title)) return;
  alerts.push({ level, title, text: text || '请检查相关设置。', targetPage });
}

async function settle(loader) {
  try {
    return { value: await loader(), error: '' };
  } catch (error) {
    return { value: null, error: error?.message || String(error) };
  }
}

function sortRecent(items, getter) {
  return [...items].sort((a, b) => parseTime(getter(b)) - parseTime(getter(a)));
}

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dateOnly(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function uniqueCount(values) {
  return new Set(values.map((value) => String(value || '').trim()).filter(Boolean)).size;
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function emptySettings() {
  return {
    lastPhotoFolder: '',
    lastArchiveRoot: '',
    defaultPhotoFolder: '',
    defaultArchiveRoot: '',
    defaultArchivePackageRoot: '',
    recentPhotoFolders: [],
    recentArchiveRoots: [],
    pathStatus: {}
  };
}

module.exports = { loadDashboardData };
