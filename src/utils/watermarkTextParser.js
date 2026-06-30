import { normalizeRecognitionResult } from './recognitionTypes.js';

const PROJECTS = [
  { project: '潇湘新区二期', aliases: ['曲靖潇湘新区二期', '潇湘新区二期', '潇湘', '新区二期'] },
  { project: '香辰康园', aliases: ['曲靖香辰康园', '香辰康园', '香辰'] }
];

const WORK_RULES = [
  { workContent: '楼道杂物清理', categoryHint: '绿化保洁类', keywords: ['楼道杂物', '公共区域', '环境卫生', '清理整治'], tests: ['楼道杂物', '杂物清理'] },
  { workContent: '飞线充电治理', categoryHint: '安全管理类', keywords: ['飞线充电', '安全隐患', '用电安全', '治理'], tests: ['飞线充电', '飞线'] },
  { workContent: '消防通道违停', categoryHint: '机动车违规管理', keywords: ['消防通道', '违规停车', '车辆停放', '安全隐患'], tests: ['消防通道', '违停', '违规停车'] },
  { workContent: '公共设施设备维修', categoryHint: '工程类专用', keywords: ['公共设施', '设备维修', '工程维修', '设备设施'], tests: ['公共设施', '设备维修', '设施维修'] },
  { workContent: '环境卫生维护', categoryHint: '绿化保洁类', keywords: ['环境卫生', '清理', '保洁', '维护'], tests: ['环境卫生', '保洁', '清理'] },
  { workContent: '绿化养护', categoryHint: '绿化保洁类', keywords: ['绿化养护', '修剪', '绿化带'], tests: ['绿化养护', '修剪', '绿化带'] },
  { workContent: '秩序巡查', categoryHint: '巡查检查类', keywords: ['秩序巡查', '巡查', '现场记录'], tests: ['秩序巡查', '巡查'] },
  { workContent: '安全隐患排查', categoryHint: '安全管理类', keywords: ['安全隐患', '排查', '整改', '跟进'], tests: ['安全隐患', '隐患排查', '整改'] }
];

export function cleanRecognitionText(rawText = '') {
  return String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function parseWatermarkText(rawText = '', options = {}) {
  const cleanedText = cleanRecognitionText(rawText);
  const fields = normalizeRecognitionFields({
    ...extractDateTime(cleanedText),
    project: extractProject(cleanedText),
    location: extractLocation(cleanedText),
    ...extractWorkContent(cleanedText),
    possibleStage: detectPhotoStage(cleanedText),
    possibleStatus: detectProcessStatus(cleanedText)
  });

  return normalizeRecognitionResult({
    photoId: options.photoId || '',
    filePath: options.filePath || '',
    source: options.source || 'system',
    providerId: options.providerId || 'text_parser',
    mode: options.mode || 'manual',
    rawText: String(rawText || ''),
    cleanedText,
    fields,
    confidence: null,
    status: cleanedText ? 'weak' : 'failed',
    errorCode: cleanedText ? '' : 'empty_text',
    errorMessage: cleanedText ? '' : '识别文本为空。',
    warnings: cleanedText ? buildParserWarnings(fields) : ['识别文本为空，无法解析。'],
    updatedAt: new Date().toISOString()
  });
}

export function extractDateTime(text = '') {
  const value = String(text || '');
  const patterns = [
    /(?<year>\d{4})[-/.年](?<month>\d{1,2})[-/.月](?<day>\d{1,2})(?:日)?\s*(?<time>\d{1,2}:\d{2})?/,
    /(?<month>\d{1,2})[-/.月](?<day>\d{1,2})(?:日)?\s*(?<time>\d{1,2}:\d{2})?/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.groups) continue;
    const year = match.groups.year || '';
    const month = match.groups.month?.padStart(2, '0') || '';
    const day = match.groups.day?.padStart(2, '0') || '';
    const time = normalizeTime(match.groups.time || '');
    const date = year ? `${year}-${month}-${day}` : `${month}-${day}`;
    return { date, time, dateTime: time ? `${date} ${time}` : date };
  }
  return { date: '', time: '', dateTime: '' };
}

export function extractProject(text = '') {
  const normalized = normalizeForMatch(text);
  const matched = PROJECTS.find((item) => item.aliases.some((alias) => normalized.includes(normalizeForMatch(alias))));
  return matched?.project || '';
}

export function extractLocation(text = '') {
  const value = String(text || '');
  const labeled = value.match(/(?:地点|位置|地址)[:：]?\s*([^\n，,。；;]{2,32})/);
  if (labeled?.[1]) return labeled[1].trim();
  const locationPattern = /((?:\d+\s*[栋幢号#][^\s，,。；;]{0,12})|(?:\d+\s*单元[^\s，,。；;]{0,8})|(?:楼层|楼道|通道|车库|门岗|道路|绿化带|设备房|消防通道|公共区域|地下室|电梯厅)[^\s，,。；;]{0,12})/;
  return value.match(locationPattern)?.[1]?.trim() || '';
}

export function extractWorkContent(text = '') {
  const normalized = normalizeForMatch(text);
  const matched = WORK_RULES.find((rule) => rule.tests.some((keyword) => normalized.includes(normalizeForMatch(keyword))));
  if (!matched) {
    const keywords = extractKeywords(text);
    return { workContent: keywords[0] || '', categoryHint: '', keywords, remark: '' };
  }
  return {
    workContent: matched.workContent,
    categoryHint: matched.categoryHint,
    keywords: matched.keywords,
    remark: ''
  };
}

export function extractKeywords(text = '') {
  const candidates = ['楼道杂物', '飞线充电', '消防通道', '公共设施', '设备维修', '环境卫生', '绿化养护', '秩序巡查', '安全隐患', '高空抛物', '违停', '车辆停放', '资料整理', '宣传通知', '巡查', '清理', '维修', '整改', '处理'];
  const normalized = normalizeForMatch(text);
  return unique(candidates.filter((keyword) => normalized.includes(normalizeForMatch(keyword))));
}

export function detectPhotoStage(text = '') {
  const rules = ['整改前', '整改中', '整改后', '处理前', '处理中', '处理后', '现场', '远景', '近景', '定位'];
  return rules.find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || '';
}

export function detectProcessStatus(text = '') {
  const rules = ['待处理', '处理中', '已处理', '已完成', '已整改', '已清理', '已维修', '已巡查', '已跟进'];
  return rules.find((keyword) => normalizeForMatch(text).includes(normalizeForMatch(keyword))) || '';
}

export function normalizeRecognitionFields(fields = {}) {
  return {
    dateTime: clean(fields.dateTime),
    date: clean(fields.date),
    time: clean(fields.time),
    location: clean(fields.location),
    project: clean(fields.project),
    workContent: clean(fields.workContent),
    categoryHint: clean(fields.categoryHint),
    keywords: unique(Array.isArray(fields.keywords) ? fields.keywords : String(fields.keywords || '').split(/[、,，;；\s]+/)),
    remark: clean(fields.remark),
    possibleStage: clean(fields.possibleStage),
    possibleStatus: clean(fields.possibleStatus)
  };
}

function buildParserWarnings(fields = {}) {
  return [
    !fields.date && '未解析到日期。',
    !fields.project && '未解析到项目。',
    !fields.location && '未解析到位置。',
    !fields.workContent && '未解析到工作内容。'
  ].filter(Boolean);
}

function normalizeTime(value = '') {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function normalizeForMatch(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function clean(value) {
  return String(value || '').trim();
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => clean(value)).filter(Boolean)));
}
