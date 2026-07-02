const defaultArchiveFields = {
  photoSource: '',
  project: '',
  department: '',
  watermarkCategory: '',
  workContent: '',
  date: '',
  area: '',
  location: '',
  itemName: '',
  photoStage: '',
  processStatus: '',
  keywords: '',
  remark: '',
  locationPlaceholder: ''
};

const requiredFieldLabels = [
  ['照片来源', 'photoSource'],
  ['项目', 'project'],
  ['部门', 'department'],
  ['水印分类', 'watermarkCategory'],
  ['工作内容', 'workContent'],
  ['日期', 'date'],
  ['照片阶段', 'photoStage']
];

export function normalizeRecognitionEvidence(recognitionResult = {}, photo = {}) {
  const rawText = String(recognitionResult.rawText || recognitionResult.adoptedOcrText || recognitionResult.text || '').trim();
  return {
    photoId: String(recognitionResult.photoId || photo.id || ''),
    success: recognitionResult.status === 'success' || recognitionResult.success === true,
    rawText,
    textLength: rawText.length,
    croppedImagePath: recognitionResult.cropResult?.croppedImagePath || recognitionResult.croppedImagePath || '',
    croppedPreview: recognitionResult.cropResult?.croppedPreviewUrl || recognitionResult.croppedPreview || '',
    engine: recognitionResult.engineResult?.ocrEngine || recognitionResult.engine || 'rapidocr',
    provider: recognitionResult.providerId || recognitionResult.provider || 'local_ocr',
    durationMs: Number(recognitionResult.durationMs || recognitionResult.engineResult?.durationMs || 0),
    error: recognitionResult.error || recognitionResult.errors?.[0]?.message || '',
    recognizedAt: recognitionResult.createdAt || recognitionResult.recognizedAt || new Date().toISOString(),
    taskId: recognitionResult.taskId || recognitionResult.stagedResultId || recognitionResult.logId || ''
  };
}

export function parseWatermarkRecord(recognitionResult = {}) {
  const evidence = normalizeRecognitionEvidence(recognitionResult);
  const rawText = evidence.rawText;
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const dateMatch = rawText.match(/(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})/);
  const timeMatch = rawText.match(/(?<!\d)(?<hour>\d{1,2}):(?<minute>\d{2})(?::\d{2})?(?!\d)/);
  const captureDate = dateMatch?.groups
    ? `${dateMatch.groups.year}-${dateMatch.groups.month.padStart(2, '0')}-${dateMatch.groups.day.padStart(2, '0')}`
    : '';
  const captureTime = timeMatch?.groups ? `${timeMatch.groups.hour.padStart(2, '0')}:${timeMatch.groups.minute}` : '';
  const projectText = findProjectText(rawText);
  const locationText = pickLabeledValue(rawText, ['地点', '地址', '位置']) || inferLocationLine(lines, projectText);
  const workContentText = pickLabeledValue(rawText, ['工作内容', '事项', '问题']) || inferWorkContentLine(lines);
  const remarkText = pickLabeledValue(rawText, ['备注', '说明']);
  const keywordCandidates = unique([
    ...splitKeywords(workContentText),
    ...splitKeywords(locationText),
    ...splitKeywords(remarkText)
  ]);
  const missingFacts = [];
  if (!captureDate) missingFacts.push('拍摄日期');
  if (!locationText) missingFacts.push('地点');
  if (!workContentText) missingFacts.push('工作内容');
  const parseWarnings = [];
  if (!evidence.success) parseWarnings.push(evidence.error || 'OCR 识别失败。');
  if (evidence.success && !rawText) parseWarnings.push('OCR 未识别到有效文字。');
  return {
    photoId: evidence.photoId,
    captureDate,
    captureTime,
    captureDateTime: [captureDate, captureTime].filter(Boolean).join(' '),
    locationText,
    projectText,
    watermarkCategoryText: pickLabeledValue(rawText, ['水印分类', '分类']),
    workContentText,
    remarkText,
    keywordCandidates,
    rawText,
    confidence: calculateWatermarkConfidence({ captureDate, locationText, workContentText, rawText, success: evidence.success }),
    missingFacts,
    parseWarnings
  };
}

