const fs = require('node:fs/promises');
const path = require('node:path');
const dayjs = require('dayjs');
const { appendLedgerRows } = require('./excelService.cjs');

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

async function buildArchivePreview(payload) {
  const { form, photos, archiveRoot } = payload;
  validatePreviewPayload(form, photos, archiveRoot);

  return photos.map((photo, index) => {
    const item = mergePhotoOverrides(form, photo);
    const targetDirectory = buildTargetDirectory(archiveRoot, item);
    const newFileName = buildFileName(item, photo.extension, index + 1);

    return {
      id: photo.id,
      index: index + 1,
      sourcePath: photo.path || photo.sourcePath,
      originalName: photo.name || photo.originalName,
      previewUrl: photo.previewUrl,
      extension: photo.extension,
      newFileName,
      targetDirectory,
      targetPath: path.join(targetDirectory, newFileName),
      status: '待归档',
      error: '',
      ...item
    };
  });
}

async function archivePhotos(archivePlan) {
  if (!archivePlan?.archiveRoot) {
    throw new Error('缺少归档根目录');
  }
  if (!Array.isArray(archivePlan.items) || archivePlan.items.length === 0) {
    throw new Error('没有可归档的照片');
  }

  const archivedAt = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const results = [];

  for (const item of archivePlan.items) {
    try {
      await fs.mkdir(item.targetDirectory, { recursive: true });
      const finalTargetPath = await resolveUniquePath(item.targetPath);
      await fs.copyFile(item.sourcePath, finalTargetPath);

      const finalFileName = path.basename(finalTargetPath);
      results.push({
        ...item,
        newFileName: finalFileName,
        targetPath: finalTargetPath,
        status: '归档成功',
        error: '',
        archivedAt
      });
    } catch (error) {
      results.push({
        ...item,
        status: '归档失败',
        error: error.message,
        archivedAt
      });
    }
  }

  await appendLedgerRows(archivePlan.archiveRoot, results);

  return {
    success: results.every((item) => item.status === '归档成功'),
    total: results.length,
    successCount: results.filter((item) => item.status === '归档成功').length,
    failedCount: results.filter((item) => item.status === '归档失败').length,
    items: results
  };
}

function validatePreviewPayload(form, photos, archiveRoot) {
  if (!String(archiveRoot || '').trim()) throw new Error('请先选择归档根目录');
  if (!Array.isArray(photos) || photos.length === 0) throw new Error('请先扫描照片');
  if (!String(form?.project || '').trim()) throw new Error('请选择项目');
  if (!String(form?.department || '').trim()) throw new Error('请选择部门');
  if (!String(form?.photoSource || '').trim()) throw new Error('请选择照片来源');
  if (!String(form?.watermarkCategory || '').trim()) throw new Error('请选择水印分类');
  if (!String(form?.workContent || '').trim()) throw new Error('请选择工作内容');
  if (!String(form?.date || '').trim()) throw new Error('请选择日期');
  if (!String(form?.photoStage || '').trim()) throw new Error('请选择照片阶段');
}

function mergePhotoOverrides(form, photo) {
  const item = {
    ...form,
    photoStage: photo.photoStage || form.photoStage,
    keywords: photo.keywords ?? form.keywords,
    remark: photo.remark ?? form.remark
  };
  return normalizeArchiveItem(item);
}

function normalizeArchiveItem(item) {
  const workContent = String(item.workContent || '').trim();
  const workItem = String(item.workItem || '').trim() || workContent;
  const location = String(item.location || '').trim() || '现场';
  return {
    ...item,
    workItem,
    location
  };
}

function buildTargetDirectory(archiveRoot, item) {
  const date = dayjs(item.date);
  return path.join(
    archiveRoot,
    sanitizeSegment(item.project, 40),
    date.format('YYYY'),
    `${date.format('MM')}月`,
    sanitizeSegment(item.department, 20),
    sanitizeSegment(item.watermarkCategory, 40),
    sanitizeSegment(item.workContent, 50),
    sanitizeSegment(`${item.date}_${item.location}_${item.workItem}`, 90),
    sanitizeSegment(item.photoStage, 30)
  );
}

function buildFileName(item, extension, index) {
  const parts = [
    item.date,
    item.project,
    item.watermarkCategory,
    item.workContent,
    item.location,
    item.workItem,
    item.photoStage,
    String(index).padStart(3, '0')
  ];
  const baseName = truncateFileName(parts.map((part) => sanitizeSegment(part, 45)).join('_'), 150);
  return `${baseName}${extension}`;
}

function sanitizeSegment(value, maxLength = 80) {
  const text = String(value || '').replace(ILLEGAL_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return truncateFileName(text || '未填写', maxLength);
}

function truncateFileName(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
}

async function resolveUniquePath(targetPath) {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let counter = 1;

  while (await exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}_${String(counter).padStart(2, '0')}${parsed.ext}`);
    counter += 1;
  }

  return candidate;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { buildArchivePreview, archivePhotos };
