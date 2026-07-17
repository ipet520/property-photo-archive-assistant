const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');

const MANIFEST_RELATIVE_PATH = 'vendor/ocr/rapidocr/runtime-manifest.json';
const FIXED_INSTALL_RELATIVE_PATH = 'vendor/ocr/rapidocr/rapidocr-runner.exe';
const MAX_REDIRECTS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STALE_LOCK_MS = 30 * 60_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUIRED_MANIFEST_FIELDS = [
  'schemaVersion',
  'component',
  'version',
  'platform',
  'arch',
  'releaseTag',
  'assetName',
  'downloadUrl',
  'sha256',
  'sizeBytes',
  'installRelativePath'
];
const activeEnsures = new Map();

class RapidOcrRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'RapidOcrRuntimeError';
    this.code = code;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message
    };
  }
}

function createRuntimeError(code, message, cause) {
  if (cause instanceof RapidOcrRuntimeError) return cause;
  return new RapidOcrRuntimeError(code, message, { cause });
}

function serializeRuntimeError(error) {
  const safeError = error instanceof RapidOcrRuntimeError
    ? error
    : createRuntimeError('rapidocr_runtime_failed', 'RapidOCR 运行时准备失败。', error);
  return safeError.toJSON();
}

function validateRuntimeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createRuntimeError('rapidocr_manifest_invalid', 'RapidOCR 运行时清单格式无效。');
  }
  const keys = Object.keys(value);
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw createRuntimeError('rapidocr_manifest_missing_field', `RapidOCR 运行时清单缺少字段：${field}。`);
    }
  }
  const unknownFields = keys.filter((key) => !REQUIRED_MANIFEST_FIELDS.includes(key));
  if (unknownFields.length > 0) {
    throw createRuntimeError('rapidocr_manifest_unknown_field', 'RapidOCR 运行时清单包含未支持字段。');
  }
  if (value.schemaVersion !== 1) {
    throw createRuntimeError('rapidocr_manifest_schema_unsupported', 'RapidOCR 运行时清单版本不受支持。');
  }
  if (value.component !== 'rapidocr-runner') {
    throw createRuntimeError('rapidocr_manifest_component_invalid', 'RapidOCR 运行时组件名称无效。');
  }
  if (!/^\d{4}\.\d+\.\d+-v\d+\.\d+\.\d+$/.test(String(value.version || ''))) {
    throw createRuntimeError('rapidocr_manifest_version_invalid', 'RapidOCR 运行时版本格式无效。');
  }
  if (value.platform !== 'win32' || value.arch !== 'x64') {
    throw createRuntimeError('rapidocr_manifest_platform_invalid', 'RapidOCR 运行时平台或架构无效。');
  }
  if (!/^rapidocr-runtime-\d{4}\.\d+\.\d+-v\d+\.\d+\.\d+$/.test(String(value.releaseTag || ''))) {
    throw createRuntimeError('rapidocr_manifest_release_tag_invalid', 'RapidOCR Release 标签格式无效。');
  }
  if (!/^rapidocr-runner-\d{4}\.\d+\.\d+-v\d+\.\d+\.\d+-win-x64\.exe$/.test(String(value.assetName || ''))) {
    throw createRuntimeError('rapidocr_manifest_asset_name_invalid', 'RapidOCR Release 资产名称无效。');
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.sha256 || ''))) {
    throw createRuntimeError('rapidocr_manifest_sha256_invalid', 'RapidOCR 运行时 SHA-256 格式无效。');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
    throw createRuntimeError('rapidocr_manifest_size_invalid', 'RapidOCR 运行时字节数无效。');
  }
  const installRelativePath = String(value.installRelativePath || '').replace(/\\/g, '/');
  if (
    path.isAbsolute(String(value.installRelativePath || ''))
    || installRelativePath !== FIXED_INSTALL_RELATIVE_PATH
    || installRelativePath.split('/').includes('..')
  ) {
    throw createRuntimeError('rapidocr_manifest_install_path_invalid', 'RapidOCR 运行时安装路径无效。');
  }
  let downloadUrl;
  try {
    downloadUrl = new URL(String(value.downloadUrl || ''));
  } catch {
    throw createRuntimeError('rapidocr_manifest_download_url_invalid', 'RapidOCR 下载地址无效。');
  }
  const expectedPath = `/ipet520/property-photo-archive-assistant/releases/download/${value.releaseTag}/${value.assetName}`;
  if (
    downloadUrl.protocol !== 'https:'
    || downloadUrl.hostname !== 'github.com'
    || downloadUrl.pathname !== expectedPath
    || downloadUrl.username
    || downloadUrl.password
    || downloadUrl.search
    || downloadUrl.hash
  ) {
    throw createRuntimeError('rapidocr_manifest_download_url_invalid', 'RapidOCR 下载地址必须是固定的公开 HTTPS Release 资产地址。');
  }
  return Object.freeze({
    ...value,
    installRelativePath
  });
}

