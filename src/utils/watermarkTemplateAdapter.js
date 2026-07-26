import MARKI_TEMPLATE_CATEGORY_MAPPINGS from '../../electron/shared/markiTemplateCategoryMappings.json' with { type: 'json' };

export const WATERMARK_TEMPLATE_TYPES = Object.freeze({
  STANDARD_WORK_RECORD: 'standard_work_record',
  TIME_LOCATION: 'time_location',
  VEHICLE_VIOLATION: 'vehicle_violation',
  UNRESOLVED: 'unresolved'
});

export const NOT_APPLICABLE_WORK_CONTENT = 'not_applicable';
export const ENGINEERING_ARCHIVE_CATEGORY = '工程类工作记录';
export const TIME_LOCATION_ARCHIVE_CATEGORY = '时间地点水印';
export const VEHICLE_ARCHIVE_CATEGORY = '机动车违规管理';

const PLACEHOLDER_VALUES = new Set([
  '',
  '-',
  '--',
  '请选择',
  '请输入',
  '请输入内容',
  '未填写',
  '暂无'
]);

const FIELD_LABELS = Object.freeze({
  date: ['日期时间', '拍摄日期', '拍摄时间', '日期'],
  projectOriginalText: ['小区名称', '项目名称', '项目'],
  archiveCategory: ['水印类型', '归档分类', '水印分类'],
  workContent: ['工作内容'],
  remarks: ['工作备注', '备注'],
  locationArea: ['地址', '地点', '位置', '区域'],
  propertyCompany: ['物业公司'],
  communityName: ['小区名称'],
  constructionUnitOriginalText: ['施工单位'],
  vehiclePlate: ['车牌号码', '车牌号'],
  violationType: ['违停类型']
});

export function resolveWatermarkTemplateType(input = {}) {
  const fields = collectTrustedTemplateFields(input);
  const trustedTemplateName = cleanValue(
    input.recognitionResult?.watermarkTemplateName
    || input.recognitionResult?.structuredFields?.watermarkTemplateName
    || input.watermarkRecord?.watermarkTemplateName
    || input.watermarkRecord?.templateName
    || extractExplicitTemplateTitle(
      input.recognitionResult?.rawText
      || input.recognitionResult?.adoptedOcrText
      || input.watermarkRecord?.rawText
    )
  );
  const normalizedTemplateName = normalizeComparable(trustedTemplateName);
  const mappedStandardCategory = resolveExplicitMarkiTemplateCategory(
    trustedTemplateName || fields.archiveCategory
  );
  if (
    normalizedTemplateName.includes(normalizeComparable(VEHICLE_ARCHIVE_CATEGORY))
    || Boolean(fields.vehiclePlate && fields.violationType)
  ) {
    return WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION;
  }
  if (
    normalizedTemplateName.includes('时间地点')
    && !fields.vehiclePlate
    && !fields.violationType
  ) {
    return WATERMARK_TEMPLATE_TYPES.TIME_LOCATION;
  }
  if (/工作记录/.test(trustedTemplateName)) {
    return WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD;
  }
  if (mappedStandardCategory && fields.workContent) {
    return WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD;
  }
  if (
    fields.workContent
    && (
      fields.remarks
      || fields.constructionUnitOriginalText
      || /工作记录/.test(trustedTemplateName)
    )
  ) {
    return WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD;
  }
  return WATERMARK_TEMPLATE_TYPES.UNRESOLVED;
}

