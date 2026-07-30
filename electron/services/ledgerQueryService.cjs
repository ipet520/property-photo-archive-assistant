const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { getLedgerPath, normalizeExistingLedgerRows } = require('./excelService.cjs');

const FIELD_ALIASES = {
  date: ['日期', '归档日期', '拍摄日期', '时间'],
  projectId: ['项目ID', 'projectId'],
  project: ['项目', '项目名称'],
  watermarkCategory: ['归档分类', '水印分类', '分类'],
  workContent: ['工作内容', '标准工作项'],
  location: ['位置/区域', '具体位置', '位置', '区域'],
  newFileName: ['新文件名', '归档文件名', '文件名'],
  originalName: ['原文件名', '原始文件名'],
  keywords: ['关键词', '关键字'],
  remark: ['备注'],
  archivePath: ['归档路径', '目标路径', '文件路径', '归档文件路径'],
  archivedAt: ['归档时间', '写入时间'],
  sourceType: ['来源类型', '照片来源类型'],
  sourceKey: ['来源标识', 'sourceKey'],
  photoId: ['照片ID', 'photoId'],
  sourcePath: ['来源文件路径', '原始文件路径', '原图路径', '来源路径'],
  originalPath: ['来源文件路径', '原始文件路径', '原图路径', '来源路径'],
  sourceSha256: ['来源文件SHA-256', 'sourceSha256'],
  archiveSha256: ['归档文件SHA-256', 'archiveSha256'],
  transactionId: ['归档事务ID', 'transactionId'],
  watermarkTemplateType: ['水印模板', 'watermarkTemplateType'],
  processingMode: ['识别处理方式', 'processingMode'],
  vehiclePlate: ['车牌号码', 'vehiclePlate'],
  violationType: ['违停类型', 'violationType'],
  constructionUnitId: ['施工单位ID', 'constructionUnitId'],
  constructionUnitName: ['施工单位', 'constructionUnitName'],
  constructionUnitOriginalText: ['施工单位原始文本', 'constructionUnitOriginalText'],
  constructionUnitConfirmed: ['施工单位已确认', 'constructionUnitConfirmed'],
  constructionUnitSource: ['施工单位来源', 'constructionUnitSource']
};

const EXPORT_HEADERS = [
  ['date', '日期'],
  ['projectId', '项目ID'],
  ['project', '项目'],
  ['watermarkCategory', '归档分类'],
  ['workContent', '工作内容'],
  ['location', '位置/区域'],
  ['keywords', '关键词'],
  ['remark', '备注'],
  ['originalName', '原文件名'],
  ['newFileName', '新文件名'],
  ['archivePath', '归档文件路径'],
  ['sourceType', '来源类型'],
  ['sourceKey', '来源标识'],
  ['photoId', '照片ID'],
  ['sourcePath', '来源文件路径'],
  ['sourceSha256', '来源文件SHA-256'],
  ['archiveSha256', '归档文件SHA-256'],
  ['transactionId', '归档事务ID'],
  ['watermarkTemplateType', '水印模板'],
  ['processingMode', '识别处理方式'],
  ['vehiclePlate', '车牌号码'],
  ['violationType', '违停类型'],
  ['constructionUnitId', '施工单位ID'],
  ['constructionUnitName', '施工单位'],
  ['constructionUnitOriginalText', '施工单位原始文本'],
  ['constructionUnitConfirmed', '施工单位已确认'],
  ['constructionUnitSource', '施工单位来源'],
  ['fileStatus', '文件状态']
];

const SAFE_ARCHIVE_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.heic'
]);

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

async function loadProjectLedgerRecordsAcrossRoots(
  archiveRoots,
  activeProject,
  options = {}
) {
  const roots = uniquePaths(archiveRoots);
  const projectId = String(activeProject?.projectId || '').trim();
  const projectName = normalizeProjectName(activeProject?.projectName);
  if (!projectId || !projectName) throw new TypeError('当前项目无效。');
  const loader = options.loadLedgerRecords || loadLedgerRecords;
  const records = [];
  const ledgerPaths = [];
  let failedCount = 0;
  for (const archiveRoot of roots) {
    try {
      const result = await loader(archiveRoot);
      if (result?.ledgerPath) ledgerPaths.push(result.ledgerPath);
      for (const record of result?.records || []) {
        const matchesProject = record.projectId
          ? String(record.projectId).trim() === projectId
          : normalizeProjectName(record.project) === projectName;
        if (!matchesProject) continue;
        records.push({
          ...record,
          id: `${Buffer.from(archiveRoot).toString('base64url')}:${record.rowNumber}`,
          archiveRoot,
          archiveDirectory: record.archiveDirectory
            || path.dirname(record.archivePath || archiveRoot)
        });
      }
    } catch {
      failedCount += 1;
    }
  }
  return {
    success: true,
    archiveRoots: roots,
    ledgerPaths,
    missingLedger: ledgerPaths.length === 0 || records.length === 0,
    records,
    failedCount
  };
}

