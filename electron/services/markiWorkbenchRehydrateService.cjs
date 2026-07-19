const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { loadConfigs } = require('./configService.cjs');
const { inspectJpegFile } = require('./markiPhotoDownloadService.cjs');
const {
  buildMarkiSourceKey,
  getMarkiImportRoot,
  loadMarkiSourceManifestForRecovery
} = require('./markiSourceManifestService.cjs');
const {
  buildMarkiSourceMetadataRef,
  loadMarkiSourceMetadata
} = require('./markiSourceMetadataService.cjs');
const {
  buildMarkiStructuredImportBundle
} = require('./markiStructuredImportService.cjs');
const {
  createEmptyWorkspace,
  loadSortWorkspaceSnapshot,
  saveSortWorkspaceSnapshot
} = require('./sortWorkspaceSnapshotService.cjs');

const RECOVERY_STATUSES = Object.freeze([
  'recoverable',
  'already_in_workbench',
  'already_archived',
  'missing_file',
  'corrupted_file',
  'missing_metadata',
  'invalid_record'
]);
const MAX_RECOVERY_SELECTIONS = 1000;
const SAFE_SUMMARY_FIELDS = Object.freeze([
  'recoveryToken',
  'displayId',
  'capturedAt',
  'photographerName',
  'projectName',
  'status'
]);

let mergeModulePromise = null;

class MarkiWorkbenchRehydrateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkiWorkbenchRehydrateError';
    this.code = code;
  }
}

