const crypto = require('node:crypto');

const MARKI_API_BASE_URL = 'https://open-api.markiapp.com';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_MOMENT_QUERY_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_MOMENT_PAGE_SIZE = 1000;
const MAX_MOMENT_CONTENT_LENGTH = 1024 * 1024;
const MAX_PAGINATION_CURSOR_LENGTH = 2000;
const MOMENT_QUERY_KEYS = new Set(['teamId', 'uid', 'start', 'end', 'next']);

class MarkiApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MarkiApiError';
    this.code = code;
    this.apiCode = options.apiCode;
    this.httpStatus = options.httpStatus;
    this.traceId = options.traceId || '';
  }
}

function buildMarkiPostSignature({ orgId, key, timestamp, traceId, bodyText = '' }) {
  const source = `orgId=${orgId}&key=${key}&timestamp=${timestamp}&traceId=${traceId}&data=${bodyText}`;
  return crypto.createHash('md5').update(source, 'utf8').digest('hex');
}

async function testMarkiConnection(credentials, options = {}) {
  const result = await listMarkiTeams(credentials, options);
  return {
    success: true,
    connectionStatus: 'connected',
    orgId: String(credentials.orgId || ''),
    teamCount: result.teams.length,
    traceId: result.traceId,
    checkedAt: new Date().toISOString()
  };
}

async function listMarkiTeams(credentials, options = {}) {
  const response = await postMarkiApi('/marki/org/team', credentials, null, {
    ...options,
    tracePrefix: 'photo-archive-team'
  });
  const list = Array.isArray(response.data?.teamOrgList) ? response.data.teamOrgList : [];
  return {
    success: true,
    teams: list.map(sanitizeTeam),
    traceId: response.traceId,
    receivedAt: new Date().toISOString()
  };
}

async function listMarkiMembers(credentials, input = {}, options = {}) {
  const teamId = normalizeIntegerId(input.teamId, 'teamId');
  const body = { teamId };
  const next = String(input.next || '').trim();
  if (next) body.next = next;
  const response = await postMarkiApi('/marki/team/mem', credentials, body, {
    ...options,
    tracePrefix: 'photo-archive-member'
  });
  const data = response.data || {};
  const list = Array.isArray(data.memberList) ? data.memberList : [];
  return {
    success: true,
    teamId: String(teamId),
    members: list.map(sanitizeMember),
    next: String(data.next || ''),
    hasMore: data.hasMore === true,
    regTotal: normalizeCount(data.regTotal),
    unRegTotal: normalizeCount(data.unRegTotal),
    total: normalizeCount(data.total),
    traceId: response.traceId,
    receivedAt: new Date().toISOString()
  };
}

async function listMarkiMoments(credentials, input = {}, options = {}) {
  const query = normalizeMomentQueryInput(input);
  const body = {
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(query.uid ? { uid: query.uid } : {}),
    start: query.start,
    end: query.end,
    ...(query.next ? { next: query.next } : {}),
    momType: 1
  };
  const response = await postMarkiApi('/marki/moment', credentials, body, {
    ...options,
    tracePrefix: 'photo-archive-moment'
  });
  const data = response.data || {};
  const list = data.momList;
  if (list !== undefined && !Array.isArray(list)) {
    throw new MarkiApiError('invalid_response', '马克平台返回的照片列表格式不正确。', {
      traceId: response.traceId
    });
  }
  if (Array.isArray(list) && list.length > MAX_MOMENT_PAGE_SIZE) {
    throw new MarkiApiError('invalid_response', '马克平台返回的单页照片数量超过允许上限。', {
      traceId: response.traceId
    });
  }
  const next = normalizePaginationCursor(data.next, {
    optional: true,
    errorCode: 'invalid_response',
    errorMessage: '马克平台返回的分页信息不正确。'
  });
  const hasMore = data.hasMore === true;
  if (hasMore && !next) {
    throw new MarkiApiError('invalid_response', '马克平台返回的分页信息不完整。', {
      traceId: response.traceId
    });
  }
  return {
    success: true,
    moments: (list || []).map((item) => sanitizeMoment(item, response.traceId)),
    next,
    hasMore,
    traceId: response.traceId,
    receivedAt: new Date().toISOString()
  };
}

