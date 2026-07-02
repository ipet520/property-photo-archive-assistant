const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  getCandidateFieldSetByPhoto,
  getFormPatchDraftByPhoto,
  getStagedRecognitionResultByPhoto
} = require('./recognitionService.cjs');

const SCHEMA_VERSION = 1;
const STORE_FILE = 'smart-sort-groups.json';
const DEFAULT_TIME_WINDOW_MINUTES = 30;
const DEFAULT_MAX_PHOTOS_PER_GROUP = 10;
const ALLOWED_STATUSES = new Set(['pending', 'viewed', 'ignored', 'confirmed_later', 'cleared']);

function createDefaultRules(options = {}) {
  const now = new Date().toISOString();
  return [
    {
      id: 'time_window',
      key: 'time_window',
      label: '按照片时间接近分组',
      enabled: true,
      options: {
        timeWindowMinutes: normalizePositiveNumber(options.timeWindowMinutes, DEFAULT_TIME_WINDOW_MINUTES),
        minPhotosPerGroup: 1
      },
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    },
    {
      id: 'selection_order',
      key: 'selection_order',
      label: '按当前照片列表顺序分组',
      enabled: true,
      options: {
        maxPhotosPerGroup: normalizePositiveNumber(options.maxPhotosPerGroup, DEFAULT_MAX_PHOTOS_PER_GROUP)
      },
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    },
    {
      id: 'folder_batch',
      key: 'folder_batch',
      label: '按当前导入目录批次分组',
      enabled: false,
      options: {},
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    },
    {
      id: 'recognition_status',
      key: 'recognition_status',
      label: '按已有识别数据状态辅助分组',
      enabled: false,
      options: {},
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    }
  ];
}

