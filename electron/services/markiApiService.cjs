const crypto = require('node:crypto');

const MARKI_API_BASE_URL = 'https://open-api.markiapp.com';
const DEFAULT_TIMEOUT_MS = 15000;

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

function normalizeIntegerId(value, fieldName) {
  const text = String(value || '').trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number <= 0) {
    throw new MarkiApiError('invalid_request', `${fieldName} 必须为有效数字。`);
  }
  return number;
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
  listMarkiTeams,
  postMarkiApi,
  testMarkiConnection,
  toSafeMarkiError
};
