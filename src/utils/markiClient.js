function getMarkiApi() {
  return window.archiveAssistant?.marki || null;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MARKI_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function createDefaultMarkiImportFilters(nowValue = Date.now()) {
  const now = normalizeNowValue(nowValue);
  const beijingNow = new Date(now + BEIJING_OFFSET_MS);
  const date = formatUtcDate(beijingNow);
  return {
    teamId: '',
    uid: '',
    templateFilter: 'all',
    importStatusFilter: 'all',
    start: `${date}T00:00`,
    end: `${date}T${padDatePart(beijingNow.getUTCHours())}:${padDatePart(beijingNow.getUTCMinutes())}`
  };
}

export function parseMarkiImportBeijingDateTime(value) {
  const match = MARKI_DATE_TIME_PATTERN.exec(String(value || '').trim());
  if (!match) return Number.NaN;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const utcWallClock = Date.UTC(year, month - 1, day, hour, minute);
  const normalized = new Date(utcWallClock);
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
    || normalized.getUTCHours() !== hour
    || normalized.getUTCMinutes() !== minute
  ) {
    return Number.NaN;
  }
  return utcWallClock - BEIJING_OFFSET_MS;
}

export async function getMarkiConfigStatus() {
  const api = getMarkiApi();
  if (!api?.getConfigStatus) return createUnavailableResult('马克平台配置接口不可用。');
  try {
    return await api.getConfigStatus();
  } catch {
    return createUnavailableResult('马克平台配置读取失败。');
  }
}

export async function saveMarkiConfig(input = {}) {
  const api = getMarkiApi();
  if (!api?.saveConfig) return createUnavailableResult('马克平台配置保存接口不可用。');
  try {
    return await api.saveConfig(input);
  } catch {
    return createUnavailableResult('马克平台配置保存失败。');
  }
}

export async function clearMarkiConfig() {
  const api = getMarkiApi();
  if (!api?.clearConfig) return createUnavailableResult('马克平台配置清除接口不可用。');
  try {
    return await api.clearConfig();
  } catch {
    return createUnavailableResult('马克平台配置清除失败。');
  }
}

export async function testMarkiConnection() {
  const api = getMarkiApi();
  if (!api?.testConnection) return createUnavailableResult('马克平台连接测试接口不可用。');
  try {
    return await api.testConnection();
  } catch {
    return createUnavailableResult('马克平台连接测试失败。');
  }
}

export async function listMarkiTeams() {
  const api = getMarkiApi();
  if (!api?.listTeams) return createUnavailableResult('马克平台团队查询接口不可用。');
  try {
    return await api.listTeams();
  } catch {
    return createUnavailableResult('马克平台团队查询失败。');
  }
}

export async function listMarkiMembers(input = {}) {
  const api = getMarkiApi();
  if (!api?.listMembers) return createUnavailableResult('马克平台成员查询接口不可用。');
  try {
    return await api.listMembers(input);
  } catch {
    return createUnavailableResult('马克平台成员查询失败。');
  }
}

export async function startMarkiPhotoQuerySession(input = {}) {
  const api = getMarkiApi();
  if (!api?.startPhotoQuerySession) return createUnavailableResult('马克照片查询接口不可用。');
  try {
    return await api.startPhotoQuerySession(input);
  } catch {
    return createUnavailableResult('马克照片查询失败。');
  }
}

export async function getMarkiPhotoQuerySession(sessionId) {
  const api = getMarkiApi();
  if (!api?.getPhotoQuerySession) return createUnavailableResult('马克照片查询会话接口不可用。');
  try {
    return await api.getPhotoQuerySession(sessionId);
  } catch {
    return createUnavailableResult('马克照片查询会话读取失败。');
  }
}

export async function loadNextMarkiPhotoQueryPage(sessionId) {
  const api = getMarkiApi();
  if (!api?.loadNextPhotoQueryPage) return createUnavailableResult('马克照片分页查询接口不可用。');
  try {
    return await api.loadNextPhotoQueryPage(sessionId);
  } catch {
    return createUnavailableResult('马克照片下一页读取失败。');
  }
}

export async function destroyMarkiPhotoQuerySession(sessionId) {
  const api = getMarkiApi();
  if (!api?.destroyPhotoQuerySession) return createUnavailableResult('马克照片查询会话销毁接口不可用。');
  try {
    return await api.destroyPhotoQuerySession(sessionId);
  } catch {
    return createUnavailableResult('马克照片查询会话销毁失败。');
  }
}

export async function importMarkiPhotoQuerySelection(input = {}) {
  const api = getMarkiApi();
  if (!api?.importPhotoQuerySelection) return createUnavailableResult('马克照片导入接口不可用。');
  try {
    return await api.importPhotoQuerySelection(input);
  } catch {
    return createUnavailableResult('马克照片导入失败。');
  }
}