export function buildArchiveSuggestion(watermarkRecord = {}, context = {}, previousSuggestion = null) {
  const suggestedFields = { ...defaultArchiveFields };
  const fieldSources = {};
  const confidenceByField = {};
  const candidateFields = {};
  const conflictFields = new Set(previousSuggestion?.conflictFields || []);
  const configs = context.configs || {};

  Object.entries(previousSuggestion?.fieldSources || {}).forEach(([key, source]) => {
    if (!String(source || '').includes('manual')) return;
    const manualValue = normalizeValue(previousSuggestion?.suggestedFields?.[key]);
    if (!manualValue) return;
    suggestedFields[key] = manualValue;
    fieldSources[key] = source;
    confidenceByField[key] = previousSuggestion?.confidenceByField?.[key] || 1;
  });

  const setField = (key, value, source, confidence = 0.7) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    const previousValue = normalizeValue(previousSuggestion?.suggestedFields?.[key]);
    const previousSource = previousSuggestion?.fieldSources?.[key] || '';
    if (previousValue && previousValue !== normalized && previousSource.includes('manual')) {
      conflictFields.add(getFieldLabel(key));
      suggestedFields[key] = previousValue;
      fieldSources[key] = previousSource;
      confidenceByField[key] = previousSuggestion?.confidenceByField?.[key] || 1;
      return;
    }
    suggestedFields[key] = normalized;
    fieldSources[key] = source;
    confidenceByField[key] = confidence;
  };

  setField('date', watermarkRecord.captureDate, 'watermark.date', 0.95);
  setField('photoSource', context.currentPhotoSource || context.defaultPhotoSource || configs.photoSources?.[0], 'context.photoSource', 0.9);
  setField('project', context.currentProject || inferProjectFromText(watermarkRecord.projectText || watermarkRecord.locationText, configs.projects) || context.defaultProject, context.currentProject ? 'context.project' : 'watermark.project', 0.85);
  setField('department', context.defaultDepartment, 'default.department', 0.55);

  const categoryMatch = matchCategory(watermarkRecord.watermarkCategoryText || watermarkRecord.workContentText, configs.watermarkCategories);
  if (categoryMatch.category) setField('watermarkCategory', categoryMatch.category, categoryMatch.source, categoryMatch.confidence);
  if (categoryMatch.candidates.length > 1) candidateFields.watermarkCategoryCandidates = categoryMatch.candidates;

  const workMatch = matchWorkContent(watermarkRecord.workContentText, configs.watermarkCategories, suggestedFields.watermarkCategory);
  if (workMatch.workContent) {
    setField('workContent', workMatch.workContent, workMatch.source, workMatch.confidence);
    if (workMatch.category && !suggestedFields.watermarkCategory) setField('watermarkCategory', workMatch.category, 'rule.categoryMap', 0.8);
  }
  if (workMatch.candidates.length > 1) candidateFields.workContentCandidates = workMatch.candidates;

  const area = stripProjectName(watermarkRecord.locationText, suggestedFields.project || watermarkRecord.projectText);
  setField('area', area, 'watermark.location', 0.75);
  setField('location', area, 'watermark.location', 0.75);
  setField('itemName', buildItemName({ date: watermarkRecord.captureDate, area, workContent: suggestedFields.workContent || watermarkRecord.workContentText }), 'derived.itemName', 0.65);
  setField('keywords', unique([...(watermarkRecord.keywordCandidates || []), suggestedFields.workContent, area]).join('、'), 'derived.keywords', 0.6);
  setField('remark', watermarkRecord.remarkText, 'watermark.remark', 0.6);

  const stage = inferStage(watermarkRecord.rawText || '', configs.photoStages);
  if (stage.value) setField('photoStage', stage.value, stage.source, stage.confidence);
  if (stage.candidates.length > 1) candidateFields.photoStageCandidates = stage.candidates;

  const status = inferProcessStatus(watermarkRecord.rawText || '', configs.processStatuses);
  if (status.value) setField('processStatus', status.value, status.source, status.confidence);
  if (status.candidates.length > 1) candidateFields.processStatusCandidates = status.candidates;

  const safeFields = sanitizeArchiveFields(suggestedFields, configs);
  const missingRequiredFields = validateSortForm(safeFields);
  const needsHumanReview = missingRequiredFields.length > 0 || Object.keys(candidateFields).length > 0 || conflictFields.size > 0;
  return {
    photoId: watermarkRecord.photoId || '',
    suggestedFields: safeFields,
    fieldSources,
    confidenceByField,
    missingRequiredFields,
    conflictFields: Array.from(conflictFields),
    candidateFields,
    needsHumanReview,
    status: missingRequiredFields.length ? 'needs_completion' : 'suggestion_ready',
    generatedAt: new Date().toISOString()
  };
}

