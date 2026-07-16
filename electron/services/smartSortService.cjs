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

    const recognitionGroups = await buildRecognitionGroups(userDataDir, photos);
    if (recognitionGroups.length > 0) {
      const result = createGroupingResult({
        groups: recognitionGroups,
        rules,
        status: 'created',
        warnings: ['已优先使用 OCR 水印解析结果生成分组；结果仅用于辅助查看，不会自动写入表单或归档。'],
        createdAt: now,
        updatedAt: now,
        source: 'selected_photos'
      });
      await writeGroupingResult(userDataDir, result);
      return result;
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
      updatedAt: now,
        source: input.source || input.options?.source || 'selected_photos'
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

async function buildRecognitionGroups(userDataDir, photos) {
  const buckets = new Map();
  const hasRecognitionInput = photos.some((photo) => photo.recognition || photo.archiveSuggestion || photo.archiveInfo || photo.previewInfo || photo.archiveResult);
  photos.forEach((photo) => {
    const bucket = resolveSmartGroupBucket(photo);
    const bucketKey = bucket.title;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(photo);
  });
  if (!hasRecognitionInput) return [];
  const entries = Array.from(buckets.entries());
  return Promise.all(entries.map(([title, bucket], index) => buildGroup(userDataDir, bucket, {
    index,
    titlePrefix: title,
    fixedTitle: title,
    basis: resolveSmartGroupBucket(bucket[0]).basis,
    basisLabel: resolveSmartGroupBucket(bucket[0]).basisLabel,
    confidenceLabel: resolveSmartGroupBucket(bucket[0]).confidenceLabel
  })));
}

async function buildGroup(userDataDir, photos, meta) {
  const now = new Date().toISOString();
  const recognitionSummary = await summarizeRecognitionState(userDataDir, photos);
  const range = buildTimeRange(photos);
  return {
    id: createId('smart-sort-group'),
    title: meta.fixedTitle || `${meta.titlePrefix} ${meta.index + 1}`,
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
    sortStatus: String(photo.sortStatus || ''),
    archiveInfo: normalizePlainObject(photo.archiveInfo),
    previewInfo: normalizePlainObject(photo.previewInfo),
    archiveResult: normalizePlainObject(photo.archiveResult),
    archiveSuggestion: normalizeArchiveSuggestionForGrouping(photo.archiveSuggestion),
    watermarkRecord: normalizePlainObject(photo.watermarkRecord),
    source: 'photo_list',
    recognition: normalizeRecognitionForGrouping(photo.recognition || photo.ocrResult || null),
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION
  };
}

function resolveSmartGroupBucket(photo = {}) {
  if (photo.archiveResult?.success === true || photo.archiveResult?.status === '归档成功' || photo.sortStatus === 'archived') {
    return createBucket('已归档', 'archive_result', '已归档照片。', 'high');
  }
  if (photo.archiveResult?.success === false || photo.archiveResult?.status === '归档失败' || ['failed', 'archive_failed'].includes(photo.sortStatus)) {
    return createBucket('归档失败', 'archive_failed', '归档失败照片，需修正后重新预览/归档。', 'high');
  }
  if (photo.previewInfo && photo.sortStatus !== 'archived') {
    return createBucket('已预览待归档', 'preview_ready', '已生成预览，等待正式归档。', 'high');
  }
  if (photo.archiveInfo || ['assigned', 'confirmed'].includes(photo.sortStatus)) {
    return createBucket('已确认待预览', 'confirmed', '已确认归档信息，等待生成预览。', 'high');
  }

  if (isRecognitionFailed(photo.recognition)) {
    return createBucket('识别失败', 'recognition_failed', 'OCR 没有正常完成识别，需重试或转为手工整理。', 'low');
  }
  if (isRecognitionEmpty(photo.recognition)) {
    return createBucket('未检测到水印', 'needs_completion', 'OCR 已正常执行但未检测到可识别的水印文字，转为手工补充归档信息。', 'low');
  }

  const fields = photo.archiveSuggestion?.suggestedFields || {};
  const workContent = sanitizeGroupTitle(fields.workContent);
  if (workContent) return createBucket(workContent, 'archive_suggestion_work_content', `来自归档建议：${workContent}`, 'high');

  const category = sanitizeGroupTitle(fields.category || fields.watermarkCategory);
  if (category) return createBucket(category, 'archive_suggestion_category', `来自归档建议分类：${category}`, 'medium');

  if (photo.archiveSuggestion) {
    return createBucket('无法判断工作内容', 'archive_suggestion_pending', '已有归档建议，但无法判断工作内容。', 'low');
  }

  return createBucket(getPendingRecognitionBucket(photo.recognition), 'recognition_pending', getPendingRecognitionBasisLabel(getPendingRecognitionBucket(photo.recognition)), 'low');
}

function createBucket(title, basis, basisLabel, confidenceLabel) {
  return { title, basis, basisLabel, confidenceLabel };
}

function isRecognitionFailed(recognition = {}) {
  return Boolean(recognition && ['failed', 'error', 'provider_unavailable', 'not_configured', 'disabled'].includes(recognition.status));
}

function isRecognitionEmpty(recognition = {}) {
  if (!recognition) return false;
  const rawText = String(recognition.rawText || recognition.adoptedOcrText || '').trim();
  return recognition.status === 'empty'
    || (recognition.status === 'success' && (!rawText || !hasValidWatermarkEvidence(recognition)));
}

function hasValidWatermarkEvidence(recognition = {}) {
  const text = String(recognition.rawText || recognition.adoptedOcrText || '').trim();
  if (!text) return false;
  const parsedWatermark = recognition.parsedWatermark || {};
  const parsedFields = recognition.parsedFields || {};
  const hasDate = Boolean(parsedWatermark.date || parsedFields.date);
  const hasTime = Boolean(parsedWatermark.time || parsedFields.time);
  const watermarkMarkers = [
    '物业公司',
    '小区名称',
    '防伪',
    '佳恒物业',
    'JIAHENG SERVICE',
    '天气',
    '星期',
    '工作内容',
    '违停类型'
  ];
  const normalizedText = text.toUpperCase();
  const markerCount = watermarkMarkers.filter((marker) => normalizedText.includes(marker.toUpperCase())).length;
  return (hasDate && hasTime)
    || (hasDate && markerCount >= 1)
    || (hasTime && markerCount >= 2)
    || markerCount >= 3;
}

function sanitizeGroupTitle(value = '') {
  const title = String(value || '').trim();
  const blocked = new Set([
    '小区名称',
    '项目文本',
    '地点文本',
    '拍摄日期',
    '拍摄时间',
    '时间段',
    '上午',
    '下午',
    '晚上',
    '缺少照片阶段',
    '缺少处理状态',
    '待补充｜缺少照片阶段',
    '待补充｜缺少处理状态'
  ]);
  return blocked.has(title) ? '' : title;
}

function normalizeArchiveSuggestionForGrouping(suggestion = null) {
  if (!suggestion || typeof suggestion !== 'object') return null;
  return {
    status: String(suggestion.status || ''),
    suggestedFields: normalizePlainObject(suggestion.suggestedFields),
    missingRequiredFields: Array.isArray(suggestion.missingRequiredFields) ? suggestion.missingRequiredFields.map(String) : []
  };
}

function normalizePlainObject(value = null) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}

