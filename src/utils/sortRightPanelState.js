import { validateArchiveFormByTemplate } from './archiveFormValidation.js';
import {
  buildTemplateDrivenCanonical,
  isolateTemplateSpecificFields,
  NOT_APPLICABLE_WORK_CONTENT,
  WATERMARK_TEMPLATE_TYPES
} from './watermarkTemplateAdapter.js';
import {
  buildCanonicalArchiveFormSeed,
  buildSourceCanonical,
  resolveEffectivePhotoArchiveInfo
} from './photoCanonical.js';

const defaultArchiveFields = {
  watermarkTemplateType: WATERMARK_TEMPLATE_TYPES.UNRESOLVED,
  project: '',
  projectId: '',
  projectName: '',
  projectOriginalText: '',
  projectConfirmed: false,
  projectSource: '',
  archiveCategory: '',
  watermarkCategory: '',
  workContent: '',
  date: '',
  area: '',
  location: '',
  locationArea: '',
  keywords: '',
  remark: '',
  remarks: '',
  propertyCompany: '',
  communityName: '',
  vehiclePlate: '',
  violationType: '',
  constructionUnitId: '',
  constructionUnitName: '',
  constructionUnitOriginalText: '',
  constructionUnitConfirmed: false,
  constructionUnitSource: '',
  fieldSources: {},
  unresolvedFields: []
};

