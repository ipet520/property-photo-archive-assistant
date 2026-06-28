const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const APP_FOLDER_NAME = '物业工作照片归档助手';
const DATA_FILE_NAME = 'trial-issues.json';
const MAX_TECHNICAL_DETAIL_LENGTH = 8000;

const PAGE_VALUES = ['首页总览', '照片分拣工作台', '归档记录', '整改闭环中心', '资料汇总中心', '数据维护中心', '系统设置', '其它'];
const TYPE_VALUES = ['界面显示', '按钮状态', '文件目录', '扫描照片', '生成预览', '确认归档', '台账记录', '查询筛选', '删除记录', '打开文件', '数据异常', '操作体验', '配置读取', '配置保存', '资料包生成', '页面异常', 'IPC 调用失败', '其它'];
const LEVEL_VALUES = ['info', 'warn', 'error'];
const LOG_TYPE_VALUES = ['auto', 'manual'];
const STATUS_VALUES = ['open', 'handled', 'ignored'];
const EXPORT_HEADERS = [
  ['logTypeLabel', '记录类型'],
  ['occurredAt', '时间'],
  ['page', '页面'],
  ['operation', '操作'],
  ['levelLabel', '级别'],
  ['errorType', '错误类型'],
  ['summary', '错误摘要'],
  ['suggestion', '处理建议'],
  ['statusLabel', '处理状态'],
  ['handledNote', '处理备注'],
  ['technicalDetail', '技术详情'],
  ['createdAt', '创建时间'],
  ['updatedAt', '更新时间']
];

async function loadTrialIssues(documentsPath) {
  const paths = getTrialIssuePaths(documentsPath);
  await ensureDataFile(paths);
  const items = await readItems(paths.dataFile);
  return { success: true, paths, items: items.map(normalizeItem).sort(byIssueTimeDesc) };
}

async function saveTrialIssue(documentsPath, input) {
  const paths = getTrialIssuePaths(documentsPath);
  await ensureDataFile(paths);
  const items = await readItems(paths.dataFile);
  const now = new Date().toISOString();
  const item = normalizeItem(input);
  if (!item.summary) throw new Error('问题描述不能为空。');
  if (!item.id) {
    item.id = createId(item.logType);
    item.createdAt = now;
  }
  if (item.status === 'handled' && !item.handledAt) item.handledAt = now;
  item.updatedAt = now;
  const index = items.findIndex((current) => String(current?.id || '') === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
  await writeItems(paths.dataFile, items);
  return { success: true, item, items: items.map(normalizeItem).sort(byIssueTimeDesc), paths };
}

async function deleteTrialIssue(documentsPath, id) {
  const paths = getTrialIssuePaths(documentsPath);
  await ensureDataFile(paths);
  const items = await readItems(paths.dataFile);
  const nextItems = items.filter((item) => String(item?.id || '') !== String(id || ''));
  if (nextItems.length === items.length) throw new Error('未找到需要删除的运行日志或问题反馈记录。');
  await writeItems(paths.dataFile, nextItems);
  return { success: true, items: nextItems.map(normalizeItem).sort(byIssueTimeDesc), paths };
}

async function clearHandledTrialIssues(documentsPath) {
  const paths = getTrialIssuePaths(documentsPath);
  await ensureDataFile(paths);
  const items = await readItems(paths.dataFile);
  const nextItems = items.map(normalizeItem).filter((item) => item.status !== 'handled');
  await writeItems(paths.dataFile, nextItems);
  return { success: true, items: nextItems.map(normalizeItem).sort(byIssueTimeDesc), paths };
}

async function exportTrialIssues(targetFilePath, items = [], format = 'xlsx') {
  const normalized = (Array.isArray(items) ? items : []).map(normalizeItem);
  if (normalized.length === 0) throw new Error('当前没有可导出的运行日志或问题反馈记录。');
  const rows = [
    EXPORT_HEADERS.map(([, label]) => label),
    ...normalized.map((item) => {
      const view = addDisplayFields(item);
      return EXPORT_HEADERS.map(([field]) => view[field] || '');
    })
  ];
  if (format === 'csv') {
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    await fs.writeFile(targetFilePath, `\uFEFF${csv}`, 'utf-8');
  } else {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = EXPORT_HEADERS.map(([, label]) => ({ wch: Math.max(label.length + 8, 18) }));
    XLSX.utils.book_append_sheet(workbook, sheet, '运行日志与问题反馈');
    XLSX.writeFile(workbook, targetFilePath);
  }
  return { success: true, filePath: targetFilePath, format };
}

function getTrialIssuePaths(documentsPath) {
  const dataDir = path.join(documentsPath, APP_FOLDER_NAME);
  return { dataDir, dataFile: path.join(dataDir, DATA_FILE_NAME) };
}

async function ensureDataFile(paths) {
  await fs.mkdir(paths.dataDir, { recursive: true });
  if (!fsSync.existsSync(paths.dataFile)) await fs.writeFile(paths.dataFile, '[]\n', 'utf-8');
}

async function readItems(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const payload = JSON.parse(content);
    if (!Array.isArray(payload)) throw new Error('数据文件根节点不是数组。');
    return payload;
  } catch (error) {
    throw new Error(`运行日志与问题反馈读取失败，数据文件可能损坏：${error.message}`);
  }
}

