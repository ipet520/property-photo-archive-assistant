const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DEFAULT_MAX_DECODE_BYTES = 50 * 1024 * 1024;

async function inspectPhotoSourceFile(photoOrPath, expectedFingerprint = '', options = {}) {
  const fileSystem = options.fs || fs;
  const createReadStream = options.createReadStream || fsSync.createReadStream;
  const resolvedPath = resolvePhotoPath(photoOrPath);
  const expectedSha256 = normalizeSha256(
    expectedFingerprint
    || (photoOrPath && typeof photoOrPath === 'object' ? photoOrPath.sha256 : '')
  );
  const base = {
    resolvedPath,
    exists: false,
    isFile: false,
    readable: false,
    size: 0,
    sizeValid: false,
    width: 0,
    height: 0,
    mimeType: '',
    extensionSupported: false,
    decodable: false,
    currentSha256: '',
    expectedSha256,
    fingerprintMatches: false,
    healthStatus: 'missing',
    failureReason: '照片文件不存在。'
  };
  if (!resolvedPath) return base;

  let stat;
  try {
    stat = await fileSystem.stat(resolvedPath);
    base.exists = true;
  } catch (error) {
    if (error?.code === 'ENOENT') return base;
    return fail(base, 'unreadable', safeFileError(error));
  }
  base.isFile = stat.isFile();
  if (!base.isFile) return fail(base, 'not_file', '照片路径不是普通文件。');

  try {
    await fileSystem.access(resolvedPath, fsSync.constants.R_OK);
    base.readable = true;
  } catch (error) {
    return fail(base, 'unreadable', safeFileError(error));
  }

  base.size = Number(stat.size) || 0;
  base.sizeValid = base.size > 0;
  if (!base.sizeValid) return fail(base, 'empty', '照片文件为空。');
  const maxDecodeBytes = normalizeMaxDecodeBytes(options.maxDecodeBytes);
  if (base.size > maxDecodeBytes) {
    return fail(base, 'too_large', '照片文件超过允许的解码大小。');
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  base.extensionSupported = SUPPORTED_EXTENSIONS.has(extension);
  if (!base.extensionSupported) {
    return fail(base, 'unsupported_format', '照片格式不受支持。');
  }

  let buffer;
  try {
    buffer = await fileSystem.readFile(resolvedPath);
  } catch (error) {
    return fail(base, 'unreadable', safeFileError(error));
  }
  const structure = inspectImageStructure(buffer, extension);
  base.mimeType = structure.mimeType;
  if (!structure.decodable) return fail(base, 'decode_failed', '照片文件无法解码。');
  const decoded = await decodeImageBuffer(buffer, extension, options);
  base.decodable = decoded.decodable;
  base.width = decoded.width;
  base.height = decoded.height;
  if (!decoded.decodable) return fail(base, 'decode_failed', '照片文件无法解码。');

  try {
    base.currentSha256 = await hashFile(resolvedPath, createReadStream);
  } catch (error) {
    return fail(base, 'unreadable', safeFileError(error));
  }
  if (!expectedSha256) {
    return fail(base, 'fingerprint_unknown', '照片没有可比较的历史指纹。');
  }
  base.fingerprintMatches = base.currentSha256 === expectedSha256;
  if (!base.fingerprintMatches) {
    return fail(base, 'fingerprint_changed', '照片内容与保存时的指纹不一致。');
  }
  return {
    ...base,
    healthStatus: 'healthy',
    failureReason: ''
  };
}

function inspectImageStructure(buffer, extension) {
  if (extension === '.jpg' || extension === '.jpeg') return inspectJpeg(buffer);
  if (extension === '.png') return inspectPng(buffer);
  if (extension === '.webp') return inspectWebp(buffer);
  return { mimeType: '', decodable: false };
}

async function decodeImageBuffer(buffer, extension, options = {}) {
  const decoder = options.decodeImage || getNativeImageDecoder();
  if (typeof decoder !== 'function') {
    return { decodable: false, width: 0, height: 0 };
  }
  try {
    const result = await decoder(buffer, { extension });
    const width = Number(result?.width);
    const height = Number(result?.height);
    return {
      decodable: result?.decodable !== false && width > 0 && height > 0,
      width: width > 0 ? width : 0,
      height: height > 0 ? height : 0
    };
  } catch {
    return { decodable: false, width: 0, height: 0 };
  }
}

function getNativeImageDecoder() {
  try {
    const { nativeImage } = require('electron');
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
    return (buffer) => {
      const image = nativeImage.createFromBuffer(buffer);
      if (!image || image.isEmpty()) return { decodable: false, width: 0, height: 0 };
      const size = image.getSize();
      return {
        decodable: size.width > 0 && size.height > 0,
        width: size.width,
        height: size.height
      };
    };
  } catch {
    return null;
  }
}

function normalizeMaxDecodeBytes(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_DECODE_BYTES;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError('照片解码大小上限无效。');
  }
  return number;
}

function inspectJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { mimeType: 'image/jpeg', decodable: false };
  }
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { mimeType: 'image/jpeg', decodable: width > 0 && height > 0 };
    }
    offset += length + 2;
  }
  return { mimeType: 'image/jpeg', decodable: false };
}

function inspectPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const valid = Buffer.isBuffer(buffer)
    && buffer.length >= 24
    && buffer.subarray(0, 8).equals(signature)
    && buffer.toString('ascii', 12, 16) === 'IHDR'
    && buffer.readUInt32BE(16) > 0
    && buffer.readUInt32BE(20) > 0;
  return { mimeType: 'image/png', decodable: valid };
}

function inspectWebp(buffer) {
  const valid = Buffer.isBuffer(buffer)
    && buffer.length >= 16
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16));
  return { mimeType: 'image/webp', decodable: valid };
}

function resolvePhotoPath(photoOrPath) {
  const value = typeof photoOrPath === 'string'
    ? photoOrPath
    : photoOrPath?.originalPath || photoOrPath?.path || '';
  const text = String(value || '').trim();
  return text ? path.normalize(path.resolve(text)) : '';
}

function normalizeSha256(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function hashFile(filePath, createReadStream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function fail(base, healthStatus, failureReason) {
  return {
    ...base,
    healthStatus,
    failureReason
  };
}

function safeFileError(error) {
  const code = String(error?.code || '').trim();
  return code ? `系统错误 ${code}` : '系统拒绝读取照片文件。';
}

module.exports = {
  DEFAULT_MAX_DECODE_BYTES,
  SUPPORTED_EXTENSIONS,
  inspectPhotoSourceFile
};
