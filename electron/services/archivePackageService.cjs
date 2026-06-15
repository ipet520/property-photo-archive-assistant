const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const CATALOG_HEADERS = [
  ['index', '序号'],
  ['date', '日期'],
  ['project', '项目'],
  ['department', '部门'],
  ['photoSource', '照片来源'],
  ['watermarkCategory', '水印分类'],
  ['workContent', '工作内容'],
  ['location', '位置 / 区域'],
  ['itemName', '事项名称'],
  ['photoStage', '照片阶段'],
  ['processStatus', '处理状态'],
  ['keywords', '关键词'],
  ['remark', '备注'],
  ['originalName', '原文件名'],
  ['newFileName', '新文件名'],
  ['packageRelativePath', '资料包内相对路径'],
  ['archivePath', '原归档文件路径'],
  ['fileStatus', '文件状态'],
  ['exportResult', '导出结果']
];

function buildPackagePlan(records = [], targetRoot = '') {
  if (!targetRoot) {
    throw new Error('请选择资料包保存位置');
  }
  const safeRecords = Array.isArray(records) ? records : [];
  const timestamp = formatTimestamp(new Date());
  const projectNames = Array.from(new Set(safeRecords.map((record) => cleanValue(record.project)).filter(Boolean)));
  const projectPart = projectNames.length === 1 ? `_${sanitizePathSegment(projectNames[0])}` : '';
  const baseName = sanitizePathSegment(`物业照片资料包${projectPart}_${timestamp}`);
  const packagePath = getUniqueDirectoryPath(path.join(targetRoot, baseName));
  const existsCount = safeRecords.filter((record) => resolveSourcePath(record)).length;
  const missingCount = safeRecords.length - existsCount;

  return {
    success: true,
    targetRoot,
    packageName: path.basename(packagePath),
    packagePath,
    total: safeRecords.length,
    existsCount,
    missingCount,
    groupingRule: '项目 / 水印分类 / 工作内容'
  };
}

async function generateArchivePackage(records = [], options = {}) {
  const targetRoot = options.targetRoot || '';
  if (!targetRoot) {
    throw new Error('请选择资料包保存位置');
  }

  const safeRecords = Array.isArray(records) ? records : [];
  if (safeRecords.length === 0) {
    throw new Error('当前没有可生成资料包的记录');
  }

  const plan = options.packagePath
    ? { packagePath: getUniqueDirectoryPath(options.packagePath), packageName: path.basename(options.packagePath) }
    : buildPackagePlan(safeRecords, targetRoot);

  const packagePath = plan.packagePath;
  const photosRoot = path.join(packagePath, '01_照片资料');
  const catalogRoot = path.join(packagePath, '02_资料目录');
  fs.mkdirSync(photosRoot, { recursive: true });
  fs.mkdirSync(catalogRoot, { recursive: true });

  const catalogRows = [];
  let copiedCount = 0;
  let missingCount = 0;
  let failedCount = 0;

  for (const [index, record] of safeRecords.entries()) {
    const sourcePath = resolveSourcePath(record);
    const row = {
      index: index + 1,
      ...record,
      packageRelativePath: '',
      fileStatus: sourcePath ? '文件存在' : '文件缺失',
      exportResult: sourcePath ? '待复制' : '文件缺失'
    };

    if (!sourcePath) {
      missingCount += 1;
      catalogRows.push(row);
      if (typeof options.onProgress === 'function') {
        options.onProgress({ current: index + 1, total: safeRecords.length });
      }
      continue;
    }

    try {
      const groupDir = path.join(
        photosRoot,
        sanitizePathSegment(record.project || '未分类'),
        sanitizePathSegment(record.watermarkCategory || '未分类'),
        sanitizePathSegment(record.workContent || '未分类')
      );
      fs.mkdirSync(groupDir, { recursive: true });
      const preferredName = sanitizeFileName(record.newFileName || record.originalName || path.basename(sourcePath));
      const targetPath = getUniqueFilePath(path.join(groupDir, preferredName || path.basename(sourcePath)));
      fs.copyFileSync(sourcePath, targetPath);
      copiedCount += 1;
      row.packageRelativePath = path.relative(packagePath, targetPath);
      row.exportResult = '已复制';
    } catch (error) {
      failedCount += 1;
      row.exportResult = `复制失败：${error.message}`;
    }
    catalogRows.push(row);
    if (typeof options.onProgress === 'function') {
      options.onProgress({ current: index + 1, total: safeRecords.length });
    }
  }

  const catalogPath = path.join(catalogRoot, '资料包目录.xlsx');
  writeCatalog(catalogPath, catalogRows);
  const readmePath = path.join(packagePath, '资料包说明.txt');
  writePackageReadme(readmePath, {
    packageName: path.basename(packagePath),
    generatedAt: formatDateTime(new Date()),
    total: safeRecords.length,
    copiedCount,
    missingCount,
    failedCount
  });

  return {
    success: true,
    packagePath,
    catalogPath,
    readmePath,
    total: safeRecords.length,
    copiedCount,
    missingCount,
    failedCount
  };
}

function resolveSourcePath(record = {}) {
  const archivePath = cleanValue(record.archivePath);
  if (archivePath && fs.existsSync(archivePath) && fs.statSync(archivePath).isFile()) {
    return archivePath;
  }
  return '';
}

function writeCatalog(catalogPath, catalogRows) {
  const rows = [
    CATALOG_HEADERS.map(([, header]) => header),
    ...catalogRows.map((record) => CATALOG_HEADERS.map(([field]) => record[field] || ''))
  ];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  sheet['!cols'] = CATALOG_HEADERS.map(([field, header]) => ({
    wch: ['packageRelativePath', 'archivePath', 'exportResult'].includes(field) ? 36 : Math.max(header.length + 8, 14)
  }));
  XLSX.utils.book_append_sheet(workbook, sheet, '资料包目录');
  XLSX.writeFile(workbook, catalogPath);
}

function writePackageReadme(readmePath, summary) {
  const content = [
    `资料包名称：${summary.packageName}`,
    `生成时间：${summary.generatedAt}`,
    `记录总数：${summary.total}`,
    `成功复制数量：${summary.copiedCount}`,
    `文件缺失数量：${summary.missingCount}`,
    `复制失败数量：${summary.failedCount}`,
    '',
    '来源说明：来自物业工作照片归档助手归档台账。',
    '安全说明：本次操作仅复制照片，不移动、不删除、不压缩原始照片或归档照片，不修改原始台账。'
  ].join('\r\n');
  fs.writeFileSync(readmePath, content, 'utf-8');
}

function getUniqueDirectoryPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  let index = 1;
  let nextPath = `${basePath}_${String(index).padStart(3, '0')}`;
  while (fs.existsSync(nextPath)) {
    index += 1;
    nextPath = `${basePath}_${String(index).padStart(3, '0')}`;
  }
  return nextPath;
}

function getUniqueFilePath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  let index = 1;
  let nextPath = path.join(parsed.dir, `${parsed.name}_${String(index).padStart(3, '0')}${parsed.ext}`);
  while (fs.existsSync(nextPath)) {
    index += 1;
    nextPath = path.join(parsed.dir, `${parsed.name}_${String(index).padStart(3, '0')}${parsed.ext}`);
  }
  return nextPath;
}

function sanitizePathSegment(value) {
  const cleaned = cleanValue(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || '未分类';
}

function sanitizeFileName(value) {
  const cleaned = cleanValue(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || '';
}

function cleanValue(value) {
  return String(value || '').trim();
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { buildPackagePlan, generateArchivePackage };