async function writeItems(filePath, items) {
  const temporaryPath = `${filePath}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, 'utf-8');
    await fs.copyFile(temporaryPath, filePath);
  } finally {
    try { await fs.unlink(temporaryPath); } catch { /* Ignore absent temporary files. */ }
  }
}

function normalizeItem(item = {}) {
  const nowLocal = formatLocalDateTime(new Date());
  const logType = LOG_TYPE_VALUES.includes(item.logType) ? item.logType : 'manual';
  const level = normalizeLevel(item.level || item.impact);
  const status = normalizeStatus(item.status);
  const occurredAt = normalizeIssueTime(item.occurredAt || item.issueTime) || nowLocal;
  const summary = stringValue(item.summary || item.description);
  const errorType = normalizeType(item.errorType || item.type);
  const normalized = {
    id: stringValue(item.id),
    logType,
    level,
    page: normalizePage(item.page),
    operation: stringValue(item.operation || item.type || errorType || '手动反馈'),
    errorType,
    summary,
    suggestion: stringValue(item.suggestion),
    technicalDetail: truncateText(item.technicalDetail || item.detail || item.stack),
    status,
    handledNote: stringValue(item.handledNote || item.handlingNote),
    handledAt: stringValue(item.handledAt),
    occurredAt,
    createdAt: stringValue(item.createdAt),
    updatedAt: stringValue(item.updatedAt)
  };

  return {
    ...normalized,
    issueTime: normalized.occurredAt,
    type: normalized.errorType,
    description: normalized.summary,
    impact: levelToImpact(normalized.level),
    handlingNote: normalized.handledNote
  };
}

function addDisplayFields(item) {
  return {
    ...item,
    logTypeLabel: item.logType === 'auto' ? '自动日志' : '手动反馈',
    levelLabel: levelLabel(item.level),
    statusLabel: statusLabel(item.status)
  };
}

function normalizeIssueTime(value) {
  const text = stringValue(value);
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.slice(0, 16).replace('T', ' ') : formatLocalDateTime(date);
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createId(type = 'manual') {
  return `${type === 'auto' ? 'runtime' : 'feedback'}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function byIssueTimeDesc(a, b) {
  return (Date.parse(String(b.occurredAt || b.issueTime || '').replace(' ', 'T')) || 0) - (Date.parse(String(a.occurredAt || a.issueTime || '').replace(' ', 'T')) || 0);
}

function normalizePage(value) {
  const text = stringValue(value);
  return PAGE_VALUES.includes(text) ? text : (text || '其它');
}

function normalizeType(value) {
  const text = stringValue(value);
  return TYPE_VALUES.includes(text) ? text : (text || '其它');
}

function normalizeLevel(value) {
  const text = stringValue(value);
  if (LEVEL_VALUES.includes(text)) return text;
  if (['严重', '错误', 'error'].includes(text)) return 'error';
  if (['一般', '重要', '警告', 'warn', 'warning'].includes(text)) return 'warn';
  return 'info';
}

function normalizeStatus(value) {
  const text = stringValue(value);
  if (STATUS_VALUES.includes(text)) return text;
  if (['已处理', '完成', 'handled'].includes(text)) return 'handled';
  if (['暂不处理', '已忽略', 'ignored'].includes(text)) return 'ignored';
  return 'open';
}

function levelToImpact(level) {
  return { info: '一般', warn: '重要', error: '严重' }[level] || '一般';
}

function levelLabel(level) {
  return { info: '信息', warn: '警告', error: '错误' }[level] || '信息';
}

function statusLabel(status) {
  return { open: '未处理', handled: '已处理', ignored: '已忽略' }[status] || '未处理';
}

function truncateText(value) {
  const text = stringValue(value);
  return text.length > MAX_TECHNICAL_DETAIL_LENGTH ? `${text.slice(0, MAX_TECHNICAL_DETAIL_LENGTH)}\n...内容已截断` : text;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stringValue(value) {
  return String(value || '').trim();
}

module.exports = {
  LEVEL_VALUES,
  LOG_TYPE_VALUES,
  PAGE_VALUES,
  STATUS_VALUES,
  TYPE_VALUES,
  clearHandledTrialIssues,
  deleteTrialIssue,
  exportTrialIssues,
  getTrialIssuePaths,
  loadTrialIssues,
  saveTrialIssue
};