async function loadRuntimeManifest(manifestPath) {
  let text;
  try {
    text = await fsp.readFile(manifestPath, 'utf8');
  } catch (error) {
    throw createRuntimeError('rapidocr_manifest_read_failed', '无法读取 RapidOCR 运行时清单。', error);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw createRuntimeError('rapidocr_manifest_json_invalid', 'RapidOCR 运行时清单不是有效 JSON。', error);
  }
  return validateRuntimeManifest(value);
}

function resolveInstallPath(repoRoot, manifest) {
  const root = path.resolve(repoRoot);
  const targetPath = path.resolve(root, ...manifest.installRelativePath.split('/'));
  const relative = path.relative(root, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createRuntimeError('rapidocr_manifest_install_path_invalid', 'RapidOCR 运行时安装路径越出仓库目录。');
  }
  return targetPath;
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return {
    sizeBytes,
    sha256: hash.digest('hex')
  };
}

async function verifyRunnerFile(filePath, manifest) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        valid: false,
        reasonCode: 'rapidocr_runner_missing',
        sizeBytes: 0,
        sha256: ''
      };
    }
    throw createRuntimeError('rapidocr_runner_stat_failed', '无法检查 RapidOCR runner。', error);
  }
  if (!stat.isFile()) {
    return {
      exists: true,
      valid: false,
      reasonCode: 'rapidocr_runner_not_file',
      sizeBytes: stat.size,
      sha256: ''
    };
  }
  if (stat.size !== manifest.sizeBytes) {
    return {
      exists: true,
      valid: false,
      reasonCode: 'rapidocr_runner_size_mismatch',
      sizeBytes: stat.size,
      sha256: ''
    };
  }
  let fileHash;
  try {
    fileHash = await hashFile(filePath);
  } catch (error) {
    throw createRuntimeError('rapidocr_runner_hash_failed', '无法校验 RapidOCR runner。', error);
  }
  return {
    exists: true,
    valid: fileHash.sha256 === manifest.sha256,
    reasonCode: fileHash.sha256 === manifest.sha256 ? '' : 'rapidocr_runner_hash_mismatch',
    sizeBytes: fileHash.sizeBytes,
    sha256: fileHash.sha256
  };
}

function openHttpsResponse(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      reject(createRuntimeError('rapidocr_download_url_invalid', 'RapidOCR 下载地址无效。'));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(createRuntimeError('rapidocr_download_protocol_not_allowed', 'RapidOCR 下载只允许 HTTPS。'));
      return;
    }
    const request = https.request(parsed, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'property-photo-archive-assistant-rapidocr-runtime'
      },
      signal: options.signal
    }, (response) => {
      resolve({
        statusCode: Number(response.statusCode || 0),
        headers: response.headers || {},
        stream: response
      });
    });
    request.setTimeout(options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS, () => {
      request.destroy(createRuntimeError('rapidocr_download_timeout', 'RapidOCR 下载连接超时。'));
    });
    request.on('error', (error) => {
      if (error instanceof RapidOcrRuntimeError) {
        reject(error);
      } else if (error?.name === 'AbortError' || options.signal?.aborted) {
        reject(createRuntimeError('rapidocr_download_timeout', 'RapidOCR 下载超时。', error));
      } else {
        reject(createRuntimeError('rapidocr_download_request_failed', 'RapidOCR 下载请求失败。', error));
      }
    });
    request.end();
  });
}

function discardResponseStream(stream) {
  if (!stream) return;
  if (typeof stream.resume === 'function') {
    stream.resume();
  } else if (typeof stream.destroy === 'function') {
    stream.destroy();
  }
}

