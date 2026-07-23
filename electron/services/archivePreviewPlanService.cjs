const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  buildArchiveSourceIdentity,
  hashFile,
  resolveArchiveTargetPath,
  toArchiveTargetRelativePath
} = require('./archiveTransactionService.cjs');

const PREVIEW_PLAN_SCHEMA_VERSION = 1;
const PREVIEW_PLAN_KEYS = new Set([
  'schemaVersion',
  'planId',
  'createdAt',
  'archiveRoot',
  'items'
]);
const PREVIEW_ITEM_KEYS = new Set([
  'itemId',
  'photoId',
  'sourceType',
  'sourceKey',
  'sourceIdentity',
  'sourcePath',
  'originalName',
  'extension',
  'sourceSize',
  'sourceSha256',
  'targetRelativePath',
  'ledgerRow'
]);
const LEDGER_ROW_KEYS = new Set([
  'date',
  'project',
  'watermarkCategory',
  'workContent',
  'location',
  'newFileName',
  'originalName',
  'keywords',
  'remark',
  'archivedAt',
  'sourceType',
  'sourceKey',
  'photoId',
  'sourcePath',
  'sourceSha256',
  'archiveSha256',
  'transactionId',
  'watermarkTemplateType',
  'processingMode',
  'vehiclePlate',
  'violationType',
  'constructionUnitId',
  'constructionUnitName',
  'constructionUnitOriginalText',
  'constructionUnitConfirmed',
  'constructionUnitSource'
]);

class ArchivePreviewPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchivePreviewPlanError';
    this.code = code;
  }
}

async function createArchivePreviewPlan(input = {}, options = {}) {
  const archiveRoot = normalizeArchiveRoot(input.archiveRoot);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) {
    throw createError('archive_preview_items_missing', '没有可生成归档预览的照片。');
  }

  const items = [];
  const targetKeys = new Set();
  for (const [index, rawItem] of rawItems.entries()) {
    const sourcePath = normalizeAbsoluteSourcePath(rawItem.sourcePath);
    const source = await inspectSourceFile(sourcePath, options);
    const targetPath = resolveArchiveTargetPath(
      archiveRoot,
      toArchiveTargetRelativePath(archiveRoot, rawItem.targetPath)
    );
    const targetKey = normalizePathKey(targetPath);
    if (targetKeys.has(targetKey)) {
      throw createError('archive_preview_target_duplicate', '本次预览包含重复归档目标，请调整归档信息。');
    }
    targetKeys.add(targetKey);
    if (await pathExists(targetPath, options.fs || fs)) {
      throw createError('archive_preview_target_conflict', '归档目标已存在，预览已失效，请调整后重新生成。');
    }

    const sourceKey = normalizeText(rawItem.sourceKey);
    const sourceIdentity = buildArchiveSourceIdentity({
      sourceKey,
      sourceSha256: source.sha256,
      originalPath: sourcePath
    });
    const ledgerRow = normalizeLedgerRow({
      ...(rawItem.ledgerRow || {}),
      sourceType: normalizeText(rawItem.sourceType) || (sourceKey ? 'marki_api' : 'local_file'),
      sourceKey,
      photoId: normalizeText(rawItem.photoId),
      sourcePath,
      sourceSha256: source.sha256,
      archiveSha256: source.sha256,
      transactionId: '',
      newFileName: path.basename(targetPath)
    });
    const itemSeed = {
      photoId: normalizeRequiredText(rawItem.photoId, 'archive_preview_photo_id_invalid', '照片标识无效。'),
      sourceType: ledgerRow.sourceType,
      sourceKey,
      sourceIdentity,
      sourcePath,
      originalName: normalizeText(rawItem.originalName) || path.basename(sourcePath),
      extension: normalizeExtension(rawItem.extension || path.extname(sourcePath)),
      sourceSize: source.size,
      sourceSha256: source.sha256,
      targetRelativePath: toArchiveTargetRelativePath(archiveRoot, targetPath).replaceAll('\\', '/'),
      ledgerRow
    };
    items.push({
      itemId: hashValue(stableStringify({ index, ...itemSeed })),
      ...itemSeed
    });
  }

  const createdAt = resolveNow(options.now);
  const unsigned = {
    schemaVersion: PREVIEW_PLAN_SCHEMA_VERSION,
    createdAt,
    archiveRoot,
    items
  };
  return {
    ...unsigned,
    planId: hashPreviewPlan(unsigned)
  };
}

