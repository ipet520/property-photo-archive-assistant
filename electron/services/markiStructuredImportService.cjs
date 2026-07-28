const crypto = require('node:crypto');
const path = require('node:path');
const MARKI_TEMPLATE_CATEGORY_MAPPINGS = require('../shared/markiTemplateCategoryMappings.json');
const { buildMarkiSourceKey } = require('./markiSourceManifestService.cjs');
const {
  buildMarkiSourceMetadataRecord,
  buildMarkiSourceMetadataRef
} = require('./markiSourceMetadataService.cjs');

const SOURCE_TYPE = 'marki_api';
const PROVIDER_TYPE = 'structured_data';
const MAX_CONTENT_LENGTH = 1024 * 1024;
const MAX_IMPORT_ITEMS = 5000;
const REQUIRED_ARCHIVE_FIELDS = Object.freeze([
  ['日期', 'date'],
  ['项目', 'project'],
  ['归档分类', 'watermarkCategory'],
  ['工作内容', 'workContent']
]);
const RESERVED_FIELD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD_LABEL_ALIASES = Object.freeze({
  '拍摄日期': '日期',
  '拍照日期': '日期',
  '拍摄时间': '时间',
  '拍照时间': '时间',
  '项目': '小区名称',
  '项目名称': '小区名称',
  '小区': '小区名称',
  '工作事项': '工作内容',
  '事项': '工作内容',
  '地址': '地点',
  '位置': '地点',
  '客户位置': '地点',
  '发现地点': '地点',
  '拍照人': '上传人',
  '拍照人员': '上传人',
  '备注': '工作备注',
  '说明': '工作备注',
  '车牌号': '车牌号码'
});

class MarkiStructuredImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiStructuredImportError';
    this.code = code;
  }
}

function parseMarkiContent(content) {
  if (typeof content === 'string' && content.length > MAX_CONTENT_LENGTH) {
    return createContentParseFailure(
      'marki_content_too_large',
      '马克结构化 content 超过允许大小。'
    );
  }

  let parsed = content;
  if (typeof content === 'string') {
    if (!content.trim()) {
      return createContentParseFailure(
        'marki_content_missing',
        '马克结构化 content 为空。'
      );
    }
    try {
      parsed = JSON.parse(content);
    } catch {
      return createContentParseFailure(
        'marki_content_parse_failed',
        '马克结构化 content 无法解析。'
      );
    }
  }

  const entries = extractContentEntries(parsed);
  if (!entries) {
    return createContentParseFailure(
      'marki_content_shape_invalid',
      '马克结构化 content 格式不受支持。'
    );
  }

  const fields = Object.create(null);
  const cleanedEntries = [];
  const warnings = [];
  for (const [rawLabel, rawValue] of entries) {
    const label = normalizeFieldLabel(rawLabel);
    if (!label) continue;
    const value = cleanMarkiFieldValue(rawValue);
    if (!value) continue;
    cleanedEntries.push({ label, value });
    if (!Object.hasOwn(fields, label)) {
      fields[label] = value;
    } else if (fields[label] !== value) {
      warnings.push(`字段“${label}”存在多个有效值，已保留首个值。`);
    }
  }

  return {
    success: true,
    errorCode: '',
    errorMessage: '',
    fields,
    entries: cleanedEntries,
    warnings: uniqueStrings(warnings)
  };
}

function cleanMarkiFieldValue(value) {
  let text = normalizePrimitiveValue(value);
  if (!text) return '';
  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text || isPlaceholderValue(text)) return '';
  return text.slice(0, 2000);
}

