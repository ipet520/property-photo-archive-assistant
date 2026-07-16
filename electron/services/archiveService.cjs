const fs = require('node:fs/promises');
const path = require('node:path');
const dayjs = require('dayjs');
const { appendLedgerRows } = require('./excelService.cjs');
const { recordArchivedPhotoFingerprints } = require('./archiveFingerprintService.cjs');

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

async function buildArchivePreview(payload) {
  const { form, photos, archiveRoot } = payload;
  validatePreviewPayload(form, photos, archiveRoot);

  const previewItems = [];
  const reservedPaths = new Set();
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const item = mergePhotoOverrides(form, photo);
    const targetDirectory = buildTargetDirectory(archiveRoot, item);
    const newFileName = buildFileName(item, photo.extension, index + 1);
    const targetPath = await resolveUniquePath(path.join(targetDirectory, newFileName), reservedPaths);
    reservedPaths.add(normalizePathKey(targetPath));

    previewItems.push({
      id: photo.id,
      index: index + 1,
      sourcePath: photo.path || photo.sourcePath,
      originalName: photo.name || photo.originalName,
      previewUrl: photo.previewUrl,
      extension: photo.extension,
      newFileName: path.basename(targetPath),
      targetDirectory,
      targetPath,
      status: '待归档',
      error: '',
      ...item
    });
  }
  return previewItems;
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

  const successfulResults = results.filter((item) => item.status === '归档成功');
  let fingerprintIndexWarning = '';
  if (successfulResults.length > 0) {
    await appendLedgerRows(archivePlan.archiveRoot, successfulResults);
    try {
      await recordArchivedPhotoFingerprints(archivePlan.archiveRoot, successfulResults);
    } catch (error) {
      fingerprintIndexWarning = `照片已归档，但内容指纹索引更新失败：${error.message}`;
      console.warn(`[archive-fingerprint] ${fingerprintIndexWarning}`);
    }
  }

  return {
    success: results.every((item) => item.status === '归档成功'),
    total: results.length,
    successCount: results.filter((item) => item.status === '归档成功').length,
    failedCount: results.filter((item) => item.status === '归档失败').length,
    fingerprintIndexWarning,
    items: results
  };
}

function validatePreviewPayload(form, photos, archiveRoot) {
  if (!String(archiveRoot || '').trim()) throw new Error('请先选择归档根目录');
  if (!Array.isArray(photos) || photos.length === 0) throw new Error('请先扫描照片');
  if (!String(form?.project || '').trim()) throw new Error('请选择项目');
  if (!String(form?.watermarkCategory || '').trim()) throw new Error('请选择归档分类');
  if (!String(form?.workContent || '').trim()) throw new Error('请选择工作内容');
  if (!String(form?.date || '').trim()) throw new Error('请选择日期');
}

function mergePhotoOverrides(form, photo) {
  const item = {
    ...form,
    project: photo.project || form.project,
    watermarkCategory: photo.watermarkCategory || form.watermarkCategory,
    workContent: photo.workContent || form.workContent,
    location: photo.location ?? form.location,
    date: photo.date || form.date,
    keywords: photo.keywords ?? form.keywords,
    remark: photo.remark ?? form.remark
  };
  return normalizeArchiveItem(item);
}

function normalizeArchiveItem(item) {
  const location = String(item.location || '').trim() || '现场';
  return {
    ...item,
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
    sanitizeSegment(item.watermarkCategory, 40),
    sanitizeSegment(item.workContent, 50),
    sanitizeSegment(`${item.date}_${item.location}`, 90)
  );
}

function buildFileName(item, extension, index) {
  const parts = [
    item.date,
    item.workContent,
    item.location,
    String(index).padStart(3, '0')
  ];
  const baseName = truncateFileName(parts.map((part) => sanitizeSegment(part, 45)).join('_'), 120);
  return `${baseName}${extension}`;
}

function sanitizeSegment(value, maxLength = 80) {
  const text = String(value || '').replace(ILLEGAL_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return truncateFileName(text || '未填写', maxLength);
}

function truncateFileName(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
}

async function resolveUniquePath(targetPath, reservedPaths = new Set()) {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let counter = 1;

  while (reservedPaths.has(normalizePathKey(candidate)) || await exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}_${String(counter).padStart(2, '0')}${parsed.ext}`);
    counter += 1;
  }

  return candidate;
}

function normalizePathKey(targetPath) {
  return path.resolve(targetPath).toLowerCase();
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