function createMarkiWorkbenchRehydrateService(defaultOptions = {}) {
  const candidateRecords = new Map();
  let operationQueue = Promise.resolve();

  const enqueue = (action) => {
    const current = operationQueue.catch(() => {}).then(action);
    operationQueue = current;
    return current;
  };

  async function scan(input = {}, options = {}) {
    return enqueue(async () => {
      try {
        const dependencies = resolveDependencies({ ...defaultOptions, ...options });
        const paths = normalizeInternalPaths(input);
        const snapshotResult = await dependencies.loadSnapshot(paths.userDataPath);
        const workspace = resolveWorkspace(snapshotResult);
        const existingBySourceKey = new Map(
          workspace.photos
            .filter((photo) => normalizeText(photo?.sourceKey))
            .map((photo) => [normalizeText(photo.sourceKey), photo])
        );
        const importRoot = getMarkiImportRoot(paths.documentsPath);
        const orgIds = await listOrganizationIds(dependencies.fs, importRoot);
        const nextCandidates = [];

        for (const orgId of orgIds) {
          let manifest;
          try {
            manifest = await dependencies.loadManifest(paths.documentsPath, orgId);
          } catch {
            nextCandidates.push(createInvalidCandidate(orgId));
            continue;
          }
          for (const invalid of manifest.invalidRecords || []) {
            nextCandidates.push(createInvalidCandidate(orgId, invalid.index));
          }
          for (const record of manifest.records || []) {
            if (record.importStatus !== 'imported') continue;
            nextCandidates.push(await inspectRecoveryRecord({
              dependencies,
              documentsPath: paths.documentsPath,
              importRoot,
              record,
              existingPhoto: existingBySourceKey.get(record.sourceKey) || null
            }));
          }
        }

        candidateRecords.clear();
        const items = nextCandidates.map((candidate, index) => {
          const recoveryToken = dependencies.randomUUID();
          const displayId = `R${String(index + 1).padStart(4, '0')}`;
          const stored = {
            ...candidate,
            recoveryToken,
            displayId
          };
          candidateRecords.set(recoveryToken, stored);
          return toSafeCandidateSummary(stored);
        });
        return {
          success: true,
          items,
          counts: countStatuses(items)
        };
      } catch (error) {
        candidateRecords.clear();
        return toSafeFailure(
          error,
          'marki_recovery_scan_failed',
          '已下载马克照片扫描失败，请重试。'
        );
      }
    });
  }

  async function recover(input = {}, options = {}) {
    return enqueue(async () => {
      try {
        const dependencies = resolveDependencies({ ...defaultOptions, ...options });
        const paths = normalizeInternalPaths(input);
        const recoveryTokens = normalizeRecoveryTokens(input);
        const selectedCandidates = recoveryTokens.map((token) => {
          const candidate = candidateRecords.get(token);
          if (!candidate || candidate.status !== 'recoverable') {
            throw new MarkiWorkbenchRehydrateError(
              'marki_recovery_token_invalid',
              '恢复选择已失效，请重新扫描后再试。'
            );
          }
          return candidate;
        });
        const snapshotResult = await dependencies.loadSnapshot(paths.userDataPath);
        const currentWorkspace = resolveWorkspace(snapshotResult);
        const existingSourceKeys = new Set(
          currentWorkspace.photos
            .map((photo) => normalizeText(photo?.sourceKey))
            .filter(Boolean)
        );
        const importRoot = getMarkiImportRoot(paths.documentsPath);
        const manifestCache = new Map();
        const accepted = [];
        let duplicateCount = 0;

        for (const candidate of selectedCandidates) {
          if (existingSourceKeys.has(candidate.sourceKey)) {
            duplicateCount += 1;
            continue;
          }
          let manifest = manifestCache.get(candidate.orgId);
          if (!manifest) {
            manifest = await dependencies.loadManifest(paths.documentsPath, candidate.orgId);
            manifestCache.set(candidate.orgId, manifest);
          }
          const record = (manifest.records || []).find(
            (item) => item.sourceKey === candidate.sourceKey
          );
          if (!record || record.importStatus !== 'imported') {
            throw new MarkiWorkbenchRehydrateError(
              'marki_recovery_record_changed',
              '马克来源记录已变化，请重新扫描后再试。'
            );
          }
          const inspected = await inspectRecoveryRecord({
            dependencies,
            documentsPath: paths.documentsPath,
            importRoot,
            record,
            existingPhoto: null
          });
          if (inspected.status !== 'recoverable') {
            throw new MarkiWorkbenchRehydrateError(
              `marki_recovery_${inspected.status}`,
              '马克来源文件或结构化资料已变化，请核对后重试。'
            );
          }
          accepted.push(inspected);
          existingSourceKeys.add(inspected.sourceKey);
        }

        if (accepted.length === 0) {
          return {
            success: true,
            status: 'nothing_to_recover',
            recoveredCount: 0,
            duplicateCount,
            conflictCount: 0,
            skippedCount: duplicateCount
          };
        }

        const configs = await dependencies.loadConfigs(paths.documentsPath);
        const batchId = `marki-rehydrate-${dependencies.randomUUID()}`;
        const workbenchImportPackage = buildCombinedWorkbenchPackage({
          batchId,
          candidates: accepted,
          configs,
          buildStructuredImportBundle: dependencies.buildStructuredImportBundle
        });
        const mergeWorkbenchImport = await dependencies.loadMergeFunction();
        const merged = mergeWorkbenchImport(currentWorkspace, workbenchImportPackage);
        const nextWorkspace = {
          ...currentWorkspace,
          photos: merged.photos,
          recognitionResultsByPhoto: merged.recognitionResultsByPhoto,
          watermarkRecordsByPhoto: merged.watermarkRecordsByPhoto,
          archiveSuggestionsByPhoto: merged.archiveSuggestionsByPhoto,
          selectedIds: merged.selectedIds,
          activePhotoId: merged.activePhotoId,
          filter: merged.stats.addedCount > 0 ? 'all' : currentWorkspace.filter,
          searchText: merged.stats.addedCount > 0 ? '' : currentWorkspace.searchText,
          smartSortViewMode: merged.stats.addedCount > 0
            ? 'statusFilter'
            : currentWorkspace.smartSortViewMode,
          activeSmartSortGroupId: merged.stats.addedCount > 0
            ? ''
            : currentWorkspace.activeSmartSortGroupId
        };
        const snapshotSaveResult = await dependencies.saveSnapshot(
          paths.userDataPath,
          nextWorkspace
        );
        if (snapshotSaveResult?.success !== true) {
          throw new MarkiWorkbenchRehydrateError(
            'marki_recovery_snapshot_save_failed',
            '恢复内容未写入工作台，请重试。'
          );
        }
        for (const candidate of selectedCandidates) {
          candidate.status = 'already_in_workbench';
        }
        return {
          success: true,
          status: 'recovered',
          recoveredCount: merged.stats.addedCount,
          duplicateCount: duplicateCount + merged.stats.duplicateCount,
          conflictCount: merged.stats.conflictCount,
          skippedCount: duplicateCount
            + merged.stats.duplicateCount
            + merged.stats.conflictCount
        };
      } catch (error) {
        return toSafeFailure(
          error,
          'marki_recovery_failed',
          '恢复已下载马克照片失败，请重试。'
        );
      }
    });
  }

  function reset() {
    candidateRecords.clear();
  }

  return {
    recoverMarkiWorkbenchCandidates: recover,
    resetMarkiWorkbenchRecoveryCandidates: reset,
    scanMarkiWorkbenchRecoveryCandidates: scan
  };
}

