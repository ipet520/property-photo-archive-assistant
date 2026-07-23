import {
  ENGINEERING_ARCHIVE_CATEGORY,
  NOT_APPLICABLE_WORK_CONTENT,
  TIME_LOCATION_ARCHIVE_CATEGORY,
  VEHICLE_ARCHIVE_CATEGORY,
  WATERMARK_TEMPLATE_TYPES
} from './watermarkTemplateAdapter.js';

const FIELD_LABELS = Object.freeze({
  watermarkTemplateType: '水印模板',
  date: '日期',
  project: '项目',
  archiveCategory: '归档分类',
  workContent: '工作内容',
  constructionUnit: '施工单位',
  vehiclePlate: '车牌号码',
  violationType: '违停类型'
});

export function validateArchiveFormByTemplate(form = {}, configs = {}) {
  const safeConfigs = configs && typeof configs === 'object' ? configs : {};
  const templateType = clean(form.watermarkTemplateType);
  const archiveCategory = clean(form.archiveCategory || form.watermarkCategory);
  const projectName = clean(form.projectName || form.project);
  const projectId = clean(form.projectId);
  const missing = [];

  if (!Object.values(WATERMARK_TEMPLATE_TYPES).includes(templateType)
    || templateType === WATERMARK_TEMPLATE_TYPES.UNRESOLVED) {
    missing.push(FIELD_LABELS.watermarkTemplateType);
  }
  if (!isValidDate(form.date)) missing.push(FIELD_LABELS.date);
  if (!isConfiguredProject(projectId, projectName, safeConfigs)) missing.push(FIELD_LABELS.project);
  if (!Object.hasOwn(safeConfigs.watermarkCategories || {}, archiveCategory)) {
    missing.push(FIELD_LABELS.archiveCategory);
  }
  if (
    templateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
    && archiveCategory !== TIME_LOCATION_ARCHIVE_CATEGORY
  ) {
    missing.push(FIELD_LABELS.archiveCategory);
  }
  if (
    templateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION
    && archiveCategory !== VEHICLE_ARCHIVE_CATEGORY
  ) {
    missing.push(FIELD_LABELS.archiveCategory);
  }
  if (
    templateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD
    && [
      TIME_LOCATION_ARCHIVE_CATEGORY,
      VEHICLE_ARCHIVE_CATEGORY
    ].includes(archiveCategory)
  ) {
    missing.push(FIELD_LABELS.archiveCategory);
  }

  if (templateType === WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD) {
    if (!isConfiguredWorkContent(form.workContent, archiveCategory, safeConfigs)) {
      missing.push(FIELD_LABELS.workContent);
    }
    if (
      archiveCategory === ENGINEERING_ARCHIVE_CATEGORY
      && !isValidConstructionUnit(form, safeConfigs)
    ) {
      missing.push(FIELD_LABELS.constructionUnit);
    }
  }

  if (templateType === WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION) {
    if (!clean(form.vehiclePlate)) missing.push(FIELD_LABELS.vehiclePlate);
    if (!isConfiguredWorkContent(form.violationType, archiveCategory, safeConfigs)) {
      missing.push(FIELD_LABELS.violationType);
    }
  }

  if (
    templateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION
    && clean(form.workContent) !== NOT_APPLICABLE_WORK_CONTENT
  ) {
    // The field is intentionally not required; the canonical sentinel is restored by the adapter.
  }

  return Array.from(new Set(missing));
}

export function isArchiveFormValidByTemplate(form = {}, configs = {}) {
  return validateArchiveFormByTemplate(form, configs).length === 0;
}

function isConfiguredProject(projectId, projectName, configs) {
  const options = Array.isArray(configs.projectOptions)
    ? configs.projectOptions
    : (configs.projects || []).map((name) => ({ id: '', name }));
  if (Array.isArray(configs.projectOptions) && configs.projectOptions.length > 0 && !projectId) {
    return false;
  }
  return options.some((item) => (
    clean(item.name) === projectName
    && (!projectId || clean(item.id) === projectId)
  ));
}

function isConfiguredWorkContent(value, archiveCategory, configs) {
  const normalized = clean(value);
  return Boolean(normalized)
    && (configs.watermarkCategories?.[archiveCategory]?.items || []).includes(normalized);
}

function isValidConstructionUnit(form, configs) {
  const id = clean(form.constructionUnitId);
  const name = clean(form.constructionUnitName);
  if (!id || !name || form.constructionUnitConfirmed !== true) return false;
  return (configs.constructionUnits || []).some((item) => (
    clean(item.id) === id
    && clean(item.name) === name
    && (
      !Array.isArray(item.projectIds)
      || item.projectIds.length === 0
      || item.projectIds.includes(clean(form.projectId))
    )
  ));
}

function isValidDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function clean(value) {
  return String(value ?? '').trim();
}
