const crypto = require('node:crypto');
const path = require('node:path');
const {
  listMarkiMoments,
  MarkiApiError
} = require('./markiApiService.cjs');
const {
  buildMarkiSourceKey,
} = require('./markiSourceManifestService.cjs');
const {
  resolveMarkiImportSourceStatuses
} = require('./markiImportLifecycleService.cjs');
const {
  parseMarkiContent
} = require('./markiStructuredImportService.cjs');

const IDLE_TTL_MS = 15 * 60 * 1000;
const HARD_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 3;
const MAX_SESSION_PHOTOS = 1000;
const IMPORT_TASK_STATUSES = Object.freeze({
  IDLE: 'idle',
  IN_PROGRESS: 'in_progress',
  FAILED: 'failed',
  COMPLETED: 'completed'
});
const SESSION_INPUT_KEYS = new Set(['credentials', 'documentsPath', 'userDataPath', 'filters']);
const FILTER_KEYS = new Set(['teamId', 'uid', 'start', 'end']);
const SAFE_SOURCE_STATUSES = new Set([
  'discovered',
  'workspace_file_repairable',
  'queued',
  'downloading',
  'downloaded',
  'append_pending',
  'failed_retryable',
  'removed_reimportable',
  'imported_active',
  'archived_locked',
  'unavailable'
]);
const IMPORTABLE_SOURCE_STATUSES = new Set([
  'discovered',
  'workspace_file_repairable',
  'failed_retryable',
  'removed_reimportable'
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
    }),
    beginImport: (sessionId, selectionTokens, options = {}) => beginSelectionImport(
      sessions,
      sessionId,
      selectionTokens,
      {
        ...baseOptions,
        ...options
      }
    ),
    settleImport: (sessionId, input, options = {}) => settleSelectionImport(
      sessions,
      sessionId,
      input,
      {
        ...baseOptions,
        ...options
      }
    )
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

async function beginMarkiPhotoSelectionImport(sessionId, selectionTokens, options = {}) {
  return defaultSessionService.beginImport(sessionId, selectionTokens, options);
}

async function settleMarkiPhotoSelectionImport(sessionId, input, options = {}) {
  return defaultSessionService.settleImport(sessionId, input, options);
}

async function createSession(sessions, input, options) {
  const normalized = normalizeCreateInput(input, options);
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
    userDataPath: normalized.userDataPath,
    filters: normalized.filters,
    next: '',
    hasMore: false,
    limitReached: false,
    pageCount: 0,
    momentsBySelectionToken: new Map(),
    selectionTokenBySourceKey: new Map(),
    orderedSelectionTokens: [],
    importTasks: new Map(),
    createdAt: now,
    lastAccessedAt: now,
    idleExpiresAt: Math.min(now + IDLE_TTL_MS, now + HARD_TTL_MS),
    hardExpiresAt: now + HARD_TTL_MS
  };

  await appendPageToSession(session, result, dependencies);
  await refreshSessionSourceStatuses(session, dependencies);
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
  await refreshSessionSourceStatuses(session, dependencies);
  session.pageCount += 1;
  touchSession(session, getNow(options));
  return buildSafeSessionResult(session);
}