function mapMarkiMoment(moment = {}, configs = {}, options = {}) {
  const normalizedMoment = normalizeMoment(moment);
  const parsedContent = parseMarkiContent(moment.content);
  const fields = parsedContent.fields;
  const dateInfo = resolveCaptureDate(fields, normalizedMoment.postTime);
  const projectMatch = matchConfiguredValue(
    fields['小区名称'],
    normalizeProjectOptions(configs.projects),
    options.projectAliases
  );
  const activeProject = normalizeActiveProject(options.activeProject, false);
  const businessProjectName = activeProject?.projectName || projectMatch.value;
  const categoryMatch = matchConfiguredValue(
    normalizedMoment.markName,
    normalizeCategoryOptions(configs.watermarkCategories),
    MARKI_TEMPLATE_CATEGORY_MAPPINGS,
    {
      allowConfiguredAliases: false,
      mappingSource: 'marki.template_mapping.exact'
    }
  );
  const locationInfo = resolveLocation(fields['地点'], normalizedMoment.lng, normalizedMoment.lat);
  const workContent = resolveWorkContent(fields, normalizedMoment.markName);
  const keywords = uniqueStrings([
    fields['标题'],
    fields['施工单位'],
    fields['违停类型'],
    fields['车牌号码']
  ].filter((value) => value && value !== workContent));
  const warnings = uniqueStrings([
    ...parsedContent.warnings,
    ...dateInfo.warnings,
    !projectMatch.value && projectMatch.candidate
      ? '马克项目未匹配现有项目，已保留候选值。'
      : '',
    !categoryMatch.value && categoryMatch.candidate
      ? '马克水印名称未匹配现有归档分类，已保留候选值。'
      : '',
    !workContent ? '马克结构化数据缺少有效工作内容。' : ''
  ]);

  const suggestedFields = {
    project: businessProjectName,
    projectId: activeProject?.projectId || '',
    projectName: businessProjectName,
    projectAssignmentSource: activeProject
      ? normalizeProjectAssignmentSource(options.projectAssignmentSource)
      : '',
    watermarkCategory: categoryMatch.value,
    workContent,
    date: dateInfo.date,
    area: locationInfo.value,
    location: locationInfo.value,
    keywords: keywords.join('、'),
    remark: fields['工作备注'] || '',
    propertyCompany: fields['物业公司'] || '',
    communityName: fields['小区名称'] || '',
    projectOriginalText: fields['小区名称'] || '',
    constructionUnitOriginalText: fields['施工单位'] || '',
    vehiclePlate: fields['车牌号码'] || '',
    violationType: fields['违停类型'] || ''
  };
  const fieldSources = compactObject({
    project: activeProject
      ? normalizeProjectAssignmentSource(options.projectAssignmentSource)
      : (projectMatch.value ? projectMatch.source : ''),
    watermarkCategory: categoryMatch.value ? categoryMatch.source : '',
    workContent: workContent ? resolveWorkContentSource(fields, normalizedMoment.markName) : '',
    date: dateInfo.date ? dateInfo.dateSource : '',
    area: locationInfo.value ? locationInfo.source : '',
    location: locationInfo.value ? locationInfo.source : '',
    keywords: keywords.length ? 'marki.content.keywords' : '',
    remark: fields['工作备注'] ? 'marki.content.remark' : '',
    propertyCompany: fields['物业公司'] ? 'marki.content.property_company' : '',
    communityName: fields['小区名称'] ? 'marki.content.community_name' : '',
    constructionUnitOriginalText: fields['施工单位'] ? 'marki.content.construction_unit' : '',
    vehiclePlate: fields['车牌号码'] ? 'marki.content.vehicle_plate' : '',
    violationType: fields['违停类型'] ? 'marki.content.violation_type' : ''
  });
  const confidenceByField = compactObject({
    project: activeProject ? 1 : (projectMatch.value ? projectMatch.confidence : null),
    watermarkCategory: categoryMatch.value ? categoryMatch.confidence : null,
    workContent: workContent ? 0.95 : null,
    date: dateInfo.date ? dateInfo.confidence : null,
    area: locationInfo.value ? locationInfo.confidence : null,
    location: locationInfo.value ? locationInfo.confidence : null,
    keywords: keywords.length ? 0.85 : null,
    remark: fields['工作备注'] ? 0.95 : null
  });
  const candidateFields = compactObject({
    projectCandidates: !projectMatch.value && projectMatch.candidate
      ? [projectMatch.candidate]
      : null,
    watermarkCategoryCandidates: !categoryMatch.value && categoryMatch.candidate
      ? [categoryMatch.candidate]
      : null
  });
  const missingRequiredFields = REQUIRED_ARCHIVE_FIELDS
    .filter(([, key]) => !suggestedFields[key])
    .map(([label]) => label);
  const confidence = calculateStructuredConfidence({
    parsed: parsedContent.success,
    date: suggestedFields.date,
    category: suggestedFields.watermarkCategory,
    workContent: suggestedFields.workContent,
    project: suggestedFields.project,
    location: suggestedFields.location
  });
  const missingFacts = uniqueStrings([
    !dateInfo.hasWatermarkDate ? '水印拍摄日期' : '',
    !fields['小区名称'] ? '项目文本' : '',
    !fields['地点'] && !locationInfo.value ? '地点' : '',
    !workContent ? '工作内容' : ''
  ]);
  const parsedFields = {
    watermarkCategory: suggestedFields.watermarkCategory || null,
    workContent: suggestedFields.workContent || null,
    projectName: suggestedFields.project || null,
    projectId: suggestedFields.projectId || null,
    projectAssignmentSource: suggestedFields.projectAssignmentSource || null,
    location: suggestedFields.location || null,
    date: suggestedFields.date || null,
    time: dateInfo.time || null,
    weekday: null,
    keywords,
    remark: suggestedFields.remark || null,
    stage: null,
    processStatus: null,
    project: suggestedFields.project || null,
    categoryHint: suggestedFields.watermarkCategory || null,
    possibleStage: null,
    possibleStatus: null,
    dateTime: dateInfo.captureDateTime || null,
    propertyCompany: fields['物业公司'] || null,
    communityName: fields['小区名称'] || null,
    constructionUnit: fields['施工单位'] || null,
    vehiclePlate: fields['车牌号码'] || null,
    violationType: fields['违停类型'] || null
  };
  const structuredFields = {
    date: suggestedFields.date,
    projectOriginalText: fields['小区名称'] || '',
    communityName: fields['小区名称'] || '',
    archiveCategory: suggestedFields.watermarkCategory,
    watermarkCategory: suggestedFields.watermarkCategory,
    watermarkTemplateName: normalizedMoment.markName,
    archiveCategoryOriginalText: normalizedMoment.markName,
    workContent,
    remarks: fields['工作备注'] || '',
    locationArea: locationInfo.value,
    propertyCompany: fields['物业公司'] || '',
    constructionUnitOriginalText: fields['施工单位'] || '',
    vehiclePlate: fields['车牌号码'] || '',
    violationType: fields['违停类型'] || '',
    fieldSources
  };

  return {
    sourceType: SOURCE_TYPE,
    contentStatus: parsedContent.success ? 'parsed' : 'parse_failed',
    contentError: parsedContent.success
      ? null
      : {
        code: parsedContent.errorCode,
        message: '马克结构化数据无法解析，请手工补充或主动使用 OCR。'
      },
    parsedContent,
    capturedAt: dateInfo.capturedAt,
    postTime: normalizedMoment.postTime,
    suggestedFields,
    fieldSources,
    confidenceByField,
    candidateFields,
    missingRequiredFields,
    confidence,
    warnings,
    parsedFields,
    structuredFields,
    watermarkTemplateName: normalizedMoment.markName,
    watermarkRecord: {
      source: SOURCE_TYPE,
      captureDate: dateInfo.date,
      captureTime: dateInfo.time,
      captureDateTime: dateInfo.captureDateTime,
      dateSource: dateInfo.dateSource,
      locationText: locationInfo.value,
      locationSource: locationInfo.source,
      projectText: fields['小区名称'] || '',
      watermarkCategoryText: suggestedFields.watermarkCategory,
      workContentText: workContent,
      remarkText: fields['工作备注'] || '',
      photographerText: fields['上传人'] || '',
      propertyCompanyText: fields['物业公司'] || '',
      communityNameText: fields['小区名称'] || '',
      constructionUnitText: fields['施工单位'] || '',
      vehiclePlateText: fields['车牌号码'] || '',
      violationTypeText: fields['违停类型'] || '',
      watermarkTemplateName: normalizedMoment.markName,
      keywordCandidates: keywords,
      rawText: '',
      confidence,
      missingFacts,
      parseWarnings: warnings
    }
  };
}