async function writeVerifiedStreamToPart(stream, partPath, manifest, signal) {
  let handle;
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    handle = await fsp.open(partPath, 'wx');
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw createRuntimeError('rapidocr_download_timeout', 'RapidOCR 下载超时。');
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      if (sizeBytes > manifest.sizeBytes) {
        throw createRuntimeError('rapidocr_download_size_exceeded', 'RapidOCR 下载内容超过清单字节数。');
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
    const sha256 = hash.digest('hex');
    if (sizeBytes !== manifest.sizeBytes) {
      throw createRuntimeError('rapidocr_download_size_mismatch', 'RapidOCR 下载字节数与清单不一致。');
    }
    if (sha256 !== manifest.sha256) {
      throw createRuntimeError('rapidocr_download_hash_mismatch', 'RapidOCR 下载 SHA-256 与清单不一致。');
    }
    await handle.sync();
    return { sizeBytes, sha256 };
  } catch (error) {
    if (error instanceof RapidOcrRuntimeError) throw error;
    throw createRuntimeError('rapidocr_file_write_failed', 'RapidOCR 临时文件写入失败。', error);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The primary error is more useful than a close failure.
      }
    }
  }
}

async function downloadReleaseAsset(manifest, partPath, options = {}) {
  const requestImpl = options.requestImpl || openHttpsResponse;
  const controller = new AbortController();
  const overallTimeoutMs = options.overallTimeoutMs || DEFAULT_OVERALL_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), overallTimeoutMs);
  let currentUrl = new URL(manifest.downloadUrl);
  let redirectCount = 0;
  try {
    while (true) {
      let response;
      try {
        response = await requestImpl(currentUrl, {
          signal: controller.signal,
          connectTimeoutMs: options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
        });
      } catch (error) {
        throw createRuntimeError('rapidocr_download_request_failed', 'RapidOCR 下载请求失败。', error);
      }
      const statusCode = Number(response?.statusCode || 0);
      if (REDIRECT_STATUSES.has(statusCode)) {
        discardResponseStream(response.stream);
        redirectCount += 1;
        if (redirectCount > MAX_REDIRECTS) {
          throw createRuntimeError('rapidocr_redirect_limit_exceeded', 'RapidOCR 下载重定向次数超过限制。');
        }
        const location = Array.isArray(response.headers?.location)
          ? response.headers.location[0]
          : response.headers?.location;
        if (!location) {
          throw createRuntimeError('rapidocr_redirect_location_invalid', 'RapidOCR 下载重定向地址缺失或无效。');
        }
        let nextUrl;
        try {
          nextUrl = new URL(String(location), currentUrl);
        } catch {
          throw createRuntimeError('rapidocr_redirect_location_invalid', 'RapidOCR 下载重定向地址缺失或无效。');
        }
        if (nextUrl.protocol !== 'https:') {
          throw createRuntimeError('rapidocr_redirect_protocol_not_allowed', 'RapidOCR 下载重定向只允许 HTTPS。');
        }
        currentUrl = nextUrl;
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        discardResponseStream(response?.stream);
        throw createRuntimeError('rapidocr_download_http_failed', 'RapidOCR 下载服务器返回失败状态。');
      }
      const contentLength = Number(response.headers?.['content-length']);
      if (Number.isFinite(contentLength) && contentLength > manifest.sizeBytes) {
        discardResponseStream(response.stream);
        throw createRuntimeError('rapidocr_download_size_exceeded', 'RapidOCR 下载内容超过清单字节数。');
      }
      return await writeVerifiedStreamToPart(response.stream, partPath, manifest, controller.signal);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function copyLocalSourceToPart(sourcePath, partPath, manifest) {
  let stat;
  try {
    stat = await fsp.stat(sourcePath);
  } catch (error) {
    throw createRuntimeError('rapidocr_local_source_invalid', 'RAPIDOCR_RUNNER_SOURCE 不是可用的本地文件。', error);
  }
  if (!stat.isFile()) {
    throw createRuntimeError('rapidocr_local_source_invalid', 'RAPIDOCR_RUNNER_SOURCE 不是可用的本地文件。');
  }
  const verification = await verifyRunnerFile(sourcePath, manifest);
  if (!verification.valid) {
    const code = verification.reasonCode === 'rapidocr_runner_size_mismatch'
      ? 'rapidocr_local_source_size_mismatch'
      : 'rapidocr_local_source_hash_mismatch';
    throw createRuntimeError(code, '本地 RapidOCR 来源文件与清单不一致。');
  }
  return writeVerifiedStreamToPart(fs.createReadStream(sourcePath), partPath, manifest);
}

async function acquireInstallLock(lockPath, options = {}) {
  const deadline = Date.now() + (options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS);
  const staleLockMs = options.staleLockMs || DEFAULT_STALE_LOCK_MS;
  while (true) {
    let handle;
    try {
      handle = await fsp.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        createdAt: new Date().toISOString()
      }));
      await handle.sync();
      return async () => {
        try {
          await handle.close();
        } finally {
          await fsp.rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Ignore cleanup failure while reporting the lock error.
        }
      }
      if (error?.code !== 'EEXIST') {
        throw createRuntimeError('rapidocr_lock_failed', '无法建立 RapidOCR 安装锁。', error);
      }
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw createRuntimeError('rapidocr_lock_failed', '无法检查 RapidOCR 安装锁。', statError);
      }
      if (Date.now() >= deadline) {
        throw createRuntimeError('rapidocr_lock_timeout', '等待 RapidOCR 安装锁超时。');
      }
      await new Promise((resolve) => setTimeout(resolve, options.lockPollMs || 200));
    }
  }
}

