const DEDUPE_WINDOW_MS = 5000;
const MAX_DETAIL_LENGTH = 8000;
const recentLogKeys = new Map();

export function serializeError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const parts = [
    error.name,
    error.message,
    error.stack
  ].filter(Boolean);
  if (parts.length > 0) return truncateDetail(parts.join('\n'));
  try {
    return truncateDetail(JSON.stringify(error, null, 2));
  } catch {
    return truncateDetail(String(error));
  }
}

export function getRuntimeSuggestion(operation = '', errorType = '') {
  const text = `${operation} ${errorType}`;
  if (text.includes('扫描')) return '请检查照片文件夹是否存在、是否有访问权限，确认后重新扫描。';
  if (text.includes('台账') || text.includes('归档')) return '请检查归档根目录和台账文件是否被 Excel 占用，关闭后重试。';
  if (text.includes('打开照片') || text.includes('打开文件') || text.includes('打开所在文件夹')) return '请检查文件是否存在，或到归档记录中核对文件路径。';
  if (text.includes('资料包')) return '请检查资料包导出目录是否存在、是否有写入权限。';
  if (text.includes('配置') || text.includes('设置')) return '请检查配置文件是否损坏，可尝试从设置备份中恢复。';
  if (text.includes('导出')) return '请检查目标目录是否存在、是否有写入权限。';
  return '请记录当前操作步骤，并导出运行日志交给维护人员排查。';
}

export async function recordRuntimeLog(payload = {}) {
  try {
    if (!window.archiveAssistant?.saveTrialIssue) return null;
    const summary = String(payload.summary || payload.message || payload.error?.message || '未知错误').trim();
    const page = String(payload.page || getCurrentPageName()).trim();
    const operation = String(payload.operation || '未知操作').trim();
    const key = `${page}|${operation}|${summary}`;
    const now = Date.now();
    const previousAt = recentLogKeys.get(key) || 0;
    if (now - previousAt < DEDUPE_WINDOW_MS) return null;
    recentLogKeys.set(key, now);

    const item = {
      logType: payload.logType || 'auto',
      level: payload.level || 'error',
      page,
      operation,
      errorType: payload.errorType || '未知错误',
      summary,
      suggestion: payload.suggestion || getRuntimeSuggestion(operation, payload.errorType),
      technicalDetail: truncateDetail(payload.technicalDetail || serializeError(payload.error)),
      status: payload.status || 'open',
      occurredAt: formatLocalDateTime(new Date())
    };
    return await window.archiveAssistant.saveTrialIssue(item);
  } catch {
    return null;
  }
}

export function installGlobalRuntimeLoggers() {
  const onError = (event) => {
    recordRuntimeLog({
      page: getCurrentPageName(),
      operation: '前端页面异常',
      errorType: 'window error',
      summary: event?.message || '页面脚本异常',
      technicalDetail: serializeError(event?.error) || `${event?.filename || ''}:${event?.lineno || ''}:${event?.colno || ''}`
    });
  };
  const onRejection = (event) => {
    recordRuntimeLog({
      page: getCurrentPageName(),
      operation: '前端异步异常',
      errorType: 'unhandledrejection',
      summary: event?.reason?.message || String(event?.reason || '未处理的异步异常'),
      technicalDetail: serializeError(event?.reason)
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

export function getCurrentPageName() {
  const text = document.querySelector('.nav-group button.active strong')?.textContent
    || document.querySelector('.page-hero h1')?.textContent
    || document.title
    || '其它';
  return text.trim() || '其它';
}

function truncateDetail(value) {
  const text = String(value || '').trim();
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}\n...内容已截断` : text;
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