function buildMarkiWorkbenchImportPackage(input = {}, options = {}) {
  return buildMarkiStructuredImportBundle(input, options).workbenchImportPackage;
}

function buildMarkiStructuredImportBundle(input = {}, options = {}) {
  const orgId = normalizeOrgId(input.orgId);
  const items = Array.isArray(input.items) ? input.items : null;
  if (!items) {
    throw new MarkiStructuredImportError(
      'invalid_marki_import_items',
      '马克工作台导入项必须为数组。'
    );
  }
  if (items.length > MAX_IMPORT_ITEMS) {
    throw new MarkiStructuredImportError(
      'marki_import_batch_too_large',
      `一次最多转换 ${MAX_IMPORT_ITEMS} 张马克照片。`
    );
  }

  const now = resolveNow(options);
  const batchId = resolveBatchId(options, now);
  const photos = [];
  const recognitionResultsByPhoto = {};
  const watermarkRecordsByPhoto = {};
  const archiveSuggestionsByPhoto = {};
  const sourceMetadataRecordsByRef = {};
  const sourceKeyFirstInputIndexes = new Map();
  const skippedItems = [];

  for (const [inputIndex, item] of items.entries()) {
    const normalized = normalizeImportItem(orgId, item);
    if (sourceKeyFirstInputIndexes.has(normalized.sourceKey)) {
      skippedItems.push({
        sourceKey: normalized.sourceKey,
        keptInputIndex: sourceKeyFirstInputIndexes.get(normalized.sourceKey),
        skippedInputIndex: inputIndex
      });
      continue;
    }
    sourceKeyFirstInputIndexes.set(normalized.sourceKey, inputIndex);

    const mapped = mapMarkiMoment(normalized.moment, input.configs || {}, {
      ...options,
      projectAssignmentSource: normalized.projectAssignmentSource
    });
    const photoId = buildPhotoId(normalized.sourceKey);
    const sourceMetadataRecord = buildMarkiSourceMetadataRecord({
      sourceMetadataRef: normalized.sourceMetadataRef,
      sourceKey: normalized.sourceKey,
      orgId,
      momentId: normalized.moment.id,
      teamId: normalized.moment.teamId,
      uid: normalized.moment.uid,
      postTime: normalized.moment.postTime,
      capturedAt: mapped.capturedAt,
      markName: normalized.moment.markName,
      antiCounterfeitCode: mapped.parsedContent.fields['防伪码'] || '',
      parsedEntries: mapped.parsedContent.entries.map((entry) => ({
        key: entry.label,
        value: entry.value
      }))
    }, {
      now: () => new Date(now)
    });
    const recognitionResult = buildRecognitionResult(photoId, normalized, mapped, now);
    const watermarkRecord = {
      ...mapped.watermarkRecord,
      photoId
    };
    const archiveSuggestion = buildArchiveSuggestion(photoId, mapped, now);
    photos.push(buildWorkbenchPhoto(
      photoId,
      normalized,
      mapped,
      archiveSuggestion,
      options.activeProject
    ));
    recognitionResultsByPhoto[photoId] = recognitionResult;
    watermarkRecordsByPhoto[photoId] = watermarkRecord;
    archiveSuggestionsByPhoto[photoId] = archiveSuggestion;
    sourceMetadataRecordsByRef[sourceMetadataRecord.sourceMetadataRef] = sourceMetadataRecord;
  }

  return {
    workbenchImportPackage: {
      batchId,
      photos,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto
    },
    sourceMetadataRecordsByRef,
    deduplication: {
      inputCount: items.length,
      uniqueCount: sourceKeyFirstInputIndexes.size,
      duplicateCount: skippedItems.length,
      skippedItems
    }
  };
}