function normalizeLedgerRow(row, index, archiveRoot) {
  const sourceRow = repairCurrentRowUnderLegacyHeaders(row);
  const record = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    record[field] = pickField(sourceRow, aliases);
  });

  const archivePath = record.archivePath || inferArchivePath(archiveRoot, record.newFileName);
  const fileExists = Boolean(archivePath && fs.existsSync(archivePath) && fs.statSync(archivePath).isFile());

  return {
    id: `ledger-${index + 1}`,
    rowNumber: index + 2,
    ...record,
    date: normalizeDate(record.date),
    archiveRoot,
    archiveDirectory: archivePath ? path.dirname(archivePath) : '',
    archivePath,
    fileExists,
    fileStatus: archivePath ? (fileExists ? '文件存在' : '文件缺失') : '文件缺失',
    previewUrl: fileExists ? `local-photo://image/${encodeURIComponent(archivePath)}` : ''
  };
}

function repairCurrentRowUnderLegacyHeaders(row = {}) {
  if (String(row['归档路径'] || '').trim() || !looksLikeArchivePath(row['处理状态'])) return row;
  return {
    日期: row['日期'],
    项目: row['项目'],
    归档分类: row['部门'],
    工作内容: row['照片来源'],
    具体位置: row['水印分类'],
    新文件名: row['工作内容'],
    原文件名: row['具体位置'],
    关键词: row['工作事项'],
    备注: row['照片阶段'],
    归档路径: row['处理状态'],
    归档时间: row['新文件名']
  };
}