async function inspectRecoveryRecord({
  dependencies,
  documentsPath,
  importRoot,
  record,
  existingPhoto
}) {
  const base = {
    orgId: normalizeText(record?.orgId),
    momentId: normalizeText(record?.momentId),
    sourceKey: normalizeText(record?.sourceKey),
    sourceMetadataRef: '',
    record,
    metadata: null,
    download: null,
    capturedAt: '',
    photographerName: '',
    projectName: ''
  };
  if (existingPhoto) {
    return {
      ...base,
      status: isArchivedWorkbenchPhoto(existingPhoto)
        ? 'already_archived'
        : 'already_in_workbench'
    };
  }
  if (
    !base.orgId
    || !base.momentId
    || base.sourceKey !== buildMarkiSourceKey(base.orgId, base.momentId)
    || !record?.downloadInfo
  ) {
    return { ...base, status: 'invalid_record' };
  }

  let resolvedFile;
  try {
    resolvedFile = await resolveTrustedDownloadFile(
      dependencies.fs,
      importRoot,
      base.orgId,
      base.momentId,
      record.downloadInfo
    );
  } catch (error) {
    return {
      ...base,
      status: error?.code === 'ENOENT' ? 'missing_file' : 'invalid_record'
    };
  }

  let inspection;
  try {
    inspection = await dependencies.inspectJpeg(resolvedFile.localPath);
    assertDownloadInfoMatches(record.downloadInfo, inspection);
  } catch (error) {
    return {
      ...base,
      status: error?.code === 'ENOENT' ? 'missing_file' : 'corrupted_file'
    };
  }

  let metadata;
  try {
    metadata = await dependencies.loadMetadata(
      documentsPath,
      base.orgId,
      base.momentId
    );
  } catch {
    return { ...base, status: 'missing_metadata' };
  }
  if (!metadata) return { ...base, status: 'missing_metadata' };
  const expectedMetadataRef = buildMarkiSourceMetadataRef(base.orgId, base.momentId);
  if (
    metadata.sourceMetadataRef !== expectedMetadataRef
    || metadata.sourceKey !== base.sourceKey
    || metadata.orgId !== base.orgId
    || metadata.momentId !== base.momentId
    || !Array.isArray(metadata.parsedEntries)
  ) {
    return { ...base, status: 'invalid_record' };
  }

  return {
    ...base,
    status: 'recoverable',
    sourceMetadataRef: expectedMetadataRef,
    metadata,
    download: {
      sourceKey: base.sourceKey,
      importStatus: 'imported',
      localPath: resolvedFile.localPath,
      relativePath: record.downloadInfo.relativePath,
      fileName: record.downloadInfo.fileName,
      size: inspection.size,
      width: inspection.width,
      height: inspection.height,
      sha256: inspection.sha256,
      completedAt: record.downloadInfo.completedAt
    },
    capturedAt: normalizeText(metadata.capturedAt) || formatPostTime(metadata.postTime),
    photographerName: findMetadataValue(metadata.parsedEntries, '上传人'),
    projectName: findMetadataValue(metadata.parsedEntries, '小区名称')
  };
}

async function resolveTrustedDownloadFile(fileSystem, importRoot, orgId, momentId, downloadInfo) {
  const relativePath = normalizeText(downloadInfo?.relativePath).replaceAll('\\', '/');
  const parts = relativePath.split('/');
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || parts.some((part) => !part || part === '.' || part === '..')
    || parts[0] !== orgId
    || path.basename(relativePath) !== downloadInfo.fileName
    || downloadInfo.fileName !== `${momentId}.jpg`
  ) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_path_invalid',
      '马克照片来源路径无效。'
    );
  }
  const normalizedRoot = path.resolve(importRoot);
  const localPath = path.resolve(normalizedRoot, ...parts);
  if (!isPathInside(normalizedRoot, localPath)) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_path_invalid',
      '马克照片来源路径无效。'
    );
  }
  const [realRoot, realFile] = await Promise.all([
    fileSystem.realpath(normalizedRoot),
    fileSystem.realpath(localPath)
  ]);
  if (!isPathInside(realRoot, realFile)) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_path_invalid',
      '马克照片来源路径无效。'
    );
  }
  const stat = await fileSystem.stat(realFile);
  if (!stat.isFile()) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_file_invalid',
      '马克照片来源文件无效。'
    );
  }
  return { localPath: realFile };
}