function buildRecognitionResult(photoId, normalized, mapped, now) {
  const errors = mapped.contentError ? [mapped.contentError] : [];
  return {
    photoId,
    filePath: normalized.download.localPath,
    fileName: normalized.download.fileName,
    taskId: `marki-structured-${hashValue(normalized.sourceKey, 24)}`,
    source: SOURCE_TYPE,
    providerId: SOURCE_TYPE,
    providerType: PROVIDER_TYPE,
    status: mapped.contentStatus === 'parsed' ? 'recognized' : 'failed',
    success: mapped.contentStatus === 'parsed',
    confidence: mapped.confidence,
    rawText: '',
    cleanedText: '',
    parsedFields: mapped.parsedFields,
    fields: mapped.parsedFields,
    warnings: mapped.warnings,
    errors,
    errorCode: errors[0]?.code || '',
    errorMessage: errors[0]?.message || '',
    createdAt: now,
    updatedAt: now,
    mode: PROVIDER_TYPE,
    adoptedOcrText: '',
    watermarkTemplateName: mapped.watermarkTemplateName,
    structuredFields: cloneJson(mapped.structuredFields),
    parsedWatermark: {
      date: mapped.parsedFields.date,
      time: mapped.parsedFields.time,
      projectName: mapped.parsedFields.projectName,
      watermarkCategory: mapped.parsedFields.watermarkCategory,
      workContent: mapped.parsedFields.workContent,
      location: mapped.parsedFields.location,
      remark: mapped.parsedFields.remark,
      keywords: mapped.parsedFields.keywords,
      propertyCompany: mapped.parsedFields.propertyCompany,
      communityName: mapped.parsedFields.communityName,
      constructionUnit: mapped.parsedFields.constructionUnit,
      vehiclePlate: mapped.parsedFields.vehiclePlate,
      violationType: mapped.parsedFields.violationType
    }
  };
}

