function parseWatermarkText(text = '') {
  const rawText = String(text || '').trim();
  const dateTime = extractDateTime(rawText);
  const project = extractLabeledValue(rawText, ['项目', '项目名称', '小区']);
  const location = sanitizeLocationForProject(extractLabeledValue(rawText, ['地点', '地址', '位置']), project);
  const remark = extractLabeledValue(rawText, ['备注', '说明', '工作内容']);
  const warnings = [];
  if (!rawText) warnings.push('OCR 文本为空。');
  if (!dateTime.date) warnings.push('未解析到日期。');
  if (!dateTime.time) warnings.push('未解析到时间。');
  return {
    rawText,
    capturedAt: dateTime.date && dateTime.time ? `${dateTime.date} ${dateTime.time}` : null,
    date: dateTime.date,
    time: dateTime.time,
    weekday: dateTime.weekday,
    location: location || '',
    project: project || '',
    category: '',
    watermarkCategory: null,
    workContent: '',
    remark: remark || '',
    keywords: [],
    confidence: rawText && (dateTime.date || dateTime.time || location) ? 'low' : 'low',
    needReview: true,
    warnings
  };
}

function extractDateTime(text = '') {
  const value = String(text || '');
  const datePatterns = [
    /(?<year>\d{4})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})/,
    /(?<year>\d{4})年(?<month>\d{1,2})月(?<day>\d{1,2})日?/
  ];
  const timeMatch = value.match(/(?<!\d)(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?!\d)/);
  const weekday = value.match(/(星期[一二三四五六日天]|周[一二三四五六日天])/)?.[1] || null;
  let date = null;
  for (const pattern of datePatterns) {
    const match = value.match(pattern);
    if (!match?.groups) continue;
    date = `${match.groups.year}-${match.groups.month.padStart(2, '0')}-${match.groups.day.padStart(2, '0')}`;
    break;
  }
  const time = timeMatch?.groups
    ? `${timeMatch.groups.hour.padStart(2, '0')}:${timeMatch.groups.minute}${timeMatch.groups.second ? `:${timeMatch.groups.second}` : ''}`
    : null;
  return { date, time, weekday };
}

function extractLabeledValue(text = '', labels = []) {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(text || '').match(new RegExp(`(?:${escapedLabels})\\s*[:：]\\s*([^\\n，,。；;]{1,80})`))?.[1]?.trim() || '';
}

function sanitizeLocationForProject(location = '', project = '') {
  const cleaned = String(location || '').trim();
  const projectName = String(project || '').trim();
  if (!cleaned) return '';
  const withoutProject = projectName ? cleaned.replace(projectName, '') : cleaned;
  return withoutProject
    .replace(/^[\s·•,，、;；:：/\\|_-]+|[\s·•,，、;；:：/\\|_-]+$/g, '')
    .trim();
}

module.exports = {
  parseWatermarkText
};
