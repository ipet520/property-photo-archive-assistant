import { normalizeRecognitionFields, normalizeRecognitionResult } from './recognitionTypes.js';

const WORK_RULES = [
  { workContent: '楼道杂物清理', watermarkCategory: '绿化保洁类', keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'], tests: ['楼道杂物', '杂物清理'] },
  { workContent: '飞线充电治理', watermarkCategory: '安全管理类', keywords: ['飞线充电', '安全隐患', '用电安全', '治理'], tests: ['飞线充电', '飞线'] },
  { workContent: '消防通道违停', watermarkCategory: '机动车违规管理', keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患'], tests: ['消防通道', '违停', '违规停车'] },
  { workContent: '公共设施设备维修', watermarkCategory: '工程类专用', keywords: ['公共设施', '设备维修', '工程维修', '设备设施'], tests: ['公共设施', '设备维修', '设施维修'] },
  { workContent: '环境卫生维护', watermarkCategory: '绿化保洁类', keywords: ['环境卫生', '清理', '保洁', '维护'], tests: ['环境卫生', '保洁', '清理'] },
  { workContent: '绿化养护', watermarkCategory: '绿化保洁类', keywords: ['绿化养护', '修剪', '绿化带'], tests: ['绿化养护', '修剪', '绿化带'] },
  { workContent: '秩序巡查', watermarkCategory: '巡查检查类', keywords: ['秩序巡查', '巡查', '现场记录'], tests: ['秩序巡查', '巡查'] },
  { workContent: '安全隐患排查', watermarkCategory: '安全管理类', keywords: ['安全隐患', '排查', '整改', '跟进'], tests: ['安全隐患', '隐患排查', '整改'] }
];

const KEYWORD_CANDIDATES = ['楼道杂物', '飞线充电', '消防通道', '公共设施', '设备维修', '环境卫生', '绿化养护', '秩序巡查', '安全隐患', '高空抛物', '违停', '车辆停放', '资料整理', '宣传通知', '巡查', '清理', '维修', '整改', '处理'];

export function cleanRecognitionText(rawText = '') {
  return String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function parseWatermarkText(rawText = '', options = {}) {
  try {
    const cleanedText = cleanRecognitionText(rawText);
    const labeledWorkContent = extractLabeledValue(cleanedText, ['工作内容', '事项', '事项名称']);
    const labeledRemark = extractLabeledValue(cleanedText, ['备注', '说明']);
    const labeledCategory = extractLabeledValue(cleanedText, ['水印分类', '分类']);
    const workRule = extractWorkContent(cleanedText);
    const parsedFields = normalizeRecognitionFields({
      ...extractDateTime(cleanedText),
      projectName: extractLabeledValue(cleanedText, ['项目', '项目名称', '小区']),
      location: extractLabeledValue(cleanedText, ['地点', '地址', '位置']) || extractLocation(cleanedText),
      watermarkCategory: labeledCategory || workRule.watermarkCategory,
      workContent: labeledWorkContent || workRule.workContent,
      keywords: unique([...workRule.keywords, ...extractKeywords(cleanedText)]),
      remark: labeledRemark,
      stage: detectPhotoStage(cleanedText),
      processStatus: detectProcessStatus(cleanedText)
    });
    return normalizeRecognitionResult({
      photoId: options.photoId || '',
      filePath: options.filePath || '',
      source: options.source || 'watermark_parser',
      providerId: options.providerId || 'text_parser',
      providerType: options.providerType || 'manual',
      rawText: String(rawText || ''),
      cleanedText,
      parsedFields,
      confidence: null,
      status: cleanedText ? 'weak' : 'failed',
      warnings: cleanedText ? buildParserWarnings(parsedFields) : ['识别文本为空，无法解析。'],
      errors: cleanedText ? [] : [{ code: 'empty_text', message: '识别文本为空。' }],
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    return normalizeRecognitionResult({
      source: options.source || 'watermark_parser',
      providerId: options.providerId || 'text_parser',
      providerType: options.providerType || 'manual',
      rawText: String(rawText || ''),
      status: 'failed',
      warnings: ['水印文字解析失败，未修改照片或台账。'],
      errors: [{ code: 'parse_failed', message: error.message || '水印文字解析失败。' }],
      createdAt: new Date().toISOString()
    });
  }
}

export function extractDateTime(text = '') {
  const value = String(text || '');
  const datePatterns = [
    /(?<year>\d{4})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})/,
    /(?<year>\d{4})年(?<month>\d{1,2})月(?<day>\d{1,2})日?/
  ];
  const timePattern = /(?<!\d)(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?!\d)/;
  const weekdayPattern = /(星期[一二三四五六日天]|周[一二三四五六日天])/;
  let date = null;
  let dateTime = null;
  for (const pattern of datePatterns) {
    const match = value.match(pattern);
    if (!match?.groups) continue;
    const year = match.groups.year;
    const month = match.groups.month.padStart(2, '0');
    const day = match.groups.day.padStart(2, '0');
    date = `${year}-${month}-${day}`;
    break;
  }
  const timeMatch = value.match(timePattern);
  const time = timeMatch?.groups
    ? `${timeMatch.groups.hour.padStart(2, '0')}:${timeMatch.groups.minute}${timeMatch.groups.second ? `:${timeMatch.groups.second}` : ''}`
    : null;
  if (date && time) dateTime = `${date} ${time}`;
  return {
    date,
    time,
    dateTime,
    weekday: value.match(weekdayPattern)?.[1] || null
  };
}

export function extractLocation(text = '') {
  const value = String(text || '');
  const locationPattern = /((?:\d+\s*[栋幢号#][^\s，,。；;]{0,12})|(?:\d+\s*单元[^\s，,。；;]{0,8})|(?:楼层|楼道|通道|车库|门岗|道路|绿化带|设备房|消防通道|公共区域|地下室|电梯厅)[^\s，,。；;]{0,12})/;
  return value.match(locationPattern)?.[1]?.trim() || null;
}

export function extractWorkContent(text = '') {
  const normalized = normalizeForMatch(text);
  const matched = WORK_RULES.find((rule) => rule.tests.some((keyword) => normalized.includes(normalizeForMatch(keyword))));
  if (!matched) return { workContent: null, watermarkCategory: null, keywords: [] };
  return {
    workContent: matched.workContent,
    watermarkCategory: matched.watermarkCategory,
    keywords: matched.keywords
  };
}

export function extractKeywords(text = '') {
  const normalized = normalizeForMatch(text);
  return unique(KEYWORD_CANDIDATES.filter((keyword) => normalized.includes(normalizeForMatch(keyword))));
}

export function detectPhotoStage(text = '') {
  const rules = ['整改前', '整改中', '整改后', '处理前', '处理中', '处理后', '现场', '远景', '近景', '定位'];
  return rules.find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || null;
}

export function detectProcessStatus(text = '') {
  const rules = ['待处理', '处理中', '已处理', '已完成', '已整改', '已清理', '已维修', '已巡查', '已跟进'];
  return rules.find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || null;
}

function extractLabeledValue(text = '', labels = []) {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:${escapedLabels})\\s*[:：]\\s*([^\\n，,。；;]{1,60})`);
  return String(text || '').match(pattern)?.[1]?.trim() || null;
}

function buildParserWarnings(fields = {}) {
  return [
    !fields.date && '未解析到日期。',
    !fields.time && '未解析到时间。',
    !fields.projectName && '未解析到项目名称。',
    !fields.location && '未解析到地点或位置。',
    !fields.workContent && '未解析到工作内容。',
    !fields.watermarkCategory && '未解析到水印分类。'
  ].filter(Boolean);
}

function normalizeForMatch(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}