function buildArchiveSuggestion(photoId, mapped, now) {
  const candidateFields = cloneJson(mapped.candidateFields);
  return {
    photoId,
    suggestedFields: cloneJson(mapped.suggestedFields),
    fieldSources: cloneJson(mapped.fieldSources),
    confidenceByField: cloneJson(mapped.confidenceByField),
    missingRequiredFields: [...mapped.missingRequiredFields],
    conflictFields: [],
    candidateFields,
    needsHumanReview: true,
    status: mapped.missingRequiredFields.length ? 'needs_completion' : 'suggestion_ready',
    source: SOURCE_TYPE,
    generatedAt: now
  };
}

function buildWorkbenchPhoto(photoId, normalized, mapped, archiveSuggestion, activeProjectInput = null) {
  const download = normalized.download;
  const activeProject = normalizeActiveProject(activeProjectInput, false);
  return {
    id: photoId,
    originalPath: download.localPath,
    originalName: download.fileName,
    extension: '.jpg',
    size: download.size,
    sha256: download.sha256,
    width: download.width,
    height: download.height,
    modifiedAt: download.completedAt,
    thumbnailPath: buildLocalPreviewUrl(download.localPath),
    previewUrl: buildLocalPreviewUrl(download.localPath),
    selected: false,
    sortStatus: archiveSuggestion.status,
    archiveInfo: null,
    previewInfo: null,
    archiveResult: null,
    originalMissing: false,
    sourceType: SOURCE_TYPE,
    sourceKey: normalized.sourceKey,
    sourceMetadataRef: normalized.sourceMetadataRef,
    capturedAt: mapped.capturedAt,
    ...(activeProject ? {
      projectId: activeProject.projectId,
      projectName: activeProject.projectName,
      projectAssignmentSource: normalized.projectAssignmentSource
    } : {})
  };
}

function normalizeImportItem(orgId, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new MarkiStructuredImportError(
      'invalid_marki_import_item',
      '马克工作台导入项格式无效。'
    );
  }
  const moment = normalizeMoment(item.moment || item.record || item);
  const sourceKey = buildMarkiSourceKey(orgId, moment.id);
  const sourceMetadataRef = buildMarkiSourceMetadataRef(orgId, moment.id);
  const download = normalizeDownloadResult(item.download || item.downloadResult);
  if (download.sourceKey !== sourceKey) {
    throw new MarkiStructuredImportError(
      'marki_source_key_mismatch',
      '下载结果与马克照片来源标识不一致。'
    );
  }
  return {
    moment,
    sourceKey,
    sourceMetadataRef: normalizeSourceMetadataRef(item.sourceMetadataRef, sourceMetadataRef),
    download,
    projectAssignmentSource: normalizeProjectAssignmentSource(
      item.projectAssignmentSource,
      false
    )
  };
}

function normalizeActiveProject(value, required = true) {
  if (value == null && !required) return null;
  const projectId = String(value?.projectId || '').trim();
  const projectName = String(value?.projectName || '').normalize('NFKC').trim();
  if (!projectId || !projectName) {
    throw new MarkiStructuredImportError('active_project_invalid', '当前项目无效。');
  }
  return { projectId, projectName };
}

function normalizeProjectAssignmentSource(value, required = true) {
  const text = String(value || '').trim();
  if (!text && !required) return '';
  if (!['active_project_context', 'marki_structured_confirmed'].includes(text)) {
    throw new MarkiStructuredImportError(
      'photo_project_unresolved',
      '马克照片项目归属依据无效。'
    );
  }
  return text;
}

function normalizeMoment(moment) {
  if (!moment || typeof moment !== 'object' || Array.isArray(moment)) {
    throw new MarkiStructuredImportError(
      'invalid_marki_moment',
      '马克照片记录格式无效。'
    );
  }
  const id = String(moment.id ?? moment.momentId ?? '').trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new MarkiStructuredImportError('invalid_marki_moment_id', '马克照片 ID 无效。');
  }
  const momentType = Number(moment.momentType ?? 1);
  if (momentType !== 1) {
    throw new MarkiStructuredImportError(
      'marki_moment_type_not_supported',
      'V3.2 仅支持导入马克照片。'
    );
  }
  return {
    id,
    teamId: normalizeOptionalId(moment.teamId),
    uid: normalizeOptionalId(moment.uid),
    momentType,
    content: moment.content,
    markName: cleanMarkiFieldValue(moment.markName),
    lng: normalizeCoordinate(moment.lng),
    lat: normalizeCoordinate(moment.lat),
    postTime: normalizePostTime(moment.postTime)
  };
}

