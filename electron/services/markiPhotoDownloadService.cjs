const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  buildMarkiSourceKey,
  getMarkiImportRoot,
  getMarkiSourceRecordByKey,
  prepareMarkiSourceForRedownload,
  updateMarkiSourceImportStatus,
  upsertMarkiSourceRecords
} = require('./markiSourceManifestService.cjs');

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;
const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const downloadQueues = new Map();

class MarkiPhotoDownloadError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MarkiPhotoDownloadError';
    this.code = code;
    this.httpStatus = options.httpStatus || null;
  }
}

async function downloadMarkiPhoto(documentsPath, input = {}, options = {}) {
  const identifiers = normalizeDownloadIdentifiers(input);
  const sourceKey = buildMarkiSourceKey(identifiers.orgId, identifiers.momentId);
  const manifestService = resolveManifestService(options);
  return withDownloadLock(sourceKey, async () => {
    await runManifestOperation(
      () => manifestService.upsertMarkiSourceRecords(documentsPath, identifiers.orgId, [{
        momentId: identifiers.momentId,
        teamId: identifiers.teamId,
        uid: input.uid,
        postTime: input.postTime,
        markName: input.markName
      }]),
      'marki_manifest_access_failed',
      '来源清单更新失败，请重试。'
    );

    const importRoot = getMarkiImportRoot(documentsPath);
    let quarantinedPath = '';
    let repairImportedFile = false;
    let record = await runManifestOperation(
      () => manifestService.getMarkiSourceRecordByKey(documentsPath, identifiers.orgId, sourceKey),
      'marki_manifest_access_failed',
      '来源清单读取失败，请重试。'
    );
    if (record.importStatus === 'imported') {
      try {
        await verifyImportedFile(importRoot, record, options);
        return buildImportedResult(importRoot, record, true);
      } catch (error) {
        if (
          options.allowImportedRedownload !== true
          || error?.code === 'imported_file_path_invalid'
        ) {
          throw error;
        }
        const prepared = await runManifestOperation(
          () => manifestService.prepareMarkiSourceForRedownload(
            documentsPath,
            identifiers.orgId,
            sourceKey,
            options
          ),
          'marki_manifest_access_failed',
          '来源清单无法进入重新下载状态，请重试。'
        );
        repairImportedFile = true;
        record = prepared.record;
      }
    }
    if (['repair_required', 'repairing', 'repair_failed'].includes(record.importStatus)) {
      repairImportedFile = true;
    }

    const paths = repairImportedFile
      ? buildRepairDownloadPaths(importRoot, record)
      : buildDownloadPaths(importRoot, identifiers);
    await runManifestOperation(
      () => manifestService.updateMarkiSourceImportStatus(
        documentsPath,
        identifiers.orgId,
        sourceKey,
        repairImportedFile ? 'repairing' : 'downloading',
        {},
        options
      ),
      'marki_manifest_access_failed',
      '来源清单更新失败，请重试。'
    );

    let inspectedFile;
    let reusedExisting = true;
    try {
      await fs.mkdir(paths.directoryPath, { recursive: true });
      await fs.rm(paths.partPath, { force: true });
      inspectedFile = repairImportedFile
        ? null
        : await inspectExistingFile(paths.finalPath, options);
      if (!inspectedFile) {
        reusedExisting = false;
        const url = normalizeDownloadUrl(input.url);
        await downloadToPartFile(url, paths.partPath, options);
        inspectedFile = await inspectJpegFile(paths.partPath, options);
        if (repairImportedFile) {
          quarantinedPath = await replaceImportedFileAtomically(
            paths.partPath,
            paths.finalPath,
            options
          );
        } else {
          await renamePartFile(paths.partPath, paths.finalPath);
        }
      }
    } catch (error) {
      await fs.rm(paths.partPath, { force: true }).catch(() => {});
      const safeError = toSafeDownloadError(error);
      await runManifestOperation(
        () => manifestService.updateMarkiSourceImportStatus(
          documentsPath,
          identifiers.orgId,
          sourceKey,
          repairImportedFile ? 'repair_failed' : 'download_failed',
          { error: safeError },
          options
        ),
        'marki_manifest_access_failed',
        '照片处理失败，但来源清单更新失败，请重试。'
      );
      throw new MarkiPhotoDownloadError(safeError.code, safeError.message, {
        httpStatus: safeError.httpStatus
      });
    }

    await fs.rm(paths.partPath, { force: true }).catch(() => {});
    try {
      record = await runManifestOperation(
        () => markImported(
          documentsPath,
          identifiers.orgId,
          sourceKey,
          paths,
          inspectedFile,
          options,
          manifestService
        ),
        'marki_manifest_commit_failed',
        '照片文件已下载完成，但来源清单更新失败，请重试以恢复记录。'
      );
    } catch (error) {
      if (repairImportedFile) {
        await rollbackImportedFileReplacement(paths.finalPath, quarantinedPath);
        await runManifestOperation(
          () => manifestService.updateMarkiSourceImportStatus(
            documentsPath,
            identifiers.orgId,
            sourceKey,
            'repair_failed',
            {
              error: {
                code: 'marki_manifest_commit_failed',
                message: '新文件已验证，但来源记录提交失败，可重新修复。'
              }
            },
            options
          ),
          'marki_manifest_access_failed',
          '旧文件已恢复，但来源清单无法记录修复失败，请重试。'
        ).catch(() => {});
      }
      throw error;
    }
    await cleanupQuarantinedFiles(paths.finalPath, quarantinedPath);
    return buildImportedResult(importRoot, record, reusedExisting);
  });
}

