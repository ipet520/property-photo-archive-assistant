const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { nativeImage } = require('electron');

const DEFAULT_CROP_AREA = {
  xPercent: 0,
  yPercent: 0.65,
  widthPercent: 1,
  heightPercent: 0.35
};

async function cropWatermarkRegion(photo = {}, options = {}) {
  const sourcePath = normalizePhotoPath(photo);
  const cropArea = normalizeCropArea(options.cropArea || options.watermarkCrop || DEFAULT_CROP_AREA);
  if (!sourcePath) return createCropFailure(sourcePath, cropArea, '未选择图片。');
  try {
    await fs.access(sourcePath);
  } catch {
    return createCropFailure(sourcePath, cropArea, '图片不存在或无法访问。');
  }

  try {
    const image = nativeImage.createFromPath(sourcePath);
    const size = image.getSize();
    if (!size.width || !size.height || image.isEmpty()) {
      return createCropFailure(sourcePath, cropArea, '图片加载失败或格式不支持。');
    }
    const rect = {
      x: clampInt(size.width * cropArea.xPercent, 0, size.width - 1),
      y: clampInt(size.height * cropArea.yPercent, 0, size.height - 1),
      width: clampInt(size.width * cropArea.widthPercent, 1, size.width),
      height: clampInt(size.height * cropArea.heightPercent, 1, size.height)
    };
    if (rect.x + rect.width > size.width) rect.width = size.width - rect.x;
    if (rect.y + rect.height > size.height) rect.height = size.height - rect.y;

    const cropped = image.crop(rect);
    if (cropped.isEmpty()) return createCropFailure(sourcePath, cropArea, '水印区域裁剪失败。');
    const outputDir = path.join(String(options.userDataDir || process.cwd()), 'ocr-crops');
    await fs.mkdir(outputDir, { recursive: true });
    const croppedPath = path.join(outputDir, `watermark-${crypto.randomUUID()}.png`);
    await fs.writeFile(croppedPath, cropped.toPNG());
    return {
      success: true,
      sourcePath,
      croppedPath,
      croppedPreviewUrl: pathToFileURL(croppedPath).href,
      cropArea,
      imageSize: size,
      croppedSize: cropped.getSize(),
      error: null
    };
  } catch (error) {
    return createCropFailure(sourcePath, cropArea, error.message || '水印区域裁剪失败。');
  }
}

function createCropFailure(sourcePath, cropArea, error) {
  return {
    success: false,
    sourcePath: String(sourcePath || ''),
    croppedPath: '',
    cropArea: cropArea || null,
    error: String(error || '水印区域裁剪失败。')
  };
}

function normalizePhotoPath(photo = {}) {
  return String(photo.croppedPath || photo.originalPath || photo.filePath || photo.path || '').trim();
}

function normalizeCropArea(area = {}) {
  const next = {
    xPercent: normalizePercent(area.xPercent, DEFAULT_CROP_AREA.xPercent),
    yPercent: normalizePercent(area.yPercent, DEFAULT_CROP_AREA.yPercent),
    widthPercent: normalizePercent(area.widthPercent, DEFAULT_CROP_AREA.widthPercent),
    heightPercent: normalizePercent(area.heightPercent, DEFAULT_CROP_AREA.heightPercent)
  };
  if (next.xPercent + next.widthPercent > 1) next.widthPercent = 1 - next.xPercent;
  if (next.yPercent + next.heightPercent > 1) next.heightPercent = 1 - next.yPercent;
  return next;
}

function normalizePercent(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

module.exports = {
  DEFAULT_CROP_AREA,
  cropWatermarkRegion
};