function normalizeDownloadResult(download) {
  if (!download || typeof download !== 'object' || Array.isArray(download)) {
    throw new MarkiStructuredImportError(
      'invalid_marki_download_result',
      '缺少马克照片下载结果。'
    );
  }
  if (String(download.importStatus || '') !== 'imported') {
    throw new MarkiStructuredImportError(
      'marki_photo_not_imported',
      '只有完成事务式下载的马克照片才能生成工作台导入包。'
    );
  }
  const localPath = String(download.localPath || '').trim();
  const fileName = String(download.fileName || path.basename(localPath)).trim();
  if (
    !localPath
    || !path.isAbsolute(localPath)
    || !/\.jpg$/i.test(localPath)
    || !/^[^<>:"/\\|?*\u0000-\u001f]+\.jpg$/i.test(fileName)
  ) {
    throw new MarkiStructuredImportError(
      'invalid_marki_download_file',
      '马克照片下载文件信息无效。'
    );
  }
  return {
    sourceKey: String(download.sourceKey || '').trim(),
    localPath,
    fileName,
    size: normalizePositiveInteger(download.size, '马克照片文件大小无效。'),
    sha256: normalizeSha256(download.sha256),
    width: normalizePositiveInteger(download.width, '马克照片宽度无效。'),
    height: normalizePositiveInteger(download.height, '马克照片高度无效。'),
    completedAt: normalizeIsoDate(download.completedAt || download.updatedAt)
  };
}

function normalizeSha256(value) {
  const sha256 = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new MarkiStructuredImportError(
      'invalid_marki_download_file',
      '马克照片下载文件信息无效。'
    );
  }
  return sha256;
}

function resolveCaptureDate(fields, postTime) {
  const dateText = fields['日期'] || '';
  const timeText = fields['时间'] || '';
  const dateFromDate = extractDate(dateText);
  const dateFromTime = extractDate(timeText);
  const timeFromDate = extractTime(dateText);
  const timeFromTime = extractTime(timeText);
  const post = formatPostTime(postTime);
  const date = dateFromDate || dateFromTime || post.date;
  const time = timeFromDate || timeFromTime || ((!dateFromDate && !dateFromTime) ? post.time : '');
  const hasWatermarkDate = Boolean(dateFromDate || dateFromTime);
  const dateSource = dateFromDate
    ? 'marki.content.date'
    : dateFromTime
      ? 'marki.content.time'
      : 'marki.post_time';
  const warnings = [];
  if (!hasWatermarkDate && date) {
    warnings.push('未解析到水印拍摄日期，已使用马克平台上传时间兜底。');
  }
  return {
    date,
    time,
    captureDateTime: [date, time].filter(Boolean).join(' '),
    capturedAt: date ? `${date}T${time || '00:00:00'}+08:00` : '',
    dateSource,
    confidence: hasWatermarkDate ? 0.98 : 0.65,
    hasWatermarkDate,
    warnings
  };
}

function resolveLocation(location, lng, lat) {
  if (location) {
    return {
      value: location,
      source: 'marki.content.location',
      confidence: 0.95
    };
  }
  if (isValidCoordinatePair(lng, lat)) {
    return {
      value: `经纬度：${formatCoordinate(lat)}, ${formatCoordinate(lng)}`,
      source: 'marki.coordinates',
      confidence: 0.65
    };
  }
  return { value: '', source: '', confidence: null };
}

function resolveWorkContent(fields, markName) {
  const violation = fields['违停类型'] || '';
  const plate = fields['车牌号码'] || '';
  if (isMotorVehicleWatermark(markName, fields) && (violation || plate)) {
    return violation;
  }
  return fields['工作内容'] || fields['标题'] || '';
}

function resolveWorkContentSource(fields, markName) {
  if (isMotorVehicleWatermark(markName, fields) && (fields['违停类型'] || fields['车牌号码'])) {
    return 'marki.content.vehicle';
  }
  if (fields['工作内容']) return 'marki.content.work_content';
  if (fields['标题']) return 'marki.content.title';
  return '';
}

function isMotorVehicleWatermark(markName, fields) {
  const normalized = normalizeMatchText(markName);
  return normalized.includes('机动车违规')
    || Boolean(fields['车牌号码'])
    || Boolean(fields['违停类型']);
}