function normalizeArchivePreviewPlan(input = {}) {
  assertPlainObject(input, 'archive_preview_plan_invalid', '归档预览计划格式无效。');
  assertExactKeys(input, PREVIEW_PLAN_KEYS, 'archive_preview_plan_invalid', '归档预览计划包含未知字段。');
  const archiveRoot = normalizeArchiveRoot(input.archiveRoot);
  if (Number(input.schemaVersion) !== PREVIEW_PLAN_SCHEMA_VERSION) {
    throw createError('archive_preview_plan_invalid', '归档预览计划版本无效。');
  }
  const planId = normalizeSha256(input.planId);
  if (!planId || !Array.isArray(input.items) || input.items.length === 0) {
    throw createError('archive_preview_plan_invalid', '归档预览计划内容不完整。');
  }
  const itemIds = new Set();
  const targetKeys = new Set();
  const items = input.items.map((item) => {
    assertPlainObject(item, 'archive_preview_plan_invalid', '归档预览照片条目格式无效。');
    assertExactKeys(item, PREVIEW_ITEM_KEYS, 'archive_preview_plan_invalid', '归档预览照片条目包含未知字段。');
    const normalized = normalizePreviewItem(archiveRoot, item);
    if (itemIds.has(normalized.itemId) || targetKeys.has(normalizePathKey(normalized.targetRelativePath))) {
      throw createError('archive_preview_plan_invalid', '归档预览计划包含重复条目。');
    }
    itemIds.add(normalized.itemId);
    targetKeys.add(normalizePathKey(normalized.targetRelativePath));
    return normalized;
  });
  const unsigned = {
    schemaVersion: PREVIEW_PLAN_SCHEMA_VERSION,
    createdAt: normalizeRequiredText(
      input.createdAt,
      'archive_preview_plan_invalid',
      '归档预览计划时间无效。'
    ),
    archiveRoot,
    items
  };
  if (hashPreviewPlan(unsigned) !== planId) {
    throw createError('archive_preview_plan_tampered', '归档预览计划已变化，请重新生成预览。');
  }
  return { ...unsigned, planId };
}

async function validateArchivePreviewPlanForExecution(input = {}, options = {}) {
  const validation = await validateArchivePreviewPlanItemsForExecution(input, options);
  const failed = validation.items.find((item) => !item.valid);
  if (failed) {
    throw createError(failed.errorCode, failed.message);
  }
  return validation.plan;
}

async function validateArchivePreviewPlanItemsForExecution(input = {}, options = {}) {
  const plan = normalizeArchivePreviewPlan(input);
  const fileSystem = options.fs || fs;
  const items = [];
  for (const item of plan.items) {
    try {
      const source = await inspectSourceFile(item.sourcePath, options);
      if (source.size !== item.sourceSize || source.sha256 !== item.sourceSha256) {
        items.push(buildItemValidationFailure(
          item,
          'copy_failed',
          'archive_preview_source_changed',
          '原始照片在预览后发生变化，请重新生成该照片的预览。'
        ));
        continue;
      }
      const targetPath = resolveArchiveTargetPath(plan.archiveRoot, item.targetRelativePath);
      if (await pathExists(targetPath, fileSystem)) {
        items.push(buildItemValidationFailure(
          item,
          'target_conflict',
          'archive_preview_target_conflict',
          '归档目标在预览后被占用，请重新生成该照片的预览。'
        ));
        continue;
      }
      items.push({
        itemId: item.itemId,
        photoId: item.photoId,
        valid: true,
        stage: 'planned',
        errorCode: '',
        message: ''
      });
    } catch (error) {
      items.push(buildItemValidationFailure(
        item,
        'copy_failed',
        error?.code || 'archive_preview_source_unreadable',
        error instanceof ArchivePreviewPlanError
          ? error.message
          : '无法读取原始照片，请重新生成该照片的预览。'
      ));
    }
  }
  return { plan, items };
}