export function buildTemplateDrivenCanonical(input = {}) {
  const fields = collectTrustedTemplateFields(input);
  const configs = input.configs || {};
  const watermarkTemplateType = resolveWatermarkTemplateType({ ...input, trustedFields: fields });
  const projectMatch = matchConfiguredProject(fields.projectOriginalText || fields.communityName, configs);
  const categoryCandidate = watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
    ? TIME_LOCATION_ARCHIVE_CATEGORY
    : watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
      ? VEHICLE_ARCHIVE_CATEGORY
      : fields.archiveCategory;
  const categoryMatch = matchConfiguredCategory(categoryCandidate, configs);
  const archiveCategory = categoryMatch.value;
  const workCandidate = watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
    ? fields.violationType
    : fields.workContent;
  const workContentMatch = watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
    ? { value: NOT_APPLICABLE_WORK_CONTENT, source: '' }
    : matchConfiguredWorkContent(workCandidate, archiveCategory, configs, {
        allowTrustedMarkiValue: (
          watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD
          && isTrustedMarkiStructuredInput(input)
        )
      });
  const workContent = workContentMatch.value;
  const constructionMatch = archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
    ? matchConstructionUnit(
        fields.constructionUnitOriginalText,
        projectMatch.id,
        configs.constructionUnits
      )
    : emptyMatch(fields.constructionUnitOriginalText);
  const categoryFieldSource = cleanValue(
    fields.fieldSources?.archiveCategory
    || fields.fieldSources?.watermarkCategory
    || categoryMatch.source
  );
  const unresolvedFields = [];
  if (!fields.date) unresolvedFields.push('date');
  if (!projectMatch.name) unresolvedFields.push('project');
  if (!archiveCategory) unresolvedFields.push('archiveCategory');
  if (
    watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD
    && !workContent
  ) {
    unresolvedFields.push('workContent');
  }
  if (
    watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
    && !fields.vehiclePlate
  ) {
    unresolvedFields.push('vehiclePlate');
  }
  if (
    watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
    && !workContent
  ) {
    unresolvedFields.push('violationType');
  }
  if (
    archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
    && !constructionMatch.confirmed
  ) {
    unresolvedFields.push('constructionUnit');
  }
  if (watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.UNRESOLVED) {
    unresolvedFields.push('watermarkTemplateType');
  }

  const canonical = {
    watermarkTemplateType,
    date: normalizeDate(fields.date),
    project: projectMatch.name,
    projectId: projectMatch.id,
    projectName: projectMatch.name,
    projectOriginalText: cleanValue(fields.projectOriginalText || fields.communityName),
    projectConfirmed: Boolean(projectMatch.name),
    projectSource: projectMatch.name ? 'watermark_match' : '',
    archiveCategory,
    watermarkCategory: archiveCategory,
    workContent,
    locationArea: cleanValue(fields.locationArea),
    location: cleanValue(fields.locationArea),
    keywords: buildKeywordSuggestion({
      templateType: watermarkTemplateType,
      archiveCategory,
      workContent,
      locationArea: fields.locationArea,
      projectName: projectMatch.name,
      vehiclePlate: fields.vehiclePlate,
      constructionUnitName: constructionMatch.name
    }),
    remarks: cleanValue(fields.remarks),
    remark: cleanValue(fields.remarks),
    propertyCompany: cleanValue(fields.propertyCompany),
    communityName: cleanValue(fields.communityName || fields.projectOriginalText),
    vehiclePlate: watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
      ? cleanValue(fields.vehiclePlate)
      : '',
    violationType: watermarkTemplateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
      ? workContent
      : '',
    constructionUnitId: archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
      ? constructionMatch.id
      : '',
    constructionUnitName: archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
      ? constructionMatch.name
      : '',
    constructionUnitOriginalText: archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
      ? cleanValue(fields.constructionUnitOriginalText)
      : '',
    constructionUnitConfirmed: archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
      ? constructionMatch.confirmed
      : false,
    constructionUnitSource: archiveCategory === ENGINEERING_ARCHIVE_CATEGORY && constructionMatch.confirmed
      ? 'watermark_match'
      : '',
    fieldSources: {
      ...fields.fieldSources,
      ...(projectMatch.name ? { project: 'watermark_match' } : {}),
      ...(archiveCategory
        ? {
            archiveCategory: categoryFieldSource,
            watermarkCategory: categoryFieldSource
          }
        : {}),
      ...(workContent && workContent !== NOT_APPLICABLE_WORK_CONTENT
        ? { workContent: workContentMatch.source }
        : {}),
      ...(constructionMatch.confirmed ? { constructionUnit: 'watermark_match' } : {})
    },
    unresolvedFields: Array.from(new Set(unresolvedFields))
  };
  return canonical;
}

export function buildTemplateDrivenFormSeed(canonical = {}, existingDraft = null) {
  const draft = existingDraft && typeof existingDraft === 'object'
    ? existingDraft
    : {};
  const merged = {
    ...canonical,
    ...draft,
    fieldSources: {
      ...(canonical.fieldSources || {}),
      ...(draft.fieldSources || {})
    },
    unresolvedFields: Array.isArray(draft.unresolvedFields)
      ? [...draft.unresolvedFields]
      : [...(canonical.unresolvedFields || [])]
  };
  return isolateTemplateSpecificFields(merged);
}

export function isolateTemplateSpecificFields(form = {}) {
  const next = { ...form };
  const templateType = cleanValue(next.watermarkTemplateType);
  const isEngineering = templateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD
    && cleanValue(next.watermarkCategory || next.archiveCategory) === ENGINEERING_ARCHIVE_CATEGORY;
  if (!isEngineering) {
    next.constructionUnitId = '';
    next.constructionUnitName = '';
    next.constructionUnitOriginalText = '';
    next.constructionUnitConfirmed = false;
    next.constructionUnitSource = '';
  }
  if (templateType !== WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION) {
    next.vehiclePlate = '';
    next.violationType = '';
  }
  if (templateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION) {
    next.workContent = NOT_APPLICABLE_WORK_CONTENT;
  }
  return next;
}