async function verifyImportedFile(importRoot, record, options) {
  const downloadInfo = record?.downloadInfo;
  if (!downloadInfo) {
    throw new MarkiPhotoDownloadError(
      'imported_file_integrity_failed',
      '已导入的马克照片文件记录不完整，请人工核查。'
    );
  }
  const localPath = resolveImportedFilePath(importRoot, downloadInfo.relativePath);
  let inspected;
  try {
    inspected = await inspectJpegFile(localPath, options);
  } catch {
    throw new MarkiPhotoDownloadError(
      'imported_file_integrity_failed',
      '已导入的马克照片文件未通过完整性校验，请人工核查。'
    );
  }
  if (
    inspected.size !== downloadInfo.size
    || inspected.width !== downloadInfo.width
    || inspected.height !== downloadInfo.height
    || inspected.sha256 !== downloadInfo.sha256
  ) {
    throw new MarkiPhotoDownloadError(
      'imported_file_integrity_failed',
      '已导入的马克照片文件与来源记录不一致，请人工核查。'
    );
  }
  return inspected;
}

async function replaceImportedFileAtomically(partPath, finalPath, options = {}) {
  let stat;
  try {
    stat = await fs.stat(finalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await renamePartFile(partPath, finalPath);
      return '';
    }
    throw new MarkiPhotoDownloadError(
      'imported_file_quarantine_failed',
      '旧下载缓存无法安全检查，请人工核查。'
    );
  }
  if (!stat.isFile()) {
    throw new MarkiPhotoDownloadError(
      'imported_file_quarantine_failed',
      '旧下载缓存不是普通文件，请人工核查。'
    );
  }
  const suffix = typeof options.randomUUID === 'function'
    ? options.randomUUID()
    : crypto.randomUUID();
  const quarantinePath = `${finalPath}.invalid-${suffix}`;
  let oldFileMoved = false;
  try {
    await fs.rename(finalPath, quarantinePath);
    oldFileMoved = true;
    await fs.rename(partPath, finalPath);
  } catch {
    if (oldFileMoved) {
      try {
        await fs.rename(quarantinePath, finalPath);
      } catch {
        throw new MarkiPhotoDownloadError(
          'imported_file_replace_failed',
          '新旧下载缓存切换失败，请人工核查。'
        );
      }
    }
    throw new MarkiPhotoDownloadError(
      'imported_file_replace_failed',
      '新下载缓存无法安全替换旧文件，请重试。'
    );
  }
  return quarantinePath;
}