function buildItemValidationFailure(item, stage, errorCode, message) {
  return {
    itemId: item.itemId,
    photoId: item.photoId,
    valid: false,
    stage,
    errorCode,
    message
  };
}

function buildArchivePreviewItems(plan) {
  const normalized = normalizeArchivePreviewPlan(plan);
  return normalized.items.map((item, index) => {
    const targetPath = resolveArchiveTargetPath(normalized.archiveRoot, item.targetRelativePath);
    return {
      id: item.photoId,
      photoId: item.photoId,
      index: index + 1,
      previewPlanId: normalized.planId,
      sourcePath: item.sourcePath,
      originalName: item.originalName,
      extension: item.extension,
      sourceType: item.sourceType,
      sourceKey: item.sourceKey,
      newFileName: path.basename(targetPath),
      targetDirectory: path.dirname(targetPath),
      targetPath,
      status: '待归档',
      error: '',
      ...toPublicLedgerFields(item.ledgerRow)
    };
  });
}

function toTransactionItems(plan) {
  const normalized = normalizeArchivePreviewPlan(plan);
  return normalized.items.map((item) => ({
    itemId: item.itemId,
    photoId: item.photoId,
    sourceType: item.sourceType,
    sourceKey: item.sourceKey,
    sourceIdentity: item.sourceIdentity,
    originalPath: item.sourcePath,
    originalName: item.originalName,
    sourceSize: item.sourceSize,
    sourceSha256: item.sourceSha256,
    targetRelativePath: item.targetRelativePath,
    targetSize: null,
    targetSha256: '',
    ledgerRow: {
      ...item.ledgerRow,
      transactionId: ''
    }
  }));
}

function normalizePreviewItem(archiveRoot, input) {
  const itemId = normalizeSha256(input.itemId);
  const sourceSha256 = normalizeSha256(input.sourceSha256);
  const sourcePath = normalizeAbsoluteSourcePath(input.sourcePath);
  const sourceKey = normalizeText(input.sourceKey);
  const sourceIdentity = normalizeRequiredText(
    input.sourceIdentity,
    'archive_preview_plan_invalid',
    '归档预览来源身份无效。'
  );
  if (!itemId || !sourceSha256) {
    throw createError('archive_preview_plan_invalid', '归档预览照片指纹无效。');
  }
  if (sourceIdentity !== buildArchiveSourceIdentity({
    sourceKey,
    sourceSha256,
    originalPath: sourcePath
  })) {
    throw createError('archive_preview_plan_invalid', '归档预览来源身份不一致。');
  }
  const targetRelativePath = toArchiveTargetRelativePath(
    archiveRoot,
    resolveArchiveTargetPath(archiveRoot, input.targetRelativePath)
  ).replaceAll('\\', '/');
  const ledgerRow = normalizeLedgerRow(input.ledgerRow);
  return {
    itemId,
    photoId: normalizeRequiredText(input.photoId, 'archive_preview_plan_invalid', '照片标识无效。'),
    sourceType: normalizeText(input.sourceType) || (sourceKey ? 'marki_api' : 'local_file'),
    sourceKey,
    sourceIdentity,
    sourcePath,
    originalName: normalizeRequiredText(
      input.originalName,
      'archive_preview_plan_invalid',
      '原始文件名无效。'
    ),
    extension: normalizeExtension(input.extension),
    sourceSize: normalizeNonNegativeNumber(input.sourceSize),
    sourceSha256,
    targetRelativePath,
    ledgerRow
  };
}