async function getSession(sessions, sessionId, options) {
  const now = getNow(options);
  const session = requireActiveSession(sessions, sessionId, now);
  await refreshSessionSourceStatuses(session, resolveDependencies(options));
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

  const candidateBySourceKey = new Map();
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
    const templateIdentity = resolveTemplateIdentity(moment);
    const existingToken = session.selectionTokenBySourceKey.get(sourceKey);
    if (existingToken) {
      continue;
    }
    const pageExisting = candidateBySourceKey.get(sourceKey);
    if (pageExisting) {
      continue;
    }
    if (session.orderedSelectionTokens.length + candidateBySourceKey.size >= MAX_SESSION_PHOTOS) {
      reachedPhotoLimit = true;
      break;
    }
    candidateBySourceKey.set(sourceKey, {
      moment: cloneMoment(moment),
      sourceKey,
      ...templateIdentity
    });
  }
  const candidates = [...candidateBySourceKey.values()];

  const sourceStatusResult = candidates.length
    ? await dependencies.resolveSourceStatuses({
      documentsPath: session.documentsPath,
      userDataPath: session.userDataPath,
      orgId: session.orgId,
      sourceKeys: candidates.map((item) => item.sourceKey)
    })
    : { bySourceKey: {} };
  const statusBySourceKey = sourceStatusResult?.bySourceKey || {};
  const preparedEntries = candidates.map((candidate, index) => ({
    ...candidate,
    selectionToken: createOpaqueId(dependencies.randomUUID),
    displayId: String(session.orderedSelectionTokens.length + index + 1),
    selectedSourceStatus: normalizeSourceStatus(
      statusBySourceKey[candidate.sourceKey] || 'discovered'
    )
  }));

  for (const entry of preparedEntries) {
    session.momentsBySelectionToken.set(entry.selectionToken, {
      moment: entry.moment,
      sourceKey: entry.sourceKey,
      displayId: entry.displayId,
      templateName: entry.templateName,
      templateKey: entry.templateKey,
      selectedSourceStatus: entry.selectedSourceStatus,
      importStatus: IMPORT_TASK_STATUSES.IDLE,
      importTaskId: ''
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

function beginSelectionImport(sessions, sessionId, selectionTokens, options) {
  const now = getNow(options);
  const session = requireActiveSession(sessions, sessionId, now);
  const normalizedTokens = normalizeSelectionTokens(selectionTokens);
  const tokenSetKey = [...normalizedTokens].sort().join('|');
  const entries = normalizedTokens.map((selectionToken) => {
    const entry = session.momentsBySelectionToken.get(selectionToken);
    if (!entry) {
      throw new MarkiPhotoQuerySessionError(
        'marki_photo_import_selection_invalid',
        '所选马克照片不存在或已失效。'
      );
    }
    return entry;
  });
  const retryTask = [...session.importTasks.values()].find(
    (task) => task.status === IMPORT_TASK_STATUSES.FAILED && task.tokenSetKey === tokenSetKey
  );

  if (retryTask) {
    for (const entry of entries) {
      if (
        entry.importStatus !== IMPORT_TASK_STATUSES.FAILED
        || entry.importTaskId !== retryTask.taskId
      ) {
        throw new MarkiPhotoQuerySessionError(
          'marki_photo_import_retry_state_invalid',
          '马克照片导入重试状态已变化，请重新查询。'
        );
      }
    }
    retryTask.status = IMPORT_TASK_STATUSES.IN_PROGRESS;
    retryTask.updatedAt = now;
    for (const entry of entries) {
      entry.importStatus = IMPORT_TASK_STATUSES.IN_PROGRESS;
    }
    touchSession(session, now);
    return buildTrustedImportTaskResult(session, retryTask, true);
  }

  if (entries.some((entry) => entry.importStatus === IMPORT_TASK_STATUSES.IN_PROGRESS)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_in_progress',
      '所选马克照片正在导入，请勿重复操作。'
    );
  }
  if (entries.some((entry) => entry.importStatus === IMPORT_TASK_STATUSES.COMPLETED)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_completed',
      '所选马克照片已完成导入。'
    );
  }
  if (entries.some((entry) => entry.importStatus === IMPORT_TASK_STATUSES.FAILED)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_retry_token_mismatch',
      '失败任务只能使用原照片集合重试。'
    );
  }
  if (entries.some((entry) => !IMPORTABLE_SOURCE_STATUSES.has(entry.selectedSourceStatus))) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_source_state_invalid',
      '所选照片当前状态不允许导入。'
    );
  }

  const dependencies = resolveDependencies(options);
  const taskId = createOpaqueId(dependencies.randomUUID);
  const task = {
    taskId,
    tokenSetKey,
    selectionTokens: [...normalizedTokens],
    effectiveSelectionTokens: [],
    batchId: '',
    status: IMPORT_TASK_STATUSES.IN_PROGRESS,
    createdAt: now,
    updatedAt: now
  };
  session.importTasks.set(taskId, task);
  for (const entry of entries) {
    entry.importStatus = IMPORT_TASK_STATUSES.IN_PROGRESS;
    entry.importTaskId = taskId;
  }
  touchSession(session, now);
  return buildTrustedImportTaskResult(session, task, false);
}