export function collectTrustedTemplateFields(input = {}) {
  if (input.trustedFields) return normalizeTrustedFields(input.trustedFields);
  const recognition = input.recognitionResult || {};
  const parsed = recognition.parsedWatermark || recognition.parsedFields || {};
  const structured = recognition.structuredFields || {};
  const watermark = input.watermarkRecord || {};
  const sourceProcessing = input.sourceAwareProcessing
    || recognition.sourceAwareProcessing
    || {};
  const effective = sourceProcessing.effectiveResult?.requiredFields || {};
  const platform = sourceProcessing.platformBaseline?.requiredFields || {};
  const rawLabeled = parseLabeledFields(
    recognition.rawText || recognition.adoptedOcrText || watermark.rawText
  );
  return normalizeTrustedFields({
    date: firstValue(
      structured.date,
      effective.date,
      platform.date,
      watermark.captureDate,
      parsed.date,
      parsed.dateTime,
      rawLabeled.date
    ),
    projectOriginalText: firstValue(
      structured.projectOriginalText,
      structured.communityName,
      watermark.projectText,
      parsed.projectName,
      parsed.project,
      rawLabeled.projectOriginalText
    ),
    communityName: firstValue(
      structured.communityName,
      rawLabeled.communityName,
      watermark.projectText
    ),
    archiveCategory: firstValue(
      structured.archiveCategory,
      structured.watermarkCategory,
      watermark.watermarkCategoryText,
      parsed.watermarkCategory,
      parsed.category,
      rawLabeled.archiveCategory
    ),
    workContent: firstValue(
      structured.workContent,
      watermark.workContentText,
      parsed.workContent,
      rawLabeled.workContent
    ),
    remarks: firstValue(
      structured.remarks,
      structured.remark,
      watermark.remarkText,
      parsed.remark,
      rawLabeled.remarks
    ),
    locationArea: firstValue(
      structured.locationArea,
      structured.location,
      watermark.locationText,
      parsed.location,
      rawLabeled.locationArea
    ),
    propertyCompany: firstValue(
      structured.propertyCompany,
      rawLabeled.propertyCompany
    ),
    constructionUnitOriginalText: firstValue(
      structured.constructionUnitOriginalText,
      structured.constructionUnit,
      parsed.constructionUnit,
      rawLabeled.constructionUnitOriginalText
    ),
    vehiclePlate: firstValue(
      structured.vehiclePlate,
      parsed.vehiclePlate,
      rawLabeled.vehiclePlate
    ),
    violationType: firstValue(
      structured.violationType,
      parsed.violationType,
      rawLabeled.violationType
    ),
    fieldSources: structured.fieldSources || {}
  });
}

export function getAvailableConstructionUnits(configs = {}, projectId = '', currentUnitId = '') {
  return (Array.isArray(configs.constructionUnits) ? configs.constructionUnits : [])
    .filter((item) => (
      item.enabled !== false
      && (
        !Array.isArray(item.projectIds)
        || item.projectIds.length === 0
        || item.projectIds.includes(projectId)
      )
    ) || item.id === currentUnitId);
}

function matchConfiguredProject(value, configs) {
  const candidate = normalizeComparable(value);
  if (!candidate) return emptyMatch(value);
  const options = Array.isArray(configs.projectOptions)
    ? configs.projectOptions
    : (configs.projects || []).map((name) => ({ id: '', name }));
  const matches = options.filter((item) => normalizeComparable(item.name) === candidate);
  return matches.length === 1
    ? { id: cleanValue(matches[0].id), name: cleanValue(matches[0].name), confirmed: true }
    : emptyMatch(value);
}

function matchConfiguredCategory(value, configs) {
  const candidate = normalizeComparable(value);
  if (!candidate) return { value: '', source: '' };
  const matches = Object.keys(configs.watermarkCategories || {})
    .filter((name) => normalizeComparable(name) === candidate);
  if (matches.length === 1) {
    return {
      value: matches[0],
      source: 'watermark_exact'
    };
  }
  const mappedCategory = resolveExplicitMarkiTemplateCategory(value);
  if (!mappedCategory) return { value: '', source: '' };
  const mappedMatches = Object.keys(configs.watermarkCategories || {})
    .filter((name) => normalizeComparable(name) === normalizeComparable(mappedCategory));
  return mappedMatches.length === 1
    ? {
        value: mappedMatches[0],
        source: 'marki.template_mapping.exact'
      }
    : { value: '', source: '' };
}

