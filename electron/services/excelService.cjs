const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');

const LEDGER_FILE_NAME = '照片归档台账.xlsx';
const LEDGER_HEADERS = [
  '日期',
  '项目',
  '归档分类',
  '工作内容',
  '具体位置',
  '新文件名',
  '原文件名',
  '关键词',
  '备注',
  '归档路径',
  '归档时间'
];

const LEDGER_HEADER_ALIASES = {
  日期: ['日期', '归档日期', '拍摄日期', '时间'],
  项目: ['项目', '项目名称'],
  归档分类: ['归档分类', '水印分类', '分类'],
  工作内容: ['工作内容', '标准工作项'],
  具体位置: ['具体位置', '位置/区域', '位置', '区域'],
  新文件名: ['新文件名', '归档文件名', '文件名'],
  原文件名: ['原文件名', '原始文件名'],
  关键词: ['关键词', '关键字'],
  备注: ['备注'],
  归档路径: ['归档路径', '目标路径', '文件路径', '归档文件路径'],
  归档时间: ['归档时间', '写入时间']
};

function getLedgerPath(archiveRoot) {
  return path.join(archiveRoot || '', LEDGER_FILE_NAME);
}

async function appendLedgerRows(archiveRoot, archiveResults) {
  const ledgerPath = getLedgerPath(archiveRoot);
  await fs.mkdir(archiveRoot, { recursive: true });

  let workbook;
  let rows = [];

  if (await exists(ledgerPath)) {
    workbook = XLSX.readFile(ledgerPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  } else {
    workbook = XLSX.utils.book_new();
  }

  rows = normalizeExistingLedgerRows(rows);

  const dataRows = archiveResults.map((item) => [
    item.date,
    item.project,
    item.watermarkCategory,
    item.workContent,
    item.location,
    item.newFileName,
    item.originalName,
    item.keywords,
    item.remark,
    item.targetPath,
    item.archivedAt
  ]);

  rows.push(...dataRows);

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = LEDGER_HEADERS.map((header) => ({ wch: Math.max(header.length + 8, 16) }));
  workbook.Sheets = { 照片归档台账: sheet };
  workbook.SheetNames = ['照片归档台账'];
  XLSX.writeFile(workbook, ledgerPath);

  return ledgerPath;
}

function normalizeExistingLedgerRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [LEDGER_HEADERS];
  const sourceHeaders = rows[0].map((header) => String(header || '').trim());
  const normalizedRows = rows.slice(1).map((row) => {
    if (isCurrentRowUnderLegacyHeaders(sourceHeaders, row)) {
      return LEDGER_HEADERS.map((_, index) => row[index] ?? '');
    }
    return LEDGER_HEADERS.map((header) => {
      const aliases = LEDGER_HEADER_ALIASES[header] || [header];
      const sourceIndex = sourceHeaders.findIndex((sourceHeader) => aliases.includes(sourceHeader));
      return sourceIndex >= 0 ? row[sourceIndex] ?? '' : '';
    });
  });
  return [LEDGER_HEADERS, ...normalizedRows];
}

function isCurrentRowUnderLegacyHeaders(headers = [], row = []) {
  if (headers.length <= LEDGER_HEADERS.length || headers.includes('归档分类')) return false;
  const legacyPathIndex = headers.indexOf('归档路径');
  const legacyStatusIndex = headers.indexOf('处理状态');
  if (legacyPathIndex < 0 || legacyStatusIndex < 0) return false;
  return !String(row[legacyPathIndex] || '').trim() && looksLikeArchivePath(row[legacyStatusIndex]);
}

function looksLikeArchivePath(value = '') {
  const text = String(value || '').trim();
  return path.isAbsolute(text) && /\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/i.test(text);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { appendLedgerRows, getLedgerPath, normalizeExistingLedgerRows };