function normalizeLedgerRow(input = {}) {
  assertPlainObject(input, 'archive_preview_plan_invalid', '归档预览台账字段格式无效。');
  assertExactKeys(input, LEDGER_ROW_KEYS, 'archive_preview_plan_invalid', '归档预览台账包含未知字段。');
  return Object.fromEntries([...LEDGER_ROW_KEYS].map((key) => [key, normalizeText(input[key])]));
}

async function inspectSourceFile(sourcePath, options = {}) {
  const fileSystem = options.fs || fs;
  let stat;
  try {
    stat = await fileSystem.stat(sourcePath);
    if (!stat.isFile()) throw new Error('not_file');
  } catch {
    throw createError('archive_preview_source_unreadable', '无法读取原始照片，预览尚未生成。');
  }
  let sha256;
  try {
    sha256 = await (options.hashFile || hashFile)(sourcePath);
  } catch {
    throw createError('archive_preview_source_unreadable', '无法读取原始照片，预览尚未生成。');
  }
  return { size: Number(stat.size), sha256 };
}

function hashPreviewPlan(unsigned) {
  return hashValue(stableStringify(unsigned));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toPublicLedgerFields(ledgerRow) {
  return {
    date: ledgerRow.date,
    project: ledgerRow.project,
    watermarkCategory: ledgerRow.watermarkCategory,
    workContent: ledgerRow.workContent,
    location: ledgerRow.location,
    keywords: ledgerRow.keywords,
    remark: ledgerRow.remark,
    watermarkTemplateType: ledgerRow.watermarkTemplateType,
    processingMode: ledgerRow.processingMode,
    vehiclePlate: ledgerRow.vehiclePlate,
    violationType: ledgerRow.violationType,
    constructionUnitId: ledgerRow.constructionUnitId,
    constructionUnitName: ledgerRow.constructionUnitName,
    constructionUnitOriginalText: ledgerRow.constructionUnitOriginalText,
    constructionUnitConfirmed: ledgerRow.constructionUnitConfirmed,
    constructionUnitSource: ledgerRow.constructionUnitSource
  };
}

function normalizeArchiveRoot(value) {
  const text = normalizeText(value);
  if (!text) throw createError('archive_root_missing', '缺少归档根目录。');
  return path.resolve(text);
}

function normalizeAbsoluteSourcePath(value) {
  const text = normalizeText(value);
  if (!text || !path.isAbsolute(text)) {
    throw createError('archive_preview_source_invalid', '原始照片路径无效。');
  }
  return path.resolve(text);
}

function normalizeExtension(value) {
  const text = normalizeText(value).toLowerCase();
  const extension = text.startsWith('.') ? text : `.${text}`;
  if (!/^\.(?:jpe?g|png|webp)$/i.test(extension)) {
    throw createError('archive_preview_extension_invalid', '照片格式不受支持。');
  }
  return extension;
}

function normalizeNonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw createError('archive_preview_plan_invalid', '归档预览文件大小无效。');
  }
  return number;
}

function normalizeRequiredText(value, code, message) {
  const text = normalizeText(value);
  if (!text) throw createError(code, message);
  return text;
}

function normalizeSha256(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createError(code, message);
  }
}

function assertExactKeys(value, allowed, code, message) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw createError(code, message);
  }
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw createError('archive_preview_time_invalid', '归档预览时间无效。');
  return date.toISOString();
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizePathKey(value) {
  return path.resolve(String(value || '')).toLocaleLowerCase('zh-CN');
}

async function pathExists(targetPath, fileSystem) {
  try {
    await fileSystem.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function createError(code, message) {
  return new ArchivePreviewPlanError(code, message);
}

module.exports = {
  ArchivePreviewPlanError,
  PREVIEW_PLAN_SCHEMA_VERSION,
  buildArchivePreviewItems,
  createArchivePreviewPlan,
  normalizeArchivePreviewPlan,
  stableStringify,
  toTransactionItems,
  validateArchivePreviewPlanItemsForExecution,
  validateArchivePreviewPlanForExecution
};