async function postMarkiApi(endpoint, credentials, body, options = {}) {
  const orgId = String(credentials?.orgId || '').trim();
  const key = String(credentials?.key || '').trim();
  if (!/^\d+$/.test(orgId) || !key) {
    throw new MarkiApiError('marki_not_configured', '马克平台组织配置不完整。');
  }
  const timestamp = String(Math.floor((options.now?.() ?? Date.now()) / 1000));
  const traceId = String(options.traceId || createTraceId(options.tracePrefix));
  const bodyText = body === null || body === undefined ? '' : JSON.stringify(body);
  const sign = buildMarkiPostSignature({ orgId, key, timestamp, traceId, bodyText });
  const controller = new AbortController();
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    clearTimeout(timeout);
    throw new MarkiApiError('network_unavailable', '当前运行环境无法发起马克平台请求。', { traceId });
  }

  let response;
  try {
    response = await fetchImpl(`${options.baseUrl || MARKI_API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        orgId,
        timestamp,
        traceId,
        sign
      },
      body: bodyText || undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new MarkiApiError('request_timeout', '连接马克平台超时，请稍后重试。', { traceId });
    }
    throw new MarkiApiError('network_error', '无法连接马克平台，请检查网络后重试。', { traceId });
  } finally {
    clearTimeout(timeout);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new MarkiApiError('invalid_response', '马克平台返回了无法解析的数据。', {
      httpStatus: response.status,
      traceId
    });
  }
  const responseTraceId = String(payload?.traceId || traceId);
  if (!response.ok) {
    throw new MarkiApiError('http_error', `马克平台请求失败（HTTP ${response.status}）。`, {
      httpStatus: response.status,
      traceId: responseTraceId
    });
  }
  if (Number(payload?.code) !== 0) {
    const apiCode = Number(payload?.code);
    throw new MarkiApiError(`marki_api_${apiCode}`, getMarkiApiErrorMessage(apiCode), {
      apiCode,
      traceId: responseTraceId
    });
  }
  return {
    data: payload?.data || {},
    traceId: responseTraceId
  };
}

function sanitizeTeam(item = {}) {
  return {
    teamId: String(item.teamId ?? ''),
    teamName: String(item.teamName || ''),
    createUid: String(item.createUID ?? ''),
    manageUids: (Array.isArray(item.manageUIDs) ? item.manageUIDs : []).map((value) => String(value)),
    createTime: normalizeTimestamp(item.createTime),
    parentTeamId: String(item.parentTeam ?? ''),
    organizeId: String(item.OrganizeId ?? item.organizeId ?? '')
  };
}

function sanitizeMember(item = {}) {
  return {
    uid: String(item.uid ?? ''),
    nickname: String(item.nickname || ''),
    joinTime: normalizeTimestamp(item.joinTime),
    memberType: Number.isFinite(Number(item.memberType)) ? Number(item.memberType) : 0
  };
}

function sanitizeMoment(item = {}, traceId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new MarkiApiError('invalid_response', '马克平台返回了无效的照片记录。', { traceId });
  }
  const id = normalizeMomentResponseId(item.id, traceId);
  const uid = normalizeResponseId(item.uid, '拍照人员 ID', traceId);
  const teamId = normalizeResponseId(item.teamId, '团队 ID', traceId);
  const url = String(item.url || '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }
  if (!parsedUrl || parsedUrl.protocol !== 'https:' || url.length > 8192) {
    throw new MarkiApiError('invalid_response', '马克平台返回了无效的照片地址。', { traceId });
  }
  const momentType = Number(item.momentType);
  if (momentType !== 1) {
    throw new MarkiApiError('invalid_response', '马克平台返回了非照片类型的记录。', { traceId });
  }
  const postTime = Number(item.postTime);
  if (!Number.isSafeInteger(postTime) || postTime <= 0) {
    throw new MarkiApiError('invalid_response', '马克平台返回了无效的上传时间。', { traceId });
  }
  if (typeof item.content !== 'string' || item.content.length > MAX_MOMENT_CONTENT_LENGTH) {
    throw new MarkiApiError('invalid_response', '马克平台返回了无效的照片结构化内容。', { traceId });
  }
  return {
    id,
    uid,
    teamId,
    url,
    momentType,
    content: item.content,
    markName: String(item.markName || '').trim().slice(0, 500),
    lng: normalizeCoordinate(item.lng),
    lat: normalizeCoordinate(item.lat),
    postTime
  };
}

function normalizeMomentQueryInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MarkiApiError('invalid_request', '马克照片查询条件格式不正确。');
  }
  const extraKeys = Object.keys(input).filter((key) => !MOMENT_QUERY_KEYS.has(key));
  if (extraKeys.length) {
    throw new MarkiApiError('invalid_request', '马克照片查询包含不允许的参数。');
  }
  const start = normalizeUtc8DateTime(input.start, 'start');
  const end = normalizeUtc8DateTime(input.end, 'end');
  if (start.timestamp > end.timestamp) {
    throw new MarkiApiError('invalid_request', '查询开始时间不得晚于结束时间。');
  }
  if (end.timestamp - start.timestamp > MAX_MOMENT_QUERY_RANGE_MS) {
    throw new MarkiApiError('invalid_request', '马克照片单次查询时间范围不得超过 31 天。');
  }
  const teamId = input.teamId === undefined || input.teamId === null || input.teamId === ''
    ? null
    : normalizeIntegerId(input.teamId, 'teamId');
  const uid = input.uid === undefined || input.uid === null || input.uid === ''
    ? null
    : normalizeIntegerId(input.uid, 'uid');
  if (uid && !teamId) {
    throw new MarkiApiError('invalid_request', '按拍照人员查询时必须同时选择团队。');
  }
  return {
    teamId,
    uid,
    start: start.value,
    end: end.value,
    next: normalizePaginationCursor(input.next, {
      optional: true,
      errorCode: 'invalid_request',
      errorMessage: '分页参数不合法。'
    })
  };
}

function normalizeUtc8DateTime(value, fieldName) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) {
    throw new MarkiApiError('invalid_request', `${fieldName} 必须使用 yyyy-MM-dd HH:mm:ss 格式。`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const timestamp = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const utc8 = new Date(timestamp + 8 * 60 * 60 * 1000);
  if (
    utc8.getUTCFullYear() !== year
    || utc8.getUTCMonth() + 1 !== month
    || utc8.getUTCDate() !== day
    || utc8.getUTCHours() !== hour
    || utc8.getUTCMinutes() !== minute
    || utc8.getUTCSeconds() !== second
  ) {
    throw new MarkiApiError('invalid_request', `${fieldName} 不是有效的东八区日期时间。`);
  }
  return { value: text, timestamp };
}

function normalizePaginationCursor(value, options = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new MarkiApiError(
      options.errorCode || 'invalid_request',
      options.errorMessage || '分页参数不合法。'
    );
  }
  const text = String(value ?? '').trim();
  if (!text && options.optional) return '';
  if (
    !text
    || text.length > MAX_PAGINATION_CURSOR_LENGTH
    || /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new MarkiApiError(
      options.errorCode || 'invalid_request',
      options.errorMessage || '分页参数不合法。'
    );
  }
  return text;
}

function normalizeIntegerId(value, fieldName) {
  const text = String(value || '').trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number <= 0) {
    throw new MarkiApiError('invalid_request', `${fieldName} 必须为有效数字。`);
  }
  return number;
}

function normalizeResponseId(value, fieldName, traceId) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || text === '0') {
    throw new MarkiApiError('invalid_response', `马克平台返回了无效的${fieldName}。`, { traceId });
  }
  return text;
}

function normalizeMomentResponseId(value, traceId) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new MarkiApiError('invalid_response', '马克平台返回了无效的照片 ID。', { traceId });
  }
  return text;
}

function normalizeCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_TIMEOUT_MS;
}

function createTraceId(prefix = 'photo-archive') {
  return `${prefix || 'photo-archive'}-${crypto.randomUUID().replaceAll('-', '')}`;
}

function getMarkiApiErrorMessage(code) {
  const messages = {
    [-4]: '马克平台内部处理失败，请稍后重试。',
    [-109]: '查询条件不合法，请检查后重试。',
    404: '马克平台接口不存在或暂不可用。',
    601: '签名校验失败，请重新保存组织 KEY。',
    602: '马克平台无法解析请求内容。',
    603: '组织 ID 或签名不合法，请重新检查配置。',
    604: '本机时间与服务器时间偏差过大，请校准系统时间。',
    605: '组织 KEY 不存在或尚未生效。',
    606: '接口调用次数已达限制，请稍后重试。',
    701: '马克平台内部处理失败，请稍后重试。'
  };
  return messages[code] || `马克平台返回错误（代码 ${code}）。`;
}

function toSafeMarkiError(error) {
  if (error instanceof MarkiApiError) {
    return {
      code: error.code,
      message: error.message,
      traceId: error.traceId || '',
      apiCode: Number.isFinite(Number(error.apiCode)) ? Number(error.apiCode) : null,
      httpStatus: Number.isFinite(Number(error.httpStatus)) ? Number(error.httpStatus) : null
    };
  }
  const credentialMessages = {
    marki_not_configured: '尚未配置马克平台组织信息。',
    encryption_unavailable: '当前系统无法使用安全加密。',
    marki_credential_read_failed: '马克平台安全配置读取失败。',
    marki_credential_unavailable: '组织 KEY 无法在当前 Windows 用户或设备上解密，请重新配置。'
  };
  if (credentialMessages[error?.code]) {
    return {
      code: error.code,
      message: credentialMessages[error.code],
      traceId: '',
      apiCode: null,
      httpStatus: null
    };
  }
  return {
    code: 'marki_request_failed',
    message: '马克平台请求失败，请稍后重试。',
    traceId: '',
    apiCode: null,
    httpStatus: null
  };
}

module.exports = {
  MARKI_API_BASE_URL,
  MarkiApiError,
  buildMarkiPostSignature,
  listMarkiMembers,
  listMarkiMoments,
  listMarkiTeams,
  postMarkiApi,
  testMarkiConnection,
  toSafeMarkiError
};
