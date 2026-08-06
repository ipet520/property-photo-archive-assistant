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
  resolveMarkiImportSourceStatuses
} = require('./markiImportLifecycleService.cjs');
const {
  createEmptyWorkspace,
  loadSortWorkspaceSnapshot,
  saveSortWorkspaceSnapshot
} = require('./sortWorkspaceSnapshotService.cjs');

const RECOVERY_STATUSES = Object.freeze([
  'recoverable',
  'already_in_workbench',
  'already_archived',
  'workspace_file_missing',
  'workspace_file_corrupted',
  'workspace_file_repairable',
  'workspace_file_unresolved',
  'missing_file',
  'corrupted_file',
  'missing_metadata',
  'invalid_record',
  'project_mismatch',
  'project_unresolved',
  'source_project_locked'
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
        const snapshotResult = await dependencies.loadSnapshot(paths.userDataPath, {
          activeProject: paths.activeProject
        });
        const workspace = resolveWorkspace(snapshotResult);
        const configs = await dependencies.loadConfigs(paths.documentsPath);
        const projectOptions = Array.isArray(configs?.projectOptions) ? configs.projectOptions : [];
        const existingBySourceKey = new Map(
          workspace.photos
            .filter((photo) => (
              photo?.sourceType === 'marki_api'
              && normalizeText(photo?.sourceKey)
            ))
            .map((photo) => [normalizeText(photo.sourceKey), photo])
        );
        const importRoot = getMarkiImportRoot(paths.documentsPath);
        const orgIds = await listOrganizationIds(dependencies.fs, importRoot);
        const nextCandidates = [];
        const processedWorkspaceSourceKeys = new Set();

        for (const orgId of orgIds) {
          let manifest;
          try {
            manifest = await dependencies.loadManifest(paths.documentsPath, orgId);
          } catch {
            const hasWorkspacePhotoForOrg = workspace.photos.some((photo) => (
              photo?.sourceType === 'marki_api'
              && parseMarkiSourceKey(photo?.sourceKey)?.orgId === orgId
            ));
            if (!hasWorkspacePhotoForOrg) nextCandidates.push(createInvalidCandidate(orgId));
            continue;
          }
          const hasWorkspacePhotoForOrg = workspace.photos.some((photo) => (
            photo?.sourceType === 'marki_api'
            && parseMarkiSourceKey(photo?.sourceKey)?.orgId === orgId
          ));
          if (!hasWorkspacePhotoForOrg) {
            for (const invalid of manifest.invalidRecords || []) {
              nextCandidates.push(createInvalidCandidate(orgId, invalid.index));
            }
          }
          const importedRecords = (manifest.records || [])
            .filter((record) => record.importStatus === 'imported');
          const sourceStatuses = await dependencies.resolveSourceStatuses({
            documentsPath: paths.documentsPath,
            userDataPath: paths.userDataPath,
            orgId,
            sourceKeys: importedRecords.map((record) => record.sourceKey),
            activeProject: paths.activeProject
          }, {
            loadManifest: async () => ({
              records: Object.fromEntries(importedRecords.map((record) => [
                record.sourceKey,
                record
              ]))
            })
          });
          for (const record of importedRecords) {
            const sourceKey = normalizeText(record?.sourceKey);
            if (sourceKey && processedWorkspaceSourceKeys.has(sourceKey)) continue;
            const existingPhoto = existingBySourceKey.get(record.sourceKey) || null;
            let candidate = await inspectRecoveryRecord({
              dependencies,
              documentsPath: paths.documentsPath,
              importRoot,
              record,
              existingPhoto,
              activeProject: paths.activeProject,
              projectOptions,
              assignedProject: sourceStatuses.assignedProjectBySourceKey?.[record.sourceKey] || null
            });
            if (existingPhoto && candidate.status === 'invalid_record') {
              candidate = await inspectUnmatchedWorkspacePhoto({
                dependencies,
                documentsPath: paths.documentsPath,
                importRoot,
                photo: existingPhoto,
                activeProject: paths.activeProject,
                projectOptions,
                skipManifest: true
              });
            }
            nextCandidates.push(candidate);
            if (sourceKey) processedWorkspaceSourceKeys.add(sourceKey);
          }
        }

        for (const photo of workspace.photos.filter((item) => (
          item?.sourceType === 'marki_api'
          && normalizeText(item?.sourceKey)
        ))) {
          const sourceKey = normalizeText(photo.sourceKey);
          if (processedWorkspaceSourceKeys.has(sourceKey)) continue;
          nextCandidates.push(await inspectUnmatchedWorkspacePhoto({
            dependencies,
            documentsPath: paths.documentsPath,
            importRoot,
            photo,
            activeProject: paths.activeProject,
            projectOptions
          }));
          processedWorkspaceSourceKeys.add(sourceKey);
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
          if (!candidate || !['recoverable', 'workspace_file_repairable'].includes(candidate.status)) {
            throw new MarkiWorkbenchRehydrateError(
              'marki_recovery_token_invalid',
              '恢复选择已失效，请重新扫描后再试。'
            );
          }
          return candidate;
        });
        const selectedStatuses = new Set(selectedCandidates.map((candidate) => candidate.status));
        if (selectedStatuses.size > 1) {
          throw new MarkiWorkbenchRehydrateError(
            'marki_recovery_mixed_selection',
            '请分别处理可恢复照片和工作池文件修复项。'
          );
        }
        const snapshotResult = await dependencies.loadSnapshot(paths.userDataPath, {
          activeProject: paths.activeProject
        });
        const currentWorkspace = resolveWorkspace(snapshotResult);
        if (selectedStatuses.has('workspace_file_repairable')) {
          return repairExistingWorkspaceCandidates({
            dependencies,
            paths,
            currentWorkspace,
            selectedCandidates
          });
        }
        const existingSourceKeys = new Set(
          currentWorkspace.photos
            .map((photo) => normalizeText(photo?.sourceKey))
            .filter(Boolean)
        );
        const importRoot = getMarkiImportRoot(paths.documentsPath);
        const manifestCache = new Map();
        const configs = await dependencies.loadConfigs(paths.documentsPath);
        const projectOptions = Array.isArray(configs?.projectOptions) ? configs.projectOptions : [];
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
            existingPhoto: null,
            activeProject: paths.activeProject,
            projectOptions,
            assignedProject: candidate.assignedProject
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

        const batchId = `marki-rehydrate-${dependencies.randomUUID()}`;
        const workbenchImportPackage = buildCombinedWorkbenchPackage({
          batchId,
          candidates: accepted,
          configs,
          buildStructuredImportBundle: dependencies.buildStructuredImportBundle,
          activeProject: paths.activeProject
        });
        const mergeWorkbenchImport = await dependencies.loadMergeFunction();
        const merged = mergeWorkbenchImport(currentWorkspace, workbenchImportPackage, {
          activeProject: paths.activeProject
        });
        const nextWorkspace = {
          ...currentWorkspace,
          projectId: paths.activeProject.projectId,
          projectName: paths.activeProject.projectName,
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
          nextWorkspace,
          { activeProject: paths.activeProject }
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
  existingPhoto,
  activeProject,
  projectOptions,
  assignedProject
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
    projectName: '',
    assignedProject: assignedProject || null,
    projectAssignmentSource: ''
  };
  if (existingPhoto && isArchivedWorkbenchPhoto(existingPhoto)) {
    return { ...base, status: 'already_archived' };
  }
  if (
    !base.orgId
    || !base.momentId
    || base.sourceKey !== buildMarkiSourceKey(base.orgId, base.momentId)
    || !record?.downloadInfo
  ) {
    return { ...base, status: 'invalid_record' };
  }

  let trustedDownload;
  try {
    trustedDownload = await inspectTrustedDownload({
      dependencies,
      importRoot,
      orgId: base.orgId,
      momentId: base.momentId,
      downloadInfo: record.downloadInfo
    });
  } catch (error) {
    if (existingPhoto) {
      const currentHealth = await inspectCurrentWorkspaceFile(
        dependencies,
        existingPhoto,
        normalizeText(existingPhoto.fileHealth?.expectedSha256) || normalizeText(existingPhoto.sha256)
      );
      return {
        ...base,
        status: currentHealth.status === 'missing'
          ? 'workspace_file_missing'
          : currentHealth.status === 'corrupted'
            ? 'workspace_file_corrupted'
            : 'workspace_file_unresolved'
      };
    }
    return {
      ...base,
      status: error?.code === 'ENOENT'
        ? 'missing_file'
        : ['marki_recovery_path_invalid', 'marki_recovery_file_invalid'].includes(error?.code)
          ? 'invalid_record'
          : 'corrupted_file'
    };
  }

  if (existingPhoto) {
    const currentHealth = await inspectCurrentWorkspaceFile(
      dependencies,
      existingPhoto,
      trustedDownload.inspection.sha256
    );
    if (
      currentHealth.status === 'healthy'
      && currentHealth.inspection
      && sameFileInspection(currentHealth.inspection, trustedDownload.inspection)
    ) {
      return {
        ...base,
        status: 'already_in_workbench',
        download: trustedDownload.download
      };
    }
    return {
      ...base,
      status: 'workspace_file_repairable',
      download: trustedDownload.download,
      currentFileHealth: currentHealth
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
  const sourceProjectText = findMetadataValue(metadata.parsedEntries, '小区名称');
  const projectAssignment = resolveRecoveryProjectAssignment({
    activeProject,
    projectOptions,
    sourceProjectText,
    assignedProject
  });
  if (!projectAssignment.compatible) {
    return {
      ...base,
      status: projectAssignment.status,
      projectName: sourceProjectText,
      assignedProject: assignedProject || null
    };
  }

  return {
    ...base,
    status: 'recoverable',
    sourceMetadataRef: expectedMetadataRef,
    metadata,
    download: trustedDownload.download,
    capturedAt: normalizeText(metadata.capturedAt) || formatPostTime(metadata.postTime),
    photographerName: findMetadataValue(metadata.parsedEntries, '上传人'),
    projectName: sourceProjectText,
    projectAssignmentSource: projectAssignment.projectAssignmentSource,
    assignedProject: projectAssignment.assignedProject
  };
}

async function inspectTrustedDownload({ dependencies, importRoot, orgId, momentId, downloadInfo }) {
  const resolvedFile = await resolveTrustedDownloadFile(
    dependencies.fs,
    importRoot,
    orgId,
    momentId,
    downloadInfo
  );
  const inspection = await dependencies.inspectJpeg(resolvedFile.localPath);
  assertDownloadInfoMatches(downloadInfo, inspection);
  return {
    localPath: resolvedFile.localPath,
    inspection,
    download: {
      sourceKey: buildMarkiSourceKey(orgId, momentId),
      importStatus: 'imported',
      localPath: resolvedFile.localPath,
      relativePath: downloadInfo.relativePath,
      fileName: downloadInfo.fileName,
      size: inspection.size,
      width: inspection.width,
      height: inspection.height,
      sha256: inspection.sha256,
      completedAt: downloadInfo.completedAt
    }
  };
}

async function inspectCurrentWorkspaceFile(dependencies, photo, expectedSha256 = '') {
  const localPath = normalizeText(photo?.originalPath);
  if (!localPath || !path.isAbsolute(localPath)) return { status: 'missing', inspection: null };
  try {
    const inspection = await dependencies.inspectJpeg(localPath);
    if (expectedSha256 && normalizeText(inspection?.sha256).toLowerCase() !== expectedSha256.toLowerCase()) {
      return { status: 'corrupted', inspection };
    }
    return { status: 'healthy', inspection };
  } catch (error) {
    return {
      status: error?.code === 'ENOENT' ? 'missing' : 'corrupted',
      inspection: null
    };
  }
}

async function inspectUnmatchedWorkspacePhoto({
  dependencies,
  documentsPath,
  importRoot,
  photo,
  activeProject,
  projectOptions,
  skipManifest = false
}) {
  const sourceKey = normalizeText(photo?.sourceKey);
  const base = {
    orgId: '',
    momentId: '',
    sourceKey,
    sourceMetadataRef: '',
    record: null,
    metadata: null,
    download: null,
    capturedAt: normalizeText(photo?.capturedAt),
    photographerName: '',
    projectName: normalizeText(photo?.projectName),
    assignedProject: null,
    projectAssignmentSource: ''
  };
  if (isArchivedWorkbenchPhoto(photo)) {
    return { ...base, status: 'already_archived' };
  }

  const parsedSourceKey = parseMarkiSourceKey(sourceKey);
  if (!parsedSourceKey) {
    return { ...base, status: 'workspace_file_unresolved' };
  }
  base.orgId = parsedSourceKey.orgId;
  base.momentId = parsedSourceKey.momentId;

  const currentHealth = await inspectCurrentWorkspaceFile(
    dependencies,
    photo,
    normalizeText(photo?.fileHealth?.expectedSha256) || normalizeText(photo?.sha256)
  );
  const fallbackStatus = workspaceHealthStatus(currentHealth.status);
  if (skipManifest) return { ...base, status: fallbackStatus };
  let manifest;
  try {
    manifest = await dependencies.loadManifest(documentsPath, parsedSourceKey.orgId);
  } catch {
    return { ...base, status: fallbackStatus };
  }
  const record = (manifest.records || []).find((item) => item?.sourceKey === sourceKey);
  if (!record || record.importStatus !== 'imported') {
    return { ...base, status: fallbackStatus };
  }
  return inspectRecoveryRecord({
    dependencies,
    documentsPath,
    importRoot,
    record,
    existingPhoto: photo,
    activeProject,
    projectOptions,
    assignedProject: null
  });
}

function parseMarkiSourceKey(sourceKey) {
  const match = /^marki_api:([^:]+):([^:]+)$/.exec(normalizeText(sourceKey));
  if (!match || !/^\d+$/.test(match[1])) return null;
  return { orgId: match[1], momentId: match[2] };
}

function workspaceHealthStatus(status) {
  if (status === 'missing') return 'workspace_file_missing';
  if (status === 'corrupted') return 'workspace_file_corrupted';
  return 'workspace_file_unresolved';
}

function sameFileInspection(left, right) {
  return Boolean(
    left
    && right
    && Number(left.size) === Number(right.size)
    && Number(left.width) === Number(right.width)
    && Number(left.height) === Number(right.height)
    && normalizeText(left.sha256).toLowerCase() === normalizeText(right.sha256).toLowerCase()
  );
}

async function repairExistingWorkspaceCandidates({ dependencies, paths, currentWorkspace, selectedCandidates }) {
  const configs = await dependencies.loadConfigs(paths.documentsPath);
  const projectOptions = Array.isArray(configs?.projectOptions) ? configs.projectOptions : [];
  const manifestCache = new Map();
  const photos = Array.isArray(currentWorkspace.photos) ? [...currentWorkspace.photos] : [];
  let repairedCount = 0;
  let skippedCount = 0;

  for (const candidate of selectedCandidates) {
    const photoIndex = photos.findIndex((photo) => photo?.sourceKey === candidate.sourceKey);
    if (photoIndex < 0) {
      throw new MarkiWorkbenchRehydrateError(
        'marki_recovery_token_invalid',
        '工作池照片已变化，请重新扫描后再试。'
      );
    }
    const existingPhoto = photos[photoIndex];
    let manifest = manifestCache.get(candidate.orgId);
    if (!manifest) {
      manifest = await dependencies.loadManifest(paths.documentsPath, candidate.orgId);
      manifestCache.set(candidate.orgId, manifest);
    }
    const record = (manifest.records || []).find((item) => item.sourceKey === candidate.sourceKey);
    if (!record || record.importStatus !== 'imported') {
      throw new MarkiWorkbenchRehydrateError(
        'marki_recovery_record_changed',
        '马克来源记录已变化，请重新扫描后再试。'
      );
    }
    const inspected = await inspectRecoveryRecord({
      dependencies,
      documentsPath: paths.documentsPath,
      importRoot: getMarkiImportRoot(paths.documentsPath),
      record,
      existingPhoto,
      activeProject: paths.activeProject,
      projectOptions,
      assignedProject: candidate.assignedProject
    });
    if (inspected.status === 'already_in_workbench') {
      skippedCount += 1;
      continue;
    }
    if (inspected.status !== 'workspace_file_repairable' || !inspected.download) {
      throw new MarkiWorkbenchRehydrateError(
        `marki_recovery_${inspected.status}`,
        '工作池文件当前无法安全修复，请重新扫描后再试。'
      );
    }
    photos[photoIndex] = buildRepairedWorkspacePhoto(existingPhoto, inspected.download);
    repairedCount += 1;
  }

  if (repairedCount === 0) {
    for (const candidate of selectedCandidates) candidate.status = 'already_in_workbench';
    return {
      success: true,
      status: 'nothing_to_recover',
      recoveredCount: 0,
      repairedCount: 0,
      duplicateCount: skippedCount,
      conflictCount: 0,
      skippedCount
    };
  }

  const nextWorkspace = {
    ...currentWorkspace,
    projectId: paths.activeProject.projectId,
    projectName: paths.activeProject.projectName,
    photos
  };
  const snapshotSaveResult = await dependencies.saveSnapshot(
    paths.userDataPath,
    nextWorkspace,
    { activeProject: paths.activeProject }
  );
  if (snapshotSaveResult?.success !== true) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_snapshot_save_failed',
      '文件修复结果未写入工作台，请重试。'
    );
  }
  for (const candidate of selectedCandidates) candidate.status = 'already_in_workbench';
  return {
    success: true,
    status: 'repaired',
    recoveredCount: 0,
    repairedCount,
    duplicateCount: skippedCount,
    conflictCount: 0,
    skippedCount
  };
}