function assertDownloadInfoMatches(downloadInfo, inspection) {
  if (
    inspection.size !== Number(downloadInfo.size)
    || inspection.width !== Number(downloadInfo.width)
    || inspection.height !== Number(downloadInfo.height)
    || inspection.sha256 !== normalizeText(downloadInfo.sha256).toLowerCase()
  ) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_file_mismatch',
      '马克照片来源文件校验不一致。'
    );
  }
}

function buildCombinedWorkbenchPackage({
  batchId,
  candidates,
  configs,
  buildStructuredImportBundle
}) {
  const combined = {
    batchId,
    photos: [],
    recognitionResultsByPhoto: {},
    watermarkRecordsByPhoto: {},
    archiveSuggestionsByPhoto: {}
  };
  const byOrg = new Map();
  for (const candidate of candidates) {
    if (!byOrg.has(candidate.orgId)) byOrg.set(candidate.orgId, []);
    byOrg.get(candidate.orgId).push(candidate);
  }
  for (const [orgId, items] of byOrg) {
    const bundle = buildStructuredImportBundle({
      orgId,
      configs,
      items: items.map(buildStructuredImportItem)
    }, { batchId });
    const workbenchPackage = bundle.workbenchImportPackage;
    combined.photos.push(...workbenchPackage.photos);
    Object.assign(combined.recognitionResultsByPhoto, workbenchPackage.recognitionResultsByPhoto);
    Object.assign(combined.watermarkRecordsByPhoto, workbenchPackage.watermarkRecordsByPhoto);
    Object.assign(combined.archiveSuggestionsByPhoto, workbenchPackage.archiveSuggestionsByPhoto);
  }
  return combined;
}

function buildStructuredImportItem(candidate) {
  const metadata = candidate.metadata;
  const entries = metadata.parsedEntries.map((entry) => [entry.key, entry.value]);
  if (
    metadata.antiCounterfeitCode
    && !metadata.parsedEntries.some((entry) => entry.key === '防伪码')
  ) {
    entries.push(['防伪码', metadata.antiCounterfeitCode]);
  }
  return {
    moment: {
      id: metadata.momentId,
      uid: metadata.uid,
      teamId: metadata.teamId,
      momentType: 1,
      content: JSON.stringify(entries),
      markName: metadata.markName,
      lng: 0,
      lat: 0,
      postTime: metadata.postTime
    },
    sourceMetadataRef: metadata.sourceMetadataRef,
    download: candidate.download
  };
}

async function listOrganizationIds(fileSystem, importRoot) {
  try {
    const entries = await fileSystem.readdir(importRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function resolveWorkspace(snapshotResult) {
  if (snapshotResult?.success !== true) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_snapshot_unavailable',
      '当前工作台快照无法读取，已停止恢复以避免重复照片。'
    );
  }
  return snapshotResult.found
    ? snapshotResult.snapshot.workspace
    : createEmptyWorkspace();
}

function normalizeInternalPaths(input) {
  if (!isPlainObject(input)) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_input_invalid',
      '恢复请求无效。'
    );
  }
  const documentsPath = normalizeText(input.documentsPath);
  const userDataPath = normalizeText(input.userDataPath);
  if (!documentsPath || !path.isAbsolute(documentsPath) || !userDataPath || !path.isAbsolute(userDataPath)) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_paths_invalid',
      '恢复服务目录无效。'
    );
  }
  return { documentsPath, userDataPath };
}

function normalizeRecoveryTokens(input) {
  const allowedKeys = new Set(['documentsPath', 'userDataPath', 'recoveryTokens']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_input_invalid',
      '恢复请求包含不允许的字段。'
    );
  }
  if (
    !Array.isArray(input.recoveryTokens)
    || input.recoveryTokens.length === 0
    || input.recoveryTokens.length > MAX_RECOVERY_SELECTIONS
  ) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_selection_invalid',
      '请选择需要恢复的马克照片。'
    );
  }
  const tokens = input.recoveryTokens.map((value) => normalizeText(value));
  if (
    tokens.some((token) => !isOpaqueToken(token))
    || new Set(tokens).size !== tokens.length
  ) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_selection_invalid',
      '恢复选择无效，请重新扫描。'
    );
  }
  return tokens;
}