async function rollbackImportedFileReplacement(finalPath, quarantinedPath = '') {
  await fs.rm(finalPath, { force: true }).catch(() => {});
  if (!quarantinedPath) return;
  try {
    await fs.rename(quarantinedPath, finalPath);
  } catch {
    throw new MarkiPhotoDownloadError(
      'imported_file_rollback_failed',
      '来源记录更新失败，旧下载缓存也无法恢复，请人工核查。'
    );
  }
}

function resolveImportedFilePath(importRoot, relativePath) {
  const normalizedRelativePath = String(relativePath || '').replaceAll('\\', '/');
  if (!normalizedRelativePath || path.isAbsolute(normalizedRelativePath)) {
    throw new MarkiPhotoDownloadError(
      'imported_file_path_invalid',
      '已导入照片的缓存位置无效，请人工核查。'
    );
  }
  const root = path.resolve(importRoot);
  const localPath = path.resolve(root, ...normalizedRelativePath.split('/'));
  const relative = path.relative(root, localPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MarkiPhotoDownloadError(
      'imported_file_path_invalid',
      '已导入照片的缓存位置无效，请人工核查。'
    );
  }
  return localPath;
}

async function cleanupQuarantinedFiles(finalPath, preferredPath = '') {
  const directoryPath = path.dirname(finalPath);
  const prefix = `${path.basename(finalPath)}.invalid-`;
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => fs.rm(path.join(directoryPath, entry.name), { force: true })));
  } catch {
    if (preferredPath) {
      await fs.rm(preferredPath, { force: true }).catch(() => {});
    }
  }
}

async function retryMarkiPhotoDownload(documentsPath, input = {}, options = {}) {
  const identifiers = normalizeDownloadIdentifiers(input);
  const sourceKey = buildMarkiSourceKey(identifiers.orgId, identifiers.momentId);
  const manifestService = resolveManifestService(options);
  const record = await runManifestOperation(
    () => manifestService.getMarkiSourceRecordByKey(documentsPath, identifiers.orgId, sourceKey),
    'marki_manifest_access_failed',
    '来源清单读取失败，请重试。'
  );
  if (!record || ![
    'download_failed',
    'downloading',
    'repair_required',
    'repairing',
    'repair_failed'
  ].includes(record.importStatus)) {
    throw new MarkiPhotoDownloadError(
      'invalid_retry_state',
      '只有下载失败或中断的马克照片可以重试。'
    );
  }
  return downloadMarkiPhoto(documentsPath, input, options);
}

async function markImported(
  documentsPath,
  orgId,
  sourceKey,
  paths,
  inspectedFile,
  options,
  manifestService
) {
  const importRoot = getMarkiImportRoot(documentsPath);
  const result = await manifestService.updateMarkiSourceImportStatus(
    documentsPath,
    orgId,
    sourceKey,
    'imported',
    {
      downloadInfo: {
        relativePath: path.relative(importRoot, paths.finalPath).replaceAll('\\', '/'),
        fileName: path.basename(paths.finalPath),
        size: inspectedFile.size,
        width: inspectedFile.width,
        height: inspectedFile.height,
        sha256: inspectedFile.sha256,
        completedAt: resolveNow(options).toISOString()
      }
    },
    options
  );
  return result.record;
}