async function generateSmartSortGroups(userDataDir, input = {}) {
  try {
    const now = new Date().toISOString();
    const photos = normalizePhotos(input.photos);
    const rules = createDefaultRules(input.options || {});
    if (photos.length === 0) {
      const emptyResult = createGroupingResult({
        groups: [],
        rules,
        status: 'empty',
        warnings: ['暂无照片，选择目录并扫描后可生成分拣组。'],
        createdAt: now,
        updatedAt: now
      });
      await writeGroupingResult(userDataDir, emptyResult);
      return emptyResult;
    }

    const timedPhotos = photos.filter((photo) => Number.isFinite(photo.sortTimestamp));
    const canUseTimeWindow = timedPhotos.length === photos.length;
    const groups = canUseTimeWindow
      ? await buildTimeWindowGroups(userDataDir, photos, input.options || {})
      : await buildSelectionOrderGroups(userDataDir, photos, input.options || {});
    const warnings = canUseTimeWindow
      ? ['分组结果仅用于辅助查看，不会自动写入表单或归档。']
      : ['当前缺少可靠拍摄时间，已按照片列表顺序分组。', '分组结果仅用于辅助查看，不会自动写入表单或归档。'];
    const result = createGroupingResult({
      groups,
      rules,
      status: 'created',
      warnings,
      createdAt: now,
      updatedAt: now
    });
    await writeGroupingResult(userDataDir, result);
    return result;
  } catch (error) {
    return createGroupingResult({
      groups: [],
      rules: createDefaultRules(input.options || {}),
      status: 'failed',
      errors: [{ code: 'smart_sort_generate_failed', message: error.message || '智能分拣分组生成失败。' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

async function getSmartSortGroupingResult(userDataDir) {
  try {
    return await readGroupingResult(userDataDir);
  } catch {
    return null;
  }
}

async function listSmartSortGroups(userDataDir) {
  const result = await getSmartSortGroupingResult(userDataDir);
  return Array.isArray(result?.groups) ? result.groups : [];
}

async function getSmartSortGroup(userDataDir, id) {
  const groups = await listSmartSortGroups(userDataDir);
  return groups.find((group) => group.id === String(id || '')) || null;
}

async function updateSmartSortGroupStatus(userDataDir, id, status) {
  const safeStatus = String(status || '').trim();
  if (!ALLOWED_STATUSES.has(safeStatus)) return null;
  const result = await getSmartSortGroupingResult(userDataDir);
  if (!result?.groups?.length) return null;
  const now = new Date().toISOString();
  let updatedGroup = null;
  const groups = result.groups.map((group) => {
    if (group.id !== String(id || '')) return group;
    updatedGroup = { ...group, status: safeStatus, updatedAt: now };
    return updatedGroup;
  });
  if (!updatedGroup) return null;
  const nextResult = {
    ...result,
    groups,
    updatedAt: now,
    status: groups.length ? 'created' : 'empty'
  };
  await writeGroupingResult(userDataDir, nextResult);
  return updatedGroup;
}

async function clearSmartSortGroups(userDataDir) {
  try {
    const cleared = createGroupingResult({
      groups: [],
      rules: createDefaultRules(),
      status: 'cleared',
      warnings: ['智能分拣分组结果已清除，照片和归档信息未受影响。'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await writeGroupingResult(userDataDir, cleared);
    return true;
  } catch {
    return false;
  }
}

async function buildTimeWindowGroups(userDataDir, photos, options = {}) {
  const windowMs = normalizePositiveNumber(options.timeWindowMinutes, DEFAULT_TIME_WINDOW_MINUTES) * 60 * 1000;
  const sorted = [...photos].sort((a, b) => a.sortTimestamp - b.sortTimestamp);
  const buckets = [];
  let current = [];
  for (const photo of sorted) {
    const previous = current[current.length - 1];
    if (!previous || photo.sortTimestamp - previous.sortTimestamp <= windowMs) {
      current.push(photo);
    } else {
      buckets.push(current);
      current = [photo];
    }
  }
  if (current.length) buckets.push(current);
  return Promise.all(buckets.map((bucket, index) => buildGroup(userDataDir, bucket, {
    index,
    titlePrefix: '时间段分组',
    basis: 'time_window',
    basisLabel: '按照片时间接近自动分组',
    confidenceLabel: 'medium'
  })));
}

async function buildSelectionOrderGroups(userDataDir, photos, options = {}) {
  const maxPhotosPerGroup = normalizePositiveNumber(options.maxPhotosPerGroup, DEFAULT_MAX_PHOTOS_PER_GROUP);
  const buckets = [];
  for (let index = 0; index < photos.length; index += maxPhotosPerGroup) {
    buckets.push(photos.slice(index, index + maxPhotosPerGroup));
  }
  return Promise.all(buckets.map((bucket, index) => buildGroup(userDataDir, bucket, {
    index,
    titlePrefix: '列表顺序分组',
    basis: 'selection_order',
    basisLabel: '按当前照片列表顺序分组',
    confidenceLabel: 'low'
  })));
}

async function buildGroup(userDataDir, photos, meta) {
  const now = new Date().toISOString();
  const recognitionSummary = await summarizeRecognitionState(userDataDir, photos);
  const range = buildTimeRange(photos);
  return {
    id: createId('smart-sort-group'),
    title: `${meta.titlePrefix} ${meta.index + 1}`,
    status: 'pending',
    basis: meta.basis,
    photos: photos.map(({ sortTimestamp, ...photo }) => photo),
    photoCount: photos.length,
    timeRange: range,
    summary: {
      basisLabel: meta.basisLabel,
      confidenceLabel: meta.confidenceLabel,
      hasRecognitionData: recognitionSummary.hasRecognitionData,
      hasCandidateFields: recognitionSummary.hasCandidateFields,
      hasPatchDraft: recognitionSummary.hasPatchDraft
    },
    suggestedFields: {},
    warnings: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION
  };
}

async function summarizeRecognitionState(userDataDir, photos) {
  const summary = {
    hasRecognitionData: false,
    hasCandidateFields: false,
    hasPatchDraft: false
  };
  await Promise.all(photos.map(async (photo) => {
    const photoInput = { photoId: photo.photoId, filePath: photo.filePath, fileName: photo.fileName };
    const [staged, candidate, patch] = await Promise.allSettled([
      getStagedRecognitionResultByPhoto(userDataDir, photoInput),
      getCandidateFieldSetByPhoto(userDataDir, photoInput),
      getFormPatchDraftByPhoto(userDataDir, photoInput)
    ]);
    if (staged.status === 'fulfilled' && staged.value) summary.hasRecognitionData = true;
    if (candidate.status === 'fulfilled' && candidate.value) summary.hasCandidateFields = true;
    if (patch.status === 'fulfilled' && patch.value) summary.hasPatchDraft = true;
  }));
  return summary;
}

function normalizePhotos(photos = []) {
  return (Array.isArray(photos) ? photos : [])
    .map((photo, index) => normalizePhoto(photo, index))
    .filter(Boolean);
}

function normalizePhoto(photo = {}, index = 0) {
  const filePath = String(photo.filePath || photo.originalPath || photo.path || '').trim();
  if (!filePath) return null;
  const fileName = String(photo.fileName || photo.originalName || photo.name || path.basename(filePath)).trim();
  const capturedAt = normalizeDateValue(photo.capturedAt || photo.takenAt || photo.dateTime || null);
  const modifiedAt = normalizeDateValue(photo.modifiedAt || photo.updatedAt || null);
  const sortDate = capturedAt || modifiedAt;
  return {
    photoId: String(photo.photoId || photo.id || '').trim() || undefined,
    filePath,
    fileName,
    index: Number.isFinite(Number(photo.index)) ? Number(photo.index) : index,
    capturedAt,
    modifiedAt,
    sortTimestamp: sortDate ? Date.parse(sortDate) : null,
    source: 'photo_list',
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION
  };
}

function buildTimeRange(photos) {
  const timestamps = photos
    .map((photo) => photo.sortTimestamp)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!timestamps.length) return { start: null, end: null };
  return {
    start: new Date(timestamps[0]).toISOString(),
    end: new Date(timestamps[timestamps.length - 1]).toISOString()
  };
}

function createGroupingResult({ groups = [], rules = [], status = 'created', warnings = [], errors = [], createdAt, updatedAt }) {
  const now = new Date().toISOString();
  return {
    id: createId('smart-sort-result'),
    source: 'current_photo_list',
    groupCount: groups.length,
    photoCount: groups.reduce((sum, group) => sum + Number(group.photoCount || 0), 0),
    groups,
    rules,
    status,
    warnings,
    errors,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
    schemaVersion: SCHEMA_VERSION
  };
}

async function readGroupingResult(userDataDir) {
  const filePath = getStorePath(userDataDir);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeGroupingResult(parsed);
  } catch {
    return null;
  }
}

async function writeGroupingResult(userDataDir, result) {
  const filePath = getStorePath(userDataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalizeGroupingResult(result), null, 2)}\n`, 'utf8');
}

function normalizeGroupingResult(result = {}) {
  if (!result || typeof result !== 'object') return null;
  const groups = (Array.isArray(result.groups) ? result.groups : []).map(normalizeGroup).filter(Boolean);
  return {
    id: String(result.id || createId('smart-sort-result')),
    source: 'current_photo_list',
    groupCount: groups.length,
    photoCount: groups.reduce((sum, group) => sum + group.photoCount, 0),
    groups,
    rules: Array.isArray(result.rules) ? result.rules : createDefaultRules(),
    status: ['created', 'empty', 'failed', 'cleared'].includes(result.status) ? result.status : (groups.length ? 'created' : 'empty'),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    errors: Array.isArray(result.errors) ? result.errors : [],
    createdAt: String(result.createdAt || new Date().toISOString()),
    updatedAt: String(result.updatedAt || new Date().toISOString()),
    schemaVersion: SCHEMA_VERSION
  };
}

function normalizeGroup(group = {}) {
  if (!group || typeof group !== 'object') return null;
  const photos = (Array.isArray(group.photos) ? group.photos : []).map((photo, index) => normalizePhoto(photo, index)).filter(Boolean);
  return {
    id: String(group.id || createId('smart-sort-group')),
    title: String(group.title || '分拣组'),
    status: ALLOWED_STATUSES.has(group.status) ? group.status : 'pending',
    basis: String(group.basis || 'selection_order'),
    photos: photos.map(({ sortTimestamp, ...photo }) => photo),
    photoCount: photos.length,
    timeRange: group.timeRange || buildTimeRange(photos),
    summary: {
      basisLabel: String(group.summary?.basisLabel || '按当前照片列表顺序分组'),
      confidenceLabel: ['low', 'medium', 'high'].includes(group.summary?.confidenceLabel) ? group.summary.confidenceLabel : 'low',
      hasRecognitionData: Boolean(group.summary?.hasRecognitionData),
      hasCandidateFields: Boolean(group.summary?.hasCandidateFields),
      hasPatchDraft: Boolean(group.summary?.hasPatchDraft)
    },
    suggestedFields: {},
    warnings: Array.isArray(group.warnings) ? group.warnings : [],
    errors: Array.isArray(group.errors) ? group.errors : [],
    createdAt: String(group.createdAt || new Date().toISOString()),
    updatedAt: String(group.updatedAt || new Date().toISOString()),
    schemaVersion: SCHEMA_VERSION
  };
}

function normalizeDateValue(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getStorePath(userDataDir) {
  return path.join(userDataDir, STORE_FILE);
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

module.exports = {
  generateSmartSortGroups,
  getSmartSortGroupingResult,
  listSmartSortGroups,
  getSmartSortGroup,
  updateSmartSortGroupStatus,
  clearSmartSortGroups
};
