const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function scanImages(folderPath) {
  if (!folderPath) {
    throw new Error('请先选择照片文件夹');
  }

  const files = [];
  await walk(folderPath, files);

  const sortedFiles = files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  const results = [];
  for (const [index, file] of sortedFiles.entries()) {
    results.push({
      id: `${Date.now()}-${index}`,
      name: file.name,
      path: file.path,
      extension: file.extension,
      size: file.size,
      modifiedAt: file.modifiedAt,
      sha256: await hashFile(file.path),
      previewUrl: `local-photo://image/${encodeURIComponent(file.path)}`
    });
  }
  return results;
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

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { scanImages };