async function downloadToPartFile(url, partPath, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new MarkiPhotoDownloadError('network_unavailable', '当前运行环境无法下载马克照片。');
  }
  const timeoutMs = normalizePositiveOption(
    options.timeoutMs,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    'invalid_download_timeout'
  );
  const maxImageBytes = normalizePositiveOption(
    options.maxImageBytes,
    DEFAULT_MAX_IMAGE_BYTES,
    'invalid_max_image_size'
  );
  const maxRedirects = normalizeNonNegativeOption(
    options.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    'invalid_redirect_limit'
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let handle;
  try {
    const response = await fetchWithManualRedirects(
      fetchImpl,
      url,
      controller.signal,
      maxRedirects
    );
    if (!response || response.ok !== true) {
      const status = Number(response?.status) || 0;
      throw new MarkiPhotoDownloadError(
        'download_http_error',
        status > 0 ? `马克照片下载失败（HTTP ${status}）。` : '马克照片下载请求失败。',
        { httpStatus: status || null }
      );
    }
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
      throw new MarkiPhotoDownloadError('download_too_large', '马克照片文件超过允许的大小。');
    }
    if (!response.body) {
      throw new MarkiPhotoDownloadError('download_empty', '马克照片下载结果为空。');
    }

    try {
      handle = await fs.open(partPath, 'wx');
    } catch {
      throw new MarkiPhotoDownloadError('download_io_error', '马克照片文件写入失败，请重试。');
    }
    let writtenBytes = 0;
    const iteratorFactory = response.body[Symbol.asyncIterator];
    if (typeof iteratorFactory !== 'function') {
      throw new MarkiPhotoDownloadError('download_request_failed', '马克照片下载响应无法读取，请重试。');
    }
    const iterator = iteratorFactory.call(response.body);
    while (true) {
      const next = await readResponseChunk(iterator);
      if (next.done) break;
      const buffer = Buffer.from(next.value);
      writtenBytes += buffer.length;
      if (writtenBytes > maxImageBytes) {
        throw new MarkiPhotoDownloadError('download_too_large', '马克照片文件超过允许的大小。');
      }
      try {
        await writeBuffer(handle, buffer);
      } catch (error) {
        if (error instanceof MarkiPhotoDownloadError) throw error;
        throw new MarkiPhotoDownloadError('download_io_error', '马克照片文件写入失败，请重试。');
      }
    }
    try {
      await handle.sync();
      await handle.close();
      handle = null;
    } catch {
      throw new MarkiPhotoDownloadError('download_io_error', '马克照片文件写入失败，请重试。');
    }
    if (writtenBytes === 0) {
      throw new MarkiPhotoDownloadError('download_empty', '马克照片下载结果为空。');
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.name === 'AbortError') {
      throw new MarkiPhotoDownloadError('download_timeout', '马克照片下载超时，请重试。');
    }
    if (error instanceof MarkiPhotoDownloadError) throw error;
    throw new MarkiPhotoDownloadError('download_request_failed', '马克照片下载请求失败，请重试。');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithManualRedirects(fetchImpl, initialUrl, signal, maxRedirects) {
  let currentUrl = normalizeDownloadUrl(initialUrl);
  let redirectCount = 0;
  while (true) {
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: {
          accept: 'image/jpeg,image/*;q=0.8'
        },
        redirect: 'manual',
        signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new MarkiPhotoDownloadError('download_timeout', '马克照片下载超时，请重试。');
      }
      throw new MarkiPhotoDownloadError('download_request_failed', '马克照片下载请求失败，请重试。');
    }
    if (!REDIRECT_STATUSES.has(Number(response?.status))) return response;
    if (redirectCount >= maxRedirects) {
      throw new MarkiPhotoDownloadError(
        'marki_redirect_limit_exceeded',
        '马克照片下载重定向次数超过限制。'
      );
    }
    const location = String(response.headers?.get?.('location') || '').trim();
    if (!location) {
      throw new MarkiPhotoDownloadError(
        'marki_redirect_location_invalid',
        '马克照片下载重定向地址无效。'
      );
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new MarkiPhotoDownloadError(
        'marki_redirect_location_invalid',
        '马克照片下载重定向地址无效。'
      );
    }
    if (nextUrl.protocol !== 'https:') {
      throw new MarkiPhotoDownloadError(
        'marki_redirect_protocol_not_allowed',
        '马克照片下载重定向协议不受支持。'
      );
    }
    currentUrl = nextUrl.toString();
    redirectCount += 1;
  }
}

async function readResponseChunk(iterator) {
  try {
    return await iterator.next();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new MarkiPhotoDownloadError('download_timeout', '马克照片下载超时，请重试。');
    }
    throw new MarkiPhotoDownloadError('download_request_failed', '马克照片下载连接中断，请重试。');
  }
}

async function inspectExistingFile(finalPath, options) {
  try {
    return await inspectJpegFile(finalPath, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof MarkiPhotoDownloadError) {
      throw new MarkiPhotoDownloadError(
        'target_file_conflict',
        '目标位置已存在无法通过校验的文件，未执行覆盖。'
      );
    }
    throw error;
  }
}

