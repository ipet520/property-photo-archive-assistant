const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const MAX_RENDER_WAIT_MS = 10000;

async function exportServiceBriefImages(targetRoot, payload = {}) {
  if (!targetRoot) throw new Error('请选择每日服务简报图片导出目录');
  if (!Array.isArray(payload.pages) || payload.pages.length === 0) {
    throw new Error('当前没有可导出的图片内容，请检查事项和照片选择。');
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const folderName = sanitizeFileName(payload.folderName || `每日服务简报图片_${formatDate(new Date())}`);
  const packageDir = createUniqueDirectory(path.join(targetRoot, folderName));
  const captionText = String(payload.captionText || '').trim();
  const captionPath = path.join(packageDir, '配图文案.txt');
  fs.writeFileSync(captionPath, captionText || '暂无配图文案。', 'utf8');

  const exportedFiles = [];
  const renderWindow = new BrowserWindow({
    show: false,
    width: 1080,
    height: 1440,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  try {
    for (const [index, page] of payload.pages.entries()) {
      const width = clampNumber(page.width, 720, 1600, 1080);
      const height = clampNumber(page.height, 900, 5000, 1440);
      const html = String(page.html || '').trim();
      if (!html) throw new Error('缺少图片模板内容');

      renderWindow.setContentSize(width, height);
      await renderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await waitForImages(renderWindow);
      const image = await renderWindow.webContents.capturePage({ x: 0, y: 0, width, height });
      const fileName = sanitizeFileName(page.fileName || `每日服务简报_${String(index + 1).padStart(3, '0')}.png`);
      const normalizedFileName = fileName.toLowerCase().endsWith('.png') ? fileName : `${fileName}.png`;
      const filePath = path.join(packageDir, normalizedFileName);
      fs.writeFileSync(filePath, image.toPNG());
      exportedFiles.push({ fileName: normalizedFileName, filePath });
    }
  } catch (error) {
    try {
      fs.rmSync(packageDir, { recursive: true, force: true });
    } catch {
      // keep original rendering error visible
    }
    throw error;
  } finally {
    if (!renderWindow.isDestroyed()) renderWindow.destroy();
  }

  return {
    success: true,
    packageDir,
    captionPath,
    imageCount: exportedFiles.length,
    exportedFiles
  };
}

async function waitForImages(renderWindow) {
  const script = `
    new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ timeout: true }), ${MAX_RENDER_WAIT_MS});
      const finish = () => {
        clearTimeout(timeout);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ok: true })));
      };
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.catch(() => null).finally(() => {
          const images = Array.from(document.images || []);
          if (images.length === 0) {
            finish();
            return;
          }
          let remaining = images.length;
          const done = () => {
            remaining -= 1;
            if (remaining <= 0) finish();
          };
          images.forEach((image) => {
            if (image.complete) done();
            else {
              image.addEventListener('load', done, { once: true });
              image.addEventListener('error', done, { once: true });
            }
          });
        });
      } else {
        finish();
      }
    })
  `;
  await renderWindow.webContents.executeJavaScript(script, true);
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function sanitizeFileName(value) {
  return String(value || '每日服务简报图片')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '每日服务简报图片';
}

function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

module.exports = {
  exportServiceBriefImages
};
