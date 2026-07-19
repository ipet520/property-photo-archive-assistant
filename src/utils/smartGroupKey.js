const BUSINESS_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

const invalidFieldValues = new Set([
  '',
  '-',
  '--',
  '暂无',
  '未填写',
  '未设置',
  'null',
  'undefined'
]);

export function normalizeSmartGroupDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ''
      : formatUtc8Date(value.getTime());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = Math.abs(value) < 1e12 ? value * 1000 : value;
    return formatUtc8Date(timestamp);
  }

  const text = cleanSmartGroupValue(value);
  if (!text) return '';
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const timestamp = text.length <= 10 ? numeric * 1000 : numeric;
    return formatUtc8Date(timestamp);
  }

  const localDateTime = text.match(
    /^(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})(?:日)?(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/
  );
  if (localDateTime?.groups) {
    return normalizeDateParts(
      localDateTime.groups.year,
      localDateTime.groups.month,
      localDateTime.groups.day
    );
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? formatUtc8Date(timestamp) : '';
}

export function buildSmartGroupDescriptor({
  photo = {},
  recognitionResult = null,
  watermarkRecord = null,
  archiveSuggestion = null,
  canonicalFields = {}
} = {}) {
  const photoId = cleanSmartGroupValue(photo?.id || photo?.photoId);
  const suggestionFields = archiveSuggestion?.suggestedFields || {};
  const processing = recognitionResult?.sourceAwareProcessing || {};
  const manualDate = isManualFieldSource(archiveSuggestion?.fieldSources?.date)
    ? suggestionFields.date
    : '';
  const dateCandidates = [
    ['manual_confirmed', photo?.archiveInfo?.date || manualDate],
    ['effective_result', processing?.effectiveResult?.requiredFields?.date],
    ['watermark_record', watermarkRecord?.captureDate],
    ['archive_suggestion', suggestionFields.date],
    ['canonical_result', canonicalFields.date],
    [
      'source_capture_time',
      photo?.capturedAt
        || photo?.takenAt
        || photo?.postTime
        || photo?.modifiedAt
    ]
  ];
  let date = '';
  let dateSource = '';
  for (const [source, value] of dateCandidates) {
    const normalized = normalizeSmartGroupDate(value);
    if (!normalized) continue;
    date = normalized;
    dateSource = source;
    break;
  }

  const fields = {
    date,
    project: cleanSmartGroupValue(canonicalFields.project),
    watermarkCategory: cleanSmartGroupValue(canonicalFields.watermarkCategory),
    workContent: cleanSmartGroupValue(canonicalFields.workContent)
  };
  const missingDate = !date;
  const dateKey = missingDate
    ? `missing_date:${photoId || 'missing_photo_id'}`
    : date;
  const groupKey = buildSmartGroupKey({
    ...fields,
    date: dateKey
  });

  return {
    groupKey,
    date,
    dateSource,
    missingDate,
    fields,
    title: buildSmartGroupTitle(fields)
  };
}

export function buildSmartGroupKey({
  date = '',
  project = '',
  watermarkCategory = '',
  workContent = ''
} = {}) {
  return JSON.stringify([
    normalizeSmartGroupKeyPart(date),
    normalizeSmartGroupKeyPart(project),
    normalizeSmartGroupKeyPart(watermarkCategory),
    normalizeSmartGroupKeyPart(workContent)
  ]);
}

export function buildSmartGroupTitle(fields = {}) {
  const date = normalizeSmartGroupDate(fields.date);
  const detail = cleanSmartGroupValue(fields.workContent)
    || cleanSmartGroupValue(fields.watermarkCategory)
    || cleanSmartGroupValue(fields.project)
    || '待人工完善';
  return `${date || '日期待补充'}｜${detail}`;
}

export function normalizeSmartGroupDescriptor(value = {}, photoId = '') {
  const fields = {
    date: normalizeSmartGroupDate(value?.fields?.date || value?.date),
    project: cleanSmartGroupValue(value?.fields?.project),
    watermarkCategory: cleanSmartGroupValue(value?.fields?.watermarkCategory),
    workContent: cleanSmartGroupValue(value?.fields?.workContent)
  };
  const missingDate = !fields.date;
  const safePhotoId = cleanSmartGroupValue(photoId);
  const dateKey = missingDate
    ? `missing_date:${safePhotoId || 'missing_photo_id'}`
    : fields.date;
  return {
    groupKey: buildSmartGroupKey({ ...fields, date: dateKey }),
    date: fields.date,
    dateSource: cleanSmartGroupValue(value?.dateSource),
    missingDate,
    fields,
    title: buildSmartGroupTitle(fields)
  };
}

export function cleanSmartGroupValue(value) {
  const normalized = typeof value === 'string'
    ? value.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
    : value == null
      ? ''
      : String(value).trim();
  return invalidFieldValues.has(normalized.toLowerCase()) ? '' : normalized;
}

function normalizeSmartGroupKeyPart(value) {
  return cleanSmartGroupValue(value).toLocaleLowerCase('zh-CN');
}

function normalizeDateParts(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || month < 1
    || month > 12
    || day < 1
    || day > 31
  ) {
    return '';
  }
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return '';
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatUtc8Date(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const shifted = new Date(timestamp + BUSINESS_TIMEZONE_OFFSET_MS);
  return Number.isNaN(shifted.getTime())
    ? ''
    : shifted.toISOString().slice(0, 10);
}

function isManualFieldSource(value) {
  const normalized = cleanSmartGroupValue(value).toLowerCase();
  return normalized === 'manual'
    || normalized === 'manual_draft'
    || normalized === 'user_confirmed';
}
