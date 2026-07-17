const crypto = require('node:crypto');
const path = require('node:path');
const {
  listMarkiMoments,
  MarkiApiError
} = require('./markiApiService.cjs');
const {
  buildMarkiSourceKey,
  checkMarkiSourceKeys
} = require('./markiSourceManifestService.cjs');
const {
  parseMarkiContent
} = require('./markiStructuredImportService.cjs');

const IDLE_TTL_MS = 15 * 60 * 1000;
const HARD_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 3;
const MAX_SESSION_PHOTOS = 1000;
const SESSION_INPUT_KEYS = new Set(['credentials', 'documentsPath', 'filters']);
const FILTER_KEYS = new Set(['teamId', 'uid', 'start', 'end']);
const SAFE_SOURCE_STATUSES = new Set([
  'discovered',
  'downloading',
  'download_failed',
  'imported'
]);

class MarkiPhotoQuerySessionError extends MarkiApiError {
  constructor(code, message) {
    super(code, message);
    this.name = 'MarkiPhotoQuerySessionError';
  }
}

function createMarkiPhotoQuerySessionService(baseOptions = {}) {
  const sessions = new Map();

  return {
    create: (input, options = {}) => createSession(sessions, input, {
      ...baseOptions,
      ...options
    }),
    loadNext: (sessionId, options = {}) => loadNextPage(sessions, sessionId, {
      ...baseOptions,
      ...options
    }),
    get: (sessionId, options = {}) => getSession(sessions, sessionId, {
      ...baseOptions,
      ...options
    }),
    destroy: (sessionId, options = {}) => destroySession(sessions, sessionId, {
      ...baseOptions,
      ...options
    }),
    cleanup: (options = {}) => cleanupSessions(sessions, {
      ...baseOptions,
      ...options
    })
  };
}

const defaultSessionService = createMarkiPhotoQuerySessionService();

async function createMarkiPhotoQuerySession(input, options = {}) {
  return defaultSessionService.create(input, options);
}

async function loadNextMarkiPhotoQueryPage(sessionId, options = {}) {
  return defaultSessionService.loadNext(sessionId, options);
}

async function getMarkiPhotoQuerySession(sessionId, options = {}) {
  return defaultSessionService.get(sessionId, options);
}

async function destroyMarkiPhotoQuerySession(sessionId, options = {}) {
  return defaultSessionService.destroy(sessionId, options);
}

async function cleanupExpiredMarkiPhotoQuerySessions(options = {}) {
  return defaultSessionService.cleanup(options);
}

async function createSession(sessions, input, options) {
  const normalized = normalizeCreateInput(input);
  const now = getNow(options);
  cleanupSessionsAt(sessions, now);
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_session_limit_reached',
      '当前马克照片查询会话数量已达上限，请先关闭其他查询。'
    );
  }

  const dependencies = resolveDependencies(options);
  const result = await dependencies.listMarkiMoments(
    normalized.credentials,
    normalized.filters,
    options.listOptions || {}
  );
  const sessionId = createOpaqueId(dependencies.randomUUID);
  const session = {
    sessionId,
    orgId: normalized.orgId,
    documentsPath: normalized.documentsPath,
    filters: normalized.filters,
    next: '',
    hasMore: false,
    limitReached: false,
    pageCount: 0,
    momentsBySelectionToken: new Map(),
    selectionTokenBySourceKey: new Map(),
    orderedSelectionTokens: [],
    createdAt: now,
    lastAccessedAt: now,
    idleExpiresAt: Math.min(now + IDLE_TTL_MS, now + HARD_TTL_MS),
    hardExpiresAt: now + HARD_TTL_MS
  };

  await appendPageToSession(session, result, dependencies);
  session.pageCount = 1;
  sessions.set(sessionId, session);
  return buildSafeSessionResult(session);
}

async function loadNextPage(sessions, sessionId, options) {
  const now = getNow(options);
  const session = requireActiveSession(sessions, sessionId, now);
  const credentials = normalizeCredentials(options.credentials);
  if (credentials.orgId !== session.orgId) {
    sessions.delete(session.sessionId);
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_organization_changed',
      '马克组织配置已变化，请重新查询照片。'
    );
  }
  touchSession(session, now);
  if (!session.hasMore || session.limitReached) {
    return buildSafeSessionResult(session);
  }

  const dependencies = resolveDependencies(options);
  const result = await dependencies.listMarkiMoments(
    credentials,
    {
      ...session.filters,
      next: session.next
    },
    options.listOptions || {}
  );
  await appendPageToSession(session, result, dependencies);
  session.pageCount += 1;
  touchSession(session, getNow(options));
  return buildSafeSessionResult(session);
}

async function getSession(sessions, sessionId, options) {
  const now = getNow(options);
  const session = requireActiveSession(sessions, sessionId, now);
  touchSession(session, now);
  return buildSafeSessionResult(session);
}

