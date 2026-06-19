const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const APP_FOLDER_NAME = '物业工作照片归档助手';
const DATA_DIR_NAME = 'rectification';
const DATA_FILE_NAME = 'rectification-items.json';

const STATUS_VALUES = ['待整改', '整改中', '已完成', '已关闭'];

const EXPORT_HEADERS = [
  ['index', '序号'],
  ['rectificationNo', '整改编号'],
  ['createdDate', '创建日期'],
  ['project', '项目'],
  ['responsibleDepartment', '责任部门'],
  ['watermarkCategory', '水印分类'],
  ['workContent', '工作内容'],
  ['location', '问题位置 / 区域'],
  ['title', '问题标题'],
  ['description', '问题描述'],
  ['requirement', '整改要求'],
  ['deadline', '截止日期'],
  ['status', '整改状态'],
  ['owner', '处理人 / 跟进人'],
  ['keywords', '关键词'],
  ['remark', '备注'],
  ['beforeCount', '整改前照片数量'],
  ['duringCount', '整改中照片数量'],
  ['afterCount', '整改后照片数量'],
  ['createdAt', '创建时间'],
  ['updatedAt', '更新时间'],
  ['closedAt', '关闭时间'],
  ['closeNote', '关闭说明']
];

async function loadRectificationItems(documentsPath) {
  const paths = getRectificationPaths(documentsPath);
  await ensureDataFile(paths);
  const payload = await readData(paths.dataFile);
  return {
    success: true,
    paths,
    items: payload.items.map(normalizeItem).sort(byUpdatedDesc)
  };
}

async function saveRectificationItem(documentsPath, item) {
  const paths = getRectificationPaths(documentsPath);
  await ensureDataFile(paths);
  const payload = await readData(paths.dataFile);
  const now = new Date().toISOString();
  const normalized = normalizeItem(item);

  if (!normalized.id) {
    normalized.id = createId();
    normalized.rectificationNo = generateRectificationNo(payload.items, new Date());
    normalized.createdAt = now;
    normalized.status = normalized.status || '待整改';
  }

  normalized.updatedAt = now;
  if (normalized.status === '已关闭' && !normalized.closedAt) {
    normalized.closedAt = now;
  }
  if (normalized.status !== '已关闭') {
    normalized.closedAt = '';
  }

  validateItem(normalized);

  const index = payload.items.findIndex((existing) => existing.id === normalized.id);
  if (index >= 0) {
    payload.items[index] = normalized;
  } else {
    payload.items.push(normalized);
  }

  payload.updatedAt = now;
  await writeData(paths.dataFile, payload);
  return {
    success: true,
    item: normalized,
    items: payload.items.map(normalizeItem).sort(byUpdatedDesc),
    paths
  };
}

async function exportRectificationItems(targetFilePath, items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, message: '当前没有可导出的整改事项。' };
  }

  const rows = [
    EXPORT_HEADERS.map(([, header]) => header),
    ...items.map((item, index) => {
      const normalized = normalizeItem(item);
      const exportRow = {
        index: index + 1,
        ...normalized,
        createdDate: normalizeDate(normalized.createdAt),
        beforeCount: normalized.photos.before.length,
        duringCount: normalized.photos.during.length,
        afterCount: normalized.photos.after.length,
        keywords: normalizeKeywordsText(normalized.keywords)
      };
      return EXPORT_HEADERS.map(([field]) => exportRow[field] || '');
    })
  ];

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = EXPORT_HEADERS.map(([, header]) => ({ wch: Math.max(header.length + 6, 14) }));
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(workbook, sheet, '整改闭环台账');
  XLSX.writeFile(workbook, targetFilePath);
  return { success: true, filePath: targetFilePath };
}

function getRectificationPaths(documentsPath) {
  const dataDir = path.join(documentsPath, APP_FOLDER_NAME, DATA_DIR_NAME);
  return {
    dataDir,
    dataFile: path.join(dataDir, DATA_FILE_NAME)
  };
}

