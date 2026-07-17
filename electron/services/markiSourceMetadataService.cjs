const fs = require('node:fs/promises');
const path = require('node:path');
const {
  buildMarkiSourceKey,
  getMarkiImportRoot
} = require('./markiSourceManifestService.cjs');

const SOURCE_TYPE = 'marki_api';
const SOURCE_METADATA_REF_PREFIX = 'marki_source_metadata';
const SOURCE_METADATA_DIRECTORY_NAME = 'source-metadata';
const SOURCE_METADATA_SCHEMA_VERSION = 1;
const SOURCE_METADATA_FIELD_SET = new Set([
  'schemaVersion',
  'sourceMetadataRef',
  'sourceKey',
  'sourceType',
  'orgId',
  'momentId',
  'teamId',
  'uid',
  'postTime',
  'capturedAt',
  'markName',
  'antiCounterfeitCode',
  'parsedEntries',
  'createdAt',
  'updatedAt'
]);
const RESERVED_FIELD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const metadataWriteQueues = new Map();

class MarkiSourceMetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiSourceMetadataError';
    this.code = code;
  }
}

function buildMarkiSourceMetadataRef(orgId, momentId) {
  return `${SOURCE_METADATA_REF_PREFIX}:${normalizeOrgId(orgId)}:${normalizeMomentId(momentId)}`;
}

function getMarkiSourceMetadataPath(documentsPath, orgId, momentIdOrRef) {
  const identity = normalizeMetadataIdentity(orgId, momentIdOrRef);
  return path.join(
    getMarkiImportRoot(documentsPath),
    identity.orgId,
    SOURCE_METADATA_DIRECTORY_NAME,
    `${identity.momentId}.json`
  );
}

function buildMarkiSourceMetadataRecord(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw createMetadataError('invalid_source_metadata', '马克来源元数据格式无效。');
  }
  const orgId = normalizeOrgId(input.orgId);
  const momentId = normalizeMomentId(input.momentId ?? input.id);
  const sourceMetadataRef = buildMarkiSourceMetadataRef(orgId, momentId);
  const sourceKey = buildMarkiSourceKey(orgId, momentId);
  if (input.sourceMetadataRef && String(input.sourceMetadataRef) !== sourceMetadataRef) {
    throw createMetadataError('source_metadata_ref_mismatch', '马克来源元数据引用不匹配。');
  }
  if (input.sourceKey && String(input.sourceKey) !== sourceKey) {
    throw createMetadataError('source_metadata_key_mismatch', '马克来源标识不匹配。');
  }
  const now = resolveNow(options);
  return {
    schemaVersion: SOURCE_METADATA_SCHEMA_VERSION,
    sourceMetadataRef,
    sourceKey,
    sourceType: SOURCE_TYPE,
    orgId,
    momentId,
    teamId: normalizeOptionalId(input.teamId),
    uid: normalizeOptionalId(input.uid),
    postTime: normalizePostTime(input.postTime),
    capturedAt: normalizeOptionalDateTime(input.capturedAt),
    markName: normalizeText(input.markName, 200),
    antiCounterfeitCode: normalizeBusinessValue(input.antiCounterfeitCode, 500),
    parsedEntries: normalizeParsedEntries(input.parsedEntries),
    createdAt: normalizeIsoDate(input.createdAt || now),
    updatedAt: normalizeIsoDate(input.updatedAt || now)
  };
}

async function loadMarkiSourceMetadata(documentsPath, orgId, momentIdOrRef, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const identity = normalizeMetadataIdentity(orgId, momentIdOrRef);
  const metadataPath = getMarkiSourceMetadataPath(
    documentsPath,
    identity.orgId,
    identity.momentId
  );
  try {
    const content = await fileSystem.readFile(metadataPath, 'utf8');
    return cloneJson(normalizeStoredMetadata(JSON.parse(content), identity));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (
      error?.name === 'SyntaxError'
      || error?.code === 'marki_source_metadata_invalid'
    ) {
      throw createMetadataError(
        'marki_source_metadata_invalid',
        '马克来源元数据无法解析，已停止写入以保护现有记录。'
      );
    }
    if (error instanceof MarkiSourceMetadataError) throw error;
    throw createMetadataError(
      'marki_source_metadata_read_failed',
      '马克来源元数据读取失败，请重试。'
    );
  }
}

async function saveMarkiSourceMetadata(documentsPath, input = {}, options = {}) {
  const fileSystem = resolveFileSystem(options);
  const candidate = buildMarkiSourceMetadataRecord(input, options);
  const metadataPath = getMarkiSourceMetadataPath(
    documentsPath,
    candidate.orgId,
    candidate.momentId
  );
  return withMetadataWriteLock(metadataPath, async () => {
    const existing = await loadMarkiSourceMetadata(
      documentsPath,
      candidate.orgId,
      candidate.momentId,
      { fs: fileSystem }
    );
    const now = resolveNow(options);
    const record = buildMarkiSourceMetadataRecord({
      ...candidate,
      createdAt: existing?.createdAt || candidate.createdAt,
      updatedAt: now
    }, options);
    try {
      await writeMetadataAtomically(fileSystem, metadataPath, record);
    } catch (error) {
      if (error instanceof MarkiSourceMetadataError) throw error;
      throw createMetadataError(
        'marki_source_metadata_save_failed',
        '马克来源元数据保存失败，请重试。'
      );
    }
    return {
      success: true,
      sourceMetadataRef: record.sourceMetadataRef,
      record: cloneJson(record)
    };
  });
}