async function destroySession(sessions, sessionId) {
  const normalizedSessionId = normalizeOpaqueId(sessionId, 'sessionId');
  const destroyed = sessions.delete(normalizedSessionId);
  return {
    success: true,
    sessionId: normalizedSessionId,
    destroyed
  };
}

async function cleanupSessions(sessions, options) {
  const now = getNow(options);
  const removedCount = cleanupSessionsAt(sessions, now);
  return {
    success: true,
    removedCount,
    activeCount: sessions.size
  };
}

function cleanupSessionsAt(sessions, now) {
  let removedCount = 0;
  for (const [sessionId, session] of sessions) {
    if (isExpired(session, now)) {
      sessions.delete(sessionId);
      removedCount += 1;
    }
  }
  return removedCount;
}

async function appendPageToSession(session, result, dependencies) {
  if (!result || !Array.isArray(result.moments)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_response_invalid',
      '马克照片查询结果格式不正确。'
    );
  }

  const candidates = [];
  const candidateSourceKeys = new Set();
  let reachedPhotoLimit = false;
  for (const moment of result.moments) {
    const momentId = String(moment?.id || '').trim();
    if (!momentId) {
      throw new MarkiPhotoQuerySessionError(
        'marki_photo_query_response_invalid',
        '马克照片查询结果缺少照片标识。'
      );
    }
    const sourceKey = dependencies.buildMarkiSourceKey(session.orgId, momentId);
    if (session.selectionTokenBySourceKey.has(sourceKey)) continue;
    if (candidateSourceKeys.has(sourceKey)) continue;
    if (session.orderedSelectionTokens.length + candidates.length >= MAX_SESSION_PHOTOS) {
      reachedPhotoLimit = true;
      break;
    }
    candidateSourceKeys.add(sourceKey);
    candidates.push({ moment: cloneMoment(moment), sourceKey });
  }

  const sourceStatusResult = candidates.length
    ? await dependencies.checkMarkiSourceKeys(
      session.documentsPath,
      session.orgId,
      candidates.map((item) => item.sourceKey)
    )
    : { bySourceKey: {} };
  const statusBySourceKey = sourceStatusResult?.bySourceKey || {};
  const preparedEntries = candidates.map((candidate, index) => ({
    ...candidate,
    selectionToken: createOpaqueId(dependencies.randomUUID),
    displayId: String(session.orderedSelectionTokens.length + index + 1),
    selectedSourceStatus: normalizeSourceStatus(
      Object.hasOwn(statusBySourceKey, candidate.sourceKey)
        ? statusBySourceKey[candidate.sourceKey]
        : null
    )
  }));

  for (const entry of preparedEntries) {
    session.momentsBySelectionToken.set(entry.selectionToken, {
      moment: entry.moment,
      sourceKey: entry.sourceKey,
      displayId: entry.displayId,
      selectedSourceStatus: entry.selectedSourceStatus
    });
    session.selectionTokenBySourceKey.set(entry.sourceKey, entry.selectionToken);
    session.orderedSelectionTokens.push(entry.selectionToken);
  }

  if (reachedPhotoLimit || session.orderedSelectionTokens.length >= MAX_SESSION_PHOTOS) {
    session.limitReached = true;
  }
  session.hasMore = result.hasMore === true && !session.limitReached;
  session.next = session.hasMore ? String(result.next || '') : '';
  if (session.hasMore && !session.next) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_response_invalid',
      '马克照片查询结果缺少下一页信息。'
    );
  }
}

function buildSafeSessionResult(session) {
  return {
    success: true,
    sessionId: session.sessionId,
    photos: session.orderedSelectionTokens.map((selectionToken) => {
      const entry = session.momentsBySelectionToken.get(selectionToken);
      return buildSafePhotoSummary(selectionToken, entry);
    }),
    pagination: {
      loadedCount: session.orderedSelectionTokens.length,
      pageCount: session.pageCount,
      hasMore: session.hasMore,
      limitReached: session.limitReached
    },
    createdAt: new Date(session.createdAt).toISOString(),
    lastAccessedAt: new Date(session.lastAccessedAt).toISOString(),
    idleExpiresAt: new Date(session.idleExpiresAt).toISOString(),
    hardExpiresAt: new Date(session.hardExpiresAt).toISOString()
  };
}

function buildSafePhotoSummary(selectionToken, entry) {
  const moment = entry.moment;
  const parsed = parseMarkiContent(moment.content);
  const fields = parsed.success ? parsed.fields : Object.create(null);
  return {
    selectionToken,
    displayId: entry.displayId,
    teamId: String(moment.teamId || ''),
    uid: String(moment.uid || ''),
    photographerName: '',
    markName: String(moment.markName || ''),
    postTime: Number(moment.postTime) || 0,
    displayDate: formatPostTimeUtc8(moment.postTime),
    projectText: getOwnField(fields, '小区名称'),
    workContentText: getOwnField(fields, '工作内容') || getOwnField(fields, '标题'),
    locationText: getOwnField(fields, '地点'),
    selectedSourceStatus: entry.selectedSourceStatus
  };
}

