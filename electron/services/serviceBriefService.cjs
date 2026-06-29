const fs = require('node:fs');
const path = require('node:path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

function exportServiceBriefPackage(targetRoot, payload = {}) {
  if (!targetRoot) throw new Error('请选择图文简报导出目录');
  if (!payload.html) throw new Error('缺少图文简报 HTML 内容');
  if (!Array.isArray(payload.images)) throw new Error('缺少展示照片清单');
  fs.mkdirSync(targetRoot, { recursive: true });

  const folderName = sanitizeFileName(payload.folderName || `每日服务简报_${formatDate(new Date())}`);
  const packageDir = createUniqueDirectory(path.join(targetRoot, folderName));
  const imagesDir = path.join(packageDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const copiedImages = [];
  const skippedImages = [];
  payload.images.forEach((image, index) => {
    const sourcePath = String(image.sourcePath || '').trim();
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      skippedImages.push({ sourcePath, reason: '照片文件缺失' });
      return;
    }
    const stat = fs.statSync(sourcePath);
    const ext = path.extname(sourcePath).toLowerCase();
    if (!stat.isFile() || !IMAGE_EXTENSIONS.has(ext)) {
      skippedImages.push({ sourcePath, reason: '不是可导出的图片文件' });
      return;
    }
    const fileName = `${String(index + 1).padStart(3, '0')}${ext || '.jpg'}`;
    const targetPath = path.join(imagesDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);
    copiedImages.push({
      id: image.id,
      sourcePath,
      fileName,
      relativePath: `images/${fileName}`
    });
  });

  if (copiedImages.length === 0) {
    fs.rmSync(packageDir, { recursive: true, force: true });
    throw new Error('没有可导出的展示照片，请至少选择一张存在的照片');
  }

  const html = replaceImagePlaceholders(String(payload.html), copiedImages);
  const htmlPath = path.join(packageDir, 'index.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  return {
    success: true,
    packageDir,
    htmlPath,
    imageCount: copiedImages.length,
    skippedCount: skippedImages.length,
    skippedImages
  };
}

function replaceImagePlaceholders(html, images) {
  let nextHtml = html;
  images.forEach((image) => {
    if (!image.id) return;
    nextHtml = nextHtml.replaceAll(`__IMAGE_${image.id}__`, image.relativePath);
  });
  return nextHtml;
}

function createUniqueDirectory(baseDir) {
  let candidate = baseDir;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${baseDir}_${index}`;
    index += 1;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

function sanitizeFileName(value) {
  return String(value || '每日服务简报')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '每日服务简报';
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

module.exports = {
  exportServiceBriefPackage
};