function normalizeStoredMetadata(input, identity) {
  if (!isPlainObject(input)) {
    throw createMetadataError('marki_source_metadata_invalid', '马克来源元数据结构无效。');
  }
  const storedKeys = Object.keys(input);
  if (
    storedKeys.some((key) => !SOURCE_METADATA_FIELD_SET.has(key))
    || SOURCE_METADATA_FIELD_SET.size !== storedKeys.length
  ) {
    throw createMetadataError('marki_source_metadata_invalid', '马克来源元数据字段无效。');
  }
  if (Number(input.schemaVersion) !== SOURCE_METADATA_SCHEMA_VERSION) {
    throw createMetadataError('marki_source_metadata_invalid', '马克来源元数据版本不受支持。');
  }
  const normalized = buildMarkiSourceMetadataRecord(input, {
    now: () => new Date(input.updatedAt)
  });
  if (
    normalized.orgId !== identity.orgId
    || normalized.momentId !== identity.momentId
    || normalized.sourceType !== SOURCE_TYPE
  ) {
    throw createMetadataError('marki_source_metadata_invalid', '马克来源元数据标识不一致。');
  }
  return normalized;
}

async function writeMetadataAtomically(fileSystem, metadataPath, record) {
  await fileSystem.mkdir(path.dirname(metadataPath), { recursive: true });
  const temporaryPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, metadataPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeMetadataIdentity(orgId, momentIdOrRef) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const text = String(momentIdOrRef ?? '').trim();
  const expectedPrefix = `${SOURCE_METADATA_REF_PREFIX}:${normalizedOrgId}:`;
  const momentId = text.startsWith(`${SOURCE_METADATA_REF_PREFIX}:`)
    ? normalizeMomentId(text.slice(expectedPrefix.length))
    : normalizeMomentId(text);
  const expectedRef = buildMarkiSourceMetadataRef(normalizedOrgId, momentId);
  if (text.startsWith(`${SOURCE_METADATA_REF_PREFIX}:`) && text !== expectedRef) {
    throw createMetadataError('invalid_source_metadata_ref', '马克来源元数据引用无效。');
  }
  return {
    orgId: normalizedOrgId,
    momentId,
    sourceMetadataRef: expectedRef
  };
}

function normalizeParsedEntries(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw createMetadataError('invalid_source_metadata_entries', '马克来源字段条目格式无效。');
  }
  const entries = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const key = normalizeFieldKey(Object.hasOwn(item, 'key') ? item.key : '');
    if (!key || RESERVED_FIELD_KEYS.has(key.toLowerCase())) continue;
    const entryValue = normalizeBusinessValue(
      Object.hasOwn(item, 'value') ? item.value : '',
      2000
    );
    if (!entryValue) continue;
    entries.push({ key, value: entryValue });
  }
  return entries;
}

function normalizeFieldKey(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\s：:]+/g, '')
    .trim()
    .slice(0, 100);
}

function normalizeOrgId(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) {
    throw createMetadataError('invalid_org_id', '组织 ID 必须为数字。');
  }
  return text;
}

function normalizeMomentId(value) {
  const text = String(value ?? '').trim();
  if (
    !text
    || text.length > 200
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(text)
    || text === '.'
    || text === '..'
  ) {
    throw createMetadataError('invalid_moment_id', '马克照片 ID 无效。');
  }
  return text;
}

function normalizeOptionalId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 100 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw createMetadataError('invalid_source_metadata', '马克来源 ID 无效。');
  }
  return text;
}

function normalizePostTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeOptionalDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw createMetadataError('invalid_source_metadata', '马克拍摄时间无效。');
  }
  return text;
}

function normalizeIsoDate(value) {
  const text = String(value || '').trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw createMetadataError('invalid_source_metadata', '马克来源元数据时间无效。');
  }
  return date.toISOString();
}

function normalizeText(value, maxLength) {
  if (value == null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeBusinessValue(value, maxLength) {
  const text = normalizeText(value, 2000);
  if (!text) return '';
  const normalized = text.replace(/\s+/g, '');
  const normalizedLower = normalized.toLowerCase();
  if (
    /^(请输入|请选择|请填写|未填写|未设置|暂无|无|空|-+|—+|\/+)$/.test(normalized)
    || normalizedLower === 'null'
    || normalizedLower === 'undefined'
    || /^(请输入|请选择|请填写)/.test(normalized)
    || /^(点击|请点击).*(填写|输入|选择)$/.test(normalized)
  ) {
    return '';
  }
  return text.slice(0, maxLength);
}

function resolveFileSystem(options = {}) {
  const fileSystem = options.fs || fs;
  const requiredMethods = ['mkdir', 'open', 'readFile', 'rename', 'rm'];
  if (
    !fileSystem
    || requiredMethods.some((method) => typeof fileSystem[method] !== 'function')
  ) {
    throw createMetadataError(
      'invalid_source_metadata_storage',
      '马克来源元数据存储服务无效。'
    );
  }
  return fileSystem;
}

function resolveNow(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createMetadataError('invalid_current_time', '无法生成来源元数据时间。');
  }
  return date.toISOString();
}

function withMetadataWriteLock(metadataPath, action) {
  const previous = metadataWriteQueues.get(metadataPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  metadataWriteQueues.set(metadataPath, current);
  return current.finally(() => {
    if (metadataWriteQueues.get(metadataPath) === current) {
      metadataWriteQueues.delete(metadataPath);
    }
  });
}

function createMetadataError(code, message) {
  return new MarkiSourceMetadataError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  MarkiSourceMetadataError,
  SOURCE_METADATA_DIRECTORY_NAME,
  SOURCE_METADATA_REF_PREFIX,
  SOURCE_METADATA_SCHEMA_VERSION,
  buildMarkiSourceMetadataRecord,
  buildMarkiSourceMetadataRef,
  getMarkiSourceMetadataPath,
  loadMarkiSourceMetadata,
  saveMarkiSourceMetadata
};
