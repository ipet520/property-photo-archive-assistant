const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { loadLedgerRecords } = require('./ledgerQueryService.cjs');

const APP_FOLDER_NAMES = [
  '物业工作照片归档助手',
  '鐗╀笟宸ヤ綔鐓х墖褰掓。鍔╂墜'
];

const RECTIFICATION_FILE_NAME = 'rectification-items.json';

async function loadSummaryData({ archiveRoot, documentsPath, projectRoot }) {
  const ledgerResult = archiveRoot
    ? await loadLedgerRecords(archiveRoot)
    : { success: true, missingLedger: true, ledgerPath: '', archiveRoot: '', records: [] };
  const rectificationResult = loadRectificationItemsReadonly({ documentsPath, projectRoot });

  return {
    success: true,
    loadedAt: new Date().toISOString(),
    archiveRoot: ledgerResult.archiveRoot || archiveRoot || '',
    ledgerPath: ledgerResult.ledgerPath || '',
    missingLedger: Boolean(ledgerResult.missingLedger),
    photoRecords: Array.isArray(ledgerResult.records) ? ledgerResult.records : [],
    rectificationItems: rectificationResult.items,
    rectificationSourcePath: rectificationResult.sourcePath,
    rectificationMissing: rectificationResult.missing,
    rectificationError: rectificationResult.error || ''
  };
}

function loadRectificationItemsReadonly({ documentsPath, projectRoot }) {
  const candidates = getRectificationCandidates({ documentsPath, projectRoot });
  const sourcePath = candidates.find((filePath) => fs.existsSync(filePath));
  if (!sourcePath) {
    return { missing: true, sourcePath: '', items: [] };
  }

  try {
    const content = fs.readFileSync(sourcePath, 'utf-8');
    const payload = JSON.parse(content);
    const rawItems = Array.isArray(payload) ? payload : (Array.isArray(payload.items) ? payload.items : []);
    return {
      missing: false,
      sourcePath,
      items: rawItems.map((item, index) => normalizeRectificationItem(item, index)).sort(byUpdatedDesc)
    };
  } catch (error) {
    return { missing: false, sourcePath, items: [], error: error.message };
  }
}

function getRectificationCandidates({ documentsPath, projectRoot }) {
  const candidates = [];
  if (documentsPath) {
    APP_FOLDER_NAMES.forEach((folderName) => {
      candidates.push(path.join(documentsPath, folderName, 'rectification', RECTIFICATION_FILE_NAME));
    });
  }
  if (projectRoot) {
    candidates.push(path.join(projectRoot, 'rectification', RECTIFICATION_FILE_NAME));
  }
  return Array.from(new Set(candidates));
}

function normalizeRectificationItem(item = {}, index = 0) {
  const photos = normalizePhotos(item.photos);
  return {
    id: stringValue(item.id) || `rectification-${index + 1}`,
    rectificationNo: stringValue(item.rectificationNo),
    createdAt: stringValue(item.createdAt),
    updatedAt: stringValue(item.updatedAt),
    createdDate: normalizeDate(item.createdAt || item.updatedAt || item.deadline),
    project: stringValue(item.project),
    responsibleDepartment: stringValue(item.responsibleDepartment || item.department),
    watermarkCategory: stringValue(item.watermarkCategory),
    workContent: stringValue(item.workContent),
    location: stringValue(item.location),
    title: stringValue(item.title),
    description: stringValue(item.description),
    requirement: stringValue(item.requirement),
    deadline: normalizeDate(item.deadline),
    status: stringValue(item.status) || '待整改',
    owner: stringValue(item.owner),
    keywords: Array.isArray(item.keywords) ? item.keywords.join('、') : stringValue(item.keywords),
    remark: stringValue(item.remark),
    closeNote: stringValue(item.closeNote),
    closedAt: stringValue(item.closedAt),
    photos,
    beforeCount: photos.before.length,
    duringCount: photos.during.length,
    afterCount: photos.after.length,
    totalPhotoCount: photos.before.length + photos.during.length + photos.after.length,
    sourceRecords: Array.isArray(item.sourceRecords) ? item.sourceRecords : []
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
  return (Array.isArray(photos) ? photos : []).map((photo, index) => {
    const filePath = stringValue(photo.filePath || photo.archivePath || photo.path);
    const fileExists = Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
    return {
      id: stringValue(photo.id) || `photo-${index + 1}`,
      filePath,
      fileName: stringValue(photo.fileName || path.basename(filePath || '')),
      stage: stringValue(photo.stage),
      sourceType: stringValue(photo.sourceType),
      addedAt: stringValue(photo.addedAt),
      fileExists
    };
  });
}

async function exportSummaryWorkbook(filePath, payload = {}) {
  if (!filePath) {
    return { success: false, message: '请选择导出文件保存位置。' };
  }

  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, '汇总总览', payload.overviewRows || []);
  appendObjectSheet(workbook, '分类汇总', payload.categorySummary || []);
  appendObjectSheet(workbook, '项目汇总', payload.projectSummary || []);
  appendObjectSheet(workbook, '部门汇总', payload.departmentSummary || []);
  appendObjectSheet(workbook, '整改汇总', payload.rectificationSummary || []);
  appendObjectSheet(workbook, '照片明细', payload.photoDetails || []);
  appendObjectSheet(workbook, '整改明细', payload.rectificationDetails || []);

  XLSX.writeFile(workbook, filePath);
  return { success: true, filePath };
}

function appendSheet(workbook, sheetName, rows) {
  const normalizedRows = Array.isArray(rows) && rows.length > 0 ? rows : [['说明', '当前没有可导出的数据']];
  const sheet = XLSX.utils.aoa_to_sheet(normalizedRows);
  sheet['!cols'] = buildColumnWidths(normalizedRows);
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
}

function appendObjectSheet(workbook, sheetName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    appendSheet(workbook, sheetName, [['说明'], ['当前没有可导出的数据']]);
    return;
  }
  const headers = Object.keys(rows[0]);
  const aoaRows = [
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ];
  appendSheet(workbook, sheetName, aoaRows);
}

function buildColumnWidths(rows) {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return Array.from({ length: columnCount }, (_, index) => {
    const maxLength = rows.reduce((max, row) => {
      const value = String(row[index] ?? '');
      return Math.max(max, value.length);
    }, 8);
    return { wch: Math.min(Math.max(maxLength + 4, 12), 48) };
  });
}

function byUpdatedDesc(a, b) {
  return (Date.parse(b.updatedAt || b.createdAt || b.deadline || '') || 0)
    - (Date.parse(a.updatedAt || a.createdAt || a.deadline || '') || 0);
}

function normalizeDate(value) {
  const text = stringValue(value);
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function stringValue(value) {
  return String(value ?? '').trim();
}

module.exports = {
  exportSummaryWorkbook,
  loadSummaryData
};