async function inspectJpegFile(filePath, options = {}) {
  const maxImageBytes = normalizePositiveOption(
    options.maxImageBytes,
    DEFAULT_MAX_IMAGE_BYTES,
    'invalid_max_image_size'
  );
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new MarkiPhotoDownloadError('download_empty', '马克照片文件为空。');
  }
  if (stat.size > maxImageBytes) {
    throw new MarkiPhotoDownloadError('download_too_large', '马克照片文件超过允许的大小。');
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new MarkiPhotoDownloadError('invalid_jpeg_header', '下载文件不是有效的 JPG 图片。');
  }
  const dimensions = readJpegDimensions(buffer);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new MarkiPhotoDownloadError('invalid_jpeg_dimensions', '无法读取下载图片的宽高。');
  }
  const decoded = await decodeJpegBuffer(buffer, options);
  if (
    decoded
    && (
      decoded.width <= 0
      || decoded.height <= 0
      || decoded.width !== dimensions.width
      || decoded.height !== dimensions.height
    )
  ) {
    throw new MarkiPhotoDownloadError('invalid_jpeg_dimensions', '下载图片无法通过真实解码校验。');
  }
  return {
    size: stat.size,
    width: dimensions.width,
    height: dimensions.height,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

async function decodeJpegBuffer(buffer, options = {}) {
  let decoder = typeof options.decodeImage === 'function' ? options.decodeImage : null;
  if (!decoder) {
    try {
      const { nativeImage } = require('electron');
      if (nativeImage && typeof nativeImage.createFromBuffer === 'function') {
        decoder = (value) => {
          const image = nativeImage.createFromBuffer(value);
          if (!image || image.isEmpty()) return null;
          return image.getSize();
        };
      }
    } catch {
      decoder = null;
    }
  }
  if (!decoder) return null;
  try {
    const result = await decoder(buffer, { extension: '.jpg' });
    return {
      width: Number(result?.width) || 0,
      height: Number(result?.height) || 0
    };
  } catch {
    return { width: 0, height: 0 };
  }
}

function readJpegDimensions(buffer) {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += segmentLength;
  }
  return null;
}

async function writeBuffer(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) {
      throw new MarkiPhotoDownloadError('download_io_error', '马克照片文件写入失败，请重试。');
    }
    offset += bytesWritten;
  }
}

async function renamePartFile(partPath, finalPath) {
  try {
    await fs.rename(partPath, finalPath);
  } catch {
    throw new MarkiPhotoDownloadError('download_io_error', '马克照片文件保存失败，请重试。');
  }
}

function buildDownloadPaths(importRoot, identifiers) {
  const directoryPath = path.join(
    importRoot,
    identifiers.orgId,
    identifiers.teamId,
    identifiers.shootDate
  );
  const fileName = `${identifiers.momentId}.jpg`;
  const finalPath = path.join(directoryPath, fileName);
  return {
    directoryPath,
    finalPath,
    partPath: `${finalPath}.part`
  };
}

function buildRepairDownloadPaths(importRoot, record) {
  const finalPath = resolveImportedFilePath(importRoot, record?.downloadInfo?.relativePath);
  return {
    directoryPath: path.dirname(finalPath),
    finalPath,
    partPath: `${finalPath}.part`
  };
}

function normalizeDownloadIdentifiers(input) {
  const orgId = String(input.orgId || '').trim();
  const momentId = String(input.momentId ?? input.id ?? '').trim();
  const teamId = String(input.teamId || '').trim();
  if (!/^\d+$/.test(orgId)) {
    throw new MarkiPhotoDownloadError('invalid_org_id', '组织 ID 必须为数字。');
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(momentId)) {
    throw new MarkiPhotoDownloadError('invalid_moment_id', '照片来源 ID 无效。');
  }
  if (!/^\d+$/.test(teamId)) {
    throw new MarkiPhotoDownloadError('invalid_team_id', '团队 ID 必须为数字。');
  }
  return {
    orgId,
    momentId,
    teamId,
    shootDate: normalizeShootDate(input.shootDate, input.postTime)
  };
}

