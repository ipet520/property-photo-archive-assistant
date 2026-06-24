const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const APP_FOLDER_NAME = '物业工作照片归档助手';
const DATA_FILE_NAME = 'trial-issues.json';

const PAGE_VALUES = ['首页总览', '快速批量归档', '照片分拣工作台', '归档记录', '整改闭环中心', '资料汇总中心', '数据维护中心', '系统设置', '其它'];
const TYPE_VALUES = ['界面显示', '按钮状态', '文件目录', '扫描照片', '生成预览', '确认归档', '台账记录', '查询筛选', '删除记录', '打开文件', '数据异常', '操作体验', '其它'];
const IMPACT_VALUES = ['轻微', '一般', '严重'];
const STATUS_VALUES = ['未处理', '处理中', '已处理', '暂不处理'];
const EXPORT_HEADERS = [
  ['issueTime', '问题时间'],
  ['page', '问题页面'],
  ['type', '问题类型'],
  ['impact', '影响程度'],
  ['status', '处理状态'],
  ['description', '问题描述'],
  ['handlingNote', '处理备注'],
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
  if (!item.description) throw new Error('问题描述不能为空。');
  if (!item.id) {
    item.id = createId();
    item.createdAt = now;
  }
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
  if (nextItems.length === items.length) throw new Error('未找到需要删除的试运行问题记录。');
  await writeItems(paths.dataFile, nextItems);
  return { success: true, items: nextItems.map(normalizeItem).sort(byIssueTimeDesc), paths };
}

async function exportTrialIssues(targetFilePath, items = [], format = 'xlsx') {
  const normalized = (Array.isArray(items) ? items : []).map(normalizeItem);
  if (normalized.length === 0) throw new Error('当前没有可导出的试运行问题记录。');
  const rows = [
    EXPORT_HEADERS.map(([, label]) => label),
    ...normalized.map((item) => EXPORT_HEADERS.map(([field]) => item[field] || ''))
  ];
  if (format === 'csv') {
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    await fs.writeFile(targetFilePath, `\uFEFF${csv}`, 'utf-8');
  } else {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = EXPORT_HEADERS.map(([, label]) => ({ wch: Math.max(label.length + 8, 16) }));
    XLSX.utils.book_append_sheet(workbook, sheet, '试运行问题记录');
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
    if (!Array.isArray(payload)) throw new Error('数据文件根节点不是数组');
    return payload;
  } catch (error) {
    throw new Error(`试运行问题记录读取失败，数据文件可能损坏：${error.message}`);
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
  return {
    id: stringValue(item.id),
    issueTime: normalizeIssueTime(item.issueTime) || nowLocal,
    page: PAGE_VALUES.includes(item.page) ? item.page : '其它',
    type: TYPE_VALUES.includes(item.type) ? item.type : '其它',
    description: stringValue(item.description),
    impact: IMPACT_VALUES.includes(item.impact) ? item.impact : '一般',
    status: STATUS_VALUES.includes(item.status) ? item.status : '未处理',
    handlingNote: stringValue(item.handlingNote),
    createdAt: stringValue(item.createdAt),
    updatedAt: stringValue(item.updatedAt)
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

function createId() {
  return `trial-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function byIssueTimeDesc(a, b) {
  return (Date.parse(String(b.issueTime || '').replace(' ', 'T')) || 0) - (Date.parse(String(a.issueTime || '').replace(' ', 'T')) || 0);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stringValue(value) {
  return String(value || '').trim();
}

module.exports = {
  IMPACT_VALUES,
  PAGE_VALUES,
  STATUS_VALUES,
  TYPE_VALUES,
  deleteTrialIssue,
  exportTrialIssues,
  getTrialIssuePaths,
  loadTrialIssues,
  saveTrialIssue
};