function successResult(manifest, source) {
  return {
    version: manifest.version,
    source,
    verified: true
  };
}

async function ensureWithManifest(repoRoot, manifest, options = {}) {
  if (process.platform !== manifest.platform || process.arch !== manifest.arch) {
    throw createRuntimeError('rapidocr_platform_not_supported', '当前平台不支持此 RapidOCR 运行时。');
  }
  const installPath = resolveInstallPath(repoRoot, manifest);
  const existing = await verifyRunnerFile(installPath, manifest);
  if (existing.valid) return successResult(manifest, 'existing');
  if (existing.exists) {
    throw createRuntimeError('rapidocr_existing_runner_invalid', '现有 RapidOCR runner 与固定清单不一致，请人工移走后重试。');
  }

  await fsp.mkdir(path.dirname(installPath), { recursive: true });
  const lockPath = `${installPath}.ensure.lock`;
  const releaseLock = await acquireInstallLock(lockPath, options);
  const partPath = `${installPath}.${process.pid}.${crypto.randomUUID()}.part`;
  try {
    const afterLock = await verifyRunnerFile(installPath, manifest);
    if (afterLock.valid) return successResult(manifest, 'existing');
    if (afterLock.exists) {
      throw createRuntimeError('rapidocr_existing_runner_invalid', '现有 RapidOCR runner 与固定清单不一致，请人工移走后重试。');
    }

    const localSource = String(options.env?.RAPIDOCR_RUNNER_SOURCE || '').trim();
    let source;
    if (localSource) {
      await copyLocalSourceToPart(localSource, partPath, manifest);
      source = 'local-source';
    } else {
      await downloadReleaseAsset(manifest, partPath, options);
      source = 'release-download';
    }
    try {
      await fsp.rename(partPath, installPath);
    } catch (error) {
      throw createRuntimeError('rapidocr_atomic_install_failed', 'RapidOCR runner 原子安装失败。', error);
    }
    const installed = await verifyRunnerFile(installPath, manifest);
    if (!installed.valid) {
      throw createRuntimeError('rapidocr_installed_runner_invalid', '安装后的 RapidOCR runner 校验失败。');
    }
    return successResult(manifest, source);
  } finally {
    await fsp.rm(partPath, { force: true });
    await releaseLock();
  }
}

function ensureRapidOcrRunner(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..'));
  const manifestPath = path.resolve(
    options.manifestPath || path.join(repoRoot, ...MANIFEST_RELATIVE_PATH.split('/'))
  );
  const key = process.platform === 'win32'
    ? `${repoRoot.toLowerCase()}|${manifestPath.toLowerCase()}`
    : `${repoRoot}|${manifestPath}`;
  if (activeEnsures.has(key)) return activeEnsures.get(key);
  const promise = (async () => {
    const manifest = options.manifest
      ? validateRuntimeManifest(options.manifest)
      : await loadRuntimeManifest(manifestPath);
    return ensureWithManifest(repoRoot, manifest, {
      ...options,
      env: options.env || process.env
    });
  })();
  activeEnsures.set(key, promise);
  promise.finally(() => {
    if (activeEnsures.get(key) === promise) activeEnsures.delete(key);
  }).catch(() => {});
  return promise;
}

if (require.main === module) {
  ensureRapidOcrRunner()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(JSON.stringify(serializeRuntimeError(error)));
      process.exitCode = 1;
    });
}

module.exports = {
  MANIFEST_RELATIVE_PATH,
  FIXED_INSTALL_RELATIVE_PATH,
  MAX_REDIRECTS,
  RapidOcrRuntimeError,
  validateRuntimeManifest,
  loadRuntimeManifest,
  resolveInstallPath,
  hashFile,
  verifyRunnerFile,
  openHttpsResponse,
  downloadReleaseAsset,
  ensureRapidOcrRunner,
  serializeRuntimeError
};