function normalizeShootDate(value, postTime) {
  const text = String(value || '').trim();
  if (text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new MarkiPhotoDownloadError('invalid_shoot_date', '照片日期格式必须为 YYYY-MM-DD。');
    }
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
      throw new MarkiPhotoDownloadError('invalid_shoot_date', '照片日期无效。');
    }
    return text;
  }
  const timestamp = Number(postTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new MarkiPhotoDownloadError('invalid_shoot_date', '缺少可用的照片日期。');
  }
  return new Date((Math.floor(timestamp) + 8 * 60 * 60) * 1000).toISOString().slice(0, 10);
}

function normalizeDownloadUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new MarkiPhotoDownloadError('invalid_download_url', '马克照片下载地址无效。');
  }
  if (url.protocol !== 'https:') {
    throw new MarkiPhotoDownloadError('invalid_download_url', '马克照片下载地址必须使用 HTTPS。');
  }
  return url.toString();
}

function normalizePositiveOption(value, fallback, errorCode) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new MarkiPhotoDownloadError(errorCode, '下载参数无效。');
  }
  return number;
}

function normalizeNonNegativeOption(value, fallback, errorCode) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new MarkiPhotoDownloadError(errorCode, '下载参数无效。');
  }
  return number;
}

function toSafeDownloadError(error) {
  if (error instanceof MarkiPhotoDownloadError) {
    return {
      code: error.code,
      message: error.message,
      at: new Date().toISOString(),
      httpStatus: error.httpStatus
    };
  }
  return {
    code: 'download_io_error',
    message: '马克照片文件写入失败，请重试。',
    at: new Date().toISOString(),
    httpStatus: null
  };
}

function resolveManifestService(options = {}) {
  const overrides = options.manifestService || {};
  return {
    getMarkiSourceRecordByKey: typeof overrides.getMarkiSourceRecordByKey === 'function'
      ? overrides.getMarkiSourceRecordByKey
      : getMarkiSourceRecordByKey,
    prepareMarkiSourceForRedownload: typeof overrides.prepareMarkiSourceForRedownload === 'function'
      ? overrides.prepareMarkiSourceForRedownload
      : prepareMarkiSourceForRedownload,
    updateMarkiSourceImportStatus: typeof overrides.updateMarkiSourceImportStatus === 'function'
      ? overrides.updateMarkiSourceImportStatus
      : updateMarkiSourceImportStatus,
    upsertMarkiSourceRecords: typeof overrides.upsertMarkiSourceRecords === 'function'
      ? overrides.upsertMarkiSourceRecords
      : upsertMarkiSourceRecords
  };
}

async function runManifestOperation(action, code, message) {
  try {
    return await action();
  } catch {
    throw new MarkiPhotoDownloadError(code, message);
  }
}

function buildImportedResult(importRoot, record, reusedExisting) {
  const downloadInfo = record.downloadInfo;
  const localPath = resolveImportedFilePath(importRoot, downloadInfo.relativePath);
  return {
    success: true,
    sourceKey: record.sourceKey,
    importStatus: record.importStatus,
    localPath,
    relativePath: downloadInfo.relativePath,
    fileName: downloadInfo.fileName,
    size: downloadInfo.size,
    width: downloadInfo.width,
    height: downloadInfo.height,
    sha256: downloadInfo.sha256,
    completedAt: downloadInfo.completedAt,
    downloadAttemptCount: record.downloadAttemptCount,
    reusedExisting
  };
}

function resolveNow(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MarkiPhotoDownloadError('invalid_current_time', '无法生成下载记录时间。');
  }
  return date;
}

function withDownloadLock(sourceKey, action) {
  const previous = downloadQueues.get(sourceKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  downloadQueues.set(sourceKey, current);
  return current.finally(() => {
    if (downloadQueues.get(sourceKey) === current) {
      downloadQueues.delete(sourceKey);
    }
  });
}

module.exports = {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_REDIRECTS,
  MarkiPhotoDownloadError,
  downloadMarkiPhoto,
  inspectJpegFile,
  readJpegDimensions,
  retryMarkiPhotoDownload
};