async function ensureDataFile(paths) {
  await fs.mkdir(paths.dataDir, { recursive: true });
  if (!fsSync.existsSync(paths.dataFile)) {
    await writeData(paths.dataFile, {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: []
    });
  }
}

async function readData(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const payload = JSON.parse(content);
  return {
    version: payload.version || 1,
    createdAt: payload.createdAt || new Date().toISOString(),
    updatedAt: payload.updatedAt || '',
    items: Array.isArray(payload.items) ? payload.items : []
  };
}

async function writeData(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function normalizeItem(item = {}) {
  return {
    id: stringValue(item.id),
    rectificationNo: stringValue(item.rectificationNo),
    createdAt: stringValue(item.createdAt),
    updatedAt: stringValue(item.updatedAt),
    project: stringValue(item.project),
    responsibleDepartment: stringValue(item.responsibleDepartment || item.department),
    watermarkCategory: stringValue(item.watermarkCategory),
    workContent: stringValue(item.workContent),
    location: stringValue(item.location),
    title: stringValue(item.title),
    description: stringValue(item.description),
    requirement: stringValue(item.requirement),
    deadline: stringValue(item.deadline),
    status: STATUS_VALUES.includes(item.status) ? item.status : '待整改',
    owner: stringValue(item.owner),
    keywords: normalizeKeywords(item.keywords),
    remark: stringValue(item.remark),
    photos: normalizePhotos(item.photos),
    sourceRecords: Array.isArray(item.sourceRecords) ? item.sourceRecords : [],
    closedAt: stringValue(item.closedAt),
    closeNote: stringValue(item.closeNote)
  };
}

function normalizePhotos(photos = {}) {
  return {
    before: normalizePhotoList(photos.before),
    during: normalizePhotoList(photos.during),
    after: normalizePhotoList(photos.after)
  };
}

function normalizePhotoList(photos = []) {
  return (Array.isArray(photos) ? photos : []).map((photo) => {
    const filePath = stringValue(photo.filePath || photo.archivePath || photo.path);
    return {
      id: stringValue(photo.id) || createId('photo'),
      filePath,
      fileName: stringValue(photo.fileName || path.basename(filePath || '')),
      sourceType: stringValue(photo.sourceType || '手动添加'),
      stage: stringValue(photo.stage),
      addedAt: stringValue(photo.addedAt) || new Date().toISOString(),
      fileExists: Boolean(filePath && fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile())
    };
  });
}

function validateItem(item) {
  const requiredFields = [
    ['project', '项目'],
    ['responsibleDepartment', '责任部门'],
    ['location', '问题位置 / 区域'],
    ['title', '问题标题'],
    ['description', '问题描述'],
    ['requirement', '整改要求'],
    ['deadline', '截止日期']
  ];
  const missing = requiredFields.filter(([field]) => !item[field]).map(([, label]) => label);
  if (missing.length > 0) {
    throw new Error(`请补全必填项：${missing.join('、')}`);
  }
}

function generateRectificationNo(items, date) {
  const day = formatDay(date);
  const prefix = `ZG-${day}-`;
  const maxNo = items
    .map((item) => stringValue(item.rectificationNo))
    .filter((value) => value.startsWith(prefix))
    .map((value) => Number(value.slice(prefix.length)))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  return `${prefix}${String(maxNo + 1).padStart(3, '0')}`;
}

function createId(prefix = 'rectification') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function byUpdatedDesc(a, b) {
  return (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0);
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean);
  return String(value || '').split(/[、，,;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeKeywordsText(value) {
  return Array.isArray(value) ? value.join('、') : stringValue(value);
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDay(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function stringValue(value) {
  return String(value || '').trim();
}

module.exports = {
  STATUS_VALUES,
  exportRectificationItems,
  getRectificationPaths,
  loadRectificationItems,
  saveRectificationItem
};