const requiredFieldLabels = [
  ['项目', 'project'],
  ['归档分类', 'watermarkCategory'],
  ['工作内容', 'workContent'],
  ['日期', 'date']
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
  const projectText = pickLabeledValue(rawText, ['项目文本', '项目名称', '项目', '小区名称']);
  const locationText = stripProjectName(
    pickLabeledValue(rawText, ['地点文本', '区域文本', '位置文本', '地点', '地址', '位置']) || inferLocationLine(lines, projectText),
    projectText
  );
  const workContentText = cleanLabeledValue(pickLabeledValue(rawText, ['工作内容文本', '工作事项', '工作内容']));
  const remarkText = cleanLabeledValue(pickLabeledValue(rawText, ['备注文本', '说明文本', '备注', '说明']));
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
    watermarkCategoryText: cleanLabeledValue(pickLabeledValue(rawText, ['水印分类文本', '归档分类文本', '水印分类', '归档分类', '分类'])),
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
    if (!String(source || '').includes('manual') && !String(source || '').includes('mixed')) return;
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
    if (previousValue && previousValue !== normalized && (previousSource.includes('manual') || previousSource.includes('mixed'))) {
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
  const currentProject = pickIfValid(context.currentProject, configs.projects || []);
  const watermarkProject = inferProjectFromText(watermarkRecord.projectText, configs.projects || []);
  setField('project', currentProject || watermarkProject, currentProject ? 'context.project' : 'watermark.project', 0.85);

  const categoryMatch = matchCategory(watermarkRecord.watermarkCategoryText || watermarkRecord.workContentText, configs.watermarkCategories);
  if (categoryMatch.category) setField('watermarkCategory', categoryMatch.category, categoryMatch.source, categoryMatch.confidence);
  if (categoryMatch.candidates.length > 1) candidateFields.watermarkCategoryCandidates = categoryMatch.candidates;

  const workMatch = matchWorkContent(watermarkRecord.workContentText, configs.watermarkCategories, suggestedFields.watermarkCategory);
  if (workMatch.workContent) {
    setField('workContent', workMatch.workContent, workMatch.source, workMatch.confidence);
    if (workMatch.category && !suggestedFields.watermarkCategory) setField('watermarkCategory', workMatch.category, 'rule.categoryMap', 0.8);
  } else if (watermarkRecord.workContentText) {
    setField('workContent', watermarkRecord.workContentText, 'watermark.workContent', 0.72);
    candidateFields.workContentCandidates = unique([...(candidateFields.workContentCandidates || []), watermarkRecord.workContentText]);
  }
  if (workMatch.candidates.length > 1) candidateFields.workContentCandidates = workMatch.candidates;

  const area = stripProjectName(watermarkRecord.locationText, suggestedFields.project || watermarkRecord.projectText);
  setField('area', area, 'watermark.location', 0.75);
  setField('location', area, 'watermark.location', 0.75);
  setField('keywords', unique([...(watermarkRecord.keywordCandidates || []), suggestedFields.workContent, area]).join('、'), 'derived.keywords', 0.6);
  setField('remark', watermarkRecord.remarkText, 'watermark.remark', 0.6);
  if (
    suggestedFields.remark
    && suggestedFields.workContent
    && normalizeCompareText(suggestedFields.remark) === normalizeCompareText(suggestedFields.workContent)
    && !String(fieldSources.remark || '').includes('manual')
    && !String(fieldSources.remark || '').includes('mixed')
  ) {
    suggestedFields.remark = '';
    delete fieldSources.remark;
    delete confidenceByField.remark;
  }

  const templateCanonical = buildTemplateDrivenCanonical({
    watermarkRecord,
    archiveSuggestion: {
      suggestedFields,
      fieldSources
    },
    configs
  });
  const hasResolvedTemplate = templateCanonical.watermarkTemplateType
    !== WATERMARK_TEMPLATE_TYPES.UNRESOLVED;
  const templateFields = hasResolvedTemplate
    ? {
        ...templateCanonical,
        area: templateCanonical.locationArea,
        location: templateCanonical.locationArea,
        remark: templateCanonical.remarks
      }
    : {};
  const mergedFields = {
    ...suggestedFields,
    ...templateFields
  };
  const mergedFieldSources = {
    ...fieldSources,
    ...(hasResolvedTemplate ? templateCanonical.fieldSources : {})
  };
  Object.entries(previousSuggestion?.fieldSources || {}).forEach(([key, source]) => {
    if (!String(source || '').includes('manual') && !String(source || '').includes('mixed')) return;
    const manualValue = previousSuggestion?.suggestedFields?.[key];
    if (manualValue == null) return;
    mergedFields[key] = manualValue;
    mergedFieldSources[key] = source;
  });
  const safeFields = sanitizeArchiveFields(mergedFields, configs);
  const missingRequiredFields = validateSortForm(safeFields, configs);
  const needsHumanReview = missingRequiredFields.length > 0 || Object.keys(candidateFields).length > 0 || conflictFields.size > 0;
  return {
    photoId: watermarkRecord.photoId || '',
    suggestedFields: safeFields,
    fieldSources: mergedFieldSources,
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
  const missingRequiredFields = validateSortForm(suggestedFields, configs);
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

export function confirmArchiveSuggestion(archiveSuggestion = {}, configs = {}) {
  const archiveInfo = normalizeConfirmedArchiveInfo(
    sanitizeArchiveFields(archiveSuggestion.suggestedFields || {}, configs)
  );
  const missingRequiredFields = validateSortForm(archiveInfo, configs);
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

export function validateSortForm(form = {}, configs = {}) {
  return validateArchiveFormByTemplate(form, configs);
}

export const validateRequiredArchiveFields = validateSortForm;

export function buildCurrentPhotoArchiveServiceForm(archiveInfo = {}, configs = {}) {
  return sanitizeArchiveFields({
    ...archiveInfo,
    project: pickIfValid(archiveInfo.projectName || archiveInfo.project, configs.projects || []),
    projectName: pickIfValid(archiveInfo.projectName || archiveInfo.project, configs.projects || []),
    watermarkCategory: archiveInfo.watermarkCategory || archiveInfo.archiveCategory || '',
    archiveCategory: archiveInfo.archiveCategory || archiveInfo.watermarkCategory || '',
    location: archiveInfo.location ?? archiveInfo.locationArea ?? '',
    locationArea: archiveInfo.locationArea ?? archiveInfo.location ?? '',
    remark: archiveInfo.remark ?? archiveInfo.remarks ?? '',
    remarks: archiveInfo.remarks ?? archiveInfo.remark ?? ''
  }, configs);
}

export function sanitizeArchiveFields(fields = {}, configs = {}) {
  const categories = Object.keys(configs.watermarkCategories || {});
  const watermarkCategory = categories.includes(fields.watermarkCategory) ? fields.watermarkCategory : normalizeValue(fields.watermarkCategory);
  const workOptions = configs.watermarkCategories?.[watermarkCategory]?.items || [];
  const workContent = workOptions.includes(fields.workContent) ? fields.workContent : normalizeValue(fields.workContent);
  const project = pickIfValid(fields.projectName || fields.project, configs.projects || []);
  const projectOption = (configs.projectOptions || [])
    .find((item) => item.name === project);
  const projectId = projectOption && (!fields.projectId || fields.projectId === projectOption.id)
    ? projectOption.id
    : '';
  return isolateTemplateSpecificFields({
    ...defaultArchiveFields,
    ...fields,
    project,
    projectId,
    projectName: project,
    projectConfirmed: Boolean(projectId),
    projectSource: fields.projectSource || (projectId ? 'config_exact' : ''),
    watermarkCategory,
    archiveCategory: watermarkCategory,
    workContent,
    location: normalizeValue(fields.location || fields.locationArea || fields.area),
    locationArea: normalizeValue(fields.locationArea || fields.location || fields.area),
    remark: normalizeValue(fields.remark || fields.remarks),
    remarks: normalizeValue(fields.remarks || fields.remark),
    fieldSources: fields.fieldSources && typeof fields.fieldSources === 'object'
      ? { ...fields.fieldSources }
      : {},
    unresolvedFields: Array.isArray(fields.unresolvedFields)
      ? [...fields.unresolvedFields]
      : []
  });
}

export function resolveCanonicalPhotoResult({
  photo = {},
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null,
  sourceAwareProcessing = null,
  group = null,
  sourceCanonical = null,
  photoDraft = null,
  configs = {}
} = {}) {
  void group;
  const templateCanonical = sourceCanonical || buildSourceCanonical({
    photo,
    recognitionResult,
    watermarkRecord,
    sourceAwareProcessing,
    configs
  });
  const processing = sourceAwareProcessing || recognitionResult?.sourceAwareProcessing || null;
  const effective = resolveEffectivePhotoArchiveInfo({
    photo,
    sourceCanonical: templateCanonical,
    sourceAwareProcessing: processing,
    photoDraft: photoDraft || getManualDraftFields(archiveSuggestion)
  });
  return {
    ...effective,
    conflicts: normalizeCanonicalConflicts(
      processing?.ocrSupplement?.conflicts
      || processing?.conflicts
      || archiveSuggestion?.conflictFields
    )
  };
}

export function buildArchiveFormSeed({
  photo = {},
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null,
  sourceAwareProcessing = null,
  group = null,
  groupCanonical = null,
  sourceCanonical = null,
  groupDraft = null,
  photoDraft = null,
  configs = {}
} = {}) {
  if (photo?.archiveInfo) {
    return sanitizeArchiveFields({
      ...photo.archiveInfo,
      location: photo.archiveInfo.location ?? ''
    }, configs);
  }
  const canonical = resolveCanonicalPhotoResult({
    photo,
    recognitionResult,
    watermarkRecord,
    archiveSuggestion,
    sourceAwareProcessing,
    group,
    sourceCanonical,
    photoDraft,
    configs
  });
  return sanitizeArchiveFields(
    buildCanonicalArchiveFormSeed({
      groupCanonical,
      activePhotoEffectiveInfo: canonical,
      groupDraft,
      photoDraft: photoDraft || getManualDraftFields(archiveSuggestion)
    }),
    configs
  );
}

export function normalizeConfirmedArchiveInfo(fields = {}) {
  return {
    ...defaultArchiveFields,
    ...fields,
    project: fields.projectName || fields.project || '',
    projectName: fields.projectName || fields.project || '',
    archiveCategory: fields.archiveCategory || fields.watermarkCategory || '',
    watermarkCategory: fields.watermarkCategory || fields.archiveCategory || '',
    workContent: fields.workContent || '',
    location: fields.location || fields.locationArea || fields.area || '',
    locationArea: fields.locationArea || fields.location || fields.area || '',
    date: fields.date || '',
    keywords: fields.keywords || '',
    remark: fields.remark || fields.remarks || '',
    remarks: fields.remarks || fields.remark || ''
  };
}

export function getSuggestionSourceLabel(suggestion) {
  if (!suggestion) return '暂无建议';
  if (suggestion.status === 'confirmed') return '已确认归档建议';
  if (suggestion.status === 'needs_completion') return '待补充归档建议';
  if (suggestion.status === 'failed') return '需人工新建建议';
  return '待确认归档建议';
}

export function buildRecognitionSuggestionDisplayModel({ archiveSuggestion = null, recognitionResult = null, watermarkRecord = null } = {}) {
  if (archiveSuggestion?.suggestedFields) {
    const fields = archiveSuggestion.suggestedFields;
    const applicable = [];
    const push = (key, label, value, options = {}) => {
      const normalized = normalizeValue(value);
      if (!normalized) return;
      applicable.push({
        key,
        label,
        value: options.value || normalized,
        displayValue: options.displayValue || normalized
      });
    };
    push('date', '日期', fields.date, { displayValue: formatSuggestionDate(fields.date) });
    push('time-display-only', '时间', watermarkRecord?.captureTime);
    push('location', '位置/区域', stripProjectName(
      fields.location || fields.area || watermarkRecord?.locationText,
      fields.project || watermarkRecord?.projectText
    ));
    push('workContent', '工作内容', fields.workContent || watermarkRecord?.workContentText);
    push('watermarkCategory', '归档分类', fields.watermarkCategory);
    push('remark', '备注', fields.remark);
    push('keywords', '关键词', fields.keywords);
    return {
      applicableDisplayFields: applicable,
      applicableFormFields: applicable.filter((field) => field.key !== 'time-display-only'),
      missingFields: normalizeMissingFields(archiveSuggestion.missingRequiredFields),
      conflictFields: archiveSuggestion.conflictFields || [],
      sourceText: '来源：归档建议',
      description: archiveSuggestion.missingRequiredFields?.length
        ? '已根据水印事实生成归档建议，待补充核心字段。'
        : '已根据水印事实生成归档建议，请核对后确认。'
    };
  }

  const parsed = recognitionResult?.parsedWatermark || recognitionResult?.parsedFields || {};
  const rawText = normalizeValue(recognitionResult?.rawText || recognitionResult?.adoptedOcrText);
  const applicable = [];
  const push = (key, label, value, options = {}) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    applicable.push({
      key,
      label,
      value: options.value || normalized,
      displayValue: options.displayValue || normalized
    });
  };
  const normalizedDate = normalizeSuggestionDate(parsed.date || parsed.capturedAt || parsed.dateTime);
  push('date', '日期', normalizedDate, { displayValue: formatSuggestionDate(normalizedDate) });
  push('time-display-only', '时间', parsed.time);
  push('project', '项目', parsed.projectName || parsed.project);
  push('watermarkCategory', '归档分类', parsed.watermarkCategory || parsed.category);
  push('workContent', '工作内容', parsed.workContent);
  push('location', '位置/区域', parsed.location);
  if (Array.isArray(parsed.keywords) && parsed.keywords.length) push('keywords', '关键词', parsed.keywords.join('、'));
  push('remark', '备注', parsed.remark);
  const presentKeys = new Set(applicable.filter((field) => field.key !== 'time-display-only').map((field) => field.key));
  const missingFields = ['date', 'watermarkCategory', 'workContent']
    .filter((key) => !presentKeys.has(key))
    .map((key) => ({ date: '日期', watermarkCategory: '归档分类', workContent: '工作内容' }[key]));
  return {
    applicableDisplayFields: applicable,
    applicableFormFields: applicable.filter((field) => field.key !== 'time-display-only'),
    missingFields: rawText ? missingFields : [],
    conflictFields: [],
    sourceText: rawText ? '来源：OCR 水印识别' : '暂无 OCR 水印识别结果',
    description: rawText
      ? '已识别 OCR 文本，待人工确认字段。'
      : '请先选择照片并点击“智拣”。'
  };
}

export const sanitizeDraftFields = sanitizeArchiveFields;

function pickIfValid(value, options = []) {
  const normalized = normalizeValue(value);
  return options.includes(normalized) ? normalized : '';
}

function getFieldLabel(key = '') {
  const labels = {
    project: '项目',
    watermarkCategory: '归档分类',
    workContent: '工作内容',
    date: '日期',
    area: '位置/区域',
    location: '位置/区域',
    keywords: '关键词',
    remark: '备注',
    constructionUnitName: '施工单位',
    constructionUnitId: '施工单位',
    vehiclePlate: '车牌号码',
    violationType: '违停类型'
  };
  return labels[key] || key;
}

function normalizeValue(value) {
  return String(value || '').trim();
}

function normalizeMissingFields(fields = []) {
  const allowed = new Set(['水印模板', '项目', '日期', '工作内容', '归档分类', '施工单位', '车牌号码', '违停类型']);
  return (fields || [])
    .map((field) => {
      if (field === '水印分类') return '归档分类';
      return field;
    })
    .filter((field) => allowed.has(field));
}

function getManualDraftFields(archiveSuggestion = null) {
  const result = {};
  Object.entries(archiveSuggestion?.suggestedFields || {}).forEach(([key, value]) => {
    const source = String(archiveSuggestion?.fieldSources?.[key] || '');
    if (!source.includes('manual') && !source.includes('mixed')) return;
    result[key] = value;
  });
  return result;
}

function normalizeSuggestionDate(value = '') {
  const text = normalizeValue(value);
  const match = text.match(/(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})/);
  if (!match?.groups) return '';
  return `${match.groups.year}-${match.groups.month.padStart(2, '0')}-${match.groups.day.padStart(2, '0')}`;
}

function formatSuggestionDate(value = '') {
  return normalizeValue(value).replaceAll('-', '/');
}

function pickLabeledValue(rawText = '', labels = []) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*[：:]\\s*([^\\n\\r]+)`);
    const match = rawText.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function cleanLabeledValue(value = '') {
  return normalizeValue(value)
    .replace(/^(小区名称|项目名称|项目|工作内容文本|地点文本|区域文本|位置文本|地点|地址|位置|区域|备注文本|拍摄日期|拍摄时间)\s*[：:]\s*/, '')
    .trim();
}

function inferProjectFromText(text = '', projects = []) {
  const normalized = normalizeCompareText(text);
  if (!normalized) return '';
  return projects.find((project) => normalized === normalizeCompareText(project)) || '';
}

function inferLocationLine(lines = [], projectText = '') {
  const normalizedProject = normalizeValue(projectText);
  return lines.find((line) => {
    const candidate = stripProjectName(line, normalizedProject);
    if (!candidate) return false;
    return /栋|幢|单元|东门|西门|南门|北门|大门|门口|门岗|入口|出口|楼层|楼道|通道|车库|道路|绿化带|设备房|消防通道|公共区域|地下室|电梯厅|现场|位置|地址|building|entrance|gate|garage|floor|unit|location|address|phase/i.test(candidate);
  }) || '';
}

function matchCategory(text = '', categories = {}) {
  const normalizedText = normalizeCompareText(text);
  if (!normalizedText) return { category: '', candidates: [], source: '', confidence: 0 };
  const candidates = Object.keys(categories)
    .filter((category) => normalizeCompareText(category) === normalizedText);
  if (candidates.length === 1) return { category: candidates[0], candidates, source: 'watermark.category.exact', confidence: 1 };
  return { category: '', candidates, source: '', confidence: 0 };
}

function matchWorkContent(text = '', categories = {}, preferredCategory = '') {
  const normalizedText = normalizeCompareText(text);
  if (!normalizedText) return { workContent: '', category: '', candidates: [], source: '', confidence: 0 };
  const rows = [];
  Object.entries(categories || {}).forEach(([category, config]) => {
    if (preferredCategory && category !== preferredCategory) return;
    (config.items || []).forEach((item) => {
      const normalizedItem = normalizeCompareText(item);
      if (normalizedText === normalizedItem) {
        rows.push({ category, item });
      }
    });
  });
  const preferred = rows.find((row) => row.category === preferredCategory) || rows[0];
  return {
    workContent: preferred?.item || '',
    category: preferred?.category || '',
    candidates: rows.map((row) => row.item),
    source: preferred ? 'watermark.workContent.exact' : '',
    confidence: preferred ? 1 : 0
  };
}

function stripProjectName(location = '', project = '') {
  const cleaned = cleanLabeledValue(location);
  const normalizedProject = normalizeValue(project);
  const withoutProject = normalizedProject ? cleaned.replace(normalizedProject, '') : cleaned;
  return withoutProject
    .replace(/曲靖/g, '')
    .replace(/^[\s·•,，、;；:：/\\|_-]+|[\s·•,，、;；:：/\\|_-]+$/g, '')
    .trim();
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

function normalizeCanonicalConflicts(value = []) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item && typeof item === 'object') {
      return {
        field: normalizeValue(item.field),
        platformValue: normalizeValue(item.platformValue),
        ocrValue: normalizeValue(item.ocrValue)
      };
    }
    return { field: normalizeValue(item), platformValue: '', ocrValue: '' };
  }).filter((item) => item.field);
}

function calculateWatermarkConfidence({ captureDate, locationText, workContentText, rawText, success }) {
  if (!success) return 0;
  let score = rawText ? 0.25 : 0;
  if (captureDate) score += 0.25;
  if (locationText) score += 0.25;
  if (workContentText) score += 0.25;
  return Number(score.toFixed(2));
}
