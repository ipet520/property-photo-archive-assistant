const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { getLedgerPath } = require('./excelService.cjs');

const FIELD_ALIASES = {
  date: ['日期', '归档日期', '拍摄日期', '时间'],
  project: ['项目', '项目名称'],
  department: ['部门'],
  photoSource: ['照片来源', '来源'],
  watermarkCategory: ['水印分类', '分类'],
  workContent: ['工作内容', '标准工作项'],
  location: ['位置/区域', '具体位置', '位置', '区域'],
  itemName: ['事项名称', '工作事项', '事项'],
  photoStage: ['照片阶段', '阶段'],
  processStatus: ['处理状态', '状态'],
  newFileName: ['新文件名', '归档文件名', '文件名'],
  originalName: ['原文件名', '原始文件名'],
  keywords: ['关键词', '关键字'],
  remark: ['备注'],
  archivePath: ['归档路径', '目标路径', '文件路径', '归档文件路径'],
  archivedAt: ['归档时间', '写入时间'],
  originalPath: ['原始文件路径', '原图路径', '来源路径']
};

async function loadLedgerRecords(archiveRoot) {
  if (!archiveRoot) {
    throw new Error('请先选择归档根目录');
  }

  const ledgerPath = getLedgerPath(archiveRoot);
  if (!fs.existsSync(ledgerPath)) {
    return {
      success: true,
      missingLedger: true,
      ledgerPath,
      archiveRoot,
      records: []
    };
  }

  const workbook = XLSX.readFile(ledgerPath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { success: true, ledgerPath, archiveRoot, records: [] };
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const records = rows.map((row, index) => normalizeLedgerRow(row, index, archiveRoot));

  return {
    success: true,
    missingLedger: false,
    ledgerPath,
    archiveRoot,
    records
  };
}

function normalizeLedgerRow(row, index, archiveRoot) {
  const record = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    record[field] = pickField(row, aliases);
  });

  const archivePath = record.archivePath || inferArchivePath(archiveRoot, record.newFileName);
  const fileExists = Boolean(archivePath && fs.existsSync(archivePath) && fs.statSync(archivePath).isFile());

  return {
    id: `ledger-${index + 1}`,
    rowNumber: index + 2,
    ...record,
    date: normalizeDate(record.date),
    archivePath,
    fileExists,
    fileStatus: archivePath ? (fileExists ? '文件存在' : '文件缺失') : '文件缺失',
    previewUrl: fileExists ? `local-photo://image/${encodeURIComponent(archivePath)}` : ''
  };
}

function pickField(row, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) {
      return String(row[alias] ?? '').trim();
    }
  }
  return '';
}

function inferArchivePath(archiveRoot, newFileName) {
  if (!archiveRoot || !newFileName) return '';
  const directPath = path.join(archiveRoot, newFileName);
  return directPath;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = { loadLedgerRecords };
