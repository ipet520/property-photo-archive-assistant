const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');

const LEDGER_FILE_NAME = '照片归档台账.xlsx';
const LEDGER_HEADERS = [
  '日期',
  '项目',
  '部门',
  '照片来源',
  '水印分类',
  '工作内容',
  '具体位置',
  '工作事项',
  '照片阶段',
  '处理状态',
  '新文件名',
  '原文件名',
  '关键词',
  '备注',
  '归档路径',
  '归档时间'
];

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

  if (rows.length === 0) {
    rows.push(LEDGER_HEADERS);
  }

  const dataRows = archiveResults.map((item) => [
    item.date,
    item.project,
    item.department,
    item.photoSource,
    item.watermarkCategory,
    item.workContent,
    item.location,
    item.workItem,
    item.photoStage,
    item.processStatus,
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

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { appendLedgerRows, getLedgerPath };