function looksLikeArchivePath(value = '') {
  const text = String(value || '').trim();
  return path.isAbsolute(text) && SAFE_ARCHIVE_IMAGE_EXTENSIONS.has(path.extname(text).toLowerCase());
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

function normalizeProjectName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniquePaths(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, value) => {
    const text = String(value || '').trim();
    if (!text) return result;
    const normalized = path.resolve(text);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
}

async function exportLedgerRecords(filePath, records = []) {
  const rows = [
    EXPORT_HEADERS.map(([, header]) => header),
    ...records.map((record) => EXPORT_HEADERS.map(([field]) => record[field] || ''))
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = EXPORT_HEADERS.map(([, header]) => ({ wch: Math.max(header.length + 8, 16) }));
  XLSX.utils.book_append_sheet(workbook, sheet, '归档记录查询结果');
  XLSX.writeFile(workbook, filePath);
  return { success: true, filePath };
}

async function deleteLedgerRecords(archiveRoot, selections = [], options = {}) {
  if (!archiveRoot) throw new Error('请先选择归档根目录');
  if (!Array.isArray(selections) || selections.length === 0) throw new Error('请先选择需要删除的归档记录');

  const ledgerPath = getLedgerPath(archiveRoot);
  if (!fs.existsSync(ledgerPath)) throw new Error('当前归档目录下未找到照片归档台账');

  const current = await loadLedgerRecords(archiveRoot);
  const selectedRecords = validateSelections(current.records, selections);
  const workbook = XLSX.readFile(ledgerPath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('照片归档台账中没有可用工作表');

  const backupPath = backupLedger(archiveRoot, ledgerPath);
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const removedIndexes = new Set(selectedRecords.map((record) => record.rowNumber - 1));
  const nextRows = normalizeExistingLedgerRows(
    rows.filter((_row, index) => !removedIndexes.has(index))
  );
  const nextSheet = XLSX.utils.aoa_to_sheet(nextRows);
  nextSheet['!cols'] = nextRows[0].map((header) => ({ wch: Math.max(String(header).length + 8, 16) }));
  workbook.Sheets[sheetName] = nextSheet;

  const temporaryPath = `${ledgerPath}.delete-${Date.now()}.tmp`;
  try {
    XLSX.writeFile(workbook, temporaryPath, { bookType: 'xlsx' });
    fs.copyFileSync(temporaryPath, ledgerPath);
  } catch (error) {
    try {
      if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, ledgerPath);
    } catch {
      // The dated backup remains available for manual recovery.
    }
    throw new Error(`更新台账失败：${error.message}`);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // A stale temporary file does not change the committed ledger result.
    }
  }

  const fileResult = options.deleteFiles
    ? deleteSelectedArchiveFiles(archiveRoot, ledgerPath, selectedRecords)
    : { deletedFileCount: 0, missingFileCount: 0, failedCount: 0, notes: ['仅删除归档记录，归档照片文件已保留。'] };

  return {
    success: true,
    selectedCount: selectedRecords.length,
    deletedRecordCount: selectedRecords.length,
    backupPath,
    ...fileResult
  };
}

function validateSelections(records, selections) {
  const uniqueRows = new Set();
  return selections.map((selection) => {
    const rowNumber = Number(selection?.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || uniqueRows.has(rowNumber)) {
      throw new Error('选中的归档记录标识无效，请重新加载台账后再试');
    }
    uniqueRows.add(rowNumber);
    const record = records.find((item) => item.rowNumber === rowNumber);
    if (!record) throw new Error('台账内容已变化，请重新加载台账后再试');
    if (selection.newFileName && selection.newFileName !== record.newFileName) {
      throw new Error('台账内容已变化，请重新加载台账后再试');
    }
    if (selection.archivePath && normalizePath(selection.archivePath) !== normalizePath(record.archivePath)) {
      throw new Error('台账路径已变化，请重新加载台账后再试');
    }
    return record;
  });
}

function backupLedger(archiveRoot, ledgerPath) {
  const backupDirectory = path.join(archiveRoot, '台账备份');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const timestamp = formatTimestamp(new Date());
  const backupPath = path.join(backupDirectory, `照片归档台账_${timestamp}.xlsx`);
  try {
    fs.copyFileSync(ledgerPath, backupPath, fs.constants.COPYFILE_EXCL);
    return backupPath;
  } catch (error) {
    throw new Error(`备份台账失败：${error.message}`);
  }
}

function deleteSelectedArchiveFiles(archiveRoot, ledgerPath, records) {
  const result = { deletedFileCount: 0, missingFileCount: 0, failedCount: 0, notes: [] };
  records.forEach((record) => {
    const archivePath = String(record.archivePath || '').trim();
    if (!archivePath) {
      result.missingFileCount += 1;
      result.notes.push(`${record.newFileName || record.originalName || `第 ${record.rowNumber} 行`}：未找到归档文件路径`);
      return;
    }
    const safety = validateArchiveFilePath(archiveRoot, ledgerPath, archivePath, record.originalPath);
    if (!safety.safe) {
      result.failedCount += 1;
      result.notes.push(`${record.newFileName || record.originalName || `第 ${record.rowNumber} 行`}：${safety.reason}`);
      return;
    }
    if (!fs.existsSync(safety.filePath)) {
      result.missingFileCount += 1;
      result.notes.push(`${record.newFileName || record.originalName || `第 ${record.rowNumber} 行`}：归档文件不存在`);
      return;
    }
    try {
      const stat = fs.statSync(safety.filePath);
      if (!stat.isFile()) throw new Error('目标不是文件，已拒绝删除');
      const realRoot = fs.realpathSync(archiveRoot);
      const realFile = fs.realpathSync(safety.filePath);
      if (!isPathInside(realRoot, realFile)) throw new Error('归档文件位于归档根目录之外，已拒绝删除');
      fs.unlinkSync(safety.filePath);
      result.deletedFileCount += 1;
    } catch (error) {
      result.failedCount += 1;
      result.notes.push(`${record.newFileName || record.originalName || `第 ${record.rowNumber} 行`}：${error.message}`);
    }
  });
  if (result.notes.length === 0) result.notes.push('选中的归档记录及对应归档文件已删除。');
  return result;
}

function validateArchiveFilePath(archiveRoot, ledgerPath, archivePath, originalPath) {
  const root = path.resolve(archiveRoot);
  const filePath = path.resolve(archivePath);
  if (!isPathInside(root, filePath)) return { safe: false, reason: '归档文件路径不在当前归档根目录内，已拒绝删除' };
  if (normalizePath(filePath) === normalizePath(ledgerPath)) return { safe: false, reason: '目标是归档台账，已拒绝删除' };
  if (originalPath && normalizePath(filePath) === normalizePath(originalPath)) return { safe: false, reason: '归档路径与原始照片路径相同，已拒绝删除' };
  if (!SAFE_ARCHIVE_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return { safe: false, reason: '目标不是受支持的归档照片文件，已拒绝删除' };
  }
  return { safe: true, filePath };
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizePath(value) {
  return path.resolve(String(value || '')).toLowerCase();
}

function formatTimestamp(date) {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`;
}

module.exports = {
  deleteLedgerRecords,
  exportLedgerRecords,
  loadLedgerRecords,
  loadProjectLedgerRecordsAcrossRoots
};