function normalizeRecognitionForGrouping(recognition) {
  if (!recognition || typeof recognition !== 'object') return null;
  return {
    status: String(recognition.status || ''),
    rawText: String(recognition.rawText || recognition.adoptedOcrText || ''),
    adoptedOcrText: String(recognition.adoptedOcrText || recognition.rawText || ''),
    parsedFields: recognition.parsedFields && typeof recognition.parsedFields === 'object' ? recognition.parsedFields : {},
    parsedWatermark: recognition.parsedWatermark && typeof recognition.parsedWatermark === 'object' ? recognition.parsedWatermark : {}
  };
}

function inferWorkContentFromText(text = '') {
  const value = String(text || '').replace(/\s+/g, '');
  const rules = [
    ['楼道杂物清理', ['楼道杂物', '杂物清理']],
    ['飞线充电治理', ['飞线充电', '飞线']],
    ['消防通道违停', ['消防通道', '违停', '违规停车']],
    ['公共设施设备维修', ['公共设施', '设备维修', '设施维修']],
    ['环境卫生维护', ['环境卫生', '保洁', '清扫']],
    ['绿化养护', ['绿化', '修剪', '养护']]
  ];
  return rules.find(([, keywords]) => keywords.some((keyword) => value.includes(keyword)))?.[0] || '';
}

function getPendingRecognitionBucket(recognition = {}) {
  if (!recognition) return '待确认';
  if (['failed', 'provider_unavailable', 'not_configured', 'disabled'].includes(recognition.status)) return '待确认｜识别失败';
  const rawText = String(recognition.rawText || recognition.adoptedOcrText || '').trim();
  if (rawText) return '待确认｜已识别未匹配';
  return '待确认｜未识别到水印';
}

function getPendingRecognitionBasisLabel(title = '') {
  if (title.includes('识别失败')) return 'OCR 识别失败，需人工确认；错误原因见该照片识别结果。';
  if (title.includes('未识别到水印')) return '已执行 OCR，但未识别到有效水印文字。';
  if (title.includes('已识别未匹配')) return '已识别 OCR 文本，未匹配明确工作内容。';
  if (title.includes('未执行 OCR')) return '尚未执行 OCR 识别。';
  return 'OCR 结果为空或需人工确认。';
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

function createGroupingResult({ groups = [], rules = [], status = 'created', warnings = [], errors = [], createdAt, updatedAt, source = 'current_photo_list' }) {
  const now = new Date().toISOString();
  return {
    id: createId('smart-sort-result'),
    source,
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
    source: String(result.source || 'current_photo_list'),
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