function matchConfiguredWorkContent(value, category, configs, options = {}) {
  const candidate = normalizeComparable(value);
  const originalValue = cleanValue(value);
  if (!candidate || !category) return { value: '', source: '' };
  const matches = (configs.watermarkCategories?.[category]?.items || [])
    .filter((name) => normalizeComparable(name) === candidate);
  if (matches.length === 1) {
    return {
      value: matches[0],
      source: 'watermark.work_content.config_exact'
    };
  }
  return options.allowTrustedMarkiValue && originalValue
    ? {
        value: originalValue,
        source: 'marki.content.trusted'
      }
    : { value: '', source: '' };
}

function resolveExplicitMarkiTemplateCategory(value) {
  const candidate = normalizeComparable(value);
  if (!candidate) return '';
  const entry = Object.entries(MARKI_TEMPLATE_CATEGORY_MAPPINGS)
    .find(([sourceName]) => normalizeComparable(sourceName) === candidate);
  return cleanValue(entry?.[1]);
}

function isTrustedMarkiStructuredInput(input = {}) {
  return cleanValue(input.recognitionResult?.source) === 'marki_api'
    && cleanValue(input.recognitionResult?.providerType) === 'structured_data';
}

function matchConstructionUnit(value, projectId, items = []) {
  const candidate = normalizeComparable(value);
  if (!candidate) return emptyMatch(value);
  const matches = (Array.isArray(items) ? items : []).filter((item) => {
    if (item.enabled === false) return false;
    const projectIds = Array.isArray(item.projectIds) ? item.projectIds : [];
    if (projectIds.length > 0 && !projectIds.includes(projectId)) return false;
    return [
      item.name,
      ...(Array.isArray(item.aliases) ? item.aliases : [])
    ].some((name) => normalizeComparable(name) === candidate);
  });
  return matches.length === 1
    ? {
        id: cleanValue(matches[0].id),
        name: cleanValue(matches[0].name),
        confirmed: true
      }
    : emptyMatch(value);
}

function parseLabeledFields(rawText = '') {
  const result = {};
  for (const [key, labels] of Object.entries(FIELD_LABELS)) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = String(rawText || '').match(
        new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[：:]\\s*([^\\n\\r]+)`, 'm')
      );
      if (match?.[1]) {
        result[key] = cleanValue(match[1]);
        break;
      }
    }
  }
  return result;
}

function extractExplicitTemplateTitle(rawText = '') {
  const text = String(rawText || '').normalize('NFKC');
  if (/机动车违规管理/.test(text)) return VEHICLE_ARCHIVE_CATEGORY;
  if (/时间地点/.test(text)) return TIME_LOCATION_ARCHIVE_CATEGORY;
  const workRecordTitle = text.match(/[^\n\r]{0,20}工作记录[^\n\r]{0,20}/);
  return cleanValue(workRecordTitle?.[0]);
}

function normalizeTrustedFields(fields = {}) {
  return {
    ...fields,
    date: normalizeDate(fields.date),
    projectOriginalText: cleanValue(fields.projectOriginalText),
    communityName: cleanValue(fields.communityName),
    archiveCategory: cleanValue(fields.archiveCategory),
    workContent: cleanValue(fields.workContent),
    remarks: cleanValue(fields.remarks),
    locationArea: cleanValue(fields.locationArea),
    propertyCompany: cleanValue(fields.propertyCompany),
    constructionUnitOriginalText: cleanValue(fields.constructionUnitOriginalText),
    vehiclePlate: cleanValue(fields.vehiclePlate).toUpperCase(),
    violationType: cleanValue(fields.violationType),
    fieldSources: fields.fieldSources && typeof fields.fieldSources === 'object'
      ? { ...fields.fieldSources }
      : {}
  };
}

function buildKeywordSuggestion(fields) {
  return Array.from(new Set([
    fields.archiveCategory,
    fields.workContent === NOT_APPLICABLE_WORK_CONTENT ? '' : fields.workContent,
    fields.locationArea,
    fields.projectName,
    fields.vehiclePlate,
    fields.constructionUnitName,
    fields.templateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION ? '机动车违规' : ''
  ].map(cleanValue).filter(Boolean))).join('、');
}

function normalizeDate(value) {
  const text = cleanValue(value);
  const match = text.match(/(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})/);
  if (!match?.groups) return '';
  return `${match.groups.year}-${match.groups.month.padStart(2, '0')}-${match.groups.day.padStart(2, '0')}`;
}

function firstValue(...values) {
  return values.map(cleanValue).find(Boolean) || '';
}

function emptyMatch(originalText = '') {
  return {
    id: '',
    name: '',
    confirmed: false,
    originalText: cleanValue(originalText)
  };
}

function normalizeComparable(value) {
  return cleanValue(value)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLocaleLowerCase('zh-CN');
}

function cleanValue(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  return PLACEHOLDER_VALUES.has(text) ? '' : text;
}