function resolveDependencies(options) {
  return {
    fs: options.fs || fs,
    randomUUID: options.randomUUID || randomUUID,
    loadManifest: options.loadManifest || loadMarkiSourceManifestForRecovery,
    loadMetadata: options.loadMetadata || loadMarkiSourceMetadata,
    inspectJpeg: options.inspectJpeg || inspectJpegFile,
    loadConfigs: options.loadConfigs || loadConfigs,
    buildStructuredImportBundle: options.buildStructuredImportBundle
      || buildMarkiStructuredImportBundle,
    loadSnapshot: options.loadSnapshot || loadSortWorkspaceSnapshot,
    saveSnapshot: options.saveSnapshot || saveSortWorkspaceSnapshot,
    loadMergeFunction: options.loadMergeFunction || loadMergeWorkbenchImport
  };
}

async function loadMergeWorkbenchImport() {
  if (!mergeModulePromise) {
    const moduleUrl = pathToFileURL(path.join(__dirname, 'markiWorkbenchImportCore.js')).href;
    mergeModulePromise = import(moduleUrl);
  }
  const moduleValue = await mergeModulePromise;
  return moduleValue.mergeMarkiWorkbenchImportPackage;
}

function createInvalidCandidate(orgId, recordIndex = 0) {
  return {
    orgId,
    momentId: '',
    sourceKey: '',
    sourceMetadataRef: '',
    record: null,
    metadata: null,
    download: null,
    capturedAt: '',
    photographerName: '',
    projectName: '',
    status: 'invalid_record',
    recordIndex
  };
}

function toSafeCandidateSummary(candidate) {
  const summary = {
    recoveryToken: candidate.recoveryToken,
    displayId: candidate.displayId,
    capturedAt: normalizeText(candidate.capturedAt),
    photographerName: normalizeText(candidate.photographerName),
    projectName: normalizeText(candidate.projectName),
    status: RECOVERY_STATUSES.includes(candidate.status) ? candidate.status : 'invalid_record'
  };
  if (
    Object.keys(summary).length !== SAFE_SUMMARY_FIELDS.length
    || SAFE_SUMMARY_FIELDS.some((field) => !Object.hasOwn(summary, field))
  ) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_summary_invalid',
      '恢复候选摘要无效。'
    );
  }
  return summary;
}

function countStatuses(items) {
  return Object.fromEntries(RECOVERY_STATUSES.map((status) => [
    status,
    items.filter((item) => item.status === status).length
  ]));
}

function findMetadataValue(entries, key) {
  return normalizeText(
    (Array.isArray(entries) ? entries : []).find((entry) => entry?.key === key)?.value
  );
}

function formatPostTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000 + 8 * 60 * 60 * 1000);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function isArchivedWorkbenchPhoto(photo) {
  return (
    photo?.sortStatus === 'archived'
    || photo?.archiveResult?.success === true
    || photo?.archiveResult?.status === 'archived'
  );
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isOpaqueToken(value) {
  return /^[a-f0-9-]{20,100}$/i.test(value) && !/[\\/]/.test(value);
}

function normalizeText(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toSafeFailure(error, fallbackCode, fallbackMessage) {
  if (error instanceof MarkiWorkbenchRehydrateError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message
      }
    };
  }
  return {
    success: false,
    error: {
      code: fallbackCode,
      message: fallbackMessage
    }
  };
}

const defaultService = createMarkiWorkbenchRehydrateService();

module.exports = {
  MAX_RECOVERY_SELECTIONS,
  RECOVERY_STATUSES,
  SAFE_SUMMARY_FIELDS,
  MarkiWorkbenchRehydrateError,
  createMarkiWorkbenchRehydrateService,
  recoverMarkiWorkbenchCandidates: defaultService.recoverMarkiWorkbenchCandidates,
  resetMarkiWorkbenchRecoveryCandidates: defaultService.resetMarkiWorkbenchRecoveryCandidates,
  scanMarkiWorkbenchRecoveryCandidates: defaultService.scanMarkiWorkbenchRecoveryCandidates
};