function settleSelectionImport(sessions, sessionId, input, options) {
  const normalizedSessionId = normalizeOpaqueId(sessionId, 'sessionId');
  const session = sessions.get(normalizedSessionId);
  if (!session) {
    return {
      success: true,
      sessionAvailable: false
    };
  }
  const normalized = normalizeSettleInput(input);
  const task = session.importTasks.get(normalized.taskId);
  if (!task || task.status !== IMPORT_TASK_STATUSES.IN_PROGRESS) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_task_state_invalid',
      '马克照片导入任务状态无效。'
    );
  }
  const taskTokenSet = new Set(task.selectionTokens);
  if (normalized.effectiveSelectionTokens.some((token) => !taskTokenSet.has(token))) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_task_state_invalid',
      '马克照片导入任务范围无效。'
    );
  }
  const now = getNow(options);
  task.status = normalized.status;
  task.batchId = normalized.batchId;
  task.effectiveSelectionTokens = [...normalized.effectiveSelectionTokens];
  task.updatedAt = now;
  for (const selectionToken of task.selectionTokens) {
    const entry = session.momentsBySelectionToken.get(selectionToken);
    if (!entry || entry.importTaskId !== task.taskId) continue;
    entry.importStatus = normalized.status;
    if (normalized.status === IMPORT_TASK_STATUSES.COMPLETED) {
      entry.selectedSourceStatus = 'append_pending';
    } else {
      entry.selectedSourceStatus = 'failed_retryable';
    }
  }
  touchSession(session, now);
  return {
    success: true,
    sessionAvailable: true,
    taskId: task.taskId,
    status: task.status
  };
}

function buildTrustedImportTaskResult(session, task, retry) {
  return {
    success: true,
    sessionId: session.sessionId,
    orgId: session.orgId,
    taskId: task.taskId,
    retry,
    batchId: task.batchId,
    selectionTokens: [...task.selectionTokens],
    effectiveSelectionTokens: [...task.effectiveSelectionTokens],
    querySummary: {
      ...session.filters,
      loadedCount: session.orderedSelectionTokens.length,
      selectedCount: task.selectionTokens.length
    },
    items: task.selectionTokens.map((selectionToken) => {
      const entry = session.momentsBySelectionToken.get(selectionToken);
      return {
        selectionToken,
        displayId: entry.displayId,
        sourceKey: entry.sourceKey,
        selectedSourceStatus: entry.selectedSourceStatus,
        templateName: entry.templateName,
        templateKey: entry.templateKey,
        moment: cloneMoment(entry.moment)
      };
    })
  };
}

function normalizeSelectionTokens(selectionTokens) {
  if (
    !Array.isArray(selectionTokens)
    || selectionTokens.length === 0
    || selectionTokens.length > MAX_SESSION_PHOTOS
  ) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_selection_invalid',
      '请选择需要导入的马克照片。'
    );
  }
  const normalized = selectionTokens.map((value) => normalizeOpaqueId(value, 'selectionToken'));
  if (new Set(normalized).size !== normalized.length) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_selection_invalid',
      '所选马克照片包含重复项。'
    );
  }
  return normalized;
}

function normalizeSettleInput(input) {
  const allowedKeys = new Set(['taskId', 'status', 'batchId', 'effectiveSelectionTokens']);
  if (!isPlainObject(input) || Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_task_state_invalid',
      '马克照片导入任务结果无效。'
    );
  }
  const status = String(input.status || '').trim();
  if (![IMPORT_TASK_STATUSES.FAILED, IMPORT_TASK_STATUSES.COMPLETED].includes(status)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_task_state_invalid',
      '马克照片导入任务结果无效。'
    );
  }
  const batchId = String(input.batchId || '').trim();
  if (batchId && !/^[A-Za-z0-9_-]{1,200}$/.test(batchId)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_task_state_invalid',
      '马克照片导入批次标识无效。'
    );
  }
  return {
    taskId: normalizeOpaqueId(input.taskId, 'taskId'),
    status,
    batchId,
    effectiveSelectionTokens: input.effectiveSelectionTokens === undefined
      ? []
      : normalizeEffectiveSelectionTokens(input.effectiveSelectionTokens)
  };
}

function normalizeEffectiveSelectionTokens(value) {
  if (!Array.isArray(value) || value.length > MAX_SESSION_PHOTOS) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_import_task_state_invalid',
      '马克照片导入任务范围无效。'
    );
  }
  if (value.length === 0) return [];
  return normalizeSelectionTokens(value);
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
    templateName: entry.templateName,
    templateKey: entry.templateKey,
    postTime: Number(moment.postTime) || 0,
    displayDate: formatPostTimeUtc8(moment.postTime),
    projectText: getOwnField(fields, '小区名称'),
    workContentText: getOwnField(fields, '工作内容') || getOwnField(fields, '标题'),
    locationText: getOwnField(fields, '地点'),
    selectedSourceStatus: entry.selectedSourceStatus
  };
}