function buildRepairedWorkspacePhoto(photo, download) {
  return {
    ...photo,
    originalPath: download.localPath,
    originalName: download.fileName,
    extension: '.jpg',
    size: Number(download.size) || 0,
    width: Number(download.width) || 0,
    height: Number(download.height) || 0,
    sha256: download.sha256,
    originalMissing: false,
    fileHealth: {
      resolvedPath: download.localPath,
      exists: true,
      isFile: true,
      readable: true,
      size: Number(download.size) || 0,
      sizeValid: Number(download.size) > 0,
      mimeType: 'image/jpeg',
      extensionSupported: true,
      decodable: true,
      currentSha256: download.sha256,
      expectedSha256: download.sha256,
      fingerprintMatches: true,
      healthStatus: 'healthy',
      failureReason: ''
    }
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
  buildStructuredImportBundle,
  activeProject
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
    }, { batchId, activeProject });
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
    download: candidate.download,
    projectAssignmentSource: candidate.projectAssignmentSource
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

function resolveRecoveryProjectAssignment({
  activeProject,
  projectOptions,
  sourceProjectText,
  assignedProject
}) {
  const lockedProjectId = normalizeText(assignedProject?.projectId);
  const lockedProjectName = normalizeProjectText(assignedProject?.projectName);
  if (lockedProjectId && lockedProjectId !== activeProject.projectId) {
    return { compatible: false, status: 'source_project_locked' };
  }
  const sourceText = normalizeProjectText(sourceProjectText);
  if (!sourceText) {
    return {
      compatible: true,
      projectAssignmentSource: 'active_project_context',
      assignedProject: activeProject
    };
  }
  const normalizedOptions = (Array.isArray(projectOptions) ? projectOptions : [])
    .map((item) => ({
      projectId: normalizeText(item?.id),
      projectName: normalizeProjectText(item?.name)
    }))
    .filter((item) => item.projectId && item.projectName);
  const exactMatch = normalizedOptions.find((item) => item.projectName === sourceText);
  if (!exactMatch) return { compatible: false, status: 'project_unresolved' };
  if (exactMatch.projectId !== activeProject.projectId) {
    return { compatible: false, status: 'project_mismatch' };
  }
  return {
    compatible: true,
    projectAssignmentSource: 'marki_structured_confirmed',
    assignedProject: activeProject
  };
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
  const activeProject = normalizeActiveProject(input.activeProject);
  if (!documentsPath || !path.isAbsolute(documentsPath) || !userDataPath || !path.isAbsolute(userDataPath)) {
    throw new MarkiWorkbenchRehydrateError(
      'marki_recovery_paths_invalid',
      '恢复服务目录无效。'
    );
  }
  return { documentsPath, userDataPath, activeProject };
}

function normalizeActiveProject(value) {
  const projectId = normalizeText(value?.projectId);
  const projectName = normalizeProjectText(value?.projectName);
  if (!projectId || !projectName) {
    throw new MarkiWorkbenchRehydrateError(
      'active_project_required',
      '请选择当前工作项目。'
    );
  }
  return { projectId, projectName };
}

function normalizeProjectText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeRecoveryTokens(input) {
  const allowedKeys = new Set(['documentsPath', 'userDataPath', 'activeProject', 'recoveryTokens']);
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
    resolveSourceStatuses: options.resolveSourceStatuses
      || resolveMarkiImportSourceStatuses,
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