export function updateArchiveSuggestion(currentSuggestion = null, userPatch = {}, context = {}) {
  const configs = context.configs || {};
  const base = currentSuggestion || buildArchiveSuggestion({ photoId: context.photoId || '' }, context);
  const suggestedFields = sanitizeArchiveFields({ ...base.suggestedFields, ...userPatch }, configs);
  const fieldSources = { ...base.fieldSources };
  Object.keys(userPatch).forEach((key) => {
    fieldSources[key] = base.fieldSources?.[key] && base.fieldSources[key] !== 'manual' ? 'mixed' : 'manual';
  });
  const missingRequiredFields = validateSortForm(suggestedFields);
  return {
    ...base,
    suggestedFields,
    fieldSources,
    missingRequiredFields,
    needsHumanReview: missingRequiredFields.length > 0 || (base.conflictFields || []).length > 0 || Object.keys(base.candidateFields || {}).length > 0,
    status: missingRequiredFields.length ? 'needs_completion' : 'suggestion_ready',
    generatedAt: base.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function regenerateArchiveSuggestion(watermarkRecord = {}, context = {}, currentSuggestion = null) {
  return buildArchiveSuggestion(watermarkRecord, context, currentSuggestion);
}

export function confirmArchiveSuggestion(archiveSuggestion = {}) {
  const archiveInfo = normalizeConfirmedArchiveInfo(archiveSuggestion.suggestedFields || {});
  const missingRequiredFields = validateSortForm(archiveInfo);
  if (missingRequiredFields.length) {
    return {
      ok: false,
      missingRequiredFields,
      errors: [`请补全：${missingRequiredFields.join('、')}`]
    };
  }
  return { ok: true, archiveInfo, missingRequiredFields: [], errors: [] };
}

export function clearRecognitionForPhoto({ recognitionResultsByPhoto = {}, watermarkRecordsByPhoto = {}, photoId = '' } = {}) {
  const nextRecognition = { ...recognitionResultsByPhoto };
  const nextWatermark = { ...watermarkRecordsByPhoto };
  delete nextRecognition[photoId];
  delete nextWatermark[photoId];
  return { recognitionResultsByPhoto: nextRecognition, watermarkRecordsByPhoto: nextWatermark };
}

export function clearArchiveSuggestionForPhoto({ archiveSuggestionsByPhoto = {}, photoId = '' } = {}) {
  const nextSuggestions = { ...archiveSuggestionsByPhoto };
  delete nextSuggestions[photoId];
  return { archiveSuggestionsByPhoto: nextSuggestions };
}

export function getPreviewDisabledReason({ isBusy, selectedIds, selectedHasIgnored, selectedAssignedCount, assignedCount, suggestion } = {}) {
  if (isBusy) return '正在处理，请稍候。';
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) return '请先选择需要预览的照片。';
  if (selectedHasIgnored) return '当前选择包含已忽略照片，请先还原。';
  if (selectedAssignedCount > 0 && assignedCount > 0) return '';
  if (suggestion?.missingRequiredFields?.length) return `请先补全归档建议字段：${suggestion.missingRequiredFields.join('、')}`;
  if (suggestion && suggestion.status !== 'confirmed') return '请先确认归档建议。';
  return '请先确认归档建议。';
}

export function validateSortForm(form = {}) {
  return requiredFieldLabels.filter(([, key]) => !normalizeValue(form[key])).map(([label]) => label);
}

export function sanitizeArchiveFields(fields = {}, configs = {}) {
  const categories = Object.keys(configs.watermarkCategories || {});
  const watermarkCategory = categories.includes(fields.watermarkCategory) ? fields.watermarkCategory : '';
  const workOptions = configs.watermarkCategories?.[watermarkCategory]?.items || [];
  return {
    ...defaultArchiveFields,
    ...fields,
    photoSource: pickIfValid(fields.photoSource, configs.photoSources),
    project: pickIfValid(fields.project, configs.projects),
    department: pickIfValid(fields.department, configs.departments),
    watermarkCategory,
    workContent: workOptions.includes(fields.workContent) ? fields.workContent : '',
    photoStage: pickIfValid(fields.photoStage, configs.photoStages),
    processStatus: pickIfValid(fields.processStatus, configs.processStatuses),
    location: normalizeValue(fields.location || fields.area)
  };
}

export function normalizeConfirmedArchiveInfo(fields = {}) {
  return {
    photoSource: fields.photoSource || '',
    project: fields.project || '',
    department: fields.department || '',
    watermarkCategory: fields.watermarkCategory || '',
    workContent: fields.workContent || '',
    itemName: fields.itemName || '',
    workItem: fields.itemName || '',
    location: fields.location || fields.area || '',
    date: fields.date || '',
    photoStage: fields.photoStage || '',
    processStatus: fields.processStatus || '',
    keywords: fields.keywords || '',
    remark: fields.remark || ''
  };
}

export function getSuggestionSourceLabel(suggestion) {
  if (!suggestion) return '暂无建议';
  if (suggestion.status === 'confirmed') return '已确认归档建议';
  if (suggestion.status === 'needs_completion') return '待补充归档建议';
  if (suggestion.status === 'failed') return '需人工新建建议';
  return '待确认归档建议';
}

export const sanitizeDraftFields = sanitizeArchiveFields;

function pickIfValid(value, options = []) {
  const normalized = normalizeValue(value);
  return options.includes(normalized) ? normalized : '';
}

function normalizeValue(value) {
  return String(value || '').trim();
}

function pickLabeledValue(rawText = '', labels = []) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[：:]\\s*([^\\n\\r]+)`);
    const match = rawText.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function findProjectText(rawText = '') {
  if (rawText.includes('潇湘') || rawText.includes('新区二期')) return '潇湘新区二期';
  if (rawText.includes('香辰')) return '香辰康园';
  return '';
}

function inferProjectFromText(text = '', projects = []) {
  const normalized = normalizeCompareText(text);
  return projects.find((project) => normalized.includes(normalizeCompareText(project)) || normalizeCompareText(project).includes(normalized)) || '';
}

function inferLocationLine(lines = [], projectText = '') {
  const normalizedProject = normalizeValue(projectText);
  return lines.find((line) => (normalizedProject && line.includes(normalizedProject)) || /栋|单元|门口|楼道|车库|消防通道|现场|位置|地址|building|entrance|gate|garage|floor|unit|location|address|phase/i.test(line)) || '';
}

function inferWorkContentLine(lines = []) {
  return lines.find((line) => /维修|违停|清理|治理|巡查|保洁|养护|隐患|飞线|消防|照明|闭门器|repair|parking|violation|clean|patrol|lighting|fire lane|door closer|maintenance/i.test(line)) || '';
}

function matchCategory(text = '', categories = {}) {
  const candidates = Object.keys(categories).filter((category) => normalizeCompareText(text).includes(normalizeCompareText(category)));
  if (candidates.length === 1) return { category: candidates[0], candidates, source: 'watermark.category', confidence: 0.75 };
  return { category: '', candidates, source: '', confidence: 0 };
}

function matchWorkContent(text = '', categories = {}, preferredCategory = '') {
  const rows = [];
  Object.entries(categories || {}).forEach(([category, config]) => {
    (config.items || []).forEach((item) => {
      if (normalizeCompareText(text).includes(normalizeCompareText(item)) || normalizeCompareText(item).includes(normalizeCompareText(text))) {
        rows.push({ category, item });
      }
    });
  });
  const preferred = rows.find((row) => row.category === preferredCategory) || rows[0];
  return {
    workContent: preferred?.item || '',
    category: preferred?.category || '',
    candidates: rows.map((row) => row.item),
    source: preferred ? 'rule.workContentMap' : '',
    confidence: preferred ? 0.85 : 0
  };
}

function inferStage(rawText = '', photoStages = []) {
  const candidates = photoStages.filter((stage) => normalizeCompareText(rawText).includes(normalizeCompareText(stage)));
  if (candidates.length === 1) return { value: candidates[0], candidates, source: 'rule.stageInfer', confidence: 0.65 };
  return { value: '', candidates, source: '', confidence: 0 };
}

function inferProcessStatus(rawText = '', statuses = []) {
  const candidates = statuses.filter((status) => normalizeCompareText(rawText).includes(normalizeCompareText(status)));
  if (candidates.length === 1) return { value: candidates[0], candidates, source: 'rule.statusInfer', confidence: 0.65 };
  return { value: '', candidates, source: '', confidence: 0 };
}

function stripProjectName(location = '', project = '') {
  return normalizeValue(location).replace(normalizeValue(project), '').replace(/曲靖/g, '').trim() || normalizeValue(location);
}

function buildItemName({ date = '', area = '', workContent = '' } = {}) {
  return [area, workContent].filter(Boolean).join(' ') || [date, workContent].filter(Boolean).join(' ');
}

function splitKeywords(value = '') {
  return normalizeValue(value).split(/[、，,\s/]+/).map((item) => item.trim()).filter((item) => item.length >= 2);
}

function unique(values = []) {
  return Array.from(new Set(values.map(normalizeValue).filter(Boolean)));
}

function normalizeCompareText(value = '') {
  return normalizeValue(value).replace(/\s+/g, '').toLowerCase();
}

function calculateWatermarkConfidence({ captureDate, locationText, workContentText, rawText, success }) {
  if (!success) return 0;
  let score = rawText ? 0.25 : 0;
  if (captureDate) score += 0.25;
  if (locationText) score += 0.25;
  if (workContentText) score += 0.25;
  return Number(score.toFixed(2));
}