function matchConfiguredValue(
  candidateValue,
  configuredOptions,
  aliases = {},
  options = {}
) {
  const candidate = cleanMarkiFieldValue(candidateValue);
  if (!candidate) {
    return { value: '', candidate: '', source: '', confidence: null };
  }
  const normalizedCandidate = normalizeMatchText(candidate);
  const exact = configuredOptions.find((item) => (
    normalizeMatchText(item.name) === normalizedCandidate
  ));
  if (exact) {
    return {
      value: exact.name,
      candidate,
      source: 'marki.config.exact',
      confidence: 0.98
    };
  }
  if (options.allowConfiguredAliases !== false) {
    const configuredAlias = configuredOptions.find((item) => (
      item.aliases.some((alias) => normalizeMatchText(alias) === normalizedCandidate)
    ));
    if (configuredAlias) {
      return {
        value: configuredAlias.name,
        candidate,
        source: 'marki.config.alias',
        confidence: 0.9
      };
    }
  }
  const aliasTarget = findAliasTarget(candidate, aliases);
  const aliasMatch = configuredOptions.find((item) => (
    normalizeMatchText(item.name) === normalizeMatchText(aliasTarget)
  ));
  if (aliasMatch) {
    return {
      value: aliasMatch.name,
      candidate,
      source: options.mappingSource || 'marki.mapping.alias',
      confidence: 0.88
    };
  }
  return { value: '', candidate, source: '', confidence: null };
}

function normalizeProjectOptions(projects) {
  return normalizeConfiguredOptions(projects);
}

function normalizeCategoryOptions(categories) {
  if (Array.isArray(categories)) return normalizeConfiguredOptions(categories);
  if (!categories || typeof categories !== 'object') return [];
  return Object.entries(categories).map(([name, value]) => ({
    name: cleanMarkiFieldValue(value?.name || name),
    aliases: normalizeAliases(value?.aliases || value?.alias)
  })).filter((item) => item.name);
}

function normalizeConfiguredOptions(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') {
      return { name: cleanMarkiFieldValue(item), aliases: [] };
    }
    return {
      name: cleanMarkiFieldValue(item?.name),
      aliases: normalizeAliases(item?.aliases || item?.alias)
    };
  }).filter((item) => item.name);
}

function normalizeAliases(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[、,，;；]/);
  return uniqueStrings(values.map(cleanMarkiFieldValue));
}

function findAliasTarget(candidate, aliases) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return '';
  const normalizedCandidate = normalizeMatchText(candidate);
  for (const [alias, target] of Object.entries(aliases)) {
    if (normalizeMatchText(alias) === normalizedCandidate) {
      return cleanMarkiFieldValue(target);
    }
  }
  return '';
}

function extractContentEntries(parsed) {
  if (Array.isArray(parsed)) {
    const entries = [];
    for (const item of parsed) {
      if (Array.isArray(item) && item.length >= 2) {
        entries.push([item[0], item[1]]);
        continue;
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const label = item.key ?? item.label ?? item.name;
        const value = item.value ?? item.content ?? item.text;
        if (label !== undefined && value !== undefined) {
          entries.push([label, value]);
        }
      }
    }
    return entries;
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed);
  }
  return null;
}

function normalizeFieldLabel(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\s：:]+/g, '')
    .trim()
    .slice(0, 100);
  if (!text || RESERVED_FIELD_KEYS.has(text.toLowerCase())) return '';
  return Object.hasOwn(FIELD_LABEL_ALIASES, text)
    ? FIELD_LABEL_ALIASES[text]
    : text;
}

function normalizePrimitiveValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) => (
    item == null || ['string', 'number', 'boolean'].includes(typeof item)
  ))) {
    return value.filter((item) => item != null).join('、');
  }
  return '';
}

function isPlaceholderValue(value) {
  const normalized = String(value || '').replace(/\s+/g, '');
  const normalizedLower = normalized.toLowerCase();
  return /^(请输入|请选择|请填写|未填写|未设置|暂无|无|空|-+|—+|\/+)$/.test(normalized)
    || normalizedLower === 'null'
    || normalizedLower === 'undefined'
    || /^(请输入|请选择|请填写)/.test(normalized)
    || /^(点击|请点击).*(填写|输入|选择)$/.test(normalized);
}