export async function listReadyMarkiImportBatches(activeProject) {
  const api = getMarkiApi();
  if (!api?.listReadyImportBatches) return createUnavailableResult('马克待处理批次查询接口不可用。');
  try {
    return await api.listReadyImportBatches(activeProject);
  } catch {
    return createUnavailableResult('马克待处理批次查询失败。');
  }
}

export async function listMarkiImportRecords(activeProject) {
  return callMarkiLocalMethod('listImportRecords', [activeProject], '马克导入记录读取失败。');
}

export async function recoverMarkiImportLifecycle(activeProject) {
  return callMarkiLocalMethod('recoverImportLifecycle', [activeProject], '马克导入任务恢复失败。');
}

export async function undoMarkiImportBatch(batchId, activeProject) {
  return callMarkiLocalMethod('undoImportBatch', [batchId, activeProject], '马克导入撤销失败。');
}

export async function clearMarkiImportRecord(batchId, activeProject) {
  return callMarkiLocalMethod('clearImportRecord', [batchId, activeProject], '马克导入记录清除失败。');
}

export async function cleanupMarkiImportCache(batchId, activeProject) {
  return callMarkiLocalMethod('cleanupImportCache', [batchId, activeProject], '马克下载缓存清理失败。');
}

export async function scanMarkiWorkbenchRecoveryCandidates(activeProject) {
  const api = getMarkiApi();
  if (!api?.scanWorkbenchRecoveryCandidates) {
    return createUnavailableResult('马克照片恢复扫描接口不可用。');
  }
  try {
    return await api.scanWorkbenchRecoveryCandidates(activeProject);
  } catch {
    return createUnavailableResult('已下载马克照片核对失败。');
  }
}

export async function recoverMarkiWorkbenchCandidates(input = {}) {
  const api = getMarkiApi();
  if (!api?.recoverWorkbenchCandidates) {
    return createUnavailableResult('马克照片恢复接口不可用。');
  }
  try {
    return await api.recoverWorkbenchCandidates(input);
  } catch {
    return createUnavailableResult('恢复已下载马克照片失败。');
  }
}

export function createMarkiReadyBatchRefresh(
  requestReadyBatches = listReadyMarkiImportBatches
) {
  if (typeof requestReadyBatches !== 'function') {
    throw new TypeError('马克待处理批次刷新函数无效。');
  }
  let pendingRequest = null;
  return function refreshReadyBatches(...args) {
    if (pendingRequest) return pendingRequest;
    const request = Promise.resolve()
      .then(() => requestReadyBatches(...args))
      .then(
        (result) => normalizeReadyBatchRefreshResult(result),
        () => createReadyBatchRefreshFailure('马克待处理批次查询失败。')
      );
    pendingRequest = request.finally(() => {
      pendingRequest = null;
    });
    return pendingRequest;
  };
}

export function normalizeReadyBatchRefreshResult(result) {
  if (result?.success !== true) {
    return createReadyBatchRefreshFailure(
      normalizeSafeMessage(result?.error?.message, '马克待处理批次查询失败。')
    );
  }
  if (!Array.isArray(result.items) || !Number.isInteger(result.failedCount) || result.failedCount < 0) {
    return createReadyBatchRefreshFailure('马克待处理批次返回数据异常，请重试。');
  }
  const items = [...result.items];
  const failedCount = result.failedCount;
  if (failedCount > 0) {
    return {
      success: true,
      items,
      failedCount,
      notice: {
        type: 'warning',
        text: items.length > 0
          ? `已刷新 ${items.length} 个待处理批次，另有 ${failedCount} 个批次文件无法读取。`
          : `当前没有可用的待处理批次，另有 ${failedCount} 个批次文件无法读取。`
      }
    };
  }
  return {
    success: true,
    items,
    failedCount,
    notice: {
      type: items.length > 0 ? 'success' : 'info',
        text: items.length > 0
          ? `已刷新，找到 ${items.length} 个待加入照片池的导入批次。`
          : '当前没有待加入照片池的导入批次。'
    }
  };
}

function createUnavailableResult(message) {
  return {
    success: false,
    connectionStatus: 'error',
    error: {
      code: 'marki_client_unavailable',
      message
    }
  };
}

async function callMarkiLocalMethod(methodName, args, fallbackMessage) {
  const api = getMarkiApi();
  if (typeof api?.[methodName] !== 'function') return createUnavailableResult(fallbackMessage);
  try {
    return await api[methodName](...args);
  } catch {
    return createUnavailableResult(fallbackMessage);
  }
}

function createReadyBatchRefreshFailure(message) {
  return {
    success: false,
    items: [],
    failedCount: 0,
    notice: {
      type: 'error',
      text: message
    }
  };
}

function normalizeSafeMessage(value, fallback) {
  const message = String(value || '').trim();
  return message || fallback;
}

function normalizeNowValue(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('马克导入默认时间无效。');
  }
  return timestamp;
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${padDatePart(date.getUTCMonth() + 1)}-${padDatePart(date.getUTCDate())}`;
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}