function normalizeCreateInput(input) {
  if (!isPlainObject(input)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_invalid_request',
      '马克照片查询请求格式不正确。'
    );
  }
  assertOnlyKeys(input, SESSION_INPUT_KEYS);
  const credentials = normalizeCredentials(input.credentials);
  const documentsPath = String(input.documentsPath || '').trim();
  if (!documentsPath || !path.isAbsolute(documentsPath)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_invalid_request',
      '马克照片查询数据目录不可用。'
    );
  }
  if (!isPlainObject(input.filters)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_invalid_request',
      '马克照片查询条件格式不正确。'
    );
  }
  assertOnlyKeys(input.filters, FILTER_KEYS);
  return {
    credentials,
    orgId: credentials.orgId,
    documentsPath,
    filters: {
      ...(input.filters.teamId !== undefined ? { teamId: input.filters.teamId } : {}),
      ...(input.filters.uid !== undefined ? { uid: input.filters.uid } : {}),
      start: input.filters.start,
      end: input.filters.end
    }
  };
}

function normalizeCredentials(credentials) {
  const orgId = String(credentials?.orgId || '').trim();
  const key = String(credentials?.key || '').trim();
  if (!/^\d+$/.test(orgId) || !key) {
    throw new MarkiPhotoQuerySessionError(
      'marki_not_configured',
      '马克平台组织配置不完整。'
    );
  }
  return { orgId, key };
}

function assertOnlyKeys(value, allowedKeys) {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_invalid_request',
      '马克照片查询包含不允许的参数。'
    );
  }
}

function normalizeOpaqueId(value, fieldName) {
  const text = String(value || '').trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
  ) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_invalid_session',
      `${fieldName} 不合法。`
    );
  }
  return text;
}

function createOpaqueId(randomUUID) {
  return normalizeOpaqueId(randomUUID(), '随机标识');
}

function requireActiveSession(sessions, sessionId, now) {
  const normalizedSessionId = normalizeOpaqueId(sessionId, 'sessionId');
  const session = sessions.get(normalizedSessionId);
  if (!session) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_session_not_found',
      '马克照片查询会话不存在或已失效。'
    );
  }
  if (isExpired(session, now)) {
    sessions.delete(normalizedSessionId);
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_session_expired',
      '马克照片查询会话已过期，请重新查询。'
    );
  }
  cleanupSessionsAt(sessions, now);
  return session;
}

function isExpired(session, now) {
  return now >= session.idleExpiresAt || now >= session.hardExpiresAt;
}

function touchSession(session, now) {
  session.lastAccessedAt = now;
  session.idleExpiresAt = Math.min(now + IDLE_TTL_MS, session.hardExpiresAt);
}

function resolveDependencies(options) {
  return {
    listMarkiMoments: options.listMarkiMoments || listMarkiMoments,
    checkMarkiSourceKeys: options.checkMarkiSourceKeys || checkMarkiSourceKeys,
    buildMarkiSourceKey: options.buildMarkiSourceKey || buildMarkiSourceKey,
    randomUUID: options.randomUUID || crypto.randomUUID
  };
}

function normalizeSourceStatus(sourceInfo) {
  if (!sourceInfo?.exists) return 'new';
  const status = String(sourceInfo.importStatus || '');
  if (!SAFE_SOURCE_STATUSES.has(status)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_source_status_invalid',
      '照片来源状态无法识别，请稍后重试。'
    );
  }
  return status;
}

function formatPostTimeUtc8(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000 + 8 * 60 * 60 * 1000);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  ].join(' ');
}

function getOwnField(fields, key) {
  return Object.hasOwn(fields, key) ? String(fields[key] || '') : '';
}

function cloneMoment(moment) {
  return {
    id: String(moment.id || ''),
    uid: String(moment.uid || ''),
    teamId: String(moment.teamId || ''),
    url: String(moment.url || ''),
    momentType: Number(moment.momentType),
    content: String(moment.content || ''),
    markName: String(moment.markName || ''),
    lng: Number.isFinite(Number(moment.lng)) ? Number(moment.lng) : null,
    lat: Number.isFinite(Number(moment.lat)) ? Number(moment.lat) : null,
    postTime: Number(moment.postTime)
  };
}

function getNow(options) {
  const value = typeof options.now === 'function' ? options.now() : Date.now();
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_clock_invalid',
      '系统时间不可用，请校准后重试。'
    );
  }
  return Math.floor(number);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  HARD_TTL_MS,
  IDLE_TTL_MS,
  MAX_ACTIVE_SESSIONS,
  MAX_SESSION_PHOTOS,
  MarkiPhotoQuerySessionError,
  cleanupExpiredMarkiPhotoQuerySessions,
  createMarkiPhotoQuerySession,
  createMarkiPhotoQuerySessionService,
  destroyMarkiPhotoQuerySession,
  getMarkiPhotoQuerySession,
  loadNextMarkiPhotoQueryPage
};