function extractDate(value) {
  const match = String(value || '').match(/(?<year>\d{4})\s*[-/.年]\s*(?<month>\d{1,2})\s*[-/.月]\s*(?<day>\d{1,2})\s*日?/);
  if (!match?.groups) return '';
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const test = new Date(Date.UTC(year, month - 1, day));
  if (
    test.getUTCFullYear() !== year
    || test.getUTCMonth() !== month - 1
    || test.getUTCDate() !== day
  ) {
    return '';
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractTime(value) {
  const match = String(value || '').match(/(?<!\d)(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?!\d)/);
  if (!match?.groups) return '';
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second || 0);
  if (hour > 23 || minute > 59 || second > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function formatPostTime(postTime) {
  if (!postTime) return { date: '', time: '' };
  const adjusted = new Date(postTime * 1000 + (8 * 60 * 60 * 1000));
  if (Number.isNaN(adjusted.getTime())) return { date: '', time: '' };
  return {
    date: [
      adjusted.getUTCFullYear(),
      String(adjusted.getUTCMonth() + 1).padStart(2, '0'),
      String(adjusted.getUTCDate()).padStart(2, '0')
    ].join('-'),
    time: [
      String(adjusted.getUTCHours()).padStart(2, '0'),
      String(adjusted.getUTCMinutes()).padStart(2, '0'),
      String(adjusted.getUTCSeconds()).padStart(2, '0')
    ].join(':')
  };
}

function calculateStructuredConfidence(values) {
  let score = values.parsed ? 0.2 : 0;
  if (values.date) score += 0.2;
  if (values.category) score += 0.2;
  if (values.workContent) score += 0.2;
  if (values.project) score += 0.1;
  if (values.location) score += 0.1;
  return Number(Math.min(1, score).toFixed(2));
}

function createContentParseFailure(errorCode, errorMessage) {
  return {
    success: false,
    errorCode,
    errorMessage,
    fields: {},
    entries: [],
    warnings: []
  };
}

function buildPhotoId(sourceKey) {
  return `marki-${hashValue(sourceKey, 32)}`;
}

function buildLocalPreviewUrl(localPath) {
  return `local-photo://image/${encodeURIComponent(localPath)}`;
}

function normalizeSourceMetadataRef(value, expectedRef) {
  const text = String(value || expectedRef).trim();
  if (text !== expectedRef) {
    throw new MarkiStructuredImportError(
      'invalid_source_metadata_ref',
      '马克来源明细引用无效。'
    );
  }
  return expectedRef;
}

function normalizeOrgId(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) {
    throw new MarkiStructuredImportError('invalid_org_id', '组织 ID 必须为数字。');
  }
  return text;
}

function normalizeOptionalId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 100 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new MarkiStructuredImportError(
      'invalid_marki_source_id',
      '马克来源记录 ID 无效。'
    );
  }
  return text;
}

function normalizePostTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidCoordinatePair(lng, lat) {
  return Number.isFinite(lng)
    && Number.isFinite(lat)
    && lng !== 0
    && lat !== 0
    && lng >= -180
    && lng <= 180
    && lat >= -90
    && lat <= 90;
}

function formatCoordinate(value) {
  return Number(value.toFixed(6)).toString();
}

function normalizePositiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new MarkiStructuredImportError('invalid_marki_download_file', message);
  }
  return number;
}

function normalizeIsoDate(value) {
  const text = String(value || '').trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) {
    throw new MarkiStructuredImportError(
      'invalid_marki_download_time',
      '马克照片下载完成时间无效。'
    );
  }
  return date.toISOString();
}

function resolveNow(options) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MarkiStructuredImportError('invalid_current_time', '无法生成导入包时间。');
  }
  return date.toISOString();
}

function resolveBatchId(options, now) {
  const requested = String(options.batchId || '').trim();
  if (requested) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(requested)) {
      throw new MarkiStructuredImportError('invalid_batch_id', '工作台导入批次 ID 无效。');
    }
    return requested;
  }
  const timestamp = now.replace(/[-:.TZ]/g, '');
  return `marki-batch-${timestamp}-${crypto.randomUUID()}`;
}

function normalizeMatchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\-_/、，,。.：:；;]+/g, '');
}

function hashValue(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (
    item !== '' && item !== null && item !== undefined
  )));
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  MARKI_TEMPLATE_CATEGORY_MAPPINGS,
  MAX_CONTENT_LENGTH,
  MAX_IMPORT_ITEMS,
  MarkiStructuredImportError,
  PROVIDER_TYPE,
  SOURCE_TYPE,
  buildMarkiStructuredImportBundle,
  buildMarkiWorkbenchImportPackage,
  cleanMarkiFieldValue,
  mapMarkiMoment,
  parseMarkiContent
};
