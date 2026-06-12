const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function scanImages(folderPath) {
  if (!folderPath) {
    throw new Error('请先选择照片文件夹');
  }

  const files = [];
  await walk(folderPath, files);

  return files
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
    .map((file, index) => ({
      id: `${Date.now()}-${index}`,
      name: file.name,
      path: file.path,
      extension: file.extension,
      size: file.size,
      modifiedAt: file.modifiedAt,
      previewUrl: `local-photo://image/${encodeURIComponent(file.path)}`
    }));
}

async function walk(currentPath, files) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }

    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;

    const stat = await fs.stat(fullPath);
    files.push({
      name: entry.name,
      path: fullPath,
      extension,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    });
  }
}

module.exports = { scanImages };