function normalizeCreateInput(input, options = {}) {
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
  const userDataPath = String(
    input.userDataPath
    || (typeof options.checkMarkiSourceKeys === 'function' ? documentsPath : '')
  ).trim();
  if (!userDataPath || !path.isAbsolute(userDataPath)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_invalid_request',
      '马克照片查询状态目录不可用。'
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
    userDataPath,
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
    resolveSourceStatuses: options.resolveSourceStatuses
      || (typeof options.checkMarkiSourceKeys === 'function'
        ? createLegacySourceStatusResolver(options.checkMarkiSourceKeys)
        : resolveMarkiImportSourceStatuses),
    buildMarkiSourceKey: options.buildMarkiSourceKey || buildMarkiSourceKey,
    randomUUID: options.randomUUID || crypto.randomUUID
  };
}

function createLegacySourceStatusResolver(checkSourceKeys) {
  return async ({ documentsPath, orgId, sourceKeys }) => {
    const result = await checkSourceKeys(documentsPath, orgId, sourceKeys);
    return {
      success: true,
      bySourceKey: Object.fromEntries(sourceKeys.map((sourceKey) => {
        const item = result?.bySourceKey?.[sourceKey];
        const status = String(item?.importStatus || '');
        if (status === 'imported') return [sourceKey, 'removed_reimportable'];
        if ([
          'download_failed',
          'downloading',
          'repair_required',
          'repairing',
          'repair_failed'
        ].includes(status)) {
          return [sourceKey, status === 'downloading' ? 'downloading' : 'failed_retryable'];
        }
        return [sourceKey, 'discovered'];
      }))
    };
  };
}

function normalizeSourceStatus(value) {
  const status = String(value || '');
  if (!SAFE_SOURCE_STATUSES.has(status)) {
    throw new MarkiPhotoQuerySessionError(
      'marki_photo_query_source_status_invalid',
      '照片来源状态无法识别，请稍后重试。'
    );
  }
  return status;
}

async function refreshSessionSourceStatuses(session, dependencies) {
  const sourceKeys = session.orderedSelectionTokens
    .map((token) => session.momentsBySelectionToken.get(token)?.sourceKey)
    .filter(Boolean);
  if (sourceKeys.length === 0) return;
  const result = await dependencies.resolveSourceStatuses({
    documentsPath: session.documentsPath,
    userDataPath: session.userDataPath,
    orgId: session.orgId,
    sourceKeys
  });
  for (const selectionToken of session.orderedSelectionTokens) {
    const entry = session.momentsBySelectionToken.get(selectionToken);
    if (!entry) continue;
    if (entry.importStatus === IMPORT_TASK_STATUSES.IN_PROGRESS) {
      entry.selectedSourceStatus = 'downloading';
    } else if (entry.importStatus === IMPORT_TASK_STATUSES.FAILED) {
      entry.selectedSourceStatus = 'failed_retryable';
    } else if (entry.importStatus === IMPORT_TASK_STATUSES.COMPLETED) {
      entry.selectedSourceStatus = result.bySourceKey?.[entry.sourceKey] === 'imported_active'
        ? 'imported_active'
        : 'append_pending';
    } else {
      entry.selectedSourceStatus = normalizeSourceStatus(
        result.bySourceKey?.[entry.sourceKey] || 'discovered'
      );
    }
  }
}

function resolveTemplateIdentity(moment) {
  const templateName = normalizeTemplateName(moment?.markName);
  return {
    templateName,
    templateKey: templateName ? `name:${templateName}` : 'template_unknown'
  };
}

function normalizeTemplateName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 500);
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
  IMPORT_TASK_STATUSES,
  MAX_ACTIVE_SESSIONS,
  MAX_SESSION_PHOTOS,
  MarkiPhotoQuerySessionError,
  beginMarkiPhotoSelectionImport,
  cleanupExpiredMarkiPhotoQuerySessions,
  createMarkiPhotoQuerySession,
  createMarkiPhotoQuerySessionService,
  destroyMarkiPhotoQuerySession,
  getMarkiPhotoQuerySession,
  loadNextMarkiPhotoQueryPage,
  settleMarkiPhotoSelectionImport
};
