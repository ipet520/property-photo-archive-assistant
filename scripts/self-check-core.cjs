const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const {
  buildArchivePreview,
  archivePhotos,
  recoverPendingArchiveTransactions
} = require('../electron/services/archiveService.cjs');
const { buildPackagePlan, generateArchivePackage } = require('../electron/services/archivePackageService.cjs');
const { matchArchivedPhotos } = require('../electron/services/archiveFingerprintService.cjs');
const {
  buildArchiveOperationKey,
  buildArchiveSourceIdentity,
  getArchiveTransactionDirectory
} = require('../electron/services/archiveTransactionService.cjs');
const {
  getLedgerPath,
  normalizeExistingLedgerRows,
  recoverLedgerSwapArtifacts
} = require('../electron/services/excelService.cjs');
const { loadDashboardData } = require('../electron/services/dashboardService.cjs');
const { getDataMaintenanceReport } = require('../electron/services/dataMaintenanceService.cjs');
const {
  loadUserConfigs,
  saveAllUserConfigs
} = require('../electron/services/configService.cjs');
const { inspectDirectoryHealth } = require('../electron/services/directoryHealthService.cjs');
const { scanImages, scanImagesWithHealth } = require('../electron/services/fileService.cjs');
const { inspectPhotoSourceFile } = require('../electron/services/photoFileHealthService.cjs');
const { loadLedgerRecords } = require('../electron/services/ledgerQueryService.cjs');
const { getRecognitionStatus } = require('../electron/services/recognitionService.cjs');
const {
  buildMarkiPostSignature,
  listMarkiMembers,
  listMarkiMoments,
  listMarkiTeams
} = require('../electron/services/markiApiService.cjs');
const {
  HARD_TTL_MS,
  IDLE_TTL_MS,
  MAX_ACTIVE_SESSIONS,
  MAX_SESSION_PHOTOS,
  createMarkiPhotoQuerySessionService
} = require('../electron/services/markiPhotoQuerySessionService.cjs');
const {
  getMarkiCredentialStatus,
  loadMarkiCredentials,
  saveMarkiCredentials
} = require('../electron/services/markiCredentialService.cjs');
const {
  downloadMarkiPhoto,
  inspectJpegFile,
  retryMarkiPhotoDownload
} = require('../electron/services/markiPhotoDownloadService.cjs');
const {
  buildMarkiSourceKey,
  checkMarkiSourceKeys,
  getMarkiImportRoot,
  getMarkiSourceManifestPath,
  getMarkiSourceRecordByKey,
  hasMarkiSourceKey,
  loadMarkiSourceManifest,
  loadMarkiSourceManifestForRecovery,
  prepareMarkiSourceForRedownload,
  updateMarkiSourceImportStatus,
  upsertMarkiSourceRecords
} = require('../electron/services/markiSourceManifestService.cjs');
const {
  buildMarkiStructuredImportBundle,
  buildMarkiWorkbenchImportPackage,
  cleanMarkiFieldValue,
  mapMarkiMoment,
  parseMarkiContent
} = require('../electron/services/markiStructuredImportService.cjs');
const {
  buildMarkiSourceMetadataRecord,
  buildMarkiSourceMetadataRef,
  getMarkiSourceMetadataPath,
  loadMarkiSourceMetadata,
  saveMarkiSourceMetadata
} = require('../electron/services/markiSourceMetadataService.cjs');
const {
  prepareMarkiStructuredImport
} = require('../electron/services/markiImportOrchestratorService.cjs');
const {
  beginMarkiImportBatch,
  cleanupExpiredMarkiImportBatches,
  consumeMarkiImportBatch,
  getMarkiImportBatch,
  listReadyMarkiImportBatches,
  markMarkiImportBatchFailed,
  markMarkiImportBatchReady
} = require('../electron/services/markiImportBatchService.cjs');
const {
  importMarkiPhotoQuerySelection
} = require('../electron/services/markiTrustedImportService.cjs');
const {
  beginMarkiImportLifecycleBatch,
  cleanupMarkiImportLifecycleCache,
  clearMarkiImportLifecycleRecord,
  completeMarkiImportLifecycleBatch,
  listMarkiImportLifecycleRecords,
  markMarkiImportLifecycleAppending,
  markMarkiImportLifecycleDownloading,
  markMarkiImportLifecycleReady,
  recoverMarkiImportLifecycle,
  resolveMarkiImportSourceStatuses,
  resolveWorkspaceSourceOccupancy,
  settleMarkiImportLifecycleDownloads,
  undoMarkiImportLifecycleBatch
} = require('../electron/services/markiImportLifecycleService.cjs');
const {
  SNAPSHOT_SCHEMA_VERSION,
  createEmptyWorkspace,
  getSortWorkspaceSnapshotPath,
  loadSortWorkspaceSnapshot,
  saveSortWorkspaceSnapshot
} = require('../electron/services/sortWorkspaceSnapshotService.cjs');
const {
  SAFE_SUMMARY_FIELDS,
  createMarkiWorkbenchRehydrateService
} = require('../electron/services/markiWorkbenchRehydrateService.cjs');
const { saveRectificationItem } = require('../electron/services/rectificationService.cjs');
const { saveSettings } = require('../electron/services/settingsService.cjs');
const {
  getRuntimeConfigurationPaths,
  loadRuntimeConfiguration,
  migrateLegacyConfiguration,
  saveRuntimeDirectory,
  saveRuntimeSettings
} = require('../electron/services/runtimeConfigurationService.cjs');
const { loadSummaryData } = require('../electron/services/summaryService.cjs');
const {
  validateRuntimeManifest,
  ensureRapidOcrRunner,
  resolveInstallPath,
  serializeRuntimeError,
  verifyRunnerFile
} = require('./ensure-rapidocr-runner.cjs');

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-archive-self-check-'));
  try {
    await checkRapidOcrRuntimeProvisioning(path.join(temporaryRoot, 'rapidocr-runtime'));
    await checkRecognitionEngine(temporaryRoot);
    await checkRecognitionModelCompatibility();
    await checkRuntimeConfigurationFoundation(path.join(temporaryRoot, 'runtime-configuration'));
    await checkMarkiFoundation(path.join(temporaryRoot, 'marki'));
    await checkMarkiPhotoQuerySessions(path.join(temporaryRoot, 'marki-photo-query'));
    await checkMarkiImportTimeHelpers();
    await checkMarkiReadyBatchRefresh();
    await checkMarkiImportLifecycleClosure(path.join(temporaryRoot, 'marki-import-lifecycle'));
    await checkSecondReviewBlockers(path.join(temporaryRoot, 'second-review-blockers'));
    await checkMarkiSourceManifest(path.join(temporaryRoot, 'marki-source'));
    await checkMarkiPhotoDownload(path.join(temporaryRoot, 'marki-download'));
    await checkMarkiSourceMetadata(path.join(temporaryRoot, 'marki-source-metadata'));
    await checkMarkiStructuredImport(path.join(temporaryRoot, 'marki-structured'));
    await checkMarkiImportOrchestrator(path.join(temporaryRoot, 'marki-orchestrator'));
    await checkMarkiImportBatchService(path.join(temporaryRoot, 'marki-import-batches'));
    await checkMarkiTrustedImport(path.join(temporaryRoot, 'marki-trusted-import'));
    await checkMarkiEndToEndFlow(path.join(temporaryRoot, 'marki-end-to-end'));
    await checkMarkiWorkbenchImport();
    await checkSortWorkspaceSnapshot(path.join(temporaryRoot, 'sort-workspace-snapshot'));
    await checkMarkiWorkbenchRehydration(path.join(temporaryRoot, 'marki-workbench-rehydration'));
    await checkSourceAwareRecognition(path.join(temporaryRoot, 'source-aware-recognition'));
    await checkSmartGroupDateBoundaries(path.join(temporaryRoot, 'smart-group-date-boundaries'));
    await checkUnifiedPhotoPool(path.join(temporaryRoot, 'unified-photo-pool'));
    await checkSortWorkspaceToolbar(path.join(temporaryRoot, 'sort-workspace-toolbar'));
    await checkCurrentFormContract(path.join(temporaryRoot, 'canonical-form'));
    await checkWatermarkTemplateFormContract(path.join(temporaryRoot, 'watermark-template-form'));
    await checkSmartClassificationBusinessClosure(path.join(temporaryRoot, 'smart-classification-business-closure'));
    await checkMaintenanceRecommendations(path.join(temporaryRoot, 'maintenance'));
    await checkSmartSortOutcomes(path.join(temporaryRoot, 'smart-sort'));
    await checkArchiveFlow(path.join(temporaryRoot, 'archive-flow'));
    await checkArchiveTransactionRecovery(path.join(temporaryRoot, 'archive-transaction'));
    await checkSourceContracts();
    console.log('核心流程自检通过：RapidOCR 运行时、OCR、马克照片查询会话、来源清单、来源元数据、下载、结构化导入、主进程编排与临时批次、智拣、表单、预览、归档、台账、指纹和 IPC 契约均正常。');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  await assert.rejects(
    () => fs.access(temporaryRoot),
    (error) => error?.code === 'ENOENT',
    '核心自检结束后应清理系统临时目录'
  );
}

async function checkSecondReviewBlockers(root) {
  let scenarioCount = 0;
  let assertionCount = 0;
  const scenario = () => {
    scenarioCount += 1;
  };
  const check = (condition, message) => {
    assert.ok(condition, message);
    assertionCount += 1;
  };
  const equal = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    assertionCount += 1;
  };
  await fs.mkdir(root, { recursive: true });

  const repairDocuments = path.join(root, 'repair-documents');
  const repairUserData = path.join(root, 'repair-user-data');
  const repairInput = {
    orgId: '12345',
    momentId: 'repair-retry-001',
    teamId: '10',
    uid: '20',
    postTime: 1784764800,
    shootDate: '2026-07-23',
    markName: '巡查检查工作记录',
    url: 'https://mock.invalid/repair-retry-001.jpg'
  };
  const originalJpeg = createTestJpeg(4, 3);
  const replacementJpeg = Buffer.from(originalJpeg);
  replacementJpeg[12] ^= 0x01;
  const decodeFourByThree = async () => ({ decodable: true, width: 4, height: 3 });
  const initialDownload = await downloadMarkiPhoto(repairDocuments, repairInput, {
    fetchImpl: async () => new Response(originalJpeg, { status: 200 }),
    decodeImage: decodeFourByThree
  });
  const sourceKey = buildMarkiSourceKey(repairInput.orgId, repairInput.momentId);
  const importedBeforeRepair = await getMarkiSourceRecordByKey(
    repairDocuments,
    repairInput.orgId,
    sourceKey
  );
  const corruptOldFile = Buffer.from(originalJpeg);
  corruptOldFile[13] ^= 0x01;
  await fs.writeFile(initialDownload.localPath, corruptOldFile);
  const repairRequired = await prepareMarkiSourceForRedownload(
    repairDocuments,
    repairInput.orgId,
    sourceKey
  );
  scenario();
  equal(repairRequired.importStatus, 'repair_required', '损坏 imported 文件必须进入 repair_required');
  equal(
    repairRequired.record.downloadInfo,
    importedBeforeRepair.downloadInfo,
    '进入修复状态必须完整保留旧 downloadInfo'
  );

  await assert.rejects(
    () => retryMarkiPhotoDownload(repairDocuments, repairInput, {
      fetchImpl: async () => new Response('', { status: 503 }),
      decodeImage: decodeFourByThree
    }),
    (error) => error?.code === 'download_http_error',
    '第一次修复下载失败必须返回受控下载错误'
  );
  assertionCount += 1;
  const firstRepairFailure = await getMarkiSourceRecordByKey(
    repairDocuments,
    repairInput.orgId,
    sourceKey
  );
  scenario();
  equal(firstRepairFailure.importStatus, 'repair_failed', '修复下载失败必须进入 repair_failed');
  equal(
    firstRepairFailure.downloadInfo,
    importedBeforeRepair.downloadInfo,
    'repair_failed 必须跨重试保留旧下载身份'
  );
  equal(
    await fs.readFile(initialDownload.localPath),
    corruptOldFile,
    '修复下载失败前不得移动或删除旧文件'
  );

  const repairableStatus = await resolveMarkiImportSourceStatuses({
    documentsPath: repairDocuments,
    userDataPath: repairUserData,
    orgId: repairInput.orgId,
    sourceKeys: [sourceKey]
  }, {
    loadSnapshot: async () => ({
      success: true,
      found: true,
      snapshot: {
        workspace: {
          photos: [{
            id: 'stable-repair-photo-id',
            sourceType: 'marki_api',
            sourceKey,
            originalMissing: false,
            fileHealth: { exists: true, healthStatus: 'fingerprint_changed' }
          }]
        }
      }
    }),
    loadManifest: () => loadMarkiSourceManifest(repairDocuments, repairInput.orgId)
  });
  scenario();
  equal(
    repairableStatus.bySourceKey[sourceKey],
    'workspace_file_repairable',
    '进程重启后 repair_failed 工作池照片仍必须可修复'
  );

  const repairedDownload = await retryMarkiPhotoDownload(repairDocuments, repairInput, {
    fetchImpl: async () => new Response(replacementJpeg, { status: 200 }),
    decodeImage: decodeFourByThree
  });
  const repairedRecord = await getMarkiSourceRecordByKey(
    repairDocuments,
    repairInput.orgId,
    sourceKey
  );
  scenario();
  equal(repairedRecord.importStatus, 'imported', '修复重试成功必须恢复 imported');
  check(repairedRecord.downloadInfo.sha256 !== importedBeforeRepair.downloadInfo.sha256, '修复成功必须保存新 SHA');
  equal(await fs.readFile(repairedDownload.localPath), replacementJpeg, '修复成功必须原位安装新 JPG');
  const repairedWorkspace = (await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/markiImportLifecycle.js')).href}?review=${Date.now()}`
  )).prepareMarkiWorkspaceFileRepairs({
    photos: [{
      id: 'stable-repair-photo-id',
      sourceType: 'marki_api',
      sourceKey,
      originalMissing: true,
      sortStatus: 'assigned',
      smartSortStatus: 'completed'
    }],
    recognitionResultsByPhoto: {
      'stable-repair-photo-id': { platformBaseline: { project: '潇湘新区二期' } }
    },
    watermarkRecordsByPhoto: {
      'stable-repair-photo-id': { projectText: '潇湘新区二期' }
    },
    archiveSuggestionsByPhoto: {
      'stable-repair-photo-id': { status: 'confirmed' }
    },
    photoDraftByPhotoId: {
      'stable-repair-photo-id': { remarks: '保留人工草稿' }
    },
    groupDraftByGroupId: {
      'group-stable': { date: '2026-07-23' }
    }
  }, {
    photos: [{
      id: 'generated-repair-id',
      sourceType: 'marki_api',
      sourceKey,
      originalPath: repairedDownload.localPath,
      originalName: repairedDownload.fileName,
      extension: '.jpg',
      size: repairedDownload.size,
      sha256: repairedDownload.sha256,
      width: repairedDownload.width,
      height: repairedDownload.height,
      modifiedAt: repairedDownload.completedAt,
      thumbnailPath: 'local-photo://repair',
      previewUrl: 'local-photo://repair'
    }]
  });
  equal(repairedWorkspace.workspace.photos[0].id, 'stable-repair-photo-id', '工作池修复必须保持 photoId');
  equal(repairedWorkspace.workspace.photos[0].sortStatus, 'assigned', '工作池修复必须保持 sortStatus');
  equal(repairedWorkspace.workspace.photos[0].smartSortStatus, 'completed', '工作池修复必须保持 smartSortStatus');
  equal(
    repairedWorkspace.workspace.photoDraftByPhotoId['stable-repair-photo-id'].remarks,
    '保留人工草稿',
    '工作池修复必须保持照片草稿且 OCR 调用为 0'
  );

  await fs.writeFile(repairedDownload.localPath, corruptOldFile);
  await prepareMarkiSourceForRedownload(repairDocuments, repairInput.orgId, sourceKey);
  await assert.rejects(
    () => retryMarkiPhotoDownload(repairDocuments, repairInput, {
      fetchImpl: async () => new Response(Buffer.from('not-jpeg'), { status: 200 }),
      decodeImage: decodeFourByThree
    }),
    (error) => error?.code === 'invalid_jpeg_header',
    '修复新文件校验失败必须拒绝安装'
  );
  assertionCount += 1;
  equal(await fs.readFile(repairedDownload.localPath), corruptOldFile, '新文件校验失败必须保持旧文件原状');
  equal(
    (await getMarkiSourceRecordByKey(repairDocuments, repairInput.orgId, sourceKey)).importStatus,
    'repair_failed',
    '校验失败后必须继续保留 repair_failed 重试语义'
  );

  const {
    mergeMarkiWorkbenchImportPackage
  } = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/markiWorkbenchImport.js')).href}?review=${Date.now()}`
  );
  const {
    mergeScannedLocalPhotoSubpool
  } = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/unifiedPhotoPool.js')).href}?review=${Date.now()}`
  );
  const snapshotTools = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/sortWorkspaceSnapshot.js')).href}?review=${Date.now()}`
  );
  const oldPhotos = Array.from({ length: 10 }, (_, index) => ({
    id: `old-photo-${index + 1}`,
    sourceType: 'local_file',
    originalPath: `C:\\mock\\old-${index + 1}.jpg`,
    originalName: `old-${index + 1}.jpg`,
    extension: '.jpg',
    size: 100 + index,
    sha256: String(index + 1).padStart(64, '0'),
    sortStatus: index === 0 ? 'previewed' : 'assigned',
    smartSortStatus: 'completed',
    previewInfo: index === 0 ? { status: '待归档' } : null
  }));
  const oldSmartSortResult = {
    status: 'created',
    photoCount: 10,
    groupCount: 3,
    groups: [
      { id: 'group-1', photoIds: oldPhotos.slice(0, 4).map((photo) => photo.id) },
      { id: 'group-2', photoIds: oldPhotos.slice(4, 7).map((photo) => photo.id) },
      { id: 'group-3', photoIds: oldPhotos.slice(7).map((photo) => photo.id) }
    ]
  };
  const oldPreviewPlan = {
    schemaVersion: 1,
    planId: 'a'.repeat(64),
    createdAt: '2026-07-23T00:00:00.000Z',
    archiveRoot: 'C:\\mock\\archive',
    items: [{ photoId: oldPhotos[0].id }]
  };
  const oldWorkspace = {
    photos: oldPhotos,
    selectedIds: [oldPhotos[0].id],
    activePhotoId: oldPhotos[0].id,
    recognitionResultsByPhoto: Object.fromEntries(oldPhotos.map((photo) => [photo.id, { id: photo.id }])),
    watermarkRecordsByPhoto: Object.fromEntries(oldPhotos.map((photo) => [photo.id, { id: photo.id }])),
    archiveSuggestionsByPhoto: Object.fromEntries(oldPhotos.map((photo) => [photo.id, { id: photo.id }])),
    photoDraftByPhotoId: { [oldPhotos[0].id]: { remarks: '旧照片草稿' } },
    groupDraftByGroupId: { 'group-1': { date: '2026-07-23' } },
    smartSortResult: oldSmartSortResult,
    archivePreviewPlan: oldPreviewPlan,
    smartSortViewMode: 'smartSortGroup',
    activeSmartSortGroupId: 'group-1',
    filter: 'pending_organize',
    searchText: '旧筛选'
  };
  const markiPhoto = {
    id: 'new-marki-photo',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:12345:new-marki-photo',
    originalPath: 'C:\\mock\\new-marki.jpg',
    originalName: 'new-marki.jpg',
    extension: '.jpg',
    size: 500,
    sha256: 'b'.repeat(64)
  };
  const markiMerged = mergeMarkiWorkbenchImportPackage(oldWorkspace, {
    batchId: 'marki-import-review-append',
    photos: [markiPhoto],
    recognitionResultsByPhoto: { [markiPhoto.id]: { source: 'marki_api' } },
    watermarkRecordsByPhoto: { [markiPhoto.id]: { source: 'marki_api' } },
    archiveSuggestionsByPhoto: { [markiPhoto.id]: { source: 'marki_api' } }
  });
  const markiWorkspace = snapshotTools.prepareWorkspaceAfterPhotoAppend({
    workspace: { ...oldWorkspace, ...markiMerged },
    addedPhotoIds: markiMerged.addedPhotoIds
  });
  scenario();
  equal(markiWorkspace.photos.slice(0, 10), oldPhotos, 'Marki 追加必须完整保留旧照片对象和值');
  equal(markiWorkspace.smartSortResult, oldSmartSortResult, 'Marki 追加必须保留旧 membership');
  equal(markiWorkspace.groupDraftByGroupId, oldWorkspace.groupDraftByGroupId, 'Marki 追加必须保留组草稿');
  equal(markiWorkspace.archivePreviewPlan, oldPreviewPlan, '无关 Marki 追加不得使 PreviewPlan 失效');
  equal(markiWorkspace.activeSmartSortGroupId, 'group-1', 'Marki 追加必须保留当前分组');
  equal(markiWorkspace.photos[10].sortStatus, 'unassigned', 'Marki 新照片必须从 unassigned 开始');
  equal(markiWorkspace.photos[10].smartSortStatus, 'not_run', 'Marki 新照片必须从 not_run 开始');

  const localMerged = mergeScannedLocalPhotoSubpool({
    currentPhotos: markiWorkspace.photos,
    scannedPhotos: [{
      id: 'scan-id',
      name: 'new-local.jpg',
      path: 'C:\\mock\\new-local.jpg',
      extension: '.jpg',
      size: 600,
      sha256: 'c'.repeat(64),
      modifiedAt: '2026-07-23T01:00:00.000Z',
      previewUrl: 'local-photo://new-local'
    }],
    recognitionResultsByPhoto: markiWorkspace.recognitionResultsByPhoto,
    watermarkRecordsByPhoto: markiWorkspace.watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto: markiWorkspace.archiveSuggestionsByPhoto,
    selectedIds: markiWorkspace.selectedIds,
    activePhotoId: markiWorkspace.activePhotoId
  });
  const localWorkspace = snapshotTools.buildSortWorkspaceSnapshotWorkspace({
    ...markiWorkspace,
    ...localMerged
  });
  scenario();
  equal(localWorkspace.photos.slice(0, 10), oldPhotos, '本地追加必须继续完整保留旧十张照片');
  equal(localWorkspace.smartSortResult, oldSmartSortResult, '本地追加不得清空旧分组');
  equal(localWorkspace.archivePreviewPlan, oldPreviewPlan, '本地追加不得清空旧预览计划');
  equal(localWorkspace.photos.at(-1).sortStatus, 'unassigned', '本地新照片必须从 unassigned 开始');
  equal(localWorkspace.photos.at(-1).smartSortStatus, 'not_run', '本地新照片必须从 not_run 开始');

  const formTools = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/sortRightPanelState.js')).href}?review=${Date.now()}`
  );
  const configs = {
    projects: ['潇湘新区二期'],
    projectOptions: [{ id: 'project-x', name: '潇湘新区二期' }],
    watermarkCategories: {
      机动车违规管理: { items: ['占用消防通道', '随意停放阻碍通行'] },
      工程类工作记录: { items: ['电梯维修维保'] },
      时间地点水印: { items: [] },
      巡查检查工作记录: { items: ['秩序巡查'] }
    },
    constructionUnits: [
      { id: 'unit-a', name: '甲施工单位', enabled: true, projectIds: ['project-x'] },
      { id: 'unit-b', name: '乙施工单位', enabled: true, projectIds: ['project-x'] }
    ]
  };
  const batchPatch = formTools.buildBatchArchiveFormPatch({
    date: '2026-07-24',
    project: '潇湘新区二期',
    projectName: '潇湘新区二期',
    projectId: 'project-x',
    projectOriginalText: '潇湘新区二期',
    projectConfirmed: true,
    projectSource: 'manual',
    watermarkTemplateType: 'vehicle_violation',
    watermarkCategory: '机动车违规管理',
    archiveCategory: '机动车违规管理',
    workContent: '占用消防通道'
  }, { editedFields: ['date', 'project'] });
  const formPhotos = [
    { id: 'vehicle-a' },
    { id: 'vehicle-b' },
    { id: 'engineering-a' },
    { id: 'engineering-b' },
    { id: 'time-location-a' },
    { id: 'standard-a' },
    { id: 'standard-b' }
  ];
  const effectiveById = {
    'vehicle-a': makeEffectiveArchiveInfo('vehicle_violation', '机动车违规管理', '占用消防通道', {
      vehiclePlate: '云D12345',
      violationType: '占用消防通道',
      location: 'A区',
      remarks: '车辆A'
    }),
    'vehicle-b': makeEffectiveArchiveInfo('vehicle_violation', '机动车违规管理', '随意停放阻碍通行', {
      vehiclePlate: '云D67890',
      violationType: '随意停放阻碍通行',
      location: 'B区',
      remarks: '车辆B'
    }),
    'engineering-a': makeEffectiveArchiveInfo('standard_work_record', '工程类工作记录', '电梯维修维保', {
      constructionUnitId: 'unit-a',
      constructionUnitName: '甲施工单位',
      constructionUnitOriginalText: '甲施工单位',
      constructionUnitConfirmed: true,
      constructionUnitSource: 'watermark_match'
    }),
    'engineering-b': makeEffectiveArchiveInfo('standard_work_record', '工程类工作记录', '电梯维修维保', {
      constructionUnitId: 'unit-b',
      constructionUnitName: '乙施工单位',
      constructionUnitOriginalText: '乙施工单位原文',
      constructionUnitConfirmed: true,
      constructionUnitSource: 'manual'
    }),
    'time-location-a': makeEffectiveArchiveInfo('time_location', '时间地点水印', 'not_applicable', {
      location: '地下车库'
    }),
    'standard-a': makeEffectiveArchiveInfo('standard_work_record', '巡查检查工作记录', '秩序巡查', {
      location: '东门',
      remarks: '夜班巡查'
    }),
    'standard-b': makeEffectiveArchiveInfo('standard_work_record', '巡查检查工作记录', '秩序巡查', {
      location: '西门',
      remarks: '白班巡查'
    })
  };
  const perPhotoForms = formTools.buildPerPhotoArchivePreviewInputs({
    photos: formPhotos,
    effectiveArchiveInfoByPhotoId: effectiveById,
    batchPatch,
    configs
  });
  const formsById = new Map(perPhotoForms.map((item) => [item.photo.id, item]));
  scenario();
  equal(formsById.get('vehicle-a').serviceForm.vehiclePlate, '云D12345', '批量项目日期不得覆盖照片 A 车牌');
  equal(formsById.get('vehicle-b').serviceForm.vehiclePlate, '云D67890', '批量项目日期不得覆盖照片 B 车牌');
  equal(formsById.get('vehicle-b').serviceForm.violationType, '随意停放阻碍通行', '不同违停类型必须保持照片级隔离');
  equal(formsById.get('engineering-a').serviceForm.constructionUnitId, 'unit-a', '工程照片 A 施工单位 ID 必须保留');
  equal(formsById.get('engineering-b').serviceForm.constructionUnitOriginalText, '乙施工单位原文', '工程照片 B 施工单位原文必须保留');
  equal(formsById.get('standard-a').serviceForm.location, '东门', '普通照片 A 位置必须保留');
  equal(formsById.get('standard-b').serviceForm.remark, '白班巡查', '普通照片 B 备注必须保留');
  equal(formsById.get('time-location-a').serviceForm.workContent, 'not_applicable', '时间地点工作内容必须固定不适用');
  check(perPhotoForms.every((item) => item.missingFields.length === 0), '混合模板必须逐张通过各自模板校验');
  check(
    new Set(perPhotoForms.map((item) => item.archiveInfo)).size === perPhotoForms.length,
    '每张照片必须生成独立 archiveInfo 对象'
  );

  const previewRoot = path.join(root, 'per-photo-preview');
  await fs.mkdir(previewRoot, { recursive: true });
  const previewPhotos = [];
  for (const [index, item] of perPhotoForms.entries()) {
    const sourcePath = path.join(previewRoot, `${item.photo.id}.jpg`);
    await fs.writeFile(sourcePath, createTestJpeg(4 + index, 3 + index));
    previewPhotos.push({
      ...item.serviceForm,
      id: item.photo.id,
      path: sourcePath,
      name: `${item.photo.id}.jpg`,
      extension: '.jpg',
      sourceType: 'local_file'
    });
  }
  const preview = await buildArchivePreview({
    form: perPhotoForms[0].serviceForm,
    photos: previewPhotos,
    archiveRoot: path.join(root, 'per-photo-archive')
  });
  scenario();
  const ledgerByPhotoId = new Map(
    preview.previewPlan.items.map((item) => [item.photoId, item.ledgerRow])
  );
  equal(ledgerByPhotoId.get('vehicle-a').vehiclePlate, '云D12345', 'PreviewPlan 必须保存照片 A 自己的车牌');
  equal(ledgerByPhotoId.get('vehicle-b').vehiclePlate, '云D67890', 'PreviewPlan 必须保存照片 B 自己的车牌');
  equal(ledgerByPhotoId.get('engineering-a').constructionUnitId, 'unit-a', 'PreviewPlan 必须保存照片 A 自己的施工单位');
  equal(ledgerByPhotoId.get('engineering-b').constructionUnitId, 'unit-b', 'PreviewPlan 必须保存照片 B 自己的施工单位');

  const relinkTools = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/photoRelink.js')).href}?review=${Date.now()}`
  );
  const relinkRoot = path.join(root, 'local-relink');
  await fs.mkdir(relinkRoot, { recursive: true });
  const expectedPath = path.join(relinkRoot, 'expected.jpg');
  const wrongPath = path.join(relinkRoot, 'same-name.jpg');
  await fs.writeFile(expectedPath, originalJpeg);
  await fs.writeFile(wrongPath, replacementJpeg);
  const expectedSha = createHash('sha256').update(originalJpeg).digest('hex');
  const wrongSha = createHash('sha256').update(replacementJpeg).digest('hex');
  const missingLocal = {
    id: 'missing-local',
    sourceType: 'local_file',
    originalMissing: true,
    originalName: 'same-name.jpg',
    size: replacementJpeg.length,
    sha256: expectedSha,
    fileHealth: { expectedSha256: expectedSha, healthStatus: 'missing' }
  };
  scenario();
  equal(
    relinkTools.selectLocalPhotoRelinkCandidate(missingLocal, [{
      name: 'same-name.jpg',
      path: wrongPath,
      size: replacementJpeg.length,
      sha256: wrongSha
    }]).success,
    false,
    '同名同大小但 SHA 不同不得自动恢复'
  );
  const candidate = {
    name: 'expected.jpg',
    path: expectedPath,
    extension: '.jpg',
    size: originalJpeg.length,
    modifiedAt: '2026-07-23T02:00:00.000Z',
    sha256: expectedSha,
    previewUrl: 'local-photo://expected'
  };
  const selectedCandidate = relinkTools.selectLocalPhotoRelinkCandidate(missingLocal, [candidate]);
  const healthy = await inspectPhotoSourceFile(expectedPath, expectedSha, {
    decodeImage: decodeFourByThree
  });
  const relinked = relinkTools.buildRelinkedLocalPhoto(missingLocal, candidate, healthy);
  check(Boolean(relinked), 'SHA 一致且健康检查通过的本地照片必须可恢复');
  equal(relinked.fileHealth.healthStatus, 'healthy', '恢复后文件健康状态必须为 healthy');
  equal(relinked.sha256, expectedSha, '恢复不得修改历史 expected SHA');
  equal(
    relinkTools.selectLocalPhotoRelinkCandidate({
      ...missingLocal,
      sourceType: 'marki_api',
      sourceKey
    }, [candidate]).reason,
    'marki_requires_trusted_repair',
    'Marki 照片不得进入通用本地重新定位'
  );
  equal(
    relinkTools.selectLocalPhotoRelinkCandidate({
      ...missingLocal,
      sha256: '',
      fileHealth: {}
    }, [candidate]).reason,
    'historical_fingerprint_missing',
    '无历史 SHA 的照片不得自动恢复'
  );
  const decodeFailure = await inspectPhotoSourceFile(expectedPath, expectedSha, {
    decodeImage: async () => ({ decodable: false, width: 0, height: 0 })
  });
  equal(
    relinkTools.buildRelinkedLocalPhoto(missingLocal, candidate, decodeFailure),
    null,
    '真实解码失败的候选不得恢复'
  );
  let relinkCommitCount = 0;
  const failedRelinkPersist = await snapshotTools.persistLocalPhotoRelinks({
    currentWorkspace: { photos: [missingLocal] },
    nextPhotos: [relinked],
    saveSnapshot: async () => ({ success: false }),
    commitWorkspace: () => {
      relinkCommitCount += 1;
    }
  });
  equal(failedRelinkPersist.success, false, '快照保存失败必须返回失败');
  equal(relinkCommitCount, 0, '快照保存失败不得提交 renderer 内存状态');
  check(selectedCandidate.success, '相同 SHA 候选必须可以确定选择');

  const invalidLegacyRoot = path.join(root, 'config-legacy');
  const invalidCanonicalRoot = path.join(root, 'config-canonical-invalid');
  await loadUserConfigs(invalidLegacyRoot);
  await saveSettings(invalidLegacyRoot, { defaultPhotoFolder: 'D:\\模拟照片' });
  const invalidPaths = getRuntimeConfigurationPaths({
    userDataPath: invalidCanonicalRoot,
    documentsPath: invalidLegacyRoot
  });
  await fs.mkdir(path.join(invalidPaths.canonicalAppDir, 'config'), { recursive: true });
  const invalidProjectsPath = path.join(invalidPaths.canonicalAppDir, 'config', 'projects.json');
  const invalidProjectsText = JSON.stringify({
    projects: [{ id: '', name: '', enabled: true }],
    constructionUnits: []
  });
  await fs.writeFile(invalidProjectsPath, invalidProjectsText, 'utf8');
  const invalidMigration = await migrateLegacyConfiguration({
    userDataPath: invalidCanonicalRoot,
    documentsPath: invalidLegacyRoot
  });
  const invalidMarker = JSON.parse(await fs.readFile(invalidPaths.migrationMarkerPath, 'utf8'));
  scenario();
  equal(
    invalidMarker.fileResults['config/projects.json'].canonicalStatus,
    'invalid_business_schema',
    '可解析但业务结构错误的 projects 必须独立识别'
  );
  equal(
    invalidMarker.fileResults['config/projects.json'].action,
    'blocked_canonical_invalid_business_schema',
    '无效 canonical projects 不得被 legacy 覆盖'
  );
  equal(await fs.readFile(invalidProjectsPath, 'utf8'), invalidProjectsText, '无效 canonical 原文件必须保持');
  check(
    invalidMigration.validationWarnings.some(
      (item) => item.code === 'runtime_configuration_canonical_invalid_business_schema'
    ),
    'canonical 业务结构无效必须返回明确 warning'
  );
  await assert.rejects(
    () => loadRuntimeConfiguration({
      userDataPath: invalidCanonicalRoot,
      documentsPath: invalidLegacyRoot
    }),
    (error) => error?.code === 'invalid_projects_business_schema',
    '运行时不得静默加载无效 canonical projects'
  );
  assertionCount += 1;

  const invalidSettingsLegacyRoot = path.join(root, 'settings-legacy');
  const invalidSettingsCanonicalRoot = path.join(root, 'settings-canonical-invalid');
  await loadUserConfigs(invalidSettingsLegacyRoot);
  await saveSettings(invalidSettingsLegacyRoot, { defaultPhotoFolder: 'D:\\模拟照片' });
  const invalidSettingsPaths = getRuntimeConfigurationPaths({
    userDataPath: invalidSettingsCanonicalRoot,
    documentsPath: invalidSettingsLegacyRoot
  });
  await fs.mkdir(invalidSettingsPaths.canonicalAppDir, { recursive: true });
  const invalidSettingsText = JSON.stringify({ schemaVersion: 1 });
  await fs.writeFile(
    path.join(invalidSettingsPaths.canonicalAppDir, 'settings.json'),
    invalidSettingsText,
    'utf8'
  );
  await migrateLegacyConfiguration({
    userDataPath: invalidSettingsCanonicalRoot,
    documentsPath: invalidSettingsLegacyRoot
  });
  const invalidSettingsMarker = JSON.parse(
    await fs.readFile(invalidSettingsPaths.migrationMarkerPath, 'utf8')
  );
  scenario();
  equal(
    invalidSettingsMarker.fileResults['settings.json'].canonicalStatus,
    'invalid_business_schema',
    '仅含版本元数据的 settings 不得冒充有效业务配置'
  );
  equal(
    invalidSettingsMarker.fileResults['settings.json'].action,
    'blocked_canonical_invalid_business_schema',
    '无效 canonical settings 不得被 legacy 覆盖'
  );
  equal(
    await fs.readFile(path.join(invalidSettingsPaths.canonicalAppDir, 'settings.json'), 'utf8'),
    invalidSettingsText,
    '无效 canonical settings 原文件必须保持'
  );
  await assert.rejects(
    () => loadRuntimeConfiguration({
      userDataPath: invalidSettingsCanonicalRoot,
      documentsPath: invalidSettingsLegacyRoot
    }),
    (error) => error?.code === 'invalid_settings_business_schema',
    '运行时不得静默加载无效 canonical settings'
  );
  assertionCount += 1;

  const invalidLegacySchemaRoot = path.join(root, 'config-invalid-legacy');
  const validCanonicalRoot = path.join(root, 'config-valid-migration-target');
  const invalidLegacyConfigs = await loadUserConfigs(invalidLegacySchemaRoot);
  await saveSettings(invalidLegacySchemaRoot, { defaultArchiveRoot: 'E:\\模拟归档' });
  await fs.writeFile(
    path.join(invalidLegacyConfigs.paths.userConfigDir, 'watermarkCategories.json'),
    JSON.stringify({ wrong: true }),
    'utf8'
  );
  const mixedMigration = await migrateLegacyConfiguration({
    userDataPath: validCanonicalRoot,
    documentsPath: invalidLegacySchemaRoot
  });
  const mixedPaths = getRuntimeConfigurationPaths({
    userDataPath: validCanonicalRoot,
    documentsPath: invalidLegacySchemaRoot
  });
  const mixedMarker = JSON.parse(await fs.readFile(mixedPaths.migrationMarkerPath, 'utf8'));
  scenario();
  equal(
    mixedMarker.fileResults['config/watermarkCategories.json'].legacyStatus,
    'invalid_business_schema',
    'legacy watermarkCategories 业务结构错误必须识别'
  );
  equal(
    mixedMarker.fileResults['config/watermarkCategories.json'].action,
    'blocked_legacy_invalid_business_schema',
    '无效 legacy watermarkCategories 不得迁移'
  );
  equal(
    mixedMarker.fileResults['config/watermarkCategories.json'].validationCode,
    'invalid_watermarkCategories_business_schema',
    '迁移 marker 必须记录真正阻断迁移的 legacy 业务校验码'
  );
  equal(
    mixedMarker.fileResults['config/projects.json'].action,
    'migrated_from_documents',
    '单个文件无效不得阻断其他有效配置逐文件迁移'
  );
  check(
    Object.values(mixedMarker.fileResults).every((item) => (
      item.canonicalStatus
      && item.legacyStatus
      && item.action
      && Object.hasOwn(item, 'conflict')
      && Object.hasOwn(item, 'sourceSha256')
      && Object.hasOwn(item, 'targetSha256')
      && item.completedAt
      && item.validationCode
    )),
    '迁移 marker 每个文件必须保存四态、哈希和 validationCode'
  );
  check(
    mixedMigration.validationWarnings.some(
      (item) => item.code === 'runtime_configuration_legacy_invalid_business_schema'
    ),
    'legacy 业务结构无效必须返回明确 warning'
  );

  console.log(
    `二审阻断项自检通过：${scenarioCount} 个真实行为场景，${assertionCount} 个行为断言；`
    + '覆盖持久修复重试、追加状态保留、逐照片表单、SHA 重连和配置四态迁移。'
  );
}

function makeEffectiveArchiveInfo(template, category, workContent, overrides = {}) {
  return {
    watermarkTemplateType: template,
    date: '2026-07-23',
    project: '潇湘新区二期',
    projectName: '潇湘新区二期',
    projectId: 'project-x',
    projectOriginalText: '潇湘新区二期',
    projectConfirmed: true,
    projectSource: 'config_exact',
    archiveCategory: category,
    watermarkCategory: category,
    workContent,
    location: '',
    locationArea: '',
    keywords: '',
    remarks: '',
    remark: '',
    vehiclePlate: '',
    violationType: '',
    constructionUnitId: '',
    constructionUnitName: '',
    constructionUnitOriginalText: '',
    constructionUnitConfirmed: false,
    constructionUnitSource: '',
    fieldSources: {},
    unresolvedFields: [],
    ...overrides
  };
}

async function checkRuntimeConfigurationFoundation(root) {
  let scenarioCount = 0;
  let assertionCount = 0;
  let migrationAssertionCount = 0;
  let directoryAssertionCount = 0;
  let fileAssertionCount = 0;
  let snapshotAssertionCount = 0;
  const check = (condition, message, bucket = 'behavior') => {
    assert.ok(condition, message);
    assertionCount += 1;
    if (bucket === 'migration') migrationAssertionCount += 1;
    if (bucket === 'directory') directoryAssertionCount += 1;
    if (bucket === 'file') fileAssertionCount += 1;
    if (bucket === 'snapshot') snapshotAssertionCount += 1;
  };
  const equal = (actual, expected, message, bucket = 'behavior') => {
    assert.deepEqual(actual, expected, message);
    assertionCount += 1;
    if (bucket === 'migration') migrationAssertionCount += 1;
    if (bucket === 'directory') directoryAssertionCount += 1;
    if (bucket === 'file') fileAssertionCount += 1;
    if (bucket === 'snapshot') snapshotAssertionCount += 1;
  };
  const scenario = () => {
    scenarioCount += 1;
  };

  const legacyRoot = path.join(root, 'legacy-documents');
  const canonicalRoot = path.join(root, 'canonical-user-data');
  await loadUserConfigs(legacyRoot);
  await saveSettings(legacyRoot, {
    defaultPhotoFolder: 'D:\\物业照片\\待整理',
    defaultArchiveRoot: 'E:\\物业归档',
    defaultArchivePackageRoot: 'E:\\物业资料包'
  });
  const firstRuntime = await loadRuntimeConfiguration({
    userDataPath: canonicalRoot,
    documentsPath: legacyRoot
  }, { now: new Date('2026-07-23T00:00:00.000Z') });
  scenario();
  equal(firstRuntime.loadedFrom, 'userData', '运行配置必须固定从 userData 正式位置加载', 'migration');
  equal(firstRuntime.migratedFrom, 'documents', '首次加载应从旧 Documents 配置迁移', 'migration');
  equal(firstRuntime.photoSourceDirectory, 'D:\\物业照片\\待整理', '迁移后照片来源目录应保持', 'migration');
  equal(firstRuntime.archiveRootDirectory, 'E:\\物业归档', '迁移后归档根目录应保持', 'migration');
  check(/^[a-f0-9]{64}$/.test(firstRuntime.revision), '运行配置应发布稳定 revision', 'migration');

  const secondRuntime = await loadRuntimeConfiguration({
    userDataPath: canonicalRoot,
    documentsPath: legacyRoot
  });
  scenario();
  equal(secondRuntime.revision, firstRuntime.revision, '重复迁移应幂等且 revision 不变', 'migration');
  equal(secondRuntime.migratedFrom, 'documents', '迁移标记应保留旧位置来源', 'migration');

  const conflictLegacyRoot = path.join(root, 'conflict-documents');
  const conflictCanonicalRoot = path.join(root, 'conflict-user-data');
  await loadUserConfigs(conflictLegacyRoot);
  await saveSettings(conflictLegacyRoot, { defaultPhotoFolder: 'D:\\旧照片' });
  await loadUserConfigs(conflictCanonicalRoot);
  await saveSettings(conflictCanonicalRoot, { defaultPhotoFolder: 'D:\\正式照片' });
  const conflictRuntime = await loadRuntimeConfiguration({
    userDataPath: conflictCanonicalRoot,
    documentsPath: conflictLegacyRoot
  });
  scenario();
  equal(conflictRuntime.photoSourceDirectory, 'D:\\正式照片', '迁移冲突必须保留正式 userData 配置', 'migration');
  check(
    conflictRuntime.validationWarnings.some((item) => item.code === 'runtime_configuration_migration_conflict'),
    '迁移冲突必须返回安全 warning',
    'migration'
  );

  const partialLegacyRoot = path.join(root, 'partial-documents');
  const partialCanonicalRoot = path.join(root, 'partial-user-data');
  const partialLegacy = await loadUserConfigs(partialLegacyRoot);
  const partialPaths = getRuntimeConfigurationPaths({
    userDataPath: partialCanonicalRoot,
    documentsPath: partialLegacyRoot
  });
  const legacyProjectContainer = {
    projects: partialLegacy.editableConfigs.projects,
    constructionUnits: [{
      id: 'construction-unit-migration-test',
      name: '迁移施工单位',
      aliases: ['迁移单位'],
      enabled: true,
      sort: 10,
      projectIds: [partialLegacy.editableConfigs.projects[0].id]
    }]
  };
  await fs.writeFile(
    path.join(partialLegacy.paths.userConfigDir, 'projects.json'),
    JSON.stringify(legacyProjectContainer, null, 2),
    'utf8'
  );
  await fs.mkdir(partialPaths.canonicalAppDir, { recursive: true });
  await fs.writeFile(
    path.join(partialPaths.canonicalAppDir, 'settings.json'),
    JSON.stringify({ defaultPhotoFolder: 'D:\\正式照片目录' }, null, 2),
    'utf8'
  );
  const partialMigration = await migrateLegacyConfiguration({
    userDataPath: partialCanonicalRoot,
    documentsPath: partialLegacyRoot
  }, { now: new Date('2026-07-23T00:10:00.000Z') });
  scenario();
  const migratedProjectsPath = path.join(
    partialPaths.canonicalAppDir,
    'config',
    'projects.json'
  );
  equal(
    JSON.parse(await fs.readFile(migratedProjectsPath, 'utf8')).constructionUnits[0].name,
    '迁移施工单位',
    '正式位置只有 settings 时仍必须逐文件迁移 projects 和 constructionUnits',
    'migration'
  );
  equal(partialMigration.migratedFrom, 'documents', '部分迁移必须记录 Documents 来源', 'migration');

  const marker = JSON.parse(await fs.readFile(partialPaths.migrationMarkerPath, 'utf8'));
  scenario();
  equal(marker.schemaVersion, 2, '迁移 marker 必须升级为逐文件 schema', 'migration');
  check(
    Object.values(marker.fileResults).every((item) => (
      item.fileName
      && item.canonicalStatus
      && item.legacyStatus
      && item.action
      && Object.hasOwn(item, 'conflict')
      && Object.hasOwn(item, 'sourceSha256')
      && Object.hasOwn(item, 'targetSha256')
      && item.completedAt
    )),
    '迁移 marker 必须保存每个配置文件的安全结果',
    'migration'
  );
  equal(
    marker.fileResults['config/projects.json'].action,
    'migrated_from_documents',
    'projects 迁移结果必须按文件记录',
    'migration'
  );
  equal(
    marker.fileResults['settings.json'].action,
    'preserved_canonical',
    '正式 settings 必须保留而不阻断其他文件迁移',
    'migration'
  );

  const sameConfigText = await fs.readFile(
    path.join(partialLegacy.paths.userConfigDir, 'keywords.json'),
    'utf8'
  );
  const canonicalKeywordsPath = path.join(partialPaths.canonicalAppDir, 'config', 'keywords.json');
  const beforeSameStat = await fs.stat(canonicalKeywordsPath);
  await fs.writeFile(canonicalKeywordsPath, sameConfigText, 'utf8');
  await migrateLegacyConfiguration({
    userDataPath: partialCanonicalRoot,
    documentsPath: partialLegacyRoot
  }, { now: new Date('2026-07-23T00:11:00.000Z') });
  scenario();
  const afterSameMarker = JSON.parse(await fs.readFile(partialPaths.migrationMarkerPath, 'utf8'));
  equal(
    afterSameMarker.fileResults['config/keywords.json'].action,
    'preserved_canonical',
    '两边相同配置不得重复覆盖',
    'migration'
  );
  equal(
    (await fs.stat(canonicalKeywordsPath)).size,
    beforeSameStat.size,
    '相同配置重复迁移必须保持正式文件内容',
    'migration'
  );

  const canonicalDepartmentsPath = path.join(partialPaths.canonicalAppDir, 'config', 'departments.json');
  await fs.writeFile(
    canonicalDepartmentsPath,
    JSON.stringify([{ id: 'canonical-department', name: '正式部门', enabled: true }]),
    'utf8'
  );
  const canonicalDepartmentBytes = await fs.readFile(canonicalDepartmentsPath);
  const conflictMigration = await migrateLegacyConfiguration({
    userDataPath: partialCanonicalRoot,
    documentsPath: partialLegacyRoot
  }, { now: new Date('2026-07-23T00:12:00.000Z') });
  scenario();
  equal(
    await fs.readFile(canonicalDepartmentsPath),
    canonicalDepartmentBytes,
    '两边配置不同必须保留正式文件',
    'migration'
  );
  check(
    conflictMigration.validationWarnings.some(
      (item) => item.code === 'runtime_configuration_migration_conflict'
    ),
    '逐文件内容冲突必须返回明确 warning',
    'migration'
  );

  const corruptLegacyRoot = path.join(root, 'corrupt-config-documents');
  const corruptCanonicalRoot = path.join(root, 'corrupt-config-user-data');
  const corruptLegacy = await loadUserConfigs(corruptLegacyRoot);
  const corruptPaths = getRuntimeConfigurationPaths({
    userDataPath: corruptCanonicalRoot,
    documentsPath: corruptLegacyRoot
  });
  await fs.mkdir(path.join(corruptPaths.canonicalAppDir, 'config'), { recursive: true });
  const corruptCanonicalProjectsPath = path.join(corruptPaths.canonicalAppDir, 'config', 'projects.json');
  const corruptCanonicalBytes = Buffer.from('{"projects":', 'utf8');
  await fs.writeFile(corruptCanonicalProjectsPath, corruptCanonicalBytes);
  const corruptMigration = await migrateLegacyConfiguration({
    userDataPath: corruptCanonicalRoot,
    documentsPath: corruptLegacyRoot
  }, { now: new Date('2026-07-23T00:13:00.000Z') });
  scenario();
  equal(
    await fs.readFile(corruptCanonicalProjectsPath),
    corruptCanonicalBytes,
    '正式配置损坏时不得使用旧配置自动覆盖',
    'migration'
  );
  check(
    corruptMigration.validationWarnings.some(
      (item) => item.code === 'runtime_configuration_canonical_corrupt_json'
    ),
    '正式配置损坏必须返回阻断 warning',
    'migration'
  );

  const currentConfigs = await loadUserConfigs(canonicalRoot);
  const configPaths = Object.values(currentConfigs.paths ? {
    projects: 'projects.json',
    departments: 'departments.json',
    watermarkCategories: 'watermarkCategories.json',
    keywords: 'keywords.json'
  } : {});
  const beforeConfigFiles = Object.fromEntries(await Promise.all(configPaths.map(async (fileName) => [
    fileName,
    await fs.readFile(path.join(currentConfigs.paths.userConfigDir, fileName), 'utf8')
  ])));
  await assert.rejects(
    () => saveAllUserConfigs(canonicalRoot, currentConfigs.editableConfigs, {
      beforeInstallEntry({ index }) {
        if (index === 1) throw new Error('injected config install failure');
      }
    }),
    /injected config install failure/,
    '多文件配置安装失败应向调用方返回错误'
  );
  scenario();
  assertionCount += 1;
  for (const fileName of configPaths) {
    equal(
      await fs.readFile(path.join(currentConfigs.paths.userConfigDir, fileName), 'utf8'),
      beforeConfigFiles[fileName],
      `配置事务失败后 ${fileName} 应恢复旧 revision`,
      'migration'
    );
  }

  const runtimeAfterFailure = await loadRuntimeConfiguration({
    userDataPath: canonicalRoot,
    documentsPath: legacyRoot
  });
  scenario();
  equal(runtimeAfterFailure.revision, firstRuntime.revision, '配置事务失败不得发布半新 RuntimeConfiguration', 'migration');

  const changedRuntime = await saveRuntimeDirectory({
    userDataPath: canonicalRoot,
    documentsPath: legacyRoot
  }, 'photoSource', 'D:\\新的照片目录');
  scenario();
  equal(changedRuntime.photoSourceDirectory, 'D:\\新的照片目录', '设置保存后应立即返回新照片目录');
  check(changedRuntime.revision !== firstRuntime.revision, '设置保存后应发布新 revision');
  const rereadRuntime = await loadRuntimeConfiguration({
    userDataPath: canonicalRoot,
    documentsPath: legacyRoot
  });
  equal(rereadRuntime.revision, changedRuntime.revision, '所有消费者重新读取应获得同一 revision');

  const updatedSettingsRuntime = await saveRuntimeSettings({
    userDataPath: canonicalRoot,
    documentsPath: legacyRoot
  }, {
    ...changedRuntime.settings,
    defaultArchiveRoot: 'E:\\新的归档目录'
  });
  scenario();
  equal(updatedSettingsRuntime.archiveRootDirectory, 'E:\\新的归档目录', '完整设置保存应刷新归档根目录');
  equal(updatedSettingsRuntime.photoSourceDirectory, 'D:\\新的照片目录', '保存归档目录不得替换照片来源目录');

  const chineseDirectory = path.join(root, '中文照片目录');
  await fs.mkdir(chineseDirectory, { recursive: true });
  const healthyDirectory = await inspectDirectoryHealth(`  ${chineseDirectory}${path.sep}  `, {
    readable: true,
    writable: false,
    allowCreate: false,
    checkOnly: true
  });
  scenario();
  equal(healthyDirectory.healthStatus, 'healthy', '中文目录和首尾空白应正确标准化', 'directory');
  equal(healthyDirectory.normalizedPath, path.normalize(chineseDirectory), '目录末尾分隔符不得造成误判', 'directory');
  check(healthyDirectory.exists && healthyDirectory.isDirectory && healthyDirectory.readable, '健康目录应返回完整能力', 'directory');

  const missingDirectory = await inspectDirectoryHealth(path.join(root, '不存在目录'), {});
  scenario();
  equal(missingDirectory.healthStatus, 'missing', '不存在目录应返回 missing', 'directory');
  check(missingDirectory.normalizedPath.includes('不存在目录'), '不存在目录应保留真实标准化路径', 'directory');

  const ordinaryFile = path.join(root, '普通文件.txt');
  await fs.writeFile(ordinaryFile, 'not a directory', 'utf8');
  const notDirectory = await inspectDirectoryHealth(ordinaryFile, {});
  scenario();
  equal(notDirectory.healthStatus, 'not_directory', '普通文件不得判为目录', 'directory');

  const unreadableDirectory = await inspectDirectoryHealth(chineseDirectory, {}, {
    fs: {
      stat: (...args) => fs.stat(...args),
      access: async () => {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      }
    }
  });
  scenario();
  equal(unreadableDirectory.healthStatus, 'unreadable', '目录访问拒绝应返回 unreadable', 'directory');
  check(!unreadableDirectory.errorMessage.includes(chineseDirectory), '目录系统错误不得重复泄露内部路径', 'directory');

  let accessCount = 0;
  const unwritableDirectory = await inspectDirectoryHealth(chineseDirectory, { writable: true }, {
    fs: {
      stat: (...args) => fs.stat(...args),
      access: async () => {
        accessCount += 1;
        if (accessCount > 1) {
          const error = new Error('denied');
          error.code = 'EACCES';
          throw error;
        }
      }
    }
  });
  scenario();
  equal(unwritableDirectory.healthStatus, 'unwritable', '归档目录写权限拒绝应独立返回', 'directory');

  const pngPath = path.join(chineseDirectory, '健康照片.png');
  const pngBuffer = createMinimalPng(8, 6);
  await fs.writeFile(pngPath, pngBuffer);
  const pngSha256 = createHash('sha256').update(pngBuffer).digest('hex');
  const healthyPhoto = await inspectPhotoSourceFile(pngPath, pngSha256, {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(healthyPhoto.healthStatus, 'healthy', '有效 PNG 和一致指纹应为 healthy', 'file');
  check(healthyPhoto.decodable && healthyPhoto.fingerprintMatches, '健康照片应可解码且指纹一致', 'file');

  const jpegPath = path.join(chineseDirectory, '健康照片.jpg');
  const jpegBuffer = createTestJpeg(12, 9);
  await fs.writeFile(jpegPath, jpegBuffer);
  const jpegSha256 = createHash('sha256').update(jpegBuffer).digest('hex');
  const healthyJpeg = await inspectPhotoSourceFile(jpegPath, jpegSha256, {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(healthyJpeg.healthStatus, 'healthy', '结构检查和实际解码均通过的 JPEG 应为 healthy', 'file');
  equal([healthyJpeg.width, healthyJpeg.height], [12, 9], 'JPEG 尺寸必须来自实际解码结果', 'file');

  const truncatedJpegPath = path.join(chineseDirectory, '截断照片.jpg');
  await fs.writeFile(truncatedJpegPath, jpegBuffer);
  const truncatedJpeg = await inspectPhotoSourceFile(truncatedJpegPath, jpegSha256, {
    decodeImage: async () => {
      throw new Error('decoder_rejected_truncated_pixels');
    }
  });
  scenario();
  equal(
    truncatedJpeg.healthStatus,
    'decode_failed',
    '只有合法 JPEG 头和 SOF 但像素解码失败时必须判为 decode_failed',
    'file'
  );
  check(!truncatedJpeg.decodable, '实际解码失败不得发布 decodable=true', 'file');

  const forgedExtensionPath = path.join(chineseDirectory, '伪造扩展名.jpg');
  await fs.writeFile(forgedExtensionPath, pngBuffer);
  const forgedExtension = await inspectPhotoSourceFile(forgedExtensionPath, '', {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(forgedExtension.healthStatus, 'decode_failed', 'PNG 内容伪装为 JPEG 扩展名必须失败', 'file');

  let oversizedReadCount = 0;
  const oversizedPhoto = await inspectPhotoSourceFile(jpegPath, jpegSha256, {
    maxDecodeBytes: jpegBuffer.length - 1,
    fs: {
      stat: (...args) => fs.stat(...args),
      access: (...args) => fs.access(...args),
      readFile: async (...args) => {
        oversizedReadCount += 1;
        return fs.readFile(...args);
      }
    },
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(oversizedPhoto.healthStatus, 'too_large', '超过解码上限的照片必须在读取前拒绝', 'file');
  equal(oversizedReadCount, 0, '超大文件不得进入一次性读取和解码阶段', 'file');

  const unknownFingerprint = await inspectPhotoSourceFile(pngPath, '', {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(unknownFingerprint.healthStatus, 'fingerprint_unknown', '无历史指纹应为 fingerprint_unknown', 'file');
  equal(unknownFingerprint.currentSha256, pngSha256, '无历史指纹仍应返回当前诊断指纹', 'file');

  await fs.writeFile(pngPath, createMinimalPng(9, 7));
  const changedPhoto = await inspectPhotoSourceFile(pngPath, pngSha256, {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(changedPhoto.healthStatus, 'fingerprint_changed', '内容变化应为 fingerprint_changed', 'file');
  equal(changedPhoto.expectedSha256, pngSha256, '内容变化不得覆盖 expectedSha256', 'file');
  check(changedPhoto.currentSha256 !== pngSha256, '内容变化应保留 currentSha256 诊断值', 'file');

  const missingPhoto = await inspectPhotoSourceFile(path.join(root, 'missing.png'), pngSha256);
  scenario();
  equal(missingPhoto.healthStatus, 'missing', '不存在照片应为 missing', 'file');

  const emptyPhotoPath = path.join(root, 'empty.png');
  await fs.writeFile(emptyPhotoPath, Buffer.alloc(0));
  const emptyPhoto = await inspectPhotoSourceFile(emptyPhotoPath, '');
  scenario();
  equal(emptyPhoto.healthStatus, 'empty', '零字节照片应为 empty', 'file');

  const unsupportedPath = path.join(root, 'photo.bmp');
  await fs.writeFile(unsupportedPath, Buffer.from('BM'));
  const unsupportedPhoto = await inspectPhotoSourceFile(unsupportedPath, '');
  scenario();
  equal(unsupportedPhoto.healthStatus, 'unsupported_format', '不支持格式应明确拒绝', 'file');

  const brokenPath = path.join(root, 'broken.png');
  await fs.writeFile(brokenPath, Buffer.from('not-png', 'utf8'));
  const brokenPhoto = await inspectPhotoSourceFile(brokenPath, '');
  scenario();
  equal(brokenPhoto.healthStatus, 'decode_failed', '损坏图片应为 decode_failed', 'file');

  const unreadablePhoto = await inspectPhotoSourceFile(pngPath, pngSha256, {
    fs: {
      stat: (...args) => fs.stat(...args),
      access: async () => {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      }
    }
  });
  scenario();
  equal(unreadablePhoto.healthStatus, 'unreadable', '不可读照片应为 unreadable', 'file');

  const beforeInspection = await fs.readFile(pngPath);
  await inspectPhotoSourceFile(pngPath, pngSha256, {
    decodeImage: decodeSelfCheckImage
  });
  equal(await fs.readFile(pngPath), beforeInspection, '文件健康检查不得修改照片内容', 'file');
  scenario();

  const scanRoot = path.join(root, 'scan-only-photo-source');
  await fs.mkdir(scanRoot, { recursive: true });
  const scanPng = createMinimalPng(4, 4);
  await fs.writeFile(path.join(scanRoot, 'scan.png'), scanPng);
  const scanResult = await scanImagesWithHealth(scanRoot, {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  equal(scanResult.photos.length, 1, '扫描只依赖照片来源目录，不要求归档根目录', 'directory');
  equal(scanResult.failures.length, 0, '健康照片扫描不应产生失败项', 'directory');

  const snapshotRoot = path.join(root, 'snapshot');
  await fs.mkdir(snapshotRoot, { recursive: true });
  const snapshotPhotoPath = path.join(snapshotRoot, 'snapshot.png');
  const snapshotBuffer = createMinimalPng(5, 5);
  await fs.writeFile(snapshotPhotoPath, snapshotBuffer);
  const snapshotSha = createHash('sha256').update(snapshotBuffer).digest('hex');
  const snapshotWorkspace = createEmptyWorkspace();
  snapshotWorkspace.photoFolder = 'D:\\旧快照照片';
  snapshotWorkspace.archiveRoot = 'E:\\旧快照归档';
  snapshotWorkspace.photos = [{
    id: 'snapshot-photo',
    originalPath: snapshotPhotoPath,
    originalName: 'snapshot.png',
    extension: '.png',
    size: snapshotBuffer.length,
    sha256: snapshotSha,
    sortStatus: 'unassigned',
    smartSortStatus: 'not_run',
    sourceType: 'local_file'
  }];
  snapshotWorkspace.selectedIds = ['snapshot-photo'];
  snapshotWorkspace.recognitionResultsByPhoto = {
    'snapshot-photo': { text: '保留识别状态' }
  };
  snapshotWorkspace.photoDraftByPhotoId = {
    'snapshot-photo': { remarks: '保留草稿' }
  };
  snapshotWorkspace.smartSortResult = {
    groups: [{ id: 'group-1', photoIds: ['snapshot-photo'] }]
  };
  const snapshotSave = await saveSortWorkspaceSnapshot(snapshotRoot, snapshotWorkspace, {
    now: new Date('2026-07-23T01:00:00.000Z')
  });
  scenario();
  check(snapshotSave.success, '快照原子保存能力应保持', 'snapshot');
  const storedSnapshot = JSON.parse(await fs.readFile(getSortWorkspaceSnapshotPath(snapshotRoot), 'utf8'));
  check(!Object.hasOwn(storedSnapshot.workspace, 'photoFolder'), '快照不得保存照片来源目录', 'snapshot');
  check(!Object.hasOwn(storedSnapshot.workspace, 'archiveRoot'), '快照不得保存归档根目录', 'snapshot');

  storedSnapshot.workspace.photoFolder = 'D:\\历史目录';
  storedSnapshot.workspace.archiveRoot = 'E:\\历史归档';
  await fs.writeFile(getSortWorkspaceSnapshotPath(snapshotRoot), JSON.stringify(storedSnapshot, null, 2), 'utf8');
  const legacySnapshotLoad = await loadSortWorkspaceSnapshot(snapshotRoot, {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  check(legacySnapshotLoad.success, 'schemaVersion 1 旧快照目录字段应安全忽略', 'snapshot');
  check(!Object.hasOwn(legacySnapshotLoad.snapshot.workspace, 'photoFolder'), '恢复结果不得重新发布旧照片目录', 'snapshot');
  check(!Object.hasOwn(legacySnapshotLoad.snapshot.workspace, 'archiveRoot'), '恢复结果不得重新发布旧归档目录', 'snapshot');
  equal(
    legacySnapshotLoad.snapshot.workspace.recognitionResultsByPhoto['snapshot-photo'].text,
    '保留识别状态',
    '加载新 RuntimeConfiguration 不得清空工作池识别状态',
    'snapshot'
  );
  equal(
    legacySnapshotLoad.snapshot.workspace.photoDraftByPhotoId['snapshot-photo'].remarks,
    '保留草稿',
    '加载新 RuntimeConfiguration 不得清空照片草稿',
    'snapshot'
  );
  equal(
    legacySnapshotLoad.snapshot.workspace.smartSortResult.groups.length,
    1,
    '加载新 RuntimeConfiguration 不得清空 smartSortResult',
    'snapshot'
  );

  await fs.writeFile(snapshotPhotoPath, createMinimalPng(6, 6));
  const changedSnapshotLoad = await loadSortWorkspaceSnapshot(snapshotRoot, {
    decodeImage: decodeSelfCheckImage
  });
  scenario();
  const restoredPhoto = changedSnapshotLoad.snapshot.workspace.photos[0];
  equal(restoredPhoto.sha256, snapshotSha, '快照恢复不得用当前 SHA 覆盖保存指纹', 'snapshot');
  equal(restoredPhoto.fileHealth.expectedSha256, snapshotSha, '恢复健康信息应保留 expectedSha256', 'snapshot');
  equal(restoredPhoto.fileHealth.healthStatus, 'fingerprint_changed', '快照恢复应识别来源文件替换', 'snapshot');
  check(restoredPhoto.fileHealth.currentSha256 !== snapshotSha, '恢复应保存 currentSha256 诊断值', 'snapshot');

  const sourceMain = await fs.readFile(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
  const sourcePreload = await fs.readFile(path.join(process.cwd(), 'electron', 'preload.cjs'), 'utf8');
  scenario();
  check(sourceMain.includes("openConfiguredDirectory") || sourceMain.includes("runtimeConfiguration:openDirectory"), '主进程应提供受控目录打开入口');
  check(sourceMain.includes("photos:scanConfigured"), '扫描 IPC 应从 RuntimeConfiguration 读取照片目录');
  check(sourcePreload.includes('loadRuntimeConfiguration'), 'preload 应暴露唯一 RuntimeConfiguration 读取入口');
  check(sourcePreload.includes('onRuntimeConfigurationChanged'), 'renderer 应能整体接收 RuntimeConfiguration revision 更新');

  check(scenarioCount >= 24, '配置、目录、文件健康和快照边界应覆盖完整行为场景');
  console.log(
    `RuntimeConfiguration 基础层自检通过：${scenarioCount} 个行为场景，${assertionCount} 个行为断言，`
    + `其中配置迁移 ${migrationAssertionCount}、目录健康 ${directoryAssertionCount}、`
    + `文件健康 ${fileAssertionCount}、快照边界 ${snapshotAssertionCount} 个断言。`
  );
}

function createMinimalPng(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 4, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

function decodeSelfCheckImage(buffer, { extension } = {}) {
  if (
    extension === '.png'
    && Buffer.isBuffer(buffer)
    && buffer.length >= 33
    && buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return {
      decodable: true,
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }
  if (
    ['.jpg', '.jpeg'].includes(extension)
    && Buffer.isBuffer(buffer)
    && buffer.length >= 31
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
  ) {
    return {
      decodable: true,
      width: buffer.readUInt16BE(27),
      height: buffer.readUInt16BE(25)
    };
  }
  throw new Error('self_check_decode_failed');
}

async function checkMarkiSourceManifest(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '马克来源清单自检必须使用系统临时目录'
  );
  const orgId = '12345';
  const firstKey = buildMarkiSourceKey(orgId, 'moment-001');
  const secondKey = buildMarkiSourceKey(orgId, 'moment-002');
  const newKey = buildMarkiSourceKey(orgId, 'moment-003');
  assert.equal(firstKey, 'marki_api:12345:moment-001', '马克来源唯一标识格式必须稳定');

  const firstWrite = await upsertMarkiSourceRecords(root, orgId, [
    {
      id: 'moment-001',
      teamId: 10001,
      uid: 20001,
      postTime: 1760000001,
      markName: '巡查检查类',
      url: 'https://private.example/photo.jpg',
      rawContent: '不应写入来源清单',
      organizationKey: '不应写入来源清单'
    },
    {
      id: 'moment-001',
      teamId: 10001,
      uid: 20001,
      postTime: 1760000001,
      markName: '巡查检查类'
    },
    {
      id: 'moment-002',
      teamId: 10001,
      uid: 20002,
      postTime: 1760000002,
      markName: '工程类专用'
    }
  ], { now: () => new Date('2026-07-17T04:00:00.000Z') });
  assert.equal(firstWrite.inputCount, 3, '来源清单应记录原始输入数量');
  assert.equal(firstWrite.uniqueInputCount, 2, '同批重复 momentId 应合并');
  assert.equal(firstWrite.duplicateInputCount, 1, '同批重复数量应准确');
  assert.equal(firstWrite.createdCount, 2, '首次写入应创建两条唯一来源记录');
  assert.equal(firstWrite.totalCount, 2, '来源清单总数应按 sourceKey 去重');

  const manifestPath = getMarkiSourceManifestPath(root, orgId);
  assert.equal(
    manifestPath,
    path.join(root, '物业工作照片归档助手', 'marki-import', orgId, 'source-manifest.json'),
    '来源清单应位于正式 marki-import 组织目录'
  );
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  assert.equal(manifestText.includes('private.example'), false, '来源清单不得保存完整远程 URL');
  assert.equal(manifestText.includes('不应写入来源清单'), false, '来源清单不得保存未允许的原始字段或凭证');

  const firstRecord = await getMarkiSourceRecordByKey(root, orgId, firstKey);
  assert.equal(firstRecord?.importStatus, 'discovered', '第一刀新来源记录初始状态应为 discovered');
  assert.equal(firstRecord?.downloadAttemptCount, 0, '尚未下载的来源记录尝试次数应为零');
  assert.equal(firstRecord?.teamId, '10001', '来源记录应保留团队 ID');
  assert.equal(Object.hasOwn(firstRecord || {}, 'url'), false, '单条来源记录不得返回远程 URL');
  assert.equal(await hasMarkiSourceKey(root, orgId, firstKey), true, '已写入 sourceKey 应返回存在');
  assert.equal(await hasMarkiSourceKey(root, orgId, newKey), false, '未写入 sourceKey 应返回不存在');

  const batchCheck = await checkMarkiSourceKeys(root, orgId, [firstKey, firstKey, secondKey, newKey]);
  assert.equal(batchCheck.requestedCount, 4, '批量检查应保留请求数量');
  assert.equal(batchCheck.uniqueCount, 3, '批量检查应合并重复 sourceKey');
  assert.equal(batchCheck.duplicateInputCount, 1, '批量检查重复数量应准确');
  assert.equal(batchCheck.existingCount, 2, '批量检查应正确识别已存在记录');
  assert.equal(batchCheck.newCount, 1, '批量检查应正确识别新来源');
  assert.equal(batchCheck.bySourceKey[firstKey].importStatus, 'discovered', '批量检查应返回已有来源状态');
  assert.equal(batchCheck.bySourceKey[newKey].exists, false, '未写入来源应返回不存在');

  const manifestBeforeRepeat = await loadMarkiSourceManifest(root, orgId);
  const repeated = await upsertMarkiSourceRecords(root, orgId, [
    { id: 'moment-001', teamId: 10001, uid: 20001, postTime: 1760000001, markName: '巡查检查类' },
    { id: 'moment-002', teamId: 10001, uid: 20002, postTime: 1760000002, markName: '工程类专用' }
  ], { now: () => new Date('2026-07-17T05:00:00.000Z') });
  assert.equal(repeated.createdCount, 0, '重复写入不得创建新记录');
  assert.equal(repeated.updatedCount, 0, '相同元数据重复写入不得制造无意义更新');
  assert.equal(repeated.unchangedCount, 2, '相同来源应明确计为未变化');
  const manifestAfterRepeat = await loadMarkiSourceManifest(root, orgId);
  assert.equal(manifestAfterRepeat.updatedAt, manifestBeforeRepeat.updatedAt, '幂等写入不得改变清单更新时间');
  assert.equal(
    manifestAfterRepeat.records[firstKey]?.importStatus,
    'discovered',
    '重复写入后来源状态仍应保持 discovered'
  );

  const updated = await upsertMarkiSourceRecords(root, orgId, [
    { id: 'moment-002', teamId: 10001, uid: 20002, postTime: 1760000002, markName: '工程类专用（更新）' }
  ], { now: () => new Date('2026-07-17T06:00:00.000Z') });
  assert.equal(updated.updatedCount, 1, '来源元数据变化时应更新原记录');
  const updatedRecord = await getMarkiSourceRecordByKey(root, orgId, secondKey);
  assert.equal(updatedRecord?.markName, '工程类专用（更新）', '来源元数据更新后应可重新读取');
  assert.equal(updatedRecord?.importStatus, 'discovered', '元数据更新不得重置或改变导入状态');

  await Promise.all([
    upsertMarkiSourceRecords(root, orgId, [
      { id: 'moment-003', teamId: 10001, uid: 20003, postTime: 1760000003, markName: '绿化保洁类' }
    ]),
    upsertMarkiSourceRecords(root, orgId, [
      { id: 'moment-004', teamId: 10001, uid: 20004, postTime: 1760000004, markName: '时间地点' }
    ])
  ]);
  const afterConcurrentWrites = await loadMarkiSourceManifest(root, orgId);
  assert.equal(Object.keys(afterConcurrentWrites.records).length, 4, '并发写入不得互相覆盖来源记录');

  const serviceModulePath = require.resolve('../electron/services/markiSourceManifestService.cjs');
  delete require.cache[serviceModulePath];
  const restartedSourceService = require(serviceModulePath);
  const manifestAfterRestart = await restartedSourceService.loadMarkiSourceManifest(root, orgId);
  assert.equal(Object.keys(manifestAfterRestart.records).length, 4, '重新加载服务后应从磁盘恢复全部来源记录');
  assert.equal(
    await restartedSourceService.hasMarkiSourceKey(root, orgId, firstKey),
    true,
    '重新加载服务后仍应正确判断 sourceKey 已存在'
  );

  const manifestDirectoryEntries = await fs.readdir(path.dirname(manifestPath));
  assert.equal(
    manifestDirectoryEntries.some((name) => name.endsWith('.tmp')),
    false,
    '来源清单成功写入后不得遗留临时文件'
  );

  const validManifestText = await fs.readFile(manifestPath, 'utf8');
  const validManifest = JSON.parse(validManifestText);
  const unknownStatusManifest = JSON.parse(JSON.stringify(validManifest));
  unknownStatusManifest.records[firstKey].importStatus = 'archived';
  await fs.writeFile(manifestPath, `${JSON.stringify(unknownStatusManifest, null, 2)}\n`, 'utf8');
  await assert.rejects(
    () => loadMarkiSourceManifest(root, orgId),
    (error) => error?.code === 'marki_source_manifest_invalid',
    '来源清单读取时必须拒绝未知状态'
  );
  assert.equal(
    JSON.parse(await fs.readFile(manifestPath, 'utf8')).records[firstKey].importStatus,
    'archived',
    '拒绝未知状态时不得静默改写清单'
  );
  await fs.writeFile(manifestPath, validManifestText, 'utf8');

  await fs.writeFile(manifestPath, '{"version":1,"records":', 'utf8');
  await assert.rejects(
    () => upsertMarkiSourceRecords(root, orgId, [
      { id: 'moment-005', teamId: 10001, uid: 20005, postTime: 1760000005, markName: '测试' }
    ]),
    (error) => error?.code === 'marki_source_manifest_invalid',
    '来源清单损坏时应阻止后续覆盖写入'
  );
  assert.equal(
    await fs.readFile(manifestPath, 'utf8'),
    '{"version":1,"records":',
    '来源清单损坏后不得被静默替换为空清单'
  );
  await fs.writeFile(manifestPath, validManifestText, 'utf8');

  await assert.rejects(
    () => checkMarkiSourceKeys(root, orgId, ['marki_api:99999:moment-001']),
    (error) => error?.code === 'invalid_source_key',
    '跨组织 sourceKey 必须被拒绝'
  );
}

async function checkMarkiPhotoDownload(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '马克照片下载自检必须使用系统临时目录'
  );
  const orgId = '12345';
  const teamId = '10001';
  const shootDate = '2026-07-17';
  const validJpeg = createTestJpeg(3, 2);
  const primaryInput = {
    orgId,
    momentId: 'download-001',
    teamId,
    uid: '20001',
    postTime: 1784246400,
    shootDate,
    markName: '巡查检查类',
    url: 'https://private.example/download-001.jpg'
  };
  let successfulFetchCount = 0;
  const primaryResult = await downloadMarkiPhoto(root, primaryInput, {
    now: () => new Date('2026-07-17T07:00:00.000Z'),
    fetchImpl: async () => {
      successfulFetchCount += 1;
      const downloadingRecord = await getMarkiSourceRecordByKey(
        root,
        orgId,
        buildMarkiSourceKey(orgId, primaryInput.momentId)
      );
      assert.equal(downloadingRecord?.importStatus, 'downloading', '发起 HTTP 下载前状态应为 downloading');
      return new Response(validJpeg, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      });
    }
  });
  const expectedPrimaryPath = path.join(
    root,
    '物业工作照片归档助手',
    'marki-import',
    orgId,
    teamId,
    shootDate,
    'download-001.jpg'
  );
  assert.equal(primaryResult.importStatus, 'imported', '通过全部校验后状态应为 imported');
  assert.equal(primaryResult.localPath, expectedPrimaryPath, '正式 JPG 应写入组织、团队和日期目录');
  assert.equal(primaryResult.width, 3, '应读取 JPG 宽度');
  assert.equal(primaryResult.height, 2, '应读取 JPG 高度');
  assert.equal(primaryResult.size, validJpeg.length, '应记录 JPG 文件大小');
  assert.equal(primaryResult.completedAt, '2026-07-17T07:00:00.000Z', '新下载结果应返回完成时间');
  assert.equal(primaryResult.downloadAttemptCount, 1, '首次下载尝试次数应为一');
  assert.equal((await fs.readFile(expectedPrimaryPath)).equals(validJpeg), true, '正式 JPG 内容应保持完整');
  await assert.rejects(
    () => fs.access(`${expectedPrimaryPath}.part`),
    (error) => error?.code === 'ENOENT',
    '成功后不得遗留 .part 文件'
  );

  const importedRecord = await getMarkiSourceRecordByKey(
    root,
    orgId,
    buildMarkiSourceKey(orgId, primaryInput.momentId)
  );
  assert.equal(importedRecord?.importStatus, 'imported', '来源清单应持久化 imported 状态');
  assert.equal(importedRecord?.downloadInfo?.relativePath.includes('download-001.jpg'), true, '应保存相对文件路径');
  assert.equal(importedRecord?.lastDownloadError, null, '成功记录不得保留下载错误');
  const manifestText = await fs.readFile(getMarkiSourceManifestPath(root, orgId), 'utf8');
  assert.equal(manifestText.includes('private.example'), false, '来源清单不得保存完整照片 URL');

  const repeatedResult = await downloadMarkiPhoto(root, primaryInput, {
    fetchImpl: async () => {
      throw new Error('已导入照片不应再次请求网络');
    }
  });
  assert.equal(repeatedResult.reusedExisting, true, '已导入来源应直接复用正式文件');
  assert.equal(repeatedResult.completedAt, primaryResult.completedAt, '复用已导入文件应保留原完成时间');
  assert.equal(successfulFetchCount, 1, '同一 sourceKey 不得重复下载');
  const tamperedJpeg = Buffer.from(validJpeg);
  tamperedJpeg[tamperedJpeg.length - 1] ^= 0x01;
  await fs.writeFile(expectedPrimaryPath, tamperedJpeg);
  await assert.rejects(
    () => downloadMarkiPhoto(root, primaryInput, {
      fetchImpl: async () => {
        throw new Error('完整性失败时不得重新下载');
      }
    }),
    (error) => error?.code === 'imported_file_integrity_failed',
    'imported JPG 内容与清单哈希不一致时必须安全失败'
  );
  assert.equal(
    (await getMarkiSourceRecordByKey(
      root,
      orgId,
      buildMarkiSourceKey(orgId, primaryInput.momentId)
    )).importStatus,
    'imported',
    'imported JPG 复验失败不得修改来源状态'
  );
  await fs.writeFile(expectedPrimaryPath, validJpeg);
  await fs.rm(expectedPrimaryPath, { force: true });
  let activeRedownloadCount = 0;
  const activeRedownload = await downloadMarkiPhoto(root, primaryInput, {
    allowImportedRedownload: true,
    fetchImpl: async () => {
      activeRedownloadCount += 1;
      return new Response(validJpeg, { status: 200 });
    }
  });
  assert.equal(activeRedownload.reusedExisting, false, '用户主动重导时允许补回缺失缓存');
  assert.equal(activeRedownloadCount, 1, '缺失缓存的主动重导只请求一次照片');
  assert.equal(await isFile(expectedPrimaryPath), true, '主动重导成功后必须恢复正式 JPG');
  const repairRecordBeforeCommitFailure = await getMarkiSourceRecordByKey(
    root,
    orgId,
    buildMarkiSourceKey(orgId, primaryInput.momentId)
  );
  await fs.writeFile(expectedPrimaryPath, tamperedJpeg);
  const commitFailingManifestService = {
    upsertMarkiSourceRecords,
    getMarkiSourceRecordByKey,
    prepareMarkiSourceForRedownload: require('../electron/services/markiSourceManifestService.cjs')
      .prepareMarkiSourceForRedownload,
    updateMarkiSourceImportStatus: async (...args) => {
      if (args[3] === 'imported') {
        const error = new Error('injected manifest commit failure');
        error.code = 'EIO';
        throw error;
      }
      return updateMarkiSourceImportStatus(...args);
    }
  };
  await assert.rejects(
    () => downloadMarkiPhoto(root, primaryInput, {
      allowImportedRedownload: true,
      manifestService: commitFailingManifestService,
      fetchImpl: async () => new Response(validJpeg, { status: 200 })
    }),
    (error) => error?.code === 'marki_manifest_commit_failed',
    '修复文件替换后来源清单提交失败必须返回受控错误'
  );
  assert.equal(
    (await fs.readFile(expectedPrimaryPath)).equals(tamperedJpeg),
    true,
    '修复清单提交失败必须原子恢复替换前文件'
  );
  assert.equal(
    (await getMarkiSourceRecordByKey(
      root,
      orgId,
      buildMarkiSourceKey(orgId, primaryInput.momentId)
    )).importStatus,
    'repair_failed',
    '修复清单提交失败后必须保留可跨重启重试的 repair_failed 状态'
  );
  await fs.writeFile(expectedPrimaryPath, validJpeg);
  await updateMarkiSourceImportStatus(
    root,
    orgId,
    buildMarkiSourceKey(orgId, primaryInput.momentId),
    'repairing'
  );
  await updateMarkiSourceImportStatus(
    root,
    orgId,
    buildMarkiSourceKey(orgId, primaryInput.momentId),
    'imported',
    { downloadInfo: repairRecordBeforeCommitFailure.downloadInfo }
  );
  await assert.rejects(
    () => downloadMarkiPhoto(root, {
      ...primaryInput,
      momentId: 'path-escape-test'
    }, {
      manifestService: {
        upsertMarkiSourceRecords: async () => ({ success: true }),
        getMarkiSourceRecordByKey: async () => ({
          sourceKey: buildMarkiSourceKey(orgId, 'path-escape-test'),
          importStatus: 'imported',
          downloadInfo: {
            relativePath: '../../outside.jpg',
            fileName: 'outside.jpg',
            size: 1,
            width: 1,
            height: 1,
            sha256: '0'.repeat(64),
            completedAt: '2026-07-17T07:00:00.000Z'
          }
        })
      }
    }),
    (error) => error?.code === 'imported_file_path_invalid',
    'imported 下载记录不得通过相对路径逃逸正式 Marki 目录'
  );

  const retryInput = {
    ...primaryInput,
    momentId: 'download-retry',
    url: 'https://private.example/download-retry.jpg'
  };
  await assert.rejects(
    () => downloadMarkiPhoto(root, retryInput, {
      fetchImpl: async () => new Response('', { status: 503 })
    }),
    (error) => error?.code === 'download_http_error' && error?.httpStatus === 503,
    '非成功 HTTP 状态应标记下载失败'
  );
  const failedRecord = await getMarkiSourceRecordByKey(
    root,
    orgId,
    buildMarkiSourceKey(orgId, retryInput.momentId)
  );
  assert.equal(failedRecord?.importStatus, 'download_failed', 'HTTP 失败后状态应为 download_failed');
  assert.equal(failedRecord?.downloadAttemptCount, 1, '失败下载也应累计尝试次数');
  assert.equal(failedRecord?.lastDownloadError?.code, 'download_http_error', '应保存受控失败原因');
  assert.equal(JSON.stringify(failedRecord).includes(retryInput.url), false, '失败记录不得保存完整照片 URL');

  const retryResult = await retryMarkiPhotoDownload(root, retryInput, {
    fetchImpl: async () => new Response(validJpeg, { status: 200 })
  });
  assert.equal(retryResult.importStatus, 'imported', '失败重试成功后状态应为 imported');
  assert.equal(retryResult.downloadAttemptCount, 2, '重试应累计第二次下载尝试');
  const retriedRecord = await getMarkiSourceRecordByKey(
    root,
    orgId,
    buildMarkiSourceKey(orgId, retryInput.momentId)
  );
  assert.equal(retriedRecord?.lastDownloadError, null, '重试成功后应清除旧失败原因');

  await assertDownloadFailure(root, {
    ...primaryInput,
    momentId: 'download-empty',
    url: 'https://private.example/download-empty.jpg'
  }, Buffer.alloc(0), 'download_empty');
  await assertDownloadFailure(root, {
    ...primaryInput,
    momentId: 'download-too-large',
    url: 'https://private.example/download-too-large.jpg'
  }, validJpeg, 'download_too_large', { maxImageBytes: validJpeg.length - 1 });
  await assertDownloadFailure(root, {
    ...primaryInput,
    momentId: 'download-not-jpeg',
    url: 'https://private.example/download-not-jpeg.jpg'
  }, Buffer.from('not a jpeg', 'utf8'), 'invalid_jpeg_header');
  await assertDownloadFailure(root, {
    ...primaryInput,
    momentId: 'download-no-size',
    url: 'https://private.example/download-no-size.jpg'
  }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'invalid_jpeg_dimensions');

  const conflictInput = {
    ...primaryInput,
    momentId: 'download-conflict',
    url: 'https://private.example/download-conflict.jpg'
  };
  const conflictPath = path.join(
    root,
    '物业工作照片归档助手',
    'marki-import',
    orgId,
    teamId,
    shootDate,
    'download-conflict.jpg'
  );
  const existingContent = Buffer.from('existing user file', 'utf8');
  await fs.mkdir(path.dirname(conflictPath), { recursive: true });
  await fs.writeFile(conflictPath, existingContent);
  await assert.rejects(
    () => downloadMarkiPhoto(root, conflictInput, {
      fetchImpl: async () => {
        throw new Error('目标冲突时不应发起网络请求');
      }
    }),
    (error) => error?.code === 'target_file_conflict',
    '目标位置已有无效文件时应拒绝覆盖'
  );
  assert.equal(
    (await fs.readFile(conflictPath)).equals(existingContent),
    true,
    '目标冲突失败后必须保留已有文件'
  );

  await checkMarkiRedirectHandling(root, primaryInput, validJpeg);
  await checkManifestCommitRecovery(root, primaryInput, validJpeg);
}

async function checkMarkiRedirectHandling(root, baseInput, validJpeg) {
  const downgradeRequests = [];
  const downgradeInput = {
    ...baseInput,
    momentId: 'redirect-http',
    url: 'https://redirect.example/start'
  };
  await assert.rejects(
    () => downloadMarkiPhoto(root, downgradeInput, {
      fetchImpl: async (url, options) => {
        downgradeRequests.push({ url, redirect: options.redirect });
        return new Response(null, {
          status: 302,
          headers: { location: 'http://unsafe.example/photo.jpg' }
        });
      }
    }),
    (error) => (
      error?.code === 'marki_redirect_protocol_not_allowed'
      && !error.message.includes('unsafe.example')
    ),
    'HTTPS 重定向到 HTTP 时应在请求下一跳前拒绝'
  );
  assert.equal(downgradeRequests.length, 1, '禁止协议的重定向地址不得被实际请求');
  assert.equal(downgradeRequests[0].redirect, 'manual', '下载请求必须使用手工重定向模式');

  const httpsRequests = [];
  const httpsInput = {
    ...baseInput,
    momentId: 'redirect-https',
    url: 'https://redirect.example/start-secure'
  };
  const httpsResult = await downloadMarkiPhoto(root, httpsInput, {
    fetchImpl: async (url, options) => {
      httpsRequests.push({ url, redirect: options.redirect });
      if (httpsRequests.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://cdn.example/photo.jpg' }
        });
      }
      return new Response(validJpeg, { status: 200 });
    }
  });
  assert.equal(httpsResult.importStatus, 'imported', 'HTTPS 重定向应允许继续并完成导入');
  assert.equal(httpsRequests.length, 2, 'HTTPS 重定向应只请求当前跳和下一跳');
  assert.equal(httpsRequests.every((item) => item.redirect === 'manual'), true, '每一跳都必须使用手工重定向');

  let redirectRequestCount = 0;
  const redirectLimitInput = {
    ...baseInput,
    momentId: 'redirect-limit',
    url: 'https://redirect.example/limit-0'
  };
  await assert.rejects(
    () => downloadMarkiPhoto(root, redirectLimitInput, {
      fetchImpl: async () => {
        redirectRequestCount += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `https://redirect.example/limit-${redirectRequestCount}` }
        });
      }
    }),
    (error) => error?.code === 'marki_redirect_limit_exceeded',
    '超过五次 HTTPS 重定向时应返回受控错误'
  );
  assert.equal(redirectRequestCount, 6, '最多允许跟随五次重定向');

  const invalidRedirectCases = [
    {
      momentId: 'redirect-missing-location',
      response: () => new Response(null, { status: 301 })
    },
    {
      momentId: 'redirect-invalid-location',
      response: () => new Response(null, {
        status: 308,
        headers: { location: 'https://[invalid' }
      })
    }
  ];
  for (const testCase of invalidRedirectCases) {
    await assert.rejects(
      () => downloadMarkiPhoto(root, {
        ...baseInput,
        momentId: testCase.momentId,
        url: `https://redirect.example/${testCase.momentId}`
      }, {
        fetchImpl: async () => testCase.response()
      }),
      (error) => (
        error?.code === 'marki_redirect_location_invalid'
        && !error.message.includes('redirect.example')
      ),
      '缺少或非法 Location 时应返回受控错误'
    );
  }
}

async function checkManifestCommitRecovery(root, baseInput, validJpeg) {
  const internalFailureText = 'EACCES C:\\private\\source-manifest.json';
  const failingManifestService = {
    updateMarkiSourceImportStatus: async (...args) => {
      if (args[3] === 'imported') throw new Error(internalFailureText);
      return updateMarkiSourceImportStatus(...args);
    }
  };
  const recoverableInput = {
    ...baseInput,
    momentId: 'manifest-recover',
    url: 'https://private.example/manifest-recover.jpg'
  };
  let recoverableFetchCount = 0;
  let commitError;
  try {
    await downloadMarkiPhoto(root, recoverableInput, {
      manifestService: failingManifestService,
      fetchImpl: async () => {
        recoverableFetchCount += 1;
        return new Response(validJpeg, { status: 200 });
      }
    });
  } catch (error) {
    commitError = error;
  }
  assert.equal(commitError?.code, 'marki_manifest_commit_failed', 'imported 清单提交失败应返回领域错误');
  assert.equal(
    commitError?.message,
    '照片文件已下载完成，但来源清单更新失败，请重试以恢复记录。',
    '清单提交失败应返回固定安全消息'
  );
  assert.equal(commitError?.message.includes('private.example'), false, '清单提交错误不得包含照片 URL');
  assert.equal(commitError?.message.includes('EACCES'), false, '清单提交错误不得包含原始存储异常');
  const recoverablePath = getExpectedMarkiDownloadPath(root, recoverableInput);
  assert.equal((await fs.readFile(recoverablePath)).equals(validJpeg), true, '清单提交失败后应保留正式 JPG');
  await assert.rejects(
    () => fs.access(`${recoverablePath}.part`),
    (error) => error?.code === 'ENOENT',
    '清单提交失败后不得遗留 .part'
  );
  const pendingRecord = await getMarkiSourceRecordByKey(
    root,
    recoverableInput.orgId,
    buildMarkiSourceKey(recoverableInput.orgId, recoverableInput.momentId)
  );
  assert.equal(pendingRecord?.importStatus, 'downloading', '清单提交失败时不得伪写为 download_failed');

  const beforeRecovery = await fs.readFile(recoverablePath);
  const recoveredResult = await retryMarkiPhotoDownload(root, recoverableInput, {
    fetchImpl: async () => {
      recoverableFetchCount += 1;
      throw new Error('恢复清单时不应重新请求照片');
    }
  });
  assert.equal(recoveredResult.importStatus, 'imported', '恢复后应补记 imported');
  assert.equal(recoveredResult.reusedExisting, true, '恢复时应复用已有正式 JPG');
  assert.equal(recoverableFetchCount, 1, '恢复清单时不得发起第二次网络请求');
  assert.equal((await fs.readFile(recoverablePath)).equals(beforeRecovery), true, '恢复清单时不得覆盖正式 JPG');

  const persistentInput = {
    ...baseInput,
    momentId: 'manifest-persistent-failure',
    url: 'https://private.example/manifest-persistent-failure.jpg'
  };
  let persistentFetchCount = 0;
  await assert.rejects(
    () => downloadMarkiPhoto(root, persistentInput, {
      manifestService: failingManifestService,
      fetchImpl: async () => {
        persistentFetchCount += 1;
        return new Response(validJpeg, { status: 200 });
      }
    }),
    (error) => error?.code === 'marki_manifest_commit_failed',
    '首次清单持续故障应返回受控错误'
  );
  const persistentPath = getExpectedMarkiDownloadPath(root, persistentInput);
  const persistentFileBeforeRetry = await fs.readFile(persistentPath);
  let persistentRetryError;
  try {
    await retryMarkiPhotoDownload(root, persistentInput, {
      manifestService: failingManifestService,
      fetchImpl: async () => {
        persistentFetchCount += 1;
        throw new Error('持续故障恢复时不应重新请求照片');
      }
    });
  } catch (error) {
    persistentRetryError = error;
  }
  assert.equal(persistentRetryError?.code, 'marki_manifest_commit_failed', '持续故障重试仍应返回受控错误');
  assert.equal(persistentRetryError?.message.includes('EACCES'), false, '持续故障不得泄露内部异常');
  assert.equal(persistentRetryError?.message.includes('private.example'), false, '持续故障不得泄露照片 URL');
  assert.equal(persistentFetchCount, 1, '持续故障重试不得重新下载正式 JPG');
  assert.equal(
    (await fs.readFile(persistentPath)).equals(persistentFileBeforeRetry),
    true,
    '持续故障重试不得修改正式 JPG'
  );
}

function getExpectedMarkiDownloadPath(root, input) {
  return path.join(
    root,
    '物业工作照片归档助手',
    'marki-import',
    String(input.orgId),
    String(input.teamId),
    input.shootDate,
    `${input.momentId}.jpg`
  );
}

async function assertDownloadFailure(root, input, body, expectedCode, options = {}) {
  await assert.rejects(
    () => downloadMarkiPhoto(root, input, {
      ...options,
      fetchImpl: async () => new Response(body, { status: 200 })
    }),
    (error) => error?.code === expectedCode,
    `无效下载应返回 ${expectedCode}`
  );
  const sourceKey = buildMarkiSourceKey(input.orgId, input.momentId);
  const record = await getMarkiSourceRecordByKey(root, input.orgId, sourceKey);
  assert.equal(record?.importStatus, 'download_failed', '文件校验失败后状态应为 download_failed');
  const finalPath = path.join(
    root,
    '物业工作照片归档助手',
    'marki-import',
    input.orgId,
    String(input.teamId),
    input.shootDate,
    `${input.momentId}.jpg`
  );
  await assert.rejects(
    () => fs.access(finalPath),
    (error) => error?.code === 'ENOENT',
    '文件校验失败时不得生成正式 JPG'
  );
  await assert.rejects(
    () => fs.access(`${finalPath}.part`),
    (error) => error?.code === 'ENOENT',
    '文件校验失败后应清理 .part 文件'
  );
}

function createTestJpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

async function generateSmartSortGroups(_storageRoot, input = {}) {
  const { rebuildSmartSortResult } = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/smartGroupBuilder.js')).href}?selfcheck=${Date.now()}`
  );
  const sourcePhotos = Array.isArray(input.photos) ? input.photos : [];
  const photos = sourcePhotos.map((item) => ({
    id: String(item?.photoId || item?.id || ''),
    originalPath: String(item?.filePath || item?.originalPath || ''),
    originalName: String(item?.fileName || item?.originalName || ''),
    sourceType: String(item?.sourceType || ''),
    capturedAt: item?.capturedAt || '',
    modifiedAt: item?.modifiedAt || '',
    smartSortStatus: 'completed'
  }));
  const canonicalByPhotoId = Object.fromEntries(sourcePhotos.map((item) => [
    String(item?.photoId || item?.id || ''),
    structuredClone(item?.smartGrouping?.fields || {})
  ]));
  const sourceById = new Map(sourcePhotos.map((item) => [
    String(item?.photoId || item?.id || ''),
    item
  ]));
  const result = rebuildSmartSortResult({
    photos,
    sourceCanonicalByPhotoId: canonicalByPhotoId,
    effectiveArchiveInfoByPhotoId: canonicalByPhotoId,
    includePhotoIds: photos.map((photo) => photo.id)
  });
  return {
    ...result,
    groups: result.groups.map((group) => ({
      ...group,
      photoCount: group.photoIds.length,
      photos: group.photoIds.map((photoId) => structuredClone(sourceById.get(photoId) || { photoId }))
    }))
  };
}

async function checkRecognitionModelCompatibility() {
  const recognitionModuleUrl = pathToFileURL(
    path.join(__dirname, '..', 'src', 'constants', 'recognition.js')
  ).href;
  const recognitionConstants = await import(recognitionModuleUrl);
  assert.equal(
    recognitionConstants.RECOGNITION_RESULT_SOURCES.includes('marki_api'),
    true,
    '正式识别来源必须支持 marki_api'
  );
  assert.equal(
    recognitionConstants.RECOGNITION_PROVIDER_TYPES.includes('structured_data'),
    true,
    '正式识别提供方类型必须支持 structured_data'
  );
  assert.equal(
    recognitionConstants.RECOGNITION_RESULT_STATUSES.includes('recognized'),
    true,
    '正式识别状态必须支持 recognized'
  );

  const workspaceSource = await fs.readFile(
    path.join(__dirname, '..', 'src', 'pages', 'SortWorkspacePage.jsx'),
    'utf8'
  );
  const normalizedWorkspaceSource = workspaceSource.replace(/\r\n?/g, '\n');
  const outcomeFunction = normalizedWorkspaceSource.match(
    /function getRecognitionOutcome\(result = null\) \{[\s\S]*?\n\}\n\nfunction hasValidWatermarkEvidence/
  )?.[0] || '';
  assert.ok(outcomeFunction, '必须能定位工作台 getRecognitionOutcome 判断函数');
  assert.match(
    outcomeFunction,
    /if \(result\.status === 'recognized'\) return 'success';/,
    'recognized 必须在 getRecognitionOutcome 中直接识别为成功'
  );
  assert.match(
    outcomeFunction,
    /if \(result\.status === 'success' && rawText\) return hasValidWatermarkEvidence\(result\) \? 'success' : 'empty';/,
    '既有 success 文本判断不得改变'
  );
  assert.match(
    outcomeFunction,
    /if \(result\.status === 'empty' \|\| \(result\.status === 'success' && !rawText\)\) return 'empty';/,
    '既有空识别判断不得改变'
  );
  assert.match(
    outcomeFunction,
    /if \(recognitionFailureStatuses\.has\(result\.status\)\) return 'failed';/,
    '既有识别失败判断不得改变'
  );
}

async function checkMarkiSourceMetadata(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '马克来源元数据自检必须使用系统临时目录'
  );
  const orgId = '12345';
  const momentId = 'metadata-001';
  const sourceMetadataRef = buildMarkiSourceMetadataRef(orgId, momentId);
  assert.equal(
    sourceMetadataRef,
    'marki_source_metadata:12345:metadata-001',
    '来源元数据引用格式必须稳定'
  );
  assert.notEqual(
    buildMarkiSourceMetadataRef('67890', momentId),
    sourceMetadataRef,
    '不同组织下相同 momentId 不得共用来源元数据引用'
  );
  const metadataPath = getMarkiSourceMetadataPath(root, orgId, momentId);
  assert.equal(
    metadataPath,
    path.join(
      root,
      '物业工作照片归档助手',
      'marki-import',
      orgId,
      'source-metadata',
      `${momentId}.json`
    ),
    '来源元数据必须保存到组织 source-metadata 目录'
  );

  const now = () => new Date('2026-07-17T04:00:00.000Z');
  const metadataOptions = deepFreeze({ now });
  const parsedEntriesInput = deepFreeze([
    { key: '__proto__', value: 'blocked' },
    { key: 'constructor', value: 'blocked' },
    { key: 'prototype', value: 'blocked' },
    { key: '工作内容', value: '设施巡查' },
    { key: '工作内容', value: '复查' },
    { key: '占位字段', value: '未设置' },
    { key: '对象字段', value: { unsafe: true } }
  ]);
  const parsedEntriesSnapshot = JSON.stringify(parsedEntriesInput);
  const record = buildMarkiSourceMetadataRecord({
    orgId,
    momentId,
    teamId: '10001',
    uid: '20001',
    postTime: 1784246400,
    capturedAt: '2026-07-17T10:00:00+08:00',
    markName: '巡查检查类',
    antiCounterfeitCode: 'ANTI-001',
    parsedEntries: parsedEntriesInput,
    url: 'https://private.example/photo.jpg',
    rawContent: '不得保存',
    organizationKey: '不得保存',
    sign: '不得保存',
    headers: { authorization: '不得保存' }
  }, metadataOptions);
  assert.equal(
    JSON.stringify(parsedEntriesInput),
    parsedEntriesSnapshot,
    '来源元数据构建不得修改深冻结的 parsedEntries 输入'
  );
  assert.deepEqual(
    Object.keys(record),
    [
      'schemaVersion',
      'sourceMetadataRef',
      'sourceKey',
      'sourceType',
      'orgId',
      'momentId',
      'teamId',
      'uid',
      'postTime',
      'capturedAt',
      'markName',
      'antiCounterfeitCode',
      'parsedEntries',
      'createdAt',
      'updatedAt'
    ],
    '来源元数据必须严格使用字段白名单'
  );
  assert.equal(Object.hasOwn(record, 'parsedFields'), false, '来源元数据不得继续保存 parsedFields');
  assert.deepEqual(
    record.parsedEntries,
    [
      { key: '工作内容', value: '设施巡查' },
      { key: '工作内容', value: '复查' }
    ],
    '来源字段条目应过滤特殊键、占位值和对象值，并保留合法顺序及重复关系'
  );
  const serializedRecord = JSON.stringify(record);
  assert.equal(serializedRecord.includes('private.example'), false, '来源元数据不得保存远程 URL');
  assert.equal(serializedRecord.includes('rawContent'), false, '来源元数据不得保存原始 content');
  assert.equal(serializedRecord.includes('organizationKey'), false, '来源元数据不得保存组织 KEY');
  assert.equal(serializedRecord.includes('"sign"'), false, '来源元数据不得保存签名');
  assert.equal(serializedRecord.includes('"headers"'), false, '来源元数据不得保存请求头');

  const firstSave = await saveMarkiSourceMetadata(root, record, metadataOptions);
  assert.equal(firstSave.success, true, '来源元数据应能保存');
  assert.equal(firstSave.sourceMetadataRef, sourceMetadataRef, '保存结果应返回稳定引用');
  const loaded = await loadMarkiSourceMetadata(root, orgId, sourceMetadataRef);
  assert.equal(loaded?.antiCounterfeitCode, 'ANTI-001', '来源元数据应保存防伪码');
  assert.equal(loaded?.sourceKey, buildMarkiSourceKey(orgId, momentId), '来源元数据应关联 sourceKey');
  assert.deepEqual(loaded?.parsedEntries, record.parsedEntries, '通过来源引用重新读取后字段条目应保持一致');

  const frozenSaveInput = deepFreeze({
    orgId,
    momentId: 'metadata-frozen-input',
    antiCounterfeitCode: 'FROZEN-001',
    parsedEntries: parsedEntriesInput
  });
  const frozenSaveOptions = deepFreeze({
    now: () => new Date('2026-07-17T04:00:30.000Z')
  });
  const frozenSaveInputSnapshot = JSON.stringify(frozenSaveInput);
  await saveMarkiSourceMetadata(root, frozenSaveInput, frozenSaveOptions);
  assert.equal(
    JSON.stringify(frozenSaveInput),
    frozenSaveInputSnapshot,
    '来源元数据保存不得修改深冻结输入及其字段条目'
  );

  const updated = await saveMarkiSourceMetadata(root, {
    ...record,
    antiCounterfeitCode: 'ANTI-002',
    parsedEntries: [
      ...record.parsedEntries,
      { key: '上传人', value: '测试人员' }
    ]
  }, {
    now: () => new Date('2026-07-17T04:01:00.000Z')
  });
  assert.equal(updated.record.antiCounterfeitCode, 'ANTI-002', '重复保存应更新同一来源记录');
  assert.equal(updated.record.createdAt, record.createdAt, '更新来源元数据应保留首次创建时间');
  assert.equal(updated.record.updatedAt, '2026-07-17T04:01:00.000Z', '更新来源元数据应刷新更新时间');
  const metadataFiles = await fs.readdir(path.dirname(metadataPath));
  assert.deepEqual(
    metadataFiles.filter((name) => name.startsWith(`${momentId}.json`)),
    [`${momentId}.json`],
    '重复保存不得为同一来源记录产生重复文件或遗留临时文件'
  );

  const corruptMomentId = 'metadata-corrupt';
  const corruptPath = getMarkiSourceMetadataPath(root, orgId, corruptMomentId);
  await fs.mkdir(path.dirname(corruptPath), { recursive: true });
  await fs.writeFile(corruptPath, '{broken-json', 'utf8');
  await assert.rejects(
    () => saveMarkiSourceMetadata(root, {
      orgId,
      momentId: corruptMomentId,
      parsedEntries: []
    }, { now }),
    (error) => (
      error?.code === 'marki_source_metadata_invalid'
      && !String(error.message || '').includes(root)
    ),
    '损坏来源元数据必须拒绝覆盖，且错误不得暴露完整路径'
  );
  assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken-json', '损坏来源元数据文件应保持原样');

  const emptyAntiCounterfeitValues = [
    '未填写',
    '未设置',
    '暂无',
    'null',
    'NULL',
    'Null',
    'undefined',
    'Undefined'
  ];
  for (const [index, antiCounterfeitCode] of emptyAntiCounterfeitValues.entries()) {
    const placeholderMomentId = `metadata-anti-empty-${index}`;
    await saveMarkiSourceMetadata(root, {
      orgId,
      momentId: placeholderMomentId,
      antiCounterfeitCode,
      parsedEntries: []
    }, metadataOptions);
    const placeholderRecord = await loadMarkiSourceMetadata(root, orgId, placeholderMomentId);
    assert.equal(
      placeholderRecord?.antiCounterfeitCode,
      '',
      `来源元数据服务必须独立过滤防伪码占位值 ${antiCounterfeitCode}`
    );
  }
  for (const [index, antiCounterfeitCode] of [0, '0', '无损防伪码-001'].entries()) {
    const validMomentId = `metadata-anti-valid-${index}`;
    await saveMarkiSourceMetadata(root, {
      orgId,
      momentId: validMomentId,
      antiCounterfeitCode,
      parsedEntries: []
    }, metadataOptions);
    const validRecord = await loadMarkiSourceMetadata(root, orgId, validMomentId);
    assert.equal(
      validRecord?.antiCounterfeitCode,
      String(antiCounterfeitCode),
      `有效防伪码 ${String(antiCounterfeitCode)} 必须保留`
    );
  }

  const renameFailure = new Error(`EACCES: rename failed at ${root}`);
  renameFailure.code = 'EACCES';
  const renameFailingFs = {
    ...fs,
    rename: async () => {
      throw renameFailure;
    }
  };
  const existingContentBeforeFailure = await fs.readFile(metadataPath, 'utf8');
  await assert.rejects(
    () => saveMarkiSourceMetadata(root, {
      ...record,
      antiCounterfeitCode: 'ANTI-RENAME-FAIL'
    }, {
      now: () => new Date('2026-07-17T04:02:00.000Z'),
      fs: renameFailingFs
    }),
    (error) => (
      error?.code === 'marki_source_metadata_save_failed'
      && !String(error.message || '').includes(root)
      && !String(error.message || '').includes('EACCES')
    ),
    '更新来源元数据 rename 失败时应返回受控错误且不得暴露路径或系统错误'
  );
  assert.equal(
    await fs.readFile(metadataPath, 'utf8'),
    existingContentBeforeFailure,
    '更新 rename 失败不得破坏已有正式元数据文件'
  );
  assert.deepEqual(
    (await fs.readdir(path.dirname(metadataPath))).filter((name) => name.includes('.tmp')),
    [],
    '更新 rename 失败后不得遗留临时文件'
  );

  const firstWriteFailureMomentId = 'metadata-first-write-failure';
  const firstWriteFailurePath = getMarkiSourceMetadataPath(root, orgId, firstWriteFailureMomentId);
  await assert.rejects(
    () => saveMarkiSourceMetadata(root, {
      orgId,
      momentId: firstWriteFailureMomentId,
      antiCounterfeitCode: 'ANTI-FIRST-FAIL',
      parsedEntries: []
    }, {
      now: () => new Date('2026-07-17T04:03:00.000Z'),
      fs: renameFailingFs
    }),
    (error) => error?.code === 'marki_source_metadata_save_failed',
    '首次来源元数据 rename 失败时应返回受控错误'
  );
  await assert.rejects(
    () => fs.access(firstWriteFailurePath),
    (error) => error?.code === 'ENOENT',
    '首次写入 rename 失败不得生成正式元数据文件'
  );
  assert.deepEqual(
    (await fs.readdir(path.dirname(firstWriteFailurePath))).filter((name) => (
      name.startsWith(`${firstWriteFailureMomentId}.json.`) && name.endsWith('.tmp')
    )),
    [],
    '首次写入 rename 失败不得遗留临时文件'
  );

  const recoveredSave = await saveMarkiSourceMetadata(root, {
    orgId,
    momentId: firstWriteFailureMomentId,
    antiCounterfeitCode: 'ANTI-RECOVERED',
    parsedEntries: []
  }, {
    now: () => new Date('2026-07-17T04:04:00.000Z')
  });
  assert.equal(recoveredSave.success, true, '文件系统恢复后应能正常重试来源元数据保存');
  assert.equal(
    (await loadMarkiSourceMetadata(root, orgId, firstWriteFailureMomentId))?.antiCounterfeitCode,
    'ANTI-RECOVERED',
    '恢复重试后应读取到完整正式元数据'
  );
}

async function checkMarkiStructuredImport(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '马克结构化导入自检必须使用系统临时目录'
  );

  const parsed = parseMarkiContent(JSON.stringify([
    ['拍摄日期', '2026/07/16'],
    ['拍摄时间', '10:30:36'],
    ['项目名称', '曲靖潇湘新区二期'],
    ['工作内容', '水泵房设备巡检'],
    ['工作备注', '请输入备注'],
    ['标题', '设备巡检'],
    ['施工单位', '佳恒维保'],
    ['上传人', '测试人员'],
    ['防伪码', 'SAFE-001']
  ]));
  assert.equal(parsed.success, true, '马克 content 数组字段应可解析');
  assert.equal(parsed.fields['日期'], '2026/07/16', '日期字段别名应规范为日期');
  assert.equal(parsed.fields['时间'], '10:30:36', '时间字段别名应规范为时间');
  assert.equal(parsed.fields['小区名称'], '曲靖潇湘新区二期', '项目字段别名应规范为小区名称');
  assert.equal(parsed.fields['工作备注'], undefined, '模板占位备注应在映射前过滤');
  assert.equal(cleanMarkiFieldValue('  请输入工作内容  '), '', '请输入类占位值应视为空');
  assert.equal(cleanMarkiFieldValue(' 公区巡查 '), '公区巡查', '有效字段值应清理并保留');
  for (const placeholder of ['', '　', '-', '--', '暂无', '未填写', '未设置', 'null', 'NULL', 'undefined', 'Undefined']) {
    assert.equal(cleanMarkiFieldValue(placeholder), '', `占位值 ${JSON.stringify(placeholder)} 应被过滤`);
  }
  assert.equal(cleanMarkiFieldValue(0), '0', '数字 0 不得被当作占位值');
  assert.equal(cleanMarkiFieldValue('0'), '0', '字符串 0 不得被当作占位值');
  assert.equal(cleanMarkiFieldValue('无障碍通道'), '无障碍通道', '包含“无”的正常业务内容不得被过滤');
  assert.equal(cleanMarkiFieldValue('无人值守'), '无人值守', '正常业务文本“无人值守”不得被过滤');
  assert.equal(cleanMarkiFieldValue('无线网络'), '无线网络', '正常业务文本“无线网络”不得被过滤');

  const frozenContentEntries = deepFreeze([
    ['日期', '2026-07-16'],
    ['工作内容', '冻结输入巡查']
  ]);
  const frozenContentSnapshot = JSON.stringify(frozenContentEntries);
  assert.equal(
    parseMarkiContent(frozenContentEntries).fields['工作内容'],
    '冻结输入巡查',
    'content 解析应支持深冻结字段数组'
  );
  assert.equal(
    JSON.stringify(frozenContentEntries),
    frozenContentSnapshot,
    'content 解析不得修改深冻结字段数组'
  );

  const specialFields = parseMarkiContent(JSON.stringify([
    ['__proto__', 'blocked'],
    ['prototype', 'blocked'],
    ['constructor', 'blocked'],
    ['工作内容', '首次巡查'],
    ['工作内容', '复查'],
    ['', 'blocked']
  ]));
  assert.deepEqual(
    Object.keys(specialFields.fields),
    ['工作内容'],
    'content 解析必须显式拒绝特殊键和空字段名'
  );
  assert.equal(specialFields.fields['工作内容'], '首次巡查', '重复字段应保留首个有效值');
  assert.equal(specialFields.warnings.length, 1, '重复有效字段应生成核对提示');
  assert.equal({}.blocked, undefined, '特殊键不得污染对象原型');

  const configs = deepFreeze({
    projects: [
      { name: '潇湘新区二期', aliases: ['曲靖潇湘新区二期', '新区二期'] },
      { name: '香辰康园', aliases: [] }
    ],
    watermarkCategories: {
      '工程类工作记录': { items: ['水电设施设备维修'] },
      '机动车违规管理': { items: ['占用消防通道'] },
      '时间地点水印': { items: ['标题/内容自定义'] }
    }
  });
  const baseMoment = deepFreeze({
    id: 'moment-structured-001',
    uid: 20001,
    teamId: 10001,
    momentType: 1,
    markName: '工程类工作记录',
    content: JSON.stringify([
      ['日期', '2026年7月16日 09:05:06'],
      ['时间', '10:30:36'],
      ['小区名称', '曲靖潇湘新区二期'],
      ['工作内容', '水泵房设备巡检'],
      ['标题', '设备巡检'],
      ['施工单位', '佳恒维保'],
      ['工作备注', '巡检正常'],
      ['地点', '地下水泵房'],
      ['上传人', '测试人员'],
      ['防伪码', 'SAFE-001']
    ]),
    lng: 103.8,
    lat: 25.5,
    postTime: Math.floor(Date.parse('2026-07-17T03:00:00Z') / 1000),
    url: 'https://private.example/photo.jpg'
  });
  const mapped = mapMarkiMoment(baseMoment, configs);
  assert.equal(mapped.contentStatus, 'parsed', '有效 content 应标记为已解析');
  assert.equal(mapped.suggestedFields.date, '2026-07-16', '水印日期必须优先于平台上传时间');
  assert.equal(mapped.watermarkRecord.captureTime, '09:05:06', '日期字段中的实际时间应优先保留');
  assert.equal(mapped.capturedAt, '2026-07-16T09:05:06+08:00', '拍摄时间应按东八区生成');
  assert.equal(mapped.suggestedFields.project, '潇湘新区二期', '项目别名应匹配现有项目');
  assert.equal(mapped.suggestedFields.watermarkCategory, '工程类工作记录', '水印名称应精确匹配当前正式分类');
  assert.equal(mapped.suggestedFields.workContent, '水泵房设备巡检', '工作内容应优先取结构化工作内容');
  assert.equal(mapped.suggestedFields.location, '地下水泵房', '地点字段应优先于经纬度');
  assert.equal(mapped.suggestedFields.remark, '巡检正常', '有效工作备注应进入建议');
  assert.deepEqual(mapped.parsedFields.keywords, ['设备巡检', '佳恒维保'], '标题和施工单位应形成辅助关键词');

  const exactProject = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-project-exact',
    content: JSON.stringify([
      ['日期', '2026-07-16'],
      ['小区名称', '潇湘新区二期'],
      ['工作内容', '设施巡查']
    ])
  }, configs);
  assert.equal(exactProject.suggestedFields.project, '潇湘新区二期', '项目名称应支持精确匹配');

  const fallbackCategory = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-structured-002',
    markName: '时间地点（兜底选择）'
  }, configs);
  assert.equal(fallbackCategory.suggestedFields.watermarkCategory, '', '未登记的旧分类名称必须保持 unresolved');

  const vehicle = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-structured-003',
    markName: '机动车违规管理',
    content: JSON.stringify([
      ['日期', '2026-07-16'],
      ['小区名称', '潇湘新区二期'],
      ['违停类型', '占用消防通道'],
      ['车牌号', '云D12345'],
      ['地点', '一号门']
    ])
  }, configs);
  assert.equal(
    vehicle.suggestedFields.workContent,
    '占用消防通道',
    '机动车公共工作内容应只同步违停类型'
  );
  assert.equal(vehicle.suggestedFields.vehiclePlate, '云D12345', '机动车车牌必须独立保存');
  assert.equal(vehicle.suggestedFields.violationType, '占用消防通道', '机动车违停类型必须独立保存');

  const postTimeFallback = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-structured-004',
    content: JSON.stringify([
      ['时间', '10:45:30'],
      ['小区名称', '潇湘新区二期'],
      ['工作内容', '设施巡查']
    ]),
    lng: 0,
    lat: 0
  }, configs);
  assert.equal(postTimeFallback.suggestedFields.date, '2026-07-17', '水印缺少日期时应使用上传日期兜底');
  assert.equal(postTimeFallback.watermarkRecord.captureTime, '10:45:30', '水印仅有时间时应继续保留实际时间');
  assert.equal(postTimeFallback.suggestedFields.location, '', '零坐标应作为合法空位置处理');
  assert.equal(
    postTimeFallback.warnings.some((item) => item.includes('上传时间兜底')),
    true,
    '上传时间兜底应产生明确提示'
  );

  const timeFieldDate = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-time-field-date',
    content: JSON.stringify([
      ['时间', '2026-07-15 08:09:10'],
      ['小区名称', '潇湘新区二期'],
      ['工作内容', '设施巡查']
    ])
  }, configs);
  assert.equal(timeFieldDate.suggestedFields.date, '2026-07-15', '日期缺失时应读取时间字段中的日期');
  assert.equal(timeFieldDate.watermarkRecord.captureTime, '08:09:10', '时间字段中的时分秒应保留');

  const invalidDate = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-invalid-date',
    content: JSON.stringify([
      ['日期', '2026-02-30'],
      ['小区名称', '潇湘新区二期'],
      ['工作内容', '设施巡查']
    ]),
    postTime: 0
  }, configs);
  assert.equal(invalidDate.suggestedFields.date, '', '无兜底时非法日期不得进入归档建议');
  assert.equal(invalidDate.missingRequiredFields.includes('日期'), true, '非法且无兜底日期应进入待补全');

  const coordinateFallback = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-structured-005',
    content: JSON.stringify([
      ['日期', '2026-07-16'],
      ['小区名称', '潇湘新区二期'],
      ['工作内容', '设施巡查']
    ])
  }, configs);
  assert.equal(
    coordinateFallback.suggestedFields.location,
    '经纬度：25.5, 103.8',
    '缺少地点时有效经纬度可作为辅助位置'
  );
  for (const [lng, lat] of [[0, 25], [103, 0], [181, 25], [103, 91], [Number.NaN, 25], [103, Number.POSITIVE_INFINITY]]) {
    const invalidCoordinate = mapMarkiMoment({
      ...baseMoment,
      id: `moment-coordinate-${String(lng)}-${String(lat)}`,
      content: JSON.stringify([
        ['日期', '2026-07-16'],
        ['小区名称', '潇湘新区二期'],
        ['工作内容', '设施巡查']
      ]),
      lng,
      lat
    }, configs);
    assert.equal(
      invalidCoordinate.suggestedFields.location,
      '',
      `无地点时无效坐标 ${String(lng)}, ${String(lat)} 不得生成位置`
    );
  }

  const unmatched = mapMarkiMoment({
    ...baseMoment,
    id: 'moment-structured-006',
    markName: '未知水印',
    content: JSON.stringify([
      ['日期', '2026-07-16'],
      ['小区名称', '未配置项目'],
      ['工作内容', '现场检查']
    ])
  }, configs);
  assert.equal(unmatched.suggestedFields.project, '', '未匹配项目不得自动写入归档建议');
  assert.deepEqual(unmatched.candidateFields.projectCandidates, ['未配置项目'], '未匹配项目应保留候选值');
  assert.equal(unmatched.missingRequiredFields.includes('项目'), true, '未匹配项目必须进入待补全状态');
  assert.equal(unmatched.suggestedFields.watermarkCategory, '', '未匹配分类不得自动写入归档建议');
  assert.deepEqual(unmatched.candidateFields.watermarkCategoryCandidates, ['未知水印'], '未匹配水印名应保留分类候选');
  assert.equal(unmatched.missingRequiredFields.includes('归档分类'), true, '未匹配分类应保持待补充状态');

  const sourceKey = buildMarkiSourceKey('12345', baseMoment.id);
  const localPath = path.join(root, 'marki-import', '12345', '10001', '2026-07-16', `${baseMoment.id}.jpg`);
  const download = deepFreeze({
    success: true,
    sourceKey,
    importStatus: 'imported',
    localPath,
    fileName: `${baseMoment.id}.jpg`,
    size: 4096,
    sha256: createHash('sha256').update(baseMoment.id).digest('hex'),
    width: 1080,
    height: 1440,
    completedAt: '2026-07-17T03:01:00.000Z'
  });
  const moments = deepFreeze([baseMoment, baseMoment]);
  const bundleInput = deepFreeze({
    orgId: '12345',
    configs,
    items: [
      { moment: moments[0], download },
      { moment: moments[1], download }
    ]
  });
  const bundleOptions = deepFreeze({
    batchId: 'marki-batch-self-check',
    now: () => new Date('2026-07-17T03:02:00.000Z')
  });
  const bundleInputSnapshot = JSON.stringify(bundleInput);
  const bundleOptionsSnapshot = JSON.stringify(bundleOptions);
  const importBundle = buildMarkiStructuredImportBundle(bundleInput, bundleOptions);
  assert.equal(JSON.stringify(bundleInput), bundleInputSnapshot, '结构化转换不得修改输入对象');
  assert.equal(JSON.stringify(bundleOptions), bundleOptionsSnapshot, '结构化转换不得修改深冻结 options');
  assert.deepEqual(
    Object.keys(importBundle),
    ['workbenchImportPackage', 'sourceMetadataRecordsByRef', 'deduplication'],
    '结构化转换 bundle 顶层结构必须稳定'
  );
  const importPackage = importBundle.workbenchImportPackage;
  assert.deepEqual(
    Object.keys(importPackage),
    [
      'batchId',
      'photos',
      'recognitionResultsByPhoto',
      'watermarkRecordsByPhoto',
      'archiveSuggestionsByPhoto'
    ],
    '工作台导入包必须严格保持五个顶层字段'
  );
  assert.equal(importPackage.batchId, 'marki-batch-self-check', '工作台导入包应保留批次标识');
  assert.equal(importPackage.photos.length, 1, '同一 sourceKey 在导入包内应去重');
  assert.deepEqual(
    importBundle.deduplication,
    {
      inputCount: 2,
      uniqueCount: 1,
      duplicateCount: 1,
      skippedItems: [{
        sourceKey,
        keptInputIndex: 0,
        skippedInputIndex: 1
      }]
    },
    '批内重复 sourceKey 必须返回稳定且不含敏感数据的去重结果'
  );
  const photo = importPackage.photos[0];
  const expectedMetadataRef = buildMarkiSourceMetadataRef('12345', baseMoment.id);
  assert.equal(photo.sourceType, 'marki_api', '马克照片来源类型应明确');
  assert.equal(photo.sourceKey, sourceKey, '照片对象应保留来源唯一标识');
  assert.equal(photo.sourceMetadataRef, expectedMetadataRef, '照片对象应使用独立来源元数据引用');
  assert.notEqual(photo.sourceMetadataRef, photo.sourceKey, '来源元数据引用不得直接等同 sourceKey');
  assert.equal(photo.originalPath, localPath, '工作台照片应使用事务下载后的本地路径');
  assert.equal(photo.originalName, `${baseMoment.id}.jpg`, '工作台照片应使用本地 JPG 文件名');
  assert.equal(photo.previewUrl.startsWith('local-photo://image/'), true, '工作台照片应使用本地预览协议');
  assert.equal(photo.capturedAt, '2026-07-16T09:05:06+08:00', '照片对象应保留水印实际拍摄时间');
  assert.equal(photo.archiveInfo, null, '结构化导入不得自动确认归档信息');
  const recognitionResult = importPackage.recognitionResultsByPhoto[photo.id];
  assert.equal(recognitionResult.source, 'marki_api', '识别结果来源应为马克 API');
  assert.equal(recognitionResult.providerType, 'structured_data', '马克识别结果应标记为结构化数据');
  assert.equal(recognitionResult.status, 'recognized', '有效结构化数据应标记为 recognized');
  assert.equal(recognitionResult.rawText, '', '工作台识别结果不得携带原始 content');
  assert.equal(
    importPackage.archiveSuggestionsByPhoto[photo.id].needsHumanReview,
    true,
    '结构化字段完整也必须进入人工确认链路'
  );
  assert.equal(
    importPackage.archiveSuggestionsByPhoto[photo.id].status,
    'suggestion_ready',
    '四个核心字段完整时应生成待确认建议'
  );
  const metadataRecord = importBundle.sourceMetadataRecordsByRef[expectedMetadataRef];
  assert.equal(Boolean(metadataRecord), true, '每张工作台照片必须有对应来源元数据记录');
  assert.equal(metadataRecord.sourceKey, sourceKey, '来源元数据记录应关联 sourceKey');
  assert.equal(metadataRecord.teamId, '10001', '来源元数据应保留团队 ID');
  assert.equal(metadataRecord.uid, '20001', '来源元数据应保留人员 UID');
  assert.equal(metadataRecord.postTime, baseMoment.postTime, '来源元数据应保留平台上传时间');
  assert.equal(metadataRecord.antiCounterfeitCode, 'SAFE-001', '防伪码必须进入后端来源元数据');
  assert.equal(Object.hasOwn(metadataRecord, 'parsedFields'), false, '来源元数据不得包含 parsedFields');
  assert.equal(
    metadataRecord.parsedEntries.some((entry) => entry.key === '上传人' && entry.value === '测试人员'),
    true,
    '清洗后的上传人条目应进入来源元数据'
  );
  const serializedPackage = JSON.stringify(importPackage);
  assert.equal(serializedPackage.includes('private.example'), false, '远程 URL 不得进入工作台导入包');
  assert.equal(serializedPackage.includes('"rawContent"'), false, '原始 content 不得进入工作台导入包');
  assert.equal(serializedPackage.includes('"content":'), false, '完整 API content 字段不得进入工作台导入包');
  assert.equal(serializedPackage.includes('SAFE-001'), false, '防伪码应保留在来源明细层，不进入工作台导入包');
  assert.equal(serializedPackage.includes('"parsedEntries"'), false, '来源字段条目不得进入五字段工作台导入包');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(importBundle)), '结构化转换 bundle 必须可 JSON 序列化');

  const otherOrgSourceKey = buildMarkiSourceKey('67890', baseMoment.id);
  const otherOrgBundle = buildMarkiStructuredImportBundle({
    orgId: '67890',
    configs,
    items: [{
      moment: baseMoment,
      download: {
        ...download,
        sourceKey: otherOrgSourceKey
      }
    }]
  }, {
    batchId: 'marki-batch-other-org',
    now: () => new Date('2026-07-17T03:02:10.000Z')
  });
  assert.notEqual(otherOrgSourceKey, sourceKey, '不同组织下相同 momentId 必须生成不同 sourceKey');
  assert.equal(otherOrgBundle.workbenchImportPackage.photos.length, 1, '不同组织的同名照片必须保留');
  assert.deepEqual(
    otherOrgBundle.deduplication,
    {
      inputCount: 1,
      uniqueCount: 1,
      duplicateCount: 0,
      skippedItems: []
    },
    '不同组织下相同 momentId 不得产生误去重'
  );

  const missingProjectPackage = buildMarkiWorkbenchImportPackage({
    orgId: '12345',
    configs,
    items: [{
      moment: {
        ...baseMoment,
        id: 'moment-missing-project',
        content: JSON.stringify([
          ['日期', '2026-07-16'],
          ['小区名称', '未配置项目'],
          ['工作内容', '设施巡查']
        ])
      },
      download: {
        ...download,
        sourceKey: buildMarkiSourceKey('12345', 'moment-missing-project'),
        localPath: path.join(root, 'moment-missing-project.jpg'),
        fileName: 'moment-missing-project.jpg'
      }
    }]
  }, {
    batchId: 'marki-batch-missing-project',
    now: () => new Date('2026-07-17T03:02:30.000Z')
  });
  const missingProjectPhoto = missingProjectPackage.photos[0];
  const missingProjectSuggestion = missingProjectPackage.archiveSuggestionsByPhoto[missingProjectPhoto.id];
  assert.equal(missingProjectSuggestion.status, 'needs_completion', '项目未匹配时归档建议必须待补全');
  assert.deepEqual(
    missingProjectSuggestion.candidateFields.projectCandidates,
    ['未配置项目'],
    '项目未匹配时归档建议必须保留项目候选'
  );

  const invalidContentPackage = buildMarkiWorkbenchImportPackage({
    orgId: '12345',
    configs,
    items: [{
      moment: {
        ...baseMoment,
        id: 'moment-structured-invalid',
        content: '{invalid-json'
      },
      download: {
        ...download,
        sourceKey: buildMarkiSourceKey('12345', 'moment-structured-invalid'),
        localPath: path.join(root, 'moment-structured-invalid.jpg'),
        fileName: 'moment-structured-invalid.jpg'
      }
    }]
  }, {
    batchId: 'marki-batch-invalid-content',
    now: () => new Date('2026-07-17T03:03:00.000Z')
  });
  assert.equal(invalidContentPackage.photos.length, 1, 'content 解析失败的照片仍应进入工作台导入包');
  const invalidPhoto = invalidContentPackage.photos[0];
  const invalidRecognition = invalidContentPackage.recognitionResultsByPhoto[invalidPhoto.id];
  assert.equal(invalidRecognition.status, 'failed', 'content 解析失败应标记为结构化数据异常');
  assert.equal(invalidRecognition.errorCode, 'marki_content_parse_failed', 'content 解析失败应返回受控错误码');
  assert.equal(
    invalidContentPackage.archiveSuggestionsByPhoto[invalidPhoto.id].status,
    'needs_completion',
    '结构化数据异常应保留待人工补充建议'
  );

  assert.throws(
    () => buildMarkiWorkbenchImportPackage({
      orgId: '12345',
      configs,
      items: [{
        moment: { ...baseMoment, id: 'video-001', momentType: 2 },
        download: { ...download, sourceKey: buildMarkiSourceKey('12345', 'video-001') }
      }]
    }),
    (error) => error?.code === 'marki_moment_type_not_supported',
    'V3.2 工作台导入包必须拒绝视频'
  );
}

async function checkMarkiFoundation(root) {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^protected:/, '')
  };
  const saved = await saveMarkiCredentials(root, safeStorage, {
    orgId: '12345',
    key: 'key123'
  });
  assert.equal(saved.success, true, '马克组织 KEY 应能通过安全存储服务保存');
  assert.equal(Object.hasOwn(saved, 'key'), false, '安全配置保存结果不得返回组织 KEY');
  const storedSource = await fs.readFile(path.join(root, 'marki-credentials.json'), 'utf8');
  assert.equal(storedSource.includes('key123'), false, '马克凭证文件不得包含组织 KEY 明文');

  const status = await getMarkiCredentialStatus(root, safeStorage);
  assert.equal(status.configured, true, '马克配置状态应显示已配置');
  assert.equal(Object.hasOwn(status, 'key'), false, '马克配置状态不得返回组织 KEY');
  const credentials = await loadMarkiCredentials(root, safeStorage);
  assert.equal(credentials.key, 'key123', '主进程内部应能解密组织 KEY');

  const officialPostSign = buildMarkiPostSignature({
    orgId: '12345',
    key: 'key123',
    timestamp: '1635160057',
    traceId: 'a1635160057',
    bodyText: '{"teamId":123,"start":"2020-01-20 00:00:00","end":"2020-10-20 00:00:00"}'
  });
  assert.equal(officialPostSign, '3d98774688237fb831d16ba13ac5341c', '马克 POST 签名必须与官方样例一致');

  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/marki/org/team')) {
      return createJsonResponse({
        code: 0,
        msg: 'ok',
        traceId: 'team-trace',
        data: {
          teamOrgList: [{
            teamId: 10001,
            teamName: '测试团队',
            createUID: 12345,
            manageUIDs: [12345],
            createTime: 1627290520,
            parentTeam: 10000,
            OrganizeId: 12345
          }]
        }
      });
    }
    return createJsonResponse({
      code: 0,
      msg: 'ok',
      traceId: 'member-trace',
      data: {
        regTotal: 1,
        unRegTotal: 0,
        total: 1,
        memberList: [{
          uid: 12345,
          nickname: '测试成员',
          phone: '13800000000',
          joinTime: 1632384679,
          memberType: 1
        }],
        next: '2|-1',
        hasMore: false
      }
    });
  };
  const requestOptions = {
    fetchImpl,
    baseUrl: 'https://marki.test',
    now: () => 1635160057000,
    traceId: 'test-trace'
  };
  const teams = await listMarkiTeams(credentials, requestOptions);
  assert.equal(teams.teams[0].teamId, '10001', '团队列表应保留稳定的字符串 ID');
  const members = await listMarkiMembers(credentials, { teamId: '10001' }, requestOptions);
  assert.equal(members.members[0].nickname, '测试成员', '成员列表应返回昵称供查询筛选');
  assert.equal(Object.hasOwn(members.members[0], 'phone'), false, '成员电话号码不得返回前端');
  assert.equal(requests[0].options.body, undefined, '团队列表 POST 请求不应发送业务参数');
  assert.equal(requests[1].options.body, '{"teamId":10001}', '成员列表请求体应保持稳定 JSON 格式');
  assert.equal(requests.every((item) => item.options.headers.sign && !item.options.headers.key), true, '请求头只应包含签名，不得发送组织 KEY');
}

async function checkMarkiPhotoQuerySessions(root) {
  const credentials = { orgId: '12345', key: 'key123' };
  const filters = {
    teamId: 10001,
    uid: 20001,
    start: '2026-07-01 00:00:00',
    end: '2026-07-17 23:59:59'
  };
  const postTime = Math.floor(Date.UTC(2026, 6, 17, 2, 30, 0) / 1000);
  const makeMoment = (id, overrides = {}) => ({
    id: String(id),
    uid: '20001',
    teamId: '10001',
    url: `https://images.test/${id}.jpg`,
    momentType: 1,
    content: JSON.stringify([
      ['小区名称', '春和苑'],
      ['工作内容', `巡查-${id}`],
      ['地点', '东门']
    ]),
    markName: '巡查检查类',
    lng: 103.5,
    lat: 25.1,
    postTime,
    ...overrides
  });
  const makePage = (moments, overrides = {}) => ({
    success: true,
    moments,
    next: '',
    hasMore: false,
    traceId: 'mock-trace',
    ...overrides
  });
  const uuidFactory = () => {
    let value = 1;
    return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`;
  };
  const createSourceChecker = (statusByMomentId = {}) => async (_documentsPath, orgId, sourceKeys) => {
    const bySourceKey = {};
    for (const sourceKey of sourceKeys) {
      const momentId = sourceKey.slice(sourceKey.lastIndexOf(':') + 1);
      const status = statusByMomentId[momentId] || 'new';
      bySourceKey[sourceKey] = {
        exists: status !== 'new',
        importStatus: status === 'new' ? '' : status
      };
    }
    return {
      success: true,
      orgId,
      bySourceKey
    };
  };
  const makeService = ({
    pages = [makePage([makeMoment('1')])],
    statusByMomentId = {},
    clock = { value: Date.UTC(2026, 6, 18, 0, 0, 0) },
    calls = []
  } = {}) => {
    let pageIndex = 0;
    const service = createMarkiPhotoQuerySessionService({
      now: () => clock.value,
      randomUUID: uuidFactory(),
      listMarkiMoments: async (receivedCredentials, input) => {
        calls.push({
          orgId: String(receivedCredentials?.orgId || ''),
          input: { ...input }
        });
        const page = pages[Math.min(pageIndex, pages.length - 1)];
        pageIndex += 1;
        return page;
      },
      checkMarkiSourceKeys: createSourceChecker(statusByMomentId)
    });
    return { service, clock, calls };
  };
  const createInput = (overrides = {}) => ({
    credentials,
    documentsPath: root,
    filters,
    ...overrides
  });
  let scenarioCount = 0;
  const apiRequests = [];
  const fetchImpl = async (url, options) => {
    apiRequests.push({ url, options });
    return createJsonResponse({
      code: 0,
      msg: 'ok',
      traceId: 'moment-trace',
      data: {
        momList: [makeMoment('moment-9001')],
        next: 'cursor-2',
        hasMore: true
      }
    });
  };
  const apiOptions = {
    fetchImpl,
    baseUrl: 'https://marki.test',
    now: () => 1650000000000,
    traceId: 'moment-query-test'
  };

  const firstApiResult = await listMarkiMoments(credentials, filters, apiOptions);
  assert.equal(apiRequests[0].url, 'https://marki.test/marki/moment', '照片查询必须使用 /marki/moment');
  assert.equal(apiRequests[0].options.method, 'POST', '照片查询必须使用 POST');
  scenarioCount += 1;

  const firstApiBody = JSON.parse(apiRequests[0].options.body);
  assert.equal(firstApiBody.momType, 1, '照片查询请求体必须固定 momType=1');
  assert.equal(Object.hasOwn(firstApiBody, 'templateFilter'), false, '模板筛选不得发送给开放接口');
  scenarioCount += 1;

  assert.equal(firstApiBody.teamId, 10001, '照片查询应写入可选 teamId');
  assert.equal(firstApiBody.uid, 20001, '照片查询应写入可选 uid');
  scenarioCount += 1;

  await listMarkiMoments(credentials, { ...filters, next: 'cursor-2' }, apiOptions);
  assert.equal(JSON.parse(apiRequests[1].options.body).next, 'cursor-2', '分页请求应原样使用内部 next');
  scenarioCount += 1;

  await assert.rejects(
    () => listMarkiMoments(credentials, {
      ...filters,
      start: '2026-07-01T00:00:00+08:00'
    }, apiOptions),
    (error) => error?.code === 'invalid_request',
    '照片查询应拒绝 ISO 时间字符串'
  );
  scenarioCount += 1;

  await assert.rejects(
    () => listMarkiMoments(credentials, {
      ...filters,
      start: '2026-02-30 00:00:00'
    }, apiOptions),
    (error) => error?.code === 'invalid_request',
    '照片查询应按 UTC+8 日历校验日期'
  );
  await assert.rejects(
    () => listMarkiMoments(credentials, {
      ...filters,
      start: '2026-07-18 00:00:00',
      end: '2026-07-17 00:00:00'
    }, apiOptions),
    (error) => error?.code === 'invalid_request',
    '照片查询开始时间不得晚于结束时间'
  );
  scenarioCount += 1;

  await assert.rejects(
    () => listMarkiMoments(credentials, {
      ...filters,
      start: '2026-06-01 00:00:00',
      end: '2026-07-03 00:00:01'
    }, apiOptions),
    (error) => error?.code === 'invalid_request',
    '照片查询时间范围不得超过 31 天'
  );
  scenarioCount += 1;

  await assert.rejects(
    () => listMarkiMoments(credentials, {
      uid: 20001,
      start: filters.start,
      end: filters.end
    }, apiOptions),
    (error) => error?.code === 'invalid_request',
    'uid 查询必须同时提供 teamId'
  );
  scenarioCount += 1;

  assert.equal(firstApiResult.moments[0].id, 'moment-9001', '照片查询应保留字符串 moment ID');
  assert.equal(firstApiResult.next, 'cursor-2', '照片查询应读取 next');
  assert.equal(firstApiResult.hasMore, true, '照片查询应读取 hasMore');
  assert.deepEqual(
    Object.keys(firstApiResult.moments[0]),
    ['id', 'uid', 'teamId', 'url', 'momentType', 'content', 'markName', 'lng', 'lat', 'postTime'],
    '主进程内部 moment 应保持固定字段白名单'
  );
  scenarioCount += 1;

  const core = makeService();
  const created = await core.service.create(createInput());
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/i, '查询会话应使用随机 UUID');
  scenarioCount += 1;

  assert.match(created.photos[0].selectionToken, /^[0-9a-f-]{36}$/i, '照片选择令牌应使用随机 UUID');
  assert.notEqual(created.photos[0].selectionToken, created.sessionId, 'sessionId 与 selectionToken 不得复用');
  scenarioCount += 1;

  assert.equal(created.sessionId.includes(credentials.orgId), false, 'sessionId 不得编码组织 ID');
  assert.equal(created.photos[0].selectionToken.includes('1'), false, 'selectionToken 不得编码 momentId');
  assert.equal(created.photos[0].selectionToken.includes('images.test'), false, 'selectionToken 不得编码照片 URL');
  scenarioCount += 1;

  assert.deepEqual(
    Object.keys(created.photos[0]),
    [
      'selectionToken',
      'displayId',
      'teamId',
      'uid',
      'photographerName',
      'templateName',
      'templateKey',
      'postTime',
      'displayDate',
      'projectText',
      'workContentText',
      'locationText',
      'selectedSourceStatus'
    ],
    'renderer 照片摘要必须严格使用十三字段安全白名单'
  );
  scenarioCount += 1;

  for (const forbidden of ['momentId', 'sourceKey', 'url', 'content', 'parsedEntries', '防伪码', 'lng', 'lat', 'orgId']) {
    assert.equal(Object.hasOwn(created.photos[0], forbidden), false, `renderer 摘要不得包含 ${forbidden}`);
  }
  scenarioCount += 1;

  assert.equal(created.photos[0].projectText, '春和苑', '摘要应复用结构化解析提取项目文本');
  assert.equal(created.photos[0].workContentText, '巡查-1', '摘要应复用结构化解析提取工作内容');
  assert.equal(created.photos[0].locationText, '东门', '摘要应复用结构化解析提取地点');
  scenarioCount += 1;

  assert.equal(created.photos[0].displayDate, '2026-07-17 10:30:00', 'postTime 应按 UTC+8 格式化');
  scenarioCount += 1;

  const paged = makeService({
    pages: [
      makePage([makeMoment('p1')], { next: 'page-2', hasMore: true }),
      makePage([makeMoment('p2'), makeMoment('p3')])
    ]
  });
  const pagedFirst = await paged.service.create(createInput());
  const pagedNext = await paged.service.loadNext(pagedFirst.sessionId, { credentials });
  assert.deepEqual(
    pagedNext.photos.map((item) => item.workContentText),
    ['巡查-p1', '巡查-p2', '巡查-p3'],
    '下一页应按首次出现顺序追加摘要'
  );
  assert.equal(pagedNext.pagination.pageCount, 2, '下一页成功后应增加页数');
  assert.equal(
    paged.calls.every((call) => !Object.hasOwn(call.input, 'templateFilter')),
    true,
    '首次查询和下一页都不得把 templateFilter 发送给开放接口'
  );
  scenarioCount += 1;

  const duplicatePaged = makeService({
    pages: [
      makePage([makeMoment('repeat', { markName: '' })], { next: 'repeat-next', hasMore: true }),
      makePage([
        makeMoment('repeat', { markName: '后页不应覆盖' }),
        makeMoment('unique')
      ])
    ]
  });
  const duplicateFirst = await duplicatePaged.service.create(createInput());
  const originalToken = duplicateFirst.photos[0].selectionToken;
  const duplicateNext = await duplicatePaged.service.loadNext(duplicateFirst.sessionId, { credentials });
  assert.equal(duplicateNext.photos.length, 2, '跨页重复 moment 不得生成重复摘要');
  assert.equal(duplicateNext.photos[0].selectionToken, originalToken, '跨页重复 moment 应复用原 selectionToken');
  assert.equal(duplicateNext.photos[0].templateKey, 'template_unknown', '跨页重复 moment 不得使用水印等级覆盖首次记录');
  scenarioCount += 1;

  assert.equal(Object.hasOwn(pagedNext, 'next'), false, '会话结果不得返回真实 next');
  assert.equal(Object.hasOwn(pagedNext.pagination, 'next'), false, '分页摘要不得返回真实 next');
  scenarioCount += 1;

  const statuses = ['new', 'discovered', 'downloading', 'download_failed', 'imported'];
  const statusService = makeService({
    pages: [makePage(statuses.map((status, index) => makeMoment(`status-${index}`)))],
    statusByMomentId: Object.fromEntries(
      statuses.map((status, index) => [`status-${index}`, status])
    )
  });
  const statusResult = await statusService.service.create(createInput());
  assert.deepEqual(
    statusResult.photos.map((item) => item.selectedSourceStatus),
    ['discovered', 'discovered', 'downloading', 'failed_retryable', 'removed_reimportable'],
    '旧来源状态应映射为当前生命周期安全状态'
  );
  scenarioCount += 1;

  const markIdService = makeService({
    pages: [makePage([makeMoment('mark-id', { markName: '', markId: 'template-100' })])]
  });
  const markIdResult = await markIdService.service.create(createInput());
  assert.equal(markIdResult.photos[0].templateKey, 'template_unknown', 'markId 不得被解释为图片水印版本或模板名称');
  scenarioCount += 1;

  const markNameService = makeService({
    pages: [makePage([
      makeMoment('mark-name-a', { markName: ' 安全管理　工作记录 ' }),
      makeMoment('mark-name-b', { markName: '安全管理 工作记录' })
    ])]
  });
  const markNameResult = await markNameService.service.create(createInput());
  assert.equal(markNameResult.photos.length, 2, '不同 moment.id 即使模板相同也必须同时保留');
  assert.equal(markNameResult.photos[0].templateName, '安全管理 工作记录', '模板名称必须执行 NFKC 和安全空白规范化');
  assert.equal(markNameResult.photos[0].templateKey, markNameResult.photos[1].templateKey, '相同 markName 必须生成相同 templateKey');
  const sameTemplateTask = markNameService.service.beginImport(
    markNameResult.sessionId,
    markNameResult.photos.map((photo) => photo.selectionToken)
  );
  assert.equal(new Set(sameTemplateTask.items.map((item) => item.sourceKey)).size, 2, '不同 moment.id 必须生成不同 sourceKey');
  assert.deepEqual(
    sameTemplateTask.items.map((item) => item.sourceKey),
    ['marki_api:12345:mark-name-a', 'marki_api:12345:mark-name-b'],
    '模板筛选不得改变 marki_api:<orgId>:<momentId> 来源键'
  );
  scenarioCount += 1;

  const explicitVersionService = makeService({
    pages: [makePage([makeMoment('explicit-version', { markName: '', isWatermarked: false })])]
  });
  const explicitVersionResult = await explicitVersionService.service.create(createInput());
  assert.equal(explicitVersionResult.photos[0].templateKey, 'template_unknown', '图片版本状态不得参与模板判断');
  assert.equal(explicitVersionResult.photos[0].selectedSourceStatus, 'discovered', '生命周期状态不得被图片版本字段覆盖');
  assert.equal(
    explicitVersionService.service.beginImport(
      explicitVersionResult.sessionId,
      [explicitVersionResult.photos[0].selectionToken]
    ).success,
    true,
    '模板未知但生命周期可导入的照片必须允许选择'
  );
  scenarioCount += 1;

  const contentOnlyService = makeService({
    pages: [makePage([makeMoment('content-only', {
      markName: '',
      content: JSON.stringify([['水印模板', '工程类工作记录']])
    })])]
  });
  const contentOnlyResult = await contentOnlyService.service.create(createInput());
  assert.equal(contentOnlyResult.photos[0].templateKey, 'template_unknown', '不得从 content 推断模板或图片水印版本');
  scenarioCount += 1;

  const getWithoutCredentials = await core.service.get(created.sessionId);
  assert.equal(getWithoutCredentials.success, true, 'get 查询会话不得依赖组织凭证');
  scenarioCount += 1;

  const destroyOnly = makeService();
  const destroyCreated = await destroyOnly.service.create(createInput());
  const destroyed = await destroyOnly.service.destroy(destroyCreated.sessionId);
  assert.equal(destroyed.destroyed, true, 'destroy 查询会话不得依赖组织凭证');
  scenarioCount += 1;

  const organizationCheck = makeService({
    pages: [
      makePage([makeMoment('org-1')], { next: 'org-next', hasMore: true }),
      makePage([makeMoment('org-2')])
    ]
  });
  const organizationSession = await organizationCheck.service.create(createInput());
  await assert.rejects(
    () => organizationCheck.service.loadNext(organizationSession.sessionId),
    (error) => error?.code === 'marki_not_configured',
    '下一页查询必须提供组织凭证'
  );
  await assert.rejects(
    () => organizationCheck.service.loadNext(organizationSession.sessionId, {
      credentials: { orgId: '54321', key: 'other-key' }
    }),
    (error) => error?.code === 'marki_photo_query_organization_changed',
    '下一页查询必须校验凭证组织与会话一致'
  );
  await assert.rejects(
    () => organizationCheck.service.get(organizationSession.sessionId),
    (error) => error?.code === 'marki_photo_query_session_not_found',
    '组织变化后旧查询会话应失效'
  );
  scenarioCount += 1;

  const idle = makeService({ clock: { value: 0 } });
  const idleSession = await idle.service.create(createInput());
  idle.clock.value = IDLE_TTL_MS;
  await assert.rejects(
    () => idle.service.get(idleSession.sessionId),
    (error) => error?.code === 'marki_photo_query_session_expired',
    '查询会话应在空闲 15 分钟后过期'
  );
  scenarioCount += 1;

  const hard = makeService({ clock: { value: 0 } });
  const hardSession = await hard.service.create(createInput());
  hard.clock.value = 10 * 60 * 1000;
  await hard.service.get(hardSession.sessionId);
  hard.clock.value = 20 * 60 * 1000;
  await hard.service.get(hardSession.sessionId);
  hard.clock.value = HARD_TTL_MS;
  await assert.rejects(
    () => hard.service.get(hardSession.sessionId),
    (error) => error?.code === 'marki_photo_query_session_expired',
    '查询会话即使持续访问也应在 30 分钟硬期限后过期'
  );
  scenarioCount += 1;

  const limitedSessions = makeService();
  for (let index = 0; index < MAX_ACTIVE_SESSIONS; index += 1) {
    await limitedSessions.service.create(createInput());
  }
  await assert.rejects(
    () => limitedSessions.service.create(createInput()),
    (error) => error?.code === 'marki_photo_query_session_limit_reached',
    '主进程最多保留三个有效照片查询会话'
  );
  scenarioCount += 1;

  const thousandMoments = Array.from(
    { length: MAX_SESSION_PHOTOS + 1 },
    (_value, index) => makeMoment(`limit-${index + 1}`)
  );
  const photoLimitCalls = [];
  const photoLimit = makeService({
    pages: [makePage(thousandMoments, { next: 'limit-next', hasMore: true })],
    calls: photoLimitCalls
  });
  const photoLimitResult = await photoLimit.service.create(createInput());
  assert.equal(photoLimitResult.photos.length, MAX_SESSION_PHOTOS, '单会话最多保存 1000 张唯一照片');
  assert.equal(photoLimitResult.pagination.limitReached, true, '达到照片上限应标记 limitReached');
  assert.equal(photoLimitResult.pagination.hasMore, false, '达到照片上限后 renderer 应视为无下一页');
  scenarioCount += 1;

  await photoLimit.service.loadNext(photoLimitResult.sessionId, { credentials });
  assert.equal(photoLimitCalls.length, 1, '达到照片上限后不得继续发起下一页请求');
  scenarioCount += 1;

  const destroyRecovery = makeService();
  const destroyRecoverySession = await destroyRecovery.service.create(createInput());
  await destroyRecovery.service.destroy(destroyRecoverySession.sessionId);
  await assert.rejects(
    () => destroyRecovery.service.get(destroyRecoverySession.sessionId),
    (error) => error?.code === 'marki_photo_query_session_not_found',
    '会话销毁后不得继续恢复'
  );
  scenarioCount += 1;

  const restartOriginal = makeService();
  const restartSession = await restartOriginal.service.create(createInput());
  const restartFresh = makeService();
  await assert.rejects(
    () => restartFresh.service.get(restartSession.sessionId),
    (error) => error?.code === 'marki_photo_query_session_not_found',
    '新的主进程内存服务实例不应恢复旧会话'
  );
  scenarioCount += 1;

  const [mainSource, preloadSource, clientSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/utils/markiClient.js'), 'utf8')
  ]);
  const startHandler = mainSource.match(
    /ipcMain\.handle\('marki:start-photo-query-session'[\s\S]*?\n\)\);/
  )?.[0] || '';
  const getHandler = mainSource.match(
    /ipcMain\.handle\('marki:get-photo-query-session'[\s\S]*?\n\)\);/
  )?.[0] || '';
  const nextHandler = mainSource.match(
    /ipcMain\.handle\('marki:load-next-photo-query-page'[\s\S]*?\n\)\);/
  )?.[0] || '';
  const destroyHandler = mainSource.match(
    /ipcMain\.handle\('marki:destroy-photo-query-session'[\s\S]*?\n\)\);/
  )?.[0] || '';
  assert.equal(startHandler.includes('safeMarkiCall'), true, '首次照片查询 IPC 必须加载组织凭证');
  assert.equal(startHandler.includes("app.getPath('documents')"), true, '首次照片查询必须使用正式 Documents 路径');
  assert.equal(startHandler.includes('getWritableDocumentsPath'), false, '照片查询不得使用可回退 userData 的 Documents 路径');
  assert.equal(nextHandler.includes('safeMarkiCall'), true, '下一页 IPC 必须加载组织凭证');
  assert.equal(getHandler.includes('safeMarkiLocalCall'), true, '查询会话恢复不得加载组织凭证');
  assert.equal(destroyHandler.includes('safeMarkiLocalCall'), true, '查询会话销毁不得加载组织凭证');
  assert.equal(/loadNextMarkiPhotoQueryPage\(sessionId, \{ credentials \}\)/.test(nextHandler), true, '下一页只能由主进程注入凭证');
  const preloadMarki = preloadSource.match(/marki: \{([\s\S]*?)\n  \},\n  loadConfigs:/)?.[1] || '';
  for (const method of [
    'startPhotoQuerySession',
    'getPhotoQuerySession',
    'loadNextPhotoQueryPage',
    'destroyPhotoQuerySession'
  ]) {
    assert.equal(preloadMarki.includes(`${method}:`), true, `preload 应暴露 ${method}`);
    assert.equal(clientSource.includes(`function ${method}`) || clientSource.includes(`function ${method.replace('Photo', 'MarkiPhoto')}`), true, `markiClient 应包装 ${method}`);
  }
  for (const forbidden of ['orgId', 'next,', 'momentId', 'remoteUrl', 'documentsPath', 'userDataPath']) {
    assert.equal(preloadMarki.includes(forbidden), false, `preload 照片查询接口不得暴露 ${forbidden}`);
  }
  scenarioCount += 1;

  assert.equal(
    apiRequests.every((request) => request.url.startsWith('https://marki.test/')),
    true,
    '照片查询自检只能使用受控 mock API'
  );
  assert.equal(
    apiRequests.some((request) => request.url.includes('open-api.markiapp.com')),
    false,
    '照片查询自检不得访问真实马克平台'
  );
  scenarioCount += 1;

  const cleanup = makeService();
  const cleanupSession = await cleanup.service.create(createInput());
  await cleanup.service.destroy(cleanupSession.sessionId);
  const cleanupResult = await cleanup.service.cleanup();
  assert.equal(cleanupResult.activeCount, 0, '照片查询自检结束后不得遗留内存会话');
  await assert.rejects(
    () => fs.access(root),
    (error) => error?.code === 'ENOENT',
    '照片查询会话自检不得生成临时文件'
  );
  scenarioCount += 1;

  assert.equal(scenarioCount, 37, '马克照片查询 API 与可信会话应完整执行 37 个自检场景');
}

async function checkMarkiImportTimeHelpers() {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'markiClient.js')
  ).href;
  const {
    createDefaultMarkiImportFilters,
    parseMarkiImportBeijingDateTime
  } = await import(`${moduleUrl}?marki-time=${Date.now()}`);

  const utcMinusSevenInstant = Date.parse('2026-07-17T23:30:00-07:00');
  assert.deepEqual(
    createDefaultMarkiImportFilters(utcMinusSevenInstant),
    {
      teamId: '',
      uid: '',
      templateFilter: 'all',
      importStatusFilter: 'all',
      start: '2026-07-18T00:00',
      end: '2026-07-18T14:30'
    },
    '马克导入默认时间不得依赖 UTC-7 系统语义或夏令时'
  );
  assert.deepEqual(
    createDefaultMarkiImportFilters(Date.parse('2026-07-17T15:59:00Z')),
    {
      teamId: '',
      uid: '',
      templateFilter: 'all',
      importStatusFilter: 'all',
      start: '2026-07-17T00:00',
      end: '2026-07-17T23:59'
    },
    '北京时间跨日前一分钟应保持当天范围'
  );
  assert.deepEqual(
    createDefaultMarkiImportFilters(Date.parse('2026-07-17T16:05:00Z')),
    {
      teamId: '',
      uid: '',
      templateFilter: 'all',
      importStatusFilter: 'all',
      start: '2026-07-18T00:00',
      end: '2026-07-18T00:05'
    },
    '绝对时间跨过北京时间零点后应切换默认日期'
  );
  assert.equal(
    parseMarkiImportBeijingDateTime('2026-03-08T01:30'),
    Date.UTC(2026, 2, 7, 17, 30),
    '北京时间筛选解析必须使用固定 UTC+8，不受夏令时影响'
  );
  assert.equal(
    Number.isNaN(parseMarkiImportBeijingDateTime('2026-02-30T01:30')),
    true,
    '北京时间筛选解析应拒绝不存在的日期'
  );
}

async function checkMarkiReadyBatchRefresh() {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'markiClient.js')
  ).href;
  const {
    createMarkiReadyBatchRefresh,
    normalizeReadyBatchRefreshResult
  } = await import(`${moduleUrl}?ready-refresh=${Date.now()}`);
  const safeBatch = {
    batchId: 'ready-refresh-001',
    status: 'ready',
    inputCount: 2,
    metadataSavedCount: 2,
    createdAt: '2026-07-19T01:00:00.000Z',
    updatedAt: '2026-07-19T01:01:00.000Z',
    expiresAt: '2026-07-20T01:01:00.000Z'
  };

  const empty = normalizeReadyBatchRefreshResult({
    success: true,
    items: [],
    failedCount: 0
  });
  assert.equal(empty.success, true, '空 ready 列表应视为成功刷新');
  assert.deepEqual(empty.items, [], '空 ready 列表应保持空数组');
  assert.equal(empty.notice.type, 'info', '空 ready 列表应显示空结果提示');
  assert.match(empty.notice.text, /当前没有待进入工作台/, '空 ready 列表提示应明确当前无批次');

  const available = normalizeReadyBatchRefreshResult({
    success: true,
    items: [safeBatch],
    failedCount: 0
  });
  assert.equal(available.items.length, 1, '正常 ready 列表应返回一个安全批次');
  assert.equal(available.notice.type, 'success', '存在 ready 批次时应显示成功提示');
  assert.match(available.notice.text, /找到 1 个/, '成功提示应包含 ready 批次数量');

  const damaged = normalizeReadyBatchRefreshResult({
    success: true,
    items: [],
    failedCount: 2
  });
  assert.equal(damaged.failedCount, 2, '损坏批次数量应原样保留');
  assert.equal(damaged.notice.type, 'warning', '存在损坏批次时应显示安全警告');
  assert.match(damaged.notice.text, /2 个批次文件无法读取/, '警告应包含无法读取的批次数量');

  const unavailable = createMarkiReadyBatchRefresh(async () => {
    throw new Error('private IPC failure');
  });
  const failed = await unavailable();
  assert.equal(failed.success, false, 'IPC 抛错应转换为失败刷新结果');
  assert.equal(failed.notice.type, 'error', 'IPC 抛错应显示明确错误提示');
  assert.equal(failed.notice.text, '马克待处理批次查询失败。', '错误提示不得泄露原始异常');
  assert.equal(JSON.stringify(failed).includes('private IPC failure'), false, '失败结果不得泄露原始 IPC 异常');

  let requestCount = 0;
  let releaseRequest;
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const singleFlightRefresh = createMarkiReadyBatchRefresh(async () => {
    requestCount += 1;
    await requestGate;
    return { success: true, items: [], failedCount: 0 };
  });
  const firstRefresh = singleFlightRefresh();
  const secondRefresh = singleFlightRefresh();
  assert.equal(firstRefresh, secondRefresh, '连续刷新必须复用同一个进行中请求');
  assert.equal(requestCount, 0, '刷新请求应在微任务中受控启动');
  await Promise.resolve();
  assert.equal(requestCount, 1, '连续刷新只能发起一次 IPC 请求');
  releaseRequest();
  await Promise.all([firstRefresh, secondRefresh]);
  await singleFlightRefresh();
  assert.equal(requestCount, 2, '刷新完成后锁必须释放并允许再次刷新');
}

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  };
}

async function checkMaintenanceRecommendations(root) {
  const documentsPath = path.join(root, 'documents');
  const archiveRoot = path.join(root, 'archive');
  const packageRoot = path.join(root, 'packages');
  await fs.mkdir(archiveRoot, { recursive: true });
  await fs.mkdir(packageRoot, { recursive: true });
  await saveSettings(documentsPath, {
    defaultArchiveRoot: archiveRoot,
    lastArchiveRoot: archiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: packageRoot
  });

  const report = await getDataMaintenanceReport({ documentsPath, projectRoot: process.cwd() });
  const directoryByKey = new Map(report.directoryStatus.items.map((item) => [item.key, item]));
  assert.equal(directoryByKey.get('sortDrafts')?.status, 'info', '尚未创建的分拣草稿目录不应误报异常');
  assert.equal(directoryByKey.get('configBackup')?.status, 'info', '尚未创建的设置备份目录不应误报异常');
  assert.equal(report.sortProgressStatus.status, 'info', '没有分拣草稿应为提示状态');
  assert.equal(report.packageStatus.status, 'normal', '已配置且可读写的空资料包目录应为正常状态');
  assert.equal(report.suggestions.some((item) => item.title.includes('分拣进度保存目录不可用')), false, '维护建议不应误报分拣草稿目录');
  assert.equal(report.suggestions.some((item) => item.title.includes('设置备份目录不可用')), false, '维护建议不应误报设置备份目录');

  await saveSettings(documentsPath, {
    defaultArchiveRoot: archiveRoot,
    lastArchiveRoot: archiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: ''
  });
  const optionalPackageReport = await getDataMaintenanceReport({ documentsPath, projectRoot: process.cwd() });
  const optionalPackageSuggestion = optionalPackageReport.suggestions.find((item) => item.title.includes('资料包导出目录未配置'));
  assert.equal(optionalPackageSuggestion?.level, 'info', '未配置可选资料包目录只应显示普通提示');

  const invalidDocumentsPath = path.join(root, 'invalid-documents');
  const missingArchiveRoot = path.join(root, 'missing-archive');
  await saveSettings(invalidDocumentsPath, {
    defaultArchiveRoot: missingArchiveRoot,
    lastArchiveRoot: missingArchiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: ''
  });
  const invalidReport = await getDataMaintenanceReport({ documentsPath: invalidDocumentsPath, projectRoot: process.cwd() });
  assert.equal(invalidReport.suggestions.some((item) => item.title === '默认归档根目录不可用'), true, '失效归档根目录应明确提示');
  assert.equal(invalidReport.suggestions.some((item) => item.title === '未发现归档台账'), false, '归档根目录失效时不应重复提示未发现台账');
}

async function checkRapidOcrRuntimeProvisioning(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    'RapidOCR 运行时自检必须使用系统临时目录'
  );
  await fs.mkdir(root, { recursive: true });

  const assetName = 'rapidocr-runner-2026.7.2-v3.9.1-win-x64.exe';
  const releaseTag = 'rapidocr-runtime-2026.7.2-v3.9.1';
  const installRelativePath = 'vendor/ocr/rapidocr/rapidocr-runner.exe';
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const buildManifest = (buffer, overrides = {}) => ({
    schemaVersion: 1,
    component: 'rapidocr-runner',
    version: '2026.7.2-v3.9.1',
    platform: 'win32',
    arch: 'x64',
    releaseTag,
    assetName,
    downloadUrl: `https://github.com/ipet520/property-photo-archive-assistant/releases/download/${releaseTag}/${assetName}`,
    sha256: digest(buffer),
    sizeBytes: buffer.length,
    installRelativePath,
    ...overrides
  });
  const createCase = async (name, expectedBytes, manifestOverrides = {}) => {
    const repoRoot = path.join(root, name);
    const manifest = buildManifest(expectedBytes, manifestOverrides);
    const manifestPath = path.join(repoRoot, 'vendor', 'ocr', 'rapidocr', 'runtime-manifest.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return {
      repoRoot,
      manifest,
      manifestPath,
      installPath: path.join(repoRoot, ...installRelativePath.split('/'))
    };
  };
  const response = (statusCode, chunks = [], headers = {}) => ({
    statusCode,
    headers,
    stream: Readable.from(chunks)
  });
  const assertRejectCode = async (promise, expectedCode, message) => {
    await assert.rejects(
      promise,
      (error) => {
        assert.equal(error?.code, expectedCode, message);
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(error)), 'RapidOCR 错误应可安全 JSON 序列化');
        assert.equal(JSON.stringify(error).includes(root), false, 'RapidOCR 错误不得暴露测试绝对路径');
        return true;
      }
    );
  };
  const assertNoInstallArtifacts = async (installPath) => {
    const directory = path.dirname(installPath);
    const names = await fs.readdir(directory);
    assert.equal(
      names.some((name) => name.endsWith('.part') || name.endsWith('.ensure.lock')),
      false,
      'RapidOCR 安装结束后不得遗留 .part 或锁文件'
    );
  };

  const validBytes = Buffer.from('rapidocr-test-runner-v1');
  const validManifest = validateRuntimeManifest(buildManifest(validBytes));
  assert.equal(validManifest.component, 'rapidocr-runner', '1. 合法清单应通过生产校验');

  const missingField = buildManifest(validBytes);
  delete missingField.sha256;
  assert.throws(
    () => validateRuntimeManifest(missingField),
    (error) => error?.code === 'rapidocr_manifest_missing_field',
    '2. 清单缺字段时应明确拒绝'
  );
  assert.throws(
    () => validateRuntimeManifest(buildManifest(validBytes, {
      downloadUrl: `http://github.com/ipet520/property-photo-archive-assistant/releases/download/${releaseTag}/${assetName}`
    })),
    (error) => error?.code === 'rapidocr_manifest_download_url_invalid',
    '3. 非 HTTPS 清单地址应拒绝'
  );
  assert.throws(
    () => validateRuntimeManifest(buildManifest(validBytes, { sha256: 'not-a-sha256' })),
    (error) => error?.code === 'rapidocr_manifest_sha256_invalid',
    '4. 非法 SHA-256 应拒绝'
  );
  assert.throws(
    () => validateRuntimeManifest(buildManifest(validBytes, { sizeBytes: 0 })),
    (error) => error?.code === 'rapidocr_manifest_size_invalid',
    '5. 非法 sizeBytes 应拒绝'
  );

  const existingCase = await createCase('06-existing-valid', validBytes);
  await fs.writeFile(existingCase.installPath, validBytes);
  const existingResult = await ensureRapidOcrRunner({
    repoRoot: existingCase.repoRoot,
    manifestPath: existingCase.manifestPath,
    env: {}
  });
  assert.deepEqual(
    existingResult,
    { version: '2026.7.2-v3.9.1', source: 'existing', verified: true },
    '6. 已有合法 runner 应直接复用且不访问网络'
  );

  const sameSizeWrongBytes = Buffer.from('rapidocr-test-runner-v2');
  assert.equal(sameSizeWrongBytes.length, validBytes.length, '错误哈希样本应保持相同字节数');
  const wrongExistingCase = await createCase('07-existing-wrong-hash', validBytes);
  await fs.writeFile(wrongExistingCase.installPath, sameSizeWrongBytes);
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: wrongExistingCase.repoRoot,
      manifestPath: wrongExistingCase.manifestPath,
      env: {}
    }),
    'rapidocr_existing_runner_invalid',
    '7. 同大小但错误哈希的已有 runner 应拒绝'
  );

  const localSourceCase = await createCase('08-local-source-success', validBytes);
  const localSourcePath = path.join(localSourceCase.repoRoot, 'offline-source.exe');
  await fs.writeFile(localSourcePath, validBytes);
  const localSourceResult = await ensureRapidOcrRunner({
    repoRoot: localSourceCase.repoRoot,
    manifestPath: localSourceCase.manifestPath,
    env: { RAPIDOCR_RUNNER_SOURCE: localSourcePath }
  });
  assert.equal(localSourceResult.source, 'local-source', '8. 合法本地来源应完成原子安装');

  const localSizeCase = await createCase('09-local-source-size', validBytes);
  const localSizePath = path.join(localSizeCase.repoRoot, 'offline-source.exe');
  await fs.writeFile(localSizePath, Buffer.from('short'));
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: localSizeCase.repoRoot,
      manifestPath: localSizeCase.manifestPath,
      env: { RAPIDOCR_RUNNER_SOURCE: localSizePath }
    }),
    'rapidocr_local_source_size_mismatch',
    '9. 本地来源字节数不一致应拒绝'
  );

  const localHashCase = await createCase('10-local-source-hash', validBytes);
  const localHashPath = path.join(localHashCase.repoRoot, 'offline-source.exe');
  await fs.writeFile(localHashPath, sameSizeWrongBytes);
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: localHashCase.repoRoot,
      manifestPath: localHashCase.manifestPath,
      env: { RAPIDOCR_RUNNER_SOURCE: localHashPath }
    }),
    'rapidocr_local_source_hash_mismatch',
    '10. 本地来源哈希不一致应拒绝'
  );

  const downloadCase = await createCase('11-download-success', validBytes);
  let downloadRequestCount = 0;
  const downloadResult = await ensureRapidOcrRunner({
    repoRoot: downloadCase.repoRoot,
    manifestPath: downloadCase.manifestPath,
    env: {},
    requestImpl: async () => {
      downloadRequestCount += 1;
      return response(200, [validBytes], { 'content-length': String(validBytes.length) });
    }
  });
  assert.equal(downloadResult.source, 'release-download', '11. 受控下载应完成原子安装');
  assert.equal(downloadRequestCount, 1, '正常下载只应请求一次');

  const interruptedCase = await createCase('12-download-interrupted', validBytes);
  const interruptedStream = Readable.from((async function* interrupted() {
    yield validBytes.subarray(0, 5);
    throw new Error('controlled interruption');
  }()));
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: interruptedCase.repoRoot,
      manifestPath: interruptedCase.manifestPath,
      env: {},
      requestImpl: async () => ({
        statusCode: 200,
        headers: {},
        stream: interruptedStream
      })
    }),
    'rapidocr_file_write_failed',
    '12. 下载中断后应失败'
  );
  await assert.rejects(() => fs.access(interruptedCase.installPath), (error) => error?.code === 'ENOENT', '下载中断不得留下正式文件');

  const overSizeCase = await createCase('13-download-over-size', validBytes);
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: overSizeCase.repoRoot,
      manifestPath: overSizeCase.manifestPath,
      env: {},
      requestImpl: async () => response(200, [Buffer.concat([validBytes, Buffer.from('x')])])
    }),
    'rapidocr_download_size_exceeded',
    '13. 下载超过清单字节数应立即失败'
  );

  const wrongHashDownloadCase = await createCase('14-download-wrong-hash', validBytes);
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: wrongHashDownloadCase.repoRoot,
      manifestPath: wrongHashDownloadCase.manifestPath,
      env: {},
      requestImpl: async () => response(200, [sameSizeWrongBytes])
    }),
    'rapidocr_download_hash_mismatch',
    '14. 下载完成但哈希不一致应失败'
  );

  const redirectLimitCase = await createCase('15-redirect-limit', validBytes);
  let redirectRequestCount = 0;
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: redirectLimitCase.repoRoot,
      manifestPath: redirectLimitCase.manifestPath,
      env: {},
      requestImpl: async () => {
        redirectRequestCount += 1;
        return response(302, [], { location: 'https://github.com/redirect-again' });
      }
    }),
    'rapidocr_redirect_limit_exceeded',
    '15. 重定向超过五次应失败'
  );
  assert.equal(redirectRequestCount, 6, '重定向上限测试应在发出第六跳前后受控终止');

  const redirectHttpCase = await createCase('16-redirect-http', validBytes);
  let insecureTargetRequests = 0;
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: redirectHttpCase.repoRoot,
      manifestPath: redirectHttpCase.manifestPath,
      env: {},
      requestImpl: async () => {
        insecureTargetRequests += 1;
        return response(302, [], { location: 'http://example.invalid/runner.exe' });
      }
    }),
    'rapidocr_redirect_protocol_not_allowed',
    '16. HTTPS 重定向到 HTTP 应在请求前拒绝'
  );
  assert.equal(insecureTargetRequests, 1, 'HTTP 重定向目标不得被实际请求');

  const concurrentCase = await createCase('17-concurrent', validBytes);
  let concurrentRequestCount = 0;
  const concurrentOptions = {
    repoRoot: concurrentCase.repoRoot,
    manifestPath: concurrentCase.manifestPath,
    env: {},
    requestImpl: async () => {
      concurrentRequestCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(200, [validBytes]);
    }
  };
  const concurrentResults = await Promise.all([
    ensureRapidOcrRunner(concurrentOptions),
    ensureRapidOcrRunner(concurrentOptions)
  ]);
  assert.equal(concurrentRequestCount, 1, '17. 同进程并发调用应只执行一次安装');
  assert.deepEqual(concurrentResults[0], concurrentResults[1], '并发调用应共享同一安装结果');

  for (const item of [
    localSourceCase,
    localSizeCase,
    localHashCase,
    downloadCase,
    interruptedCase,
    overSizeCase,
    wrongHashDownloadCase,
    redirectLimitCase,
    redirectHttpCase,
    concurrentCase
  ]) {
    await assertNoInstallArtifacts(item.installPath);
  }
  assert.ok(true, '18. 成功和失败后 .part 与锁文件均已清理');

  assert.doesNotThrow(
    () => JSON.parse(JSON.stringify(downloadResult)),
    '19. RapidOCR 成功结果应可 JSON 序列化'
  );
  const serializedError = serializeRuntimeError(new Error('internal path should not escape'));
  assert.deepEqual(
    Object.keys(serializedError).sort(),
    ['code', 'message'],
    'RapidOCR 受控错误只应返回安全代码和短消息'
  );

  const explicitInvalidCase = await createCase('20-existing-invalid', validBytes);
  await fs.writeFile(explicitInvalidCase.installPath, sameSizeWrongBytes);
  const invalidVerification = await verifyRunnerFile(explicitInvalidCase.installPath, explicitInvalidCase.manifest);
  assert.equal(invalidVerification.valid, false, '20. 已有错误文件不得被静默视为合法 runner');
  await assertRejectCode(
    ensureRapidOcrRunner({
      repoRoot: explicitInvalidCase.repoRoot,
      manifestPath: explicitInvalidCase.manifestPath,
      env: {}
    }),
    'rapidocr_existing_runner_invalid',
    '已有错误 runner 应要求人工处理'
  );

  assert.throws(
    () => validateRuntimeManifest(buildManifest(validBytes, { installRelativePath: '../rapidocr-runner.exe' })),
    (error) => error?.code === 'rapidocr_manifest_install_path_invalid',
    '21. installRelativePath 路径穿越应拒绝'
  );
  assert.throws(
    () => validateRuntimeManifest(buildManifest(validBytes, { installRelativePath: 'C:\\rapidocr-runner.exe' })),
    (error) => error?.code === 'rapidocr_manifest_install_path_invalid',
    '22. 清单中的绝对安装路径应拒绝'
  );

  const downloadedBytes = await fs.readFile(downloadCase.installPath);
  assert.deepEqual(downloadedBytes, validBytes, '23. 成功安装后的文件字节应与下载来源完全一致');

  const ensureModulePath = require.resolve('./ensure-rapidocr-runner.cjs');
  delete require.cache[ensureModulePath];
  const freshEnsureModule = require('./ensure-rapidocr-runner.cjs');
  const freshResult = await freshEnsureModule.ensureRapidOcrRunner({
    repoRoot: downloadCase.repoRoot,
    manifestPath: downloadCase.manifestPath,
    env: {}
  });
  assert.equal(freshResult.source, 'existing', '24. 删除 require cache 后仍应校验并复用已安装 runner');
  assert.equal(
    freshEnsureModule.resolveInstallPath(downloadCase.repoRoot, downloadCase.manifest),
    resolveInstallPath(downloadCase.repoRoot, downloadCase.manifest),
    '重新加载模块后安装路径规则应保持一致'
  );

  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rapidocr-runtime-cleanup-'));
  try {
    await fs.writeFile(path.join(cleanupRoot, 'temporary.bin'), validBytes);
  } finally {
    await fs.rm(cleanupRoot, { recursive: true, force: true });
  }
  await assert.rejects(
    () => fs.access(cleanupRoot),
    (error) => error?.code === 'ENOENT',
    '25. RapidOCR 自检专用临时目录最终应全部删除'
  );
}

async function checkRecognitionEngine(userDataDir) {
  const status = await getRecognitionStatus(userDataDir);
  const localProvider = (status.providers || []).find((provider) => provider.id === 'local_ocr' || provider.providerId === 'local_ocr');
  assert.equal(localProvider?.available, true, `本地 OCR 引擎不可用：${localProvider?.reason || status.reason || '未知原因'}`);
  assert.equal(localProvider?.engine, 'rapidocr', '本地 OCR 引擎应为 RapidOCR');
  assert.match(String(localProvider?.componentVersion || ''), /2026\.7\.2.*v3\.9\.1/i, 'OCR 组件版本号未统一');
}

async function checkMarkiImportOrchestrator(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '马克导入编排自检必须使用系统临时目录'
  );
  const orgId = '12345';
  const loadedConfigs = deepFreeze({
    projects: ['潇湘新区二期'],
    watermarkCategories: {
      '工程类专用': { items: ['设施巡查'] }
    }
  });
  const buildItem = (index) => {
    const suffix = String(index).padStart(3, '0');
    const momentId = `orchestrator-${suffix}`;
    return {
      moment: {
        id: momentId,
        uid: 20000 + index,
        teamId: 10001,
        momentType: 1,
        markName: '工程类专用',
        content: JSON.stringify([
          ['日期', '2026-07-17'],
          ['小区名称', '潇湘新区二期'],
          ['工作内容', '设施巡查'],
          ['上传人', `测试人员${suffix}`],
          ['防伪码', `SAFE-${suffix}`]
        ]),
        lng: 103.8,
        lat: 25.5,
        postTime: Math.floor(Date.parse('2026-07-17T03:00:00Z') / 1000),
        url: `https://private.example/${momentId}.jpg`
      },
      download: {
        success: true,
        sourceKey: buildMarkiSourceKey(orgId, momentId),
        importStatus: 'imported',
        localPath: path.join(root, 'downloads', `${momentId}.jpg`),
        fileName: `${momentId}.jpg`,
        size: 4096 + index,
        sha256: createHash('sha256').update(momentId).digest('hex'),
        width: 1080,
        height: 1440,
        completedAt: '2026-07-17T03:01:00.000Z'
      }
    };
  };
  const items = deepFreeze(Array.from({ length: 10 }, (_, index) => buildItem(index + 1)));
  const inputSnapshot = JSON.stringify(items);
  const firstNow = () => new Date('2026-07-17T04:00:00.000Z');
  const retryNow = () => new Date('2026-07-17T05:00:00.000Z');

  await fs.mkdir(root, { recursive: true });
  try {
    const successRoot = path.join(root, 'all-success');
    const configLoadPaths = [];
    const successResult = await prepareMarkiStructuredImport({
      documentsPath: successRoot,
      orgId,
      items,
      configs: {
        projects: ['不得使用的前端项目'],
        watermarkCategories: {}
      }
    }, {
      loadConfigs: async (documentsPath) => {
        configLoadPaths.push(documentsPath);
        return loadedConfigs;
      },
      batchId: 'marki-orchestrator-success',
      now: firstNow
    });
    assert.equal(JSON.stringify(items), inputSnapshot, '马克导入编排不得修改输入照片列表');
    assert.equal(configLoadPaths.length, 1, '马克导入编排应只加载一次正式配置');
    assert.equal(configLoadPaths[0], successRoot, '马克导入编排必须使用传入的 Documents 路径加载配置');
    assert.equal(successResult.success, true, '十条来源元数据全部保存时编排应成功');
    assert.equal(successResult.batchId, 'marki-orchestrator-success', '编排结果应返回 bundle 批次 ID');
    assert.equal(successResult.inputCount, 10, '编排结果应返回原始输入数量');
    assert.equal(successResult.metadataSavedCount, 10, '十条来源元数据应全部保存');
    assert.equal(successResult.failedCount, 0, '全部保存成功时失败数应为零');
    assert.deepEqual(successResult.failures, [], '全部保存成功时不应返回失败项');
    assert.deepEqual(
      Object.keys(successResult.workbenchImportPackage),
      [
        'batchId',
        'photos',
        'recognitionResultsByPhoto',
        'watermarkRecordsByPhoto',
        'archiveSuggestionsByPhoto'
      ],
      '编排交付的工作台导入包必须严格保持五字段'
    );
    const firstPhoto = successResult.workbenchImportPackage.photos[0];
    const firstSuggestion = successResult.workbenchImportPackage
      .archiveSuggestionsByPhoto[firstPhoto.id];
    assert.equal(
      firstSuggestion.suggestedFields.project,
      '潇湘新区二期',
      '正式归档项目必须来自 loadConfigs 返回的配置'
    );
    assert.equal(
      JSON.stringify(successResult.workbenchImportPackage).includes('不得使用的前端项目'),
      false,
      '编排服务不得使用输入中的前端项目配置'
    );
    for (const item of items) {
      const stored = await loadMarkiSourceMetadata(
        successRoot,
        orgId,
        item.moment.id
      );
      assert.equal(Boolean(stored), true, '全部成功时每张照片都应写入来源元数据');
    }

    const partialRoot = path.join(root, 'partial-failure');
    const saveAttempts = [];
    const partialResult = await prepareMarkiStructuredImport({
      documentsPath: partialRoot,
      orgId,
      items
    }, {
      loadConfigs: async () => loadedConfigs,
      saveSourceMetadata: async (documentsPath, record, saveOptions) => {
        saveAttempts.push(record.sourceMetadataRef);
        if (record.momentId === 'orchestrator-006') {
          const error = new Error(`存储失败 ${documentsPath} https://private.example secret-content`);
          error.code = 'marki_source_metadata_save_failed';
          error.parsedEntries = record.parsedEntries;
          throw error;
        }
        return saveMarkiSourceMetadata(documentsPath, record, saveOptions);
      },
      batchId: 'marki-orchestrator-partial',
      now: firstNow
    });
    assert.equal(saveAttempts.length, 10, '第六条失败后仍必须尝试全部十条元数据');
    assert.equal(partialResult.success, false, '存在来源元数据失败时整批应失败');
    assert.equal(partialResult.metadataSavedCount, 9, '第六条失败时应有九条成功');
    assert.equal(partialResult.failedCount, 1, '第六条失败时应汇总一条失败');
    assert.equal(partialResult.workbenchImportPackage, null, '部分失败时必须扣留工作台导入包');
    assert.deepEqual(
      Object.keys(partialResult.failures[0]),
      ['sourceMetadataRef', 'sourceKey', 'code', 'message'],
      '单条失败只允许返回安全字段白名单'
    );
    assert.equal(
      partialResult.failures[0].sourceMetadataRef,
      buildMarkiSourceMetadataRef(orgId, 'orchestrator-006'),
      '失败汇总应准确关联第六条来源元数据'
    );
    const serializedFailures = JSON.stringify(partialResult.failures);
    for (const forbidden of [
      partialRoot,
      'private.example',
      'secret-content',
      'parsedEntries',
      'antiCounterfeitCode',
      'SAFE-006',
      'stack'
    ]) {
      assert.equal(
        serializedFailures.includes(forbidden),
        false,
        `失败汇总不得包含敏感内容 ${forbidden}`
      );
    }
    assert.doesNotThrow(
      () => JSON.parse(JSON.stringify(partialResult)),
      '编排失败结果必须可 JSON 序列化'
    );

    for (const item of items) {
      const stored = await loadMarkiSourceMetadata(partialRoot, orgId, item.moment.id);
      assert.equal(
        Boolean(stored),
        item.moment.id !== 'orchestrator-006',
        '第六条失败不得回滚其他成功记录，后续记录仍应保存'
      );
    }
    const beforeRetry = await loadMarkiSourceMetadata(
      partialRoot,
      orgId,
      'orchestrator-001'
    );
    const retryResult = await prepareMarkiStructuredImport({
      documentsPath: partialRoot,
      orgId,
      items
    }, {
      loadConfigs: async () => loadedConfigs,
      batchId: 'marki-orchestrator-retry',
      now: retryNow
    });
    assert.equal(retryResult.success, true, '修复单条失败后整批重试应成功');
    assert.equal(retryResult.metadataSavedCount, 10, '幂等重试应成功提交全部十条记录');
    assert.equal(retryResult.failedCount, 0, '幂等重试后不应保留失败项');
    assert.equal(Boolean(retryResult.workbenchImportPackage), true, '幂等重试成功后应恢复交付工作台包');
    const afterRetry = await loadMarkiSourceMetadata(
      partialRoot,
      orgId,
      'orchestrator-001'
    );
    assert.equal(afterRetry.createdAt, beforeRetry.createdAt, '幂等重试必须保留来源元数据 createdAt');
    assert.equal(
      Date.parse(afterRetry.updatedAt) > Date.parse(beforeRetry.updatedAt),
      true,
      '幂等重试应合理更新来源元数据 updatedAt'
    );
    const metadataDirectory = path.dirname(getMarkiSourceMetadataPath(
      partialRoot,
      orgId,
      'orchestrator-001'
    ));
    const metadataFiles = (await fs.readdir(metadataDirectory))
      .filter((fileName) => fileName.endsWith('.json'));
    assert.equal(metadataFiles.length, 10, '幂等重试不得生成重复来源元数据文件');

    const deduplicationRoot = path.join(root, 'deduplication');
    const deduplicationSaves = [];
    const deduplicationResult = await prepareMarkiStructuredImport({
      documentsPath: deduplicationRoot,
      orgId,
      items: [items[0], items[0], items[1]]
    }, {
      loadConfigs: async () => loadedConfigs,
      saveSourceMetadata: async (documentsPath, record, saveOptions) => {
        deduplicationSaves.push(record.sourceKey);
        return saveMarkiSourceMetadata(documentsPath, record, saveOptions);
      },
      batchId: 'marki-orchestrator-deduplication',
      now: firstNow
    });
    assert.equal(deduplicationSaves.length, 2, '批内重复 sourceKey 不得重复保存元数据');
    assert.deepEqual(
      deduplicationResult.deduplication,
      {
        inputCount: 3,
        uniqueCount: 2,
        duplicateCount: 1,
        skippedItems: [{
          sourceKey: items[0].download.sourceKey,
          keptInputIndex: 0,
          skippedInputIndex: 1
        }]
      },
      '编排结果必须原样保留 bundle 的批内去重统计'
    );

    await assert.rejects(
      () => prepareMarkiStructuredImport({ documentsPath: '', orgId, items }),
      (error) => (
        error?.code === 'marki_import_documents_path_invalid'
        && !String(error.message).includes(root)
      ),
      '无效 Documents 路径应返回安全领域错误'
    );
    await assert.rejects(
      () => prepareMarkiStructuredImport({ documentsPath: root, orgId, items: null }),
      (error) => error?.code === 'marki_import_items_invalid',
      '非数组照片列表应返回安全领域错误'
    );
    await assert.rejects(
      () => prepareMarkiStructuredImport({ documentsPath: root, orgId, items }, {
        loadConfigs: async () => loadedConfigs,
        buildStructuredImportBundle: () => {
          throw new Error(`${root} https://private.example secret-content`);
        }
      }),
      (error) => (
        error?.code === 'marki_import_bundle_build_failed'
        && !String(error.message).includes(root)
        && !String(error.message).includes('private.example')
      ),
      'bundle 构建失败应收口为不泄露内部数据的领域错误'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  await assert.rejects(
    () => fs.access(root),
    (error) => error?.code === 'ENOENT',
    '马克导入编排自检结束后应清理自身临时目录'
  );
}

async function checkMarkiImportBatchService(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '马克导入批次自检必须使用系统临时目录'
  );
  const baseTime = Date.parse('2026-07-17T06:00:00.000Z');
  const at = (offsetMs = 0) => () => new Date(baseTime + offsetMs);
  const deduplication = (inputCount = 2) => ({
    inputCount,
    uniqueCount: inputCount,
    duplicateCount: 0,
    skippedItems: []
  });
  const beginInput = (batchId, inputCount = 2) => ({
    batchId,
    inputCount,
    deduplication: deduplication(inputCount)
  });
  const batchDirectory = (userDataPath) => path.join(userDataPath, 'marki-import-batches');
  const batchPath = (userDataPath, batchId) => path.join(batchDirectory(userDataPath), `${batchId}.json`);
  const workbenchPackage = (batchId, label = '原始业务内容') => ({
    batchId,
    photos: [{
      id: `${batchId}-photo-1`,
      sourceType: 'marki_api',
      sourceKey: `marki_api:12345:${batchId}-moment-1`,
      originalPath: path.join(root, 'downloaded', `${batchId}.jpg`),
      label
    }],
    recognitionResultsByPhoto: {
      [`${batchId}-photo-1`]: {
        source: 'marki_api',
        providerType: 'structured_data',
        status: 'recognized',
        rawText: ''
      }
    },
    watermarkRecordsByPhoto: {
      [`${batchId}-photo-1`]: { date: '2026-07-17', workContent: '设施巡查' }
    },
    archiveSuggestionsByPhoto: {
      [`${batchId}-photo-1`]: {
        status: 'suggestion_ready',
        needsHumanReview: true,
        suggestedFields: {
          date: '2026-07-17',
          project: '潇湘新区二期',
          watermarkCategory: '工程类专用',
          workContent: '设施巡查'
        }
      }
    }
  });
  const readyInput = (batchId, packageValue = workbenchPackage(batchId)) => ({
    success: true,
    batchId,
    inputCount: 2,
    metadataSavedCount: 2,
    failedCount: 0,
    failures: [],
    deduplication: deduplication(2),
    workbenchImportPackage: packageValue
  });
  const failedInput = (batchId, message = '马克来源元数据保存失败，请重试。') => ({
    success: false,
    batchId,
    inputCount: 2,
    metadataSavedCount: 1,
    failedCount: 1,
    failures: [{
      sourceMetadataRef: 'marki_source_metadata:12345:moment-2',
      sourceKey: 'marki_api:12345:moment-2',
      code: 'marki_source_metadata_save_failed',
      message
    }],
    deduplication: deduplication(2),
    workbenchImportPackage: null
  });
  let scenarioCount = 0;

  await fs.mkdir(root, { recursive: true });
  try {
    const lifecycleRoot = path.join(root, 'lifecycle');
    const lifecycleBatchId = 'batch-lifecycle';
    const preparing = await beginMarkiImportBatch(
      lifecycleRoot,
      beginInput(lifecycleBatchId),
      { now: at() }
    );
    assert.equal(preparing.status, 'preparing', '不存在的批次应进入 preparing');
    assert.equal(preparing.workbenchImportPackage, null, 'preparing 批次不得保存工作台包');
    assert.equal(
      batchDirectory(lifecycleRoot),
      path.join(lifecycleRoot, 'marki-import-batches'),
      '批次目录必须固定在 userData 下的 marki-import-batches'
    );
    const lifecyclePath = batchPath(lifecycleRoot, lifecycleBatchId);
    const preparingRecord = JSON.parse(await fs.readFile(lifecyclePath, 'utf8'));
    assert.deepEqual(
      Object.keys(preparingRecord),
      [
        'schemaVersion',
        'batchId',
        'status',
        'inputCount',
        'metadataSavedCount',
        'failedCount',
        'failures',
        'deduplication',
        'workbenchImportPackage',
        'createdAt',
        'updatedAt',
        'expiresAt',
        'consumedAt'
      ],
      '批次文件必须严格使用固定字段白名单'
    );
    assert.equal(preparingRecord.schemaVersion, 1, '批次 schemaVersion 必须为 1');
    scenarioCount += 1;

    const originalPackage = workbenchPackage(lifecycleBatchId);
    const packageSnapshot = JSON.stringify(originalPackage);
    const ready = await markMarkiImportBatchReady(
      lifecycleRoot,
      readyInput(lifecycleBatchId, originalPackage),
      { now: at(60 * 1000) }
    );
    assert.equal(ready.status, 'ready', 'preparing 批次应能转换为 ready');
    assert.equal(JSON.stringify(originalPackage), packageSnapshot, '批次服务不得修改工作台包业务内容');
    scenarioCount += 1;

    originalPackage.photos[0].label = '外部修改';
    const readyQuery = await getMarkiImportBatch(
      lifecycleRoot,
      lifecycleBatchId,
      { now: at(2 * 60 * 1000) }
    );
    assert.equal(readyQuery.status, 'ready', 'ready 查询应返回就绪状态');
    assert.deepEqual(
      Object.keys(readyQuery.workbenchImportPackage),
      [
        'batchId',
        'photos',
        'recognitionResultsByPhoto',
        'watermarkRecordsByPhoto',
        'archiveSuggestionsByPhoto'
      ],
      'ready 查询必须严格返回五字段工作台包'
    );
    assert.equal(
      readyQuery.workbenchImportPackage.photos[0].label,
      '原始业务内容',
      '批次服务必须深拷贝后保存工作台包'
    );
    assert.equal(Object.hasOwn(readyQuery, 'filePath'), false, '批次查询不得返回内部文件路径');
    scenarioCount += 1;

    const beforeGetText = await fs.readFile(lifecyclePath, 'utf8');
    readyQuery.workbenchImportPackage.photos[0].label = '查询对象修改';
    const secondReadyQuery = await getMarkiImportBatch(
      lifecycleRoot,
      lifecycleBatchId,
      { now: at(3 * 60 * 1000) }
    );
    const afterGetText = await fs.readFile(lifecyclePath, 'utf8');
    assert.equal(beforeGetText, afterGetText, 'get 查询不得修改批次持久化状态');
    assert.equal(
      secondReadyQuery.workbenchImportPackage.photos[0].label,
      '原始业务内容',
      '批次查询结果必须深拷贝返回'
    );
    scenarioCount += 1;

    const firstConsume = await consumeMarkiImportBatch(
      lifecycleRoot,
      lifecycleBatchId,
      { now: at(4 * 60 * 1000) }
    );
    assert.deepEqual(
      firstConsume,
      {
        success: true,
        batchId: lifecycleBatchId,
        status: 'consumed',
        alreadyConsumed: false
      },
      '首次消费应执行 ready 到 consumed 转换'
    );
    scenarioCount += 1;

    const consumedRecord = JSON.parse(await fs.readFile(lifecyclePath, 'utf8'));
    assert.equal(consumedRecord.status, 'consumed', '消费后批次文件应保存 consumed 状态');
    assert.equal(consumedRecord.workbenchImportPackage, null, '消费后持久化文件必须立即清除工作台包');
    assert.equal(Boolean(consumedRecord.consumedAt), true, '消费后应记录 consumedAt');
    const consumedQuery = await getMarkiImportBatch(
      lifecycleRoot,
      lifecycleBatchId,
      { now: at(5 * 60 * 1000) }
    );
    assert.equal(consumedQuery.workbenchImportPackage, null, 'consumed 查询不得返回旧工作台包');
    scenarioCount += 1;

    const repeatedConsume = await consumeMarkiImportBatch(
      lifecycleRoot,
      lifecycleBatchId,
      { now: at(5 * 60 * 1000) }
    );
    assert.equal(repeatedConsume.alreadyConsumed, true, '重复消费应幂等返回 alreadyConsumed=true');
    scenarioCount += 1;

    const concurrentRoot = path.join(root, 'concurrent');
    const concurrentBatchId = 'batch-concurrent';
    await beginMarkiImportBatch(concurrentRoot, beginInput(concurrentBatchId), { now: at() });
    await markMarkiImportBatchReady(
      concurrentRoot,
      readyInput(concurrentBatchId),
      { now: at(60 * 1000) }
    );
    const concurrentResults = await Promise.all([
      consumeMarkiImportBatch(concurrentRoot, concurrentBatchId, { now: at(2 * 60 * 1000) }),
      consumeMarkiImportBatch(concurrentRoot, concurrentBatchId, { now: at(2 * 60 * 1000) })
    ]);
    assert.deepEqual(
      concurrentResults.map((result) => result.alreadyConsumed).sort(),
      [false, true],
      '并发消费只能有一次真实 ready 到 consumed 转换'
    );
    scenarioCount += 1;

    const blockedRoot = path.join(root, 'blocked-consumption');
    await beginMarkiImportBatch(blockedRoot, beginInput('batch-preparing-blocked'), { now: at() });
    await assert.rejects(
      () => consumeMarkiImportBatch(blockedRoot, 'batch-preparing-blocked', { now: at(60 * 1000) }),
      (error) => error?.code === 'marki_import_batch_not_consumable',
      'preparing 批次不得消费'
    );
    await beginMarkiImportBatch(blockedRoot, beginInput('batch-failed-blocked'), { now: at() });
    await markMarkiImportBatchFailed(
      blockedRoot,
      failedInput('batch-failed-blocked'),
      { now: at(60 * 1000) }
    );
    await assert.rejects(
      () => consumeMarkiImportBatch(blockedRoot, 'batch-failed-blocked', { now: at(2 * 60 * 1000) }),
      (error) => error?.code === 'marki_import_batch_not_consumable',
      'failed 批次不得消费'
    );
    scenarioCount += 1;

    const failedQuery = await getMarkiImportBatch(
      blockedRoot,
      'batch-failed-blocked',
      { now: at(2 * 60 * 1000) }
    );
    assert.equal(failedQuery.status, 'failed', 'preparing 应能转换为 failed');
    assert.equal(failedQuery.failedCount, 1, 'failed 批次应保留安全失败数量');
    assert.equal(failedQuery.workbenchImportPackage, null, 'failed 批次不得返回工作台包');
    scenarioCount += 1;

    const failedCreatedAt = failedQuery.createdAt;
    const retryPreparing = await beginMarkiImportBatch(
      blockedRoot,
      beginInput('batch-failed-blocked'),
      { now: at(3 * 60 * 1000) }
    );
    assert.equal(retryPreparing.status, 'preparing', 'failed 批次应允许幂等重试进入 preparing');
    assert.equal(retryPreparing.createdAt, failedCreatedAt, '失败重试应保留批次 createdAt');
    const retryReady = await markMarkiImportBatchReady(
      blockedRoot,
      readyInput('batch-failed-blocked'),
      { now: at(4 * 60 * 1000) }
    );
    assert.equal(retryReady.status, 'ready', 'failed 重试后应能进入 ready');
    scenarioCount += 1;

    await assert.rejects(
      () => beginMarkiImportBatch(
        blockedRoot,
        beginInput('batch-failed-blocked'),
        { now: at(5 * 60 * 1000) }
      ),
      (error) => error?.code === 'marki_import_batch_transition_invalid',
      'ready 批次不得重新 begin 覆盖'
    );
    await assert.rejects(
      () => markMarkiImportBatchFailed(
        blockedRoot,
        failedInput('batch-failed-blocked'),
        { now: at(5 * 60 * 1000) }
      ),
      (error) => error?.code === 'marki_import_batch_transition_invalid',
      'ready 批次不得转换为 failed'
    );
    await consumeMarkiImportBatch(
      blockedRoot,
      'batch-failed-blocked',
      { now: at(6 * 60 * 1000) }
    );
    await assert.rejects(
      () => beginMarkiImportBatch(
        blockedRoot,
        beginInput('batch-failed-blocked'),
        { now: at(7 * 60 * 1000) }
      ),
      (error) => error?.code === 'marki_import_batch_transition_invalid',
      'consumed 批次不得重新 preparing'
    );
    await assert.rejects(
      () => markMarkiImportBatchReady(
        blockedRoot,
        readyInput('batch-failed-blocked'),
        { now: at(7 * 60 * 1000) }
      ),
      (error) => error?.code === 'marki_import_batch_transition_invalid',
      'consumed 批次不得重新 ready'
    );
    await assert.rejects(
      () => markMarkiImportBatchFailed(
        blockedRoot,
        failedInput('batch-failed-blocked'),
        { now: at(7 * 60 * 1000) }
      ),
      (error) => error?.code === 'marki_import_batch_transition_invalid',
      'consumed 批次不得转换为 failed'
    );
    scenarioCount += 1;

    const corruptRoot = path.join(root, 'corrupt');
    const corruptPath = batchPath(corruptRoot, 'batch-corrupt');
    await fs.mkdir(path.dirname(corruptPath), { recursive: true });
    await fs.writeFile(corruptPath, '{ damaged json', 'utf8');
    await assert.rejects(
      () => beginMarkiImportBatch(corruptRoot, beginInput('batch-corrupt'), { now: at() }),
      (error) => error?.code === 'marki_import_batch_invalid',
      '损坏批次不得被 begin 静默覆盖'
    );
    assert.equal(await fs.readFile(corruptPath, 'utf8'), '{ damaged json', '损坏批次文件必须原样保留');
    scenarioCount += 1;

    for (const invalidBatchId of ['../escape', '..', '.', 'batch/escape', 'batch\\escape', 'batch.json', '']) {
      await assert.rejects(
        () => getMarkiImportBatch(root, invalidBatchId, { now: at() }),
        (error) => error?.code === 'marki_import_batch_id_invalid',
        `非法 batchId ${JSON.stringify(invalidBatchId)} 必须拒绝`
      );
    }
    scenarioCount += 1;

    const extraFieldRoot = path.join(root, 'extra-package-field');
    const extraBatchId = 'batch-extra-field';
    await beginMarkiImportBatch(extraFieldRoot, beginInput(extraBatchId), { now: at() });
    await assert.rejects(
      () => markMarkiImportBatchReady(extraFieldRoot, readyInput(extraBatchId, {
        ...workbenchPackage(extraBatchId),
        sixthField: true
      }), { now: at(60 * 1000) }),
      (error) => error?.code === 'marki_import_batch_package_invalid',
      '工作台包多出第六个字段时必须拒绝'
    );
    assert.equal(
      (await getMarkiImportBatch(extraFieldRoot, extraBatchId, { now: at(2 * 60 * 1000) })).status,
      'preparing',
      '无效工作台包不得改变 preparing 状态'
    );
    scenarioCount += 1;

    const mismatchRoot = path.join(root, 'package-mismatch');
    const mismatchBatchId = 'batch-package-mismatch';
    await beginMarkiImportBatch(mismatchRoot, beginInput(mismatchBatchId), { now: at() });
    await assert.rejects(
      () => markMarkiImportBatchReady(
        mismatchRoot,
        readyInput(mismatchBatchId, workbenchPackage('different-batch-id')),
        { now: at(60 * 1000) }
      ),
      (error) => error?.code === 'marki_import_batch_package_invalid',
      '工作台包 batchId 不一致时必须拒绝'
    );
    scenarioCount += 1;

    const expiryRoot = path.join(root, 'ready-expiry');
    const expiryBatchId = 'batch-ready-expiry';
    await beginMarkiImportBatch(expiryRoot, beginInput(expiryBatchId), { now: at() });
    await markMarkiImportBatchReady(expiryRoot, readyInput(expiryBatchId), { now: at() });
    await assert.rejects(
      () => getMarkiImportBatch(expiryRoot, expiryBatchId, { now: at(24 * 60 * 60 * 1000 + 1) }),
      (error) => error?.code === 'marki_import_batch_expired',
      'ready 批次超过 24 小时后不得返回旧工作台包'
    );
    await assert.rejects(
      () => fs.access(batchPath(expiryRoot, expiryBatchId)),
      (error) => error?.code === 'ENOENT',
      'ready 过期查询应清理正式批次文件'
    );
    scenarioCount += 1;

    const preparingTtlRoot = path.join(root, 'ttl-preparing');
    await beginMarkiImportBatch(preparingTtlRoot, beginInput('batch-ttl-preparing'), { now: at() });
    assert.equal(
      (await cleanupExpiredMarkiImportBatches(preparingTtlRoot, { now: at(59 * 60 * 1000) })).removedCount,
      0,
      'preparing 批次一小时内不得清理'
    );
    assert.equal(
      (await cleanupExpiredMarkiImportBatches(preparingTtlRoot, { now: at(61 * 60 * 1000) })).removedCount,
      1,
      'preparing 批次超过一小时应清理'
    );
    const failedTtlRoot = path.join(root, 'ttl-failed');
    await beginMarkiImportBatch(failedTtlRoot, beginInput('batch-ttl-failed'), { now: at() });
    await markMarkiImportBatchFailed(failedTtlRoot, failedInput('batch-ttl-failed'), { now: at() });
    assert.equal(
      (await cleanupExpiredMarkiImportBatches(failedTtlRoot, { now: at(23 * 60 * 60 * 1000) })).removedCount,
      0,
      'failed 批次 24 小时内不得清理'
    );
    assert.equal(
      (await cleanupExpiredMarkiImportBatches(failedTtlRoot, { now: at(24 * 60 * 60 * 1000 + 1) })).removedCount,
      1,
      'failed 批次超过 24 小时应清理'
    );
    const consumedTtlRoot = path.join(root, 'ttl-consumed');
    await beginMarkiImportBatch(consumedTtlRoot, beginInput('batch-ttl-consumed'), { now: at() });
    await markMarkiImportBatchReady(consumedTtlRoot, readyInput('batch-ttl-consumed'), { now: at() });
    await consumeMarkiImportBatch(consumedTtlRoot, 'batch-ttl-consumed', { now: at() });
    assert.equal(
      (await cleanupExpiredMarkiImportBatches(consumedTtlRoot, { now: at(9 * 60 * 1000) })).removedCount,
      0,
      'consumed 墓碑十分钟内不得清理'
    );
    assert.equal(
      (await cleanupExpiredMarkiImportBatches(consumedTtlRoot, { now: at(11 * 60 * 1000) })).removedCount,
      1,
      'consumed 墓碑超过十分钟应清理'
    );
    scenarioCount += 1;

    const safeFailureRoot = path.join(root, 'safe-failure');
    const safeFailureBatchId = 'batch-safe-failure';
    await beginMarkiImportBatch(safeFailureRoot, beginInput(safeFailureBatchId), { now: at() });
    const unsafeFailure = failedInput(
      safeFailureBatchId,
      `${safeFailureRoot} https://private.example raw content stack secret`
    );
    await assert.rejects(
      () => markMarkiImportBatchFailed(safeFailureRoot, {
        ...unsafeFailure,
        failures: [{ ...unsafeFailure.failures[0], stack: 'secret stack' }]
      }, { now: at(60 * 1000) }),
      (error) => error?.code === 'marki_import_batch_failures_invalid',
      '失败摘要多出 stack 字段时必须拒绝'
    );
    const safeFailed = await markMarkiImportBatchFailed(
      safeFailureRoot,
      unsafeFailure,
      { now: at(2 * 60 * 1000) }
    );
    const serializedSafeFailure = JSON.stringify(safeFailed.failures);
    for (const forbidden of [safeFailureRoot, 'private.example', 'raw content', 'stack', 'secret']) {
      assert.equal(
        serializedSafeFailure.includes(forbidden),
        false,
        `批次失败摘要不得泄露 ${forbidden}`
      );
    }
    scenarioCount += 1;

    const readyListRoot = path.join(root, 'ready-list-tolerance');
    const readyListBatchId = 'batch-ready-list-valid';
    await beginMarkiImportBatch(
      readyListRoot,
      beginInput(readyListBatchId),
      { now: at() }
    );
    await markMarkiImportBatchReady(
      readyListRoot,
      readyInput(readyListBatchId),
      { now: at(1_000) }
    );
    const readyListDirectory = batchDirectory(readyListRoot);
    const corruptBatchPath = batchPath(readyListRoot, 'batch-ready-list-corrupt');
    const invalidBatchPath = batchPath(readyListRoot, 'batch-ready-list-invalid');
    await fs.writeFile(corruptBatchPath, '{"schemaVersion":', 'utf8');
    await fs.writeFile(invalidBatchPath, JSON.stringify({ schemaVersion: 1 }), 'utf8');
    const tolerantReadyList = await listReadyMarkiImportBatches(
      readyListRoot,
      { now: at(2_000) }
    );
    assert.equal(tolerantReadyList.success, true, 'ready 批次列表应在单项损坏时继续返回');
    assert.deepEqual(
      Object.keys(tolerantReadyList),
      ['success', 'items', 'failedCount'],
      'ready 批次列表顶层应严格返回 success、items 和 failedCount'
    );
    assert.equal(tolerantReadyList.failedCount, 2, '损坏 JSON 和非法结构应分别计入 failedCount');
    assert.deepEqual(
      tolerantReadyList.items.map((batch) => batch.batchId),
      [readyListBatchId],
      '单项损坏不得阻断正常 ready 批次'
    );
    assert.deepEqual(
      Object.keys(tolerantReadyList.items[0]),
      ['batchId', 'status', 'inputCount', 'metadataSavedCount', 'createdAt', 'updatedAt', 'expiresAt'],
      'ready 列表单项仍必须保持七字段安全摘要'
    );
    assert.equal(
      (await fs.readdir(readyListDirectory)).includes(path.basename(corruptBatchPath)),
      true,
      'ready 列表只读操作不得删除损坏批次文件'
    );
    assert.equal(
      (await fs.readdir(readyListDirectory)).includes(path.basename(invalidBatchPath)),
      true,
      'ready 列表只读操作不得删除结构非法批次文件'
    );
    scenarioCount += 1;

    const allBatchFiles = await fs.readdir(batchDirectory(lifecycleRoot));
    assert.equal(
      allBatchFiles.some((fileName) => fileName.endsWith('.tmp')),
      false,
      '批次保存成功后不得遗留临时文件'
    );
    const atomicFailureRoot = path.join(root, 'atomic-failure');
    const failingFileSystem = {
      mkdir: (...args) => fs.mkdir(...args),
      open: (...args) => fs.open(...args),
      readFile: (...args) => fs.readFile(...args),
      readdir: (...args) => fs.readdir(...args),
      rename: async () => {
        const error = new Error('injected rename failure');
        error.code = 'EPERM';
        throw error;
      },
      rm: (...args) => fs.rm(...args)
    };
    await assert.rejects(
      () => beginMarkiImportBatch(
        atomicFailureRoot,
        beginInput('batch-atomic-failure'),
        { fs: failingFileSystem, now: at() }
      ),
      (error) => error?.code === 'marki_import_batch_save_failed',
      '原子替换失败应返回受控保存错误'
    );
    const atomicFailureFiles = await fs.readdir(batchDirectory(atomicFailureRoot));
    assert.deepEqual(atomicFailureFiles, [], '批次保存失败后不得遗留正式文件或临时文件');
    scenarioCount += 1;

    const [mainSource, preloadSource] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8')
    ]);
    const getHandler = mainSource.match(
      /ipcMain\.handle\('marki:get-import-batch'[\s\S]*?\n\)\);/
    )?.[0] || '';
    const consumeHandler = mainSource.match(
      /ipcMain\.handle\('marki:consume-import-batch'[\s\S]*?\n\)\);/
    )?.[0] || '';
    const localCallWrapper = mainSource.match(
      /async function safeMarkiLocalCall\(callback\) \{[\s\S]*?\n\}/
    )?.[0] || '';
    for (const handler of [getHandler, consumeHandler]) {
      assert.equal(Boolean(handler), true, '主进程必须注册马克批次查询和消费 IPC');
      assert.equal(handler.includes("app.getPath('userData')"), true, '批次 IPC 必须固定使用 app.getPath(userData)');
      assert.equal(handler.includes('safeMarkiLocalCall'), true, '本地批次 IPC 必须使用 safeMarkiLocalCall');
      assert.equal(handler.includes('safeMarkiCall('), false, '本地批次 IPC 不得读取马克组织凭证');
      assert.equal(handler.includes('getWritableDocumentsPath'), false, '批次 IPC 不得使用 Documents 路径');
      assert.equal(handler.includes('documentsPath'), false, '批次 IPC 不得接受 documentsPath');
      assert.equal(handler.includes('userDataPath'), false, '批次 IPC 不得接受 userDataPath');
    }
    assert.equal(Boolean(localCallWrapper), true, '主进程应提供本地马克调用安全包装');
    assert.equal(localCallWrapper.includes('loadMarkiCredentials'), false, '本地马克调用包装不得加载组织凭证');
    assert.equal(localCallWrapper.includes('safeStorage'), false, '本地马克调用包装不得访问 safeStorage');
    assert.equal(localCallWrapper.includes('toSafeMarkiError(error)'), true, '本地马克调用包装应统一收口安全错误');
    assert.equal(localCallWrapper.includes('return await callback();'), true, '本地马克调用成功时应原样返回服务结果');
    assert.equal(
      mainSource.includes("ipcMain.handle('marki:testConnection', async () => safeMarkiCall("),
      true,
      '马克连接测试必须继续使用联网安全包装'
    );
    assert.equal(
      mainSource.includes("ipcMain.handle('marki:listTeams', async () => safeMarkiCall("),
      true,
      '马克团队查询必须继续使用联网安全包装'
    );
    assert.equal(
      /ipcMain\.handle\('marki:listMembers'[\s\S]*?safeMarkiCall\(/.test(mainSource),
      true,
      '马克成员查询必须继续使用联网安全包装'
    );
    assert.equal(
      /marki:get-import-batch', async \(_event, batchId\)/.test(getHandler),
      true,
      '批次查询 IPC 只能接收 batchId'
    );
    assert.equal(
      /marki:consume-import-batch', async \(_event, batchId\)/.test(consumeHandler),
      true,
      '批次消费 IPC 只能接收 batchId'
    );
    assert.equal(
      mainSource.includes("ipcMain.handle('marki:prepare-structured-import'"),
      false,
      '本刀不得向 renderer 注册结构化导入准备 IPC'
    );
    scenarioCount += 1;

    const markiPreloadBlock = preloadSource.match(/marki: \{([\s\S]*?)\n  \},\n  loadConfigs:/)?.[1] || '';
    assert.equal(
      markiPreloadBlock.includes("getImportBatch: (batchId) => ipcRenderer.invoke('marki:get-import-batch', batchId)"),
      true,
      'preload marki 分组应暴露 getImportBatch(batchId)'
    );
    assert.equal(
      markiPreloadBlock.includes("consumeImportBatch: (batchId) => ipcRenderer.invoke('marki:consume-import-batch', batchId)"),
      true,
      'preload marki 分组应暴露 consumeImportBatch(batchId)'
    );
    assert.deepEqual(
      [...markiPreloadBlock.matchAll(/(\w+ImportBatch):/g)].map((match) => match[1]),
      ['undoImportBatch', 'getImportBatch', 'consumeImportBatch'],
      'preload 只允许暴露查询、消费和受控撤销批次方法'
    );
    for (const forbidden of ['userDataPath', 'documentsPath', 'prepareStructuredImport', 'saveImportBatch', 'updateImportBatch']) {
      assert.equal(markiPreloadBlock.includes(forbidden), false, `preload 不得暴露 ${forbidden}`);
    }
    scenarioCount += 1;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  await assert.rejects(
    () => fs.access(root),
    (error) => error?.code === 'ENOENT',
    '马克导入批次自检结束后应清理系统临时目录'
  );
  scenarioCount += 1;
  assert.equal(scenarioCount, 24, '马克导入批次服务应完整执行 24 个自检场景');
}

async function checkMarkiTrustedImport(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '可信马克导入自检必须使用系统临时目录'
  );
  const documentsPath = path.join(root, 'documents');
  const userDataPath = path.join(root, 'user-data');
  const credentials = { orgId: '12345', key: 'self-check-key' };
  const buildMoment = (id, overrides = {}) => ({
    id,
    uid: '20001',
    teamId: '10001',
    url: `https://private.example/${id}.jpg`,
    momentType: 1,
    content: JSON.stringify([
      ['日期', '2026-07-18'],
      ['小区名称', '潇湘新区二期'],
      ['工作内容', '设施巡查']
    ]),
    markName: '工程类专用',
    lng: 103.8,
    lat: 25.5,
    postTime: Math.floor(Date.parse('2026-07-18T02:00:00Z') / 1000),
    ...overrides
  });
  const createSession = async (moments) => {
    const service = createMarkiPhotoQuerySessionService({
      listMarkiMoments: async () => ({ moments, next: '', hasMore: false }),
      checkMarkiSourceKeys: async (_documentsPath, _orgId, sourceKeys) => ({
        bySourceKey: Object.fromEntries(sourceKeys.map((sourceKey) => [
          sourceKey,
          { exists: false, importStatus: '' }
        ]))
      })
    });
    const query = await service.create({
      credentials,
      documentsPath,
      filters: {
        start: '2026-07-18 00:00:00',
        end: '2026-07-18 23:59:59'
      }
    });
    return { service, query };
  };
  const createPrepareResult = (batchId, items, success = true) => {
    const deduplication = {
      inputCount: items.length,
      uniqueCount: items.length,
      duplicateCount: 0,
      skippedItems: []
    };
    if (!success) {
      const first = items[0];
      const sourceKey = first.download.sourceKey;
      const sourceMatch = /^marki_api:(\d+):(.+)$/.exec(sourceKey);
      const orgId = sourceMatch[1];
      const momentId = sourceMatch[2];
      return {
        success: false,
        batchId,
        inputCount: items.length,
        metadataSavedCount: items.length - 1,
        failedCount: 1,
        failures: [{
          sourceMetadataRef: `marki_source_metadata:${orgId}:${momentId}`,
          sourceKey,
          code: 'marki_source_metadata_save_failed',
          message: '马克来源元数据保存失败，请重试。'
        }],
        deduplication,
        workbenchImportPackage: null
      };
    }
    return {
      success: true,
      batchId,
      inputCount: items.length,
      metadataSavedCount: items.length,
      failedCount: 0,
      failures: [],
      deduplication,
      workbenchImportPackage: {
        batchId,
        photos: items.map((item) => ({
          id: `photo-${item.moment.id}`,
          sourceType: 'marki_api',
          sourceKey: item.download.sourceKey,
          originalPath: item.download.localPath
        })),
        recognitionResultsByPhoto: {},
        watermarkRecordsByPhoto: {},
        archiveSuggestionsByPhoto: {}
      }
    };
  };
  const buildImportOptions = (service, overrides = {}) => ({
    beginSelectionImport: service.beginImport,
    settleSelectionImport: service.settleImport,
    checkSourceKeys: async (_documentsPath, _orgId, sourceKeys) => ({
      bySourceKey: Object.fromEntries(sourceKeys.map((sourceKey) => [
        sourceKey,
        { exists: false, importStatus: '' }
      ]))
    }),
    beginImportBatch: beginMarkiImportBatch,
    getImportBatch: getMarkiImportBatch,
    markBatchFailed: markMarkiImportBatchFailed,
    markBatchReady: markMarkiImportBatchReady,
    ...overrides
  });
  const buildRequest = (query, selectionTokens) => ({
    credentials,
    documentsPath,
    userDataPath,
    request: {
      sessionId: query.sessionId,
      selectionTokens,
      templateFilter: 'all',
      importStatusFilter: 'all'
    }
  });

  await fs.mkdir(root, { recursive: true });
  const templateMismatchSession = await createSession([buildMoment('template-mismatch-001')]);
  let mismatchDownloadCalls = 0;
  const mismatchRequest = buildRequest(
    templateMismatchSession.query,
    [templateMismatchSession.query.photos[0].selectionToken]
  );
  mismatchRequest.request.templateFilter = 'name:其他模板';
  await assert.rejects(
    () => importMarkiPhotoQuerySelection(
      mismatchRequest,
      buildImportOptions(templateMismatchSession.service, {
        downloadMarkiPhoto: async () => {
          mismatchDownloadCalls += 1;
          throw new Error('must not download');
        },
        prepareStructuredImport: async () => {
          throw new Error('must not prepare');
        }
      })
    ),
    (error) => error?.code === 'marki_photo_import_filter_mismatch',
    '可信导入必须二次拒绝 templateFilter 与照片 templateKey 不一致'
  );
  assert.equal(mismatchDownloadCalls, 0, '模板筛选不匹配时不得开始下载');

  const statusMismatchSession = await createSession([buildMoment('status-mismatch-001')]);
  const statusMismatchRequest = buildRequest(
    statusMismatchSession.query,
    [statusMismatchSession.query.photos[0].selectionToken]
  );
  statusMismatchRequest.request.importStatusFilter = 'imported_active';
  await assert.rejects(
    () => importMarkiPhotoQuerySelection(
      statusMismatchRequest,
      buildImportOptions(statusMismatchSession.service, {
        downloadMarkiPhoto: async () => {
          throw new Error('must not download');
        },
        prepareStructuredImport: async () => {
          throw new Error('must not prepare');
        }
      })
    ),
    (error) => error?.code === 'marki_photo_import_filter_mismatch',
    '可信导入必须用重新读取的生命周期状态复核 importStatusFilter'
  );

  const unknownTemplateSession = await createSession([
    buildMoment('template-unknown-001', { markName: '' })
  ]);
  const unknownTemplateRequest = buildRequest(
    unknownTemplateSession.query,
    [unknownTemplateSession.query.photos[0].selectionToken]
  );
  unknownTemplateRequest.request.templateFilter = 'template_unknown';
  const unknownTemplateResult = await importMarkiPhotoQuerySelection(
    unknownTemplateRequest,
    buildImportOptions(unknownTemplateSession.service, {
      resolveSourceStatuses: async () => ({
        bySourceKey: {
          [buildMarkiSourceKey(credentials.orgId, 'template-unknown-001')]: 'imported_active'
        }
      }),
      downloadMarkiPhoto: async () => {
        throw new Error('must not download imported item');
      },
      prepareStructuredImport: async () => {
        throw new Error('must not prepare imported item');
      }
    })
  );
  assert.equal(unknownTemplateResult.status, 'nothing_to_import', '模板未知筛选必须通过可信层精确复核');

  const legacyFilterSession = await createSession([buildMoment('legacy-filter-001')]);
  const legacyFilterRequest = buildRequest(
    legacyFilterSession.query,
    [legacyFilterSession.query.photos[0].selectionToken]
  );
  legacyFilterRequest.request = {
    sessionId: legacyFilterRequest.request.sessionId,
    selectionTokens: legacyFilterRequest.request.selectionTokens,
    watermarkFilter: 'name:工程类专用',
    importStatusFilter: 'all'
  };
  const legacyFilterResult = await importMarkiPhotoQuerySelection(
    legacyFilterRequest,
    buildImportOptions(legacyFilterSession.service, {
      resolveSourceStatuses: async () => ({
        bySourceKey: {
          [buildMarkiSourceKey(credentials.orgId, 'legacy-filter-001')]: 'imported_active'
        }
      }),
      downloadMarkiPhoto: async () => {
        throw new Error('must not download imported item');
      },
      prepareStructuredImport: async () => {
        throw new Error('must not prepare imported item');
      }
    })
  );
  assert.equal(legacyFilterResult.status, 'nothing_to_import', '旧 name:* watermarkFilter 必须兼容迁移为模板筛选');

  const { service, query } = await createSession([
    buildMoment('trusted-001'),
    buildMoment('trusted-002'),
    buildMoment('trusted-003'),
    buildMoment('trusted-004')
  ]);
  const selectionTokens = query.photos.map((photo) => photo.selectionToken);
  const completedDownloads = new Set();
  let activeDownloads = 0;
  let maxActiveDownloads = 0;
  let shouldFailSecond = true;
  let firstDownloadSawLifecycle = false;
  let inspectedLifecycleBeforeDownload = false;
  const downloadMock = async (_root, moment) => {
    if (!inspectedLifecycleBeforeDownload) {
      inspectedLifecycleBeforeDownload = true;
      const records = await listMarkiImportLifecycleRecords(userDataPath);
      firstDownloadSawLifecycle = records.items.some(
        (record) => record.status === 'downloading'
          && record.items.every((item) => item.status === 'downloading')
      );
    }
    activeDownloads += 1;
    maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeDownloads -= 1;
    if (moment.id === 'trusted-002' && shouldFailSecond) {
      shouldFailSecond = false;
      const error = new Error('private download failure');
      error.code = 'download_request_failed';
      throw error;
    }
    const reusedExisting = completedDownloads.has(moment.id);
    completedDownloads.add(moment.id);
    return {
      success: true,
      sourceKey: buildMarkiSourceKey(credentials.orgId, moment.id),
      importStatus: 'imported',
      localPath: path.join(documentsPath, `${moment.id}.jpg`),
      fileName: `${moment.id}.jpg`,
      size: 100,
      width: 10,
      height: 10,
      sha256: 'a'.repeat(64),
      completedAt: '2026-07-18T03:00:00.000Z',
      reusedExisting
    };
  };
  const prepareSuccess = async (input, options) => createPrepareResult(
    options.batchId,
    input.items,
    true
  );
  const firstResult = await importMarkiPhotoQuerySelection(
    buildRequest(query, selectionTokens),
    buildImportOptions(service, {
      downloadMarkiPhoto: downloadMock,
      prepareStructuredImport: prepareSuccess
    })
  );
  assert.equal(firstResult.status, 'download_failed', '任一下载失败时整批不得创建 ready 批次');
  assert.match(firstResult.batchId, /^marki-import-/, '下载开始前必须生成稳定 lifecycle batchId');
  assert.equal(firstResult.failedCount, 1, '下载失败摘要数量应准确');
  assert.equal(firstDownloadSawLifecycle, true, '第一张照片下载开始前 lifecycle batch 和单项状态必须已持久化');
  assert.deepEqual(
    Object.keys(firstResult.failures[0]),
    ['selectionToken', 'displayId', 'code', 'message'],
    'renderer 下载失败摘要必须严格保持四字段'
  );
  assert.equal(
    firstResult.failures[0].displayId,
    query.photos[1].displayId,
    '下载失败 displayId 必须来自可信查询会话'
  );
  assert.equal(maxActiveDownloads, 3, '可信下载并发上限必须为三路');
  assert.equal(JSON.stringify(firstResult).includes('private.example'), false, '下载失败结果不得泄露 URL');
  assert.equal((await listReadyMarkiImportBatches(userDataPath)).items.length, 0, '下载失败不得创建 ready 导入批次');
  const failedLifecycleRecords = await listMarkiImportLifecycleRecords(userDataPath);
  assert.equal(
    failedLifecycleRecords.items.some((record) => record.batchId === firstResult.batchId),
    true,
    '下载失败前建立的 lifecycle ledger 必须持久保留'
  );

  const retryResult = await importMarkiPhotoQuerySelection(
    buildRequest(query, selectionTokens),
    buildImportOptions(service, {
      downloadMarkiPhoto: downloadMock,
      prepareStructuredImport: prepareSuccess
    })
  );
  assert.equal(retryResult.status, 'ready', '失败任务使用原 token 集合重试后应生成 ready 批次');
  assert.equal(retryResult.downloadedCount, 1, '重试只应重新完成上次失败的照片');
  assert.equal(retryResult.reusedCount, 3, '重试应复用上次已经成功的 JPG');
  const readyList = await listReadyMarkiImportBatches(userDataPath);
  assert.equal(readyList.items.some((batch) => batch.batchId === retryResult.batchId), true, 'ready 批次应可发现');
  assert.deepEqual(
    Object.keys(readyList.items.find((batch) => batch.batchId === retryResult.batchId)),
    ['batchId', 'status', 'inputCount', 'metadataSavedCount', 'createdAt', 'updatedAt', 'expiresAt'],
    'ready 批次发现结果必须保持七字段安全摘要'
  );

  await assert.rejects(
    () => importMarkiPhotoQuerySelection({
      ...buildRequest(query, selectionTokens),
      remoteUrl: 'https://private.example/leak.jpg'
    }, buildImportOptions(service)),
    (error) => error?.code === 'marki_photo_import_invalid_request',
    '可信导入必须拒绝 renderer 额外字段'
  );

  const integritySession = await createSession([buildMoment('integrity-001')]);
  const integrityFailure = await importMarkiPhotoQuerySelection(
    buildRequest(
      integritySession.query,
      [integritySession.query.photos[0].selectionToken]
    ),
    buildImportOptions(integritySession.service, {
      downloadMarkiPhoto: async () => {
        const error = new Error('private integrity detail');
        error.code = 'imported_file_integrity_failed';
        throw error;
      },
      prepareStructuredImport: prepareSuccess
    })
  );
  assert.equal(integrityFailure.status, 'download_failed', 'imported JPG 复验失败应进入安全下载失败结果');
  assert.deepEqual(
    Object.keys(integrityFailure.failures[0]),
    ['selectionToken', 'displayId', 'code', 'message'],
    'imported JPG 复验失败摘要必须严格保持四字段'
  );
  assert.equal(
    integrityFailure.failures[0].displayId,
    integritySession.query.photos[0].displayId,
    'imported JPG 复验失败必须复用可信 displayId'
  );

  const batchFailureSession = await createSession([buildMoment('batch-failure-001')]);
  const batchFailure = await importMarkiPhotoQuerySelection(
    buildRequest(
      batchFailureSession.query,
      [batchFailureSession.query.photos[0].selectionToken]
    ),
    buildImportOptions(batchFailureSession.service, {
      downloadMarkiPhoto: downloadMock,
      prepareStructuredImport: prepareSuccess,
      beginImportBatch: async () => {
        throw new Error('private batch storage detail');
      }
    })
  );
  assert.equal(batchFailure.status, 'batch_persist_failed', '批次保存失败应返回受控失败状态');
  assert.deepEqual(
    Object.keys(batchFailure.failures[0]),
    ['selectionToken', 'displayId', 'code', 'message'],
    '批次保存失败摘要必须严格保持四字段'
  );
  assert.equal(
    batchFailure.failures[0].displayId,
    batchFailureSession.query.photos[0].displayId,
    '批次保存失败必须复用可信 displayId'
  );

  const fallbackSessionId = '11111111-1111-4111-8111-111111111111';
  const fallbackSelectionToken = '22222222-2222-4222-8222-222222222222';
  const fallbackMoment = buildMoment('fallback-display-001');
  const fallbackFailure = await importMarkiPhotoQuerySelection(
    {
      credentials,
      documentsPath,
      userDataPath,
      request: {
        sessionId: fallbackSessionId,
        selectionTokens: [fallbackSelectionToken],
        templateFilter: 'all',
        importStatusFilter: 'all'
      }
    },
    {
      beginSelectionImport: async () => ({
        success: true,
        sessionId: fallbackSessionId,
        orgId: credentials.orgId,
        taskId: 'fallback-task',
        retry: false,
        batchId: '',
        selectionTokens: [fallbackSelectionToken],
        effectiveSelectionTokens: [],
        items: [{
          selectionToken: fallbackSelectionToken,
          sourceKey: buildMarkiSourceKey(credentials.orgId, fallbackMoment.id),
          selectedSourceStatus: 'discovered',
          templateName: fallbackMoment.markName,
          templateKey: `name:${fallbackMoment.markName}`,
          moment: fallbackMoment
        }]
      }),
      settleSelectionImport: async () => ({ success: true }),
      checkSourceKeys: async () => ({ bySourceKey: {} }),
      downloadMarkiPhoto: async () => {
        throw new Error('private fallback failure');
      },
      prepareStructuredImport: prepareSuccess,
      beginImportBatch: beginMarkiImportBatch,
      getImportBatch: getMarkiImportBatch,
      markBatchFailed: markMarkiImportBatchFailed,
      markBatchReady: markMarkiImportBatchReady
    }
  );
  assert.equal(
    fallbackFailure.failures[0].displayId,
    '1',
    '可信会话缺少合法展示值时应使用稳定顺序型 displayId 后备值'
  );

  const metadataRoot = path.join(root, 'metadata-retry');
  const { service: metadataService, query: metadataQuery } = await createSession([
    buildMoment('metadata-001'),
    buildMoment('metadata-002')
  ]);
  const metadataTokens = metadataQuery.photos.map((photo) => photo.selectionToken);
  let prepareAttempt = 0;
  const metadataDownloadIds = new Set();
  const metadataOptions = buildImportOptions(metadataService, {
    downloadMarkiPhoto: async (_root, moment) => {
      const reusedExisting = metadataDownloadIds.has(moment.id);
      metadataDownloadIds.add(moment.id);
      return {
        success: true,
        sourceKey: buildMarkiSourceKey(credentials.orgId, moment.id),
        importStatus: 'imported',
        localPath: path.join(metadataRoot, `${moment.id}.jpg`),
        fileName: `${moment.id}.jpg`,
        size: 100,
        width: 10,
        height: 10,
        sha256: 'b'.repeat(64),
        completedAt: '2026-07-18T03:00:00.000Z',
        reusedExisting
      };
    },
    prepareStructuredImport: async (input, options) => {
      prepareAttempt += 1;
      return createPrepareResult(options.batchId, input.items, prepareAttempt > 1);
    }
  });
  const metadataFailed = await importMarkiPhotoQuerySelection(
    {
      ...buildRequest(metadataQuery, metadataTokens),
      documentsPath: metadataRoot
    },
    metadataOptions
  );
  assert.equal(metadataFailed.status, 'metadata_failed', '元数据局部失败应生成 failed 批次');
  assert.deepEqual(
    Object.keys(metadataFailed.failures[0]),
    ['selectionToken', 'displayId', 'code', 'message'],
    '元数据失败摘要必须严格保持四字段'
  );
  assert.equal(
    metadataFailed.failures[0].displayId,
    metadataQuery.photos[0].displayId,
    '元数据失败 displayId 必须来自可信查询会话'
  );
  const failedBatch = await getMarkiImportBatch(userDataPath, metadataFailed.batchId);
  assert.equal(failedBatch.status, 'failed', '元数据失败批次状态必须为 failed');
  assert.equal(failedBatch.workbenchImportPackage, null, 'failed 批次不得交付工作台包');

  const metadataRecovered = await importMarkiPhotoQuerySelection(
    {
      ...buildRequest(metadataQuery, metadataTokens),
      documentsPath: metadataRoot
    },
    metadataOptions
  );
  assert.equal(metadataRecovered.status, 'ready', '元数据恢复后应使用原任务重试成功');
  assert.equal(metadataRecovered.batchId, metadataFailed.batchId, '元数据失败重试必须复用同一 batchId');
  assert.equal(metadataRecovered.reusedCount, 2, '元数据重试不得重复下载已经完成的 JPG');
  assert.equal(
    (await getMarkiImportBatch(userDataPath, metadataRecovered.batchId)).status,
    'ready',
    'failed → preparing → ready 状态链必须完成'
  );

  const sharedMoment = buildMoment('reservation-shared');
  const firstReservation = await createSession([sharedMoment]);
  const secondReservation = await createSession([sharedMoment]);
  let releaseDownload;
  const blockedDownload = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  const reservationDownload = async (_root, moment) => {
    await blockedDownload;
    return {
      success: true,
      sourceKey: buildMarkiSourceKey(credentials.orgId, moment.id),
      importStatus: 'imported',
      localPath: path.join(root, `${moment.id}.jpg`),
      fileName: `${moment.id}.jpg`,
      size: 100,
      width: 10,
      height: 10,
      sha256: 'c'.repeat(64),
      completedAt: '2026-07-18T03:00:00.000Z',
      reusedExisting: false
    };
  };
  const firstReservationPromise = importMarkiPhotoQuerySelection(
    buildRequest(firstReservation.query, [firstReservation.query.photos[0].selectionToken]),
    buildImportOptions(firstReservation.service, {
      downloadMarkiPhoto: reservationDownload,
      prepareStructuredImport: prepareSuccess
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    () => importMarkiPhotoQuerySelection(
      buildRequest(secondReservation.query, [secondReservation.query.photos[0].selectionToken]),
      buildImportOptions(secondReservation.service, {
        downloadMarkiPhoto: reservationDownload,
        prepareStructuredImport: prepareSuccess
      })
    ),
    (error) => error?.code === 'marki_photo_import_source_busy',
    '不同会话并发导入相同 sourceKey 时必须整批拒绝'
  );
  releaseDownload();
  assert.equal((await firstReservationPromise).status, 'ready', '来源占用释放后原任务应正常完成');

  await service.cleanup({ now: () => Date.now() + HARD_TTL_MS + 1 });
  await integritySession.service.cleanup({ now: () => Date.now() + HARD_TTL_MS + 1 });
  await batchFailureSession.service.cleanup({ now: () => Date.now() + HARD_TTL_MS + 1 });
  await metadataService.cleanup({ now: () => Date.now() + HARD_TTL_MS + 1 });
  await firstReservation.service.cleanup({ now: () => Date.now() + HARD_TTL_MS + 1 });
  await secondReservation.service.cleanup({ now: () => Date.now() + HARD_TTL_MS + 1 });
}

async function checkMarkiEndToEndFlow(root) {
  const documentsPath = path.join(root, 'documents');
  const userDataPath = path.join(root, 'user-data');
  const orgId = '12345';
  const credentials = { orgId, key: 'mock-only-key' };
  const jpeg = createTestJpeg(8, 6);
  const moments = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return {
      id: `end-to-end-${String(number).padStart(3, '0')}`,
      uid: String(21000 + number),
      teamId: '10001',
      url: `https://mock.invalid/end-to-end-${number}.jpg`,
      momentType: 1,
      content: JSON.stringify([
        ['日期', '2026-07-18'],
        ['小区名称', '潇湘新区二期'],
        ['工作内容', '设施巡查'],
        ['地点', `测试区域${number}`],
        ['上传人', `测试人员${number}`],
        ['防伪码', `CHAIN-${number}`]
      ]),
      markName: '工程类专用',
      lng: 103.8,
      lat: 25.5,
      postTime: Math.floor(Date.parse(`2026-07-18T0${number}:00:00Z`) / 1000)
    };
  });
  let queryPage = 0;
  const queryService = createMarkiPhotoQuerySessionService({
    listMarkiMoments: async (_credentials, filters) => {
      queryPage += 1;
      if (!filters.next) {
        return { moments: [moments[0], moments[1], moments[2]], next: 'page-2', hasMore: true };
      }
      assert.equal(filters.next, 'page-2', '下一页游标必须来自主进程会话');
      return { moments: [moments[2], moments[3]], next: '', hasMore: false };
    },
    checkMarkiSourceKeys
  });
  const firstPage = await queryService.create({
    credentials,
    documentsPath,
    filters: {
      teamId: '10001',
      start: '2026-07-18 00:00:00',
      end: '2026-07-18 23:59:59'
    }
  });
  assert.equal(firstPage.photos.length, 3, '模拟全链路应读取查询第一页');
  const secondPage = await queryService.loadNext(firstPage.sessionId, { credentials });
  assert.equal(queryPage, 2, '模拟全链路应读取查询下一页');
  assert.equal(secondPage.photos.length, 4, '跨页重复 moment 不得生成重复 selectionToken');
  const selectedTokens = [
    secondPage.photos[0].selectionToken,
    secondPage.photos[2].selectionToken,
    secondPage.photos[3].selectionToken
  ];

  let activeDownloads = 0;
  let maxDownloads = 0;
  let failMomentFour = true;
  const fetchCounts = new Map();
  const fetchImpl = async (url) => {
    const text = String(url);
    const momentNumber = /end-to-end-(\d+)\.jpg/.exec(text)?.[1] || '';
    fetchCounts.set(momentNumber, (fetchCounts.get(momentNumber) || 0) + 1);
    activeDownloads += 1;
    maxDownloads = Math.max(maxDownloads, activeDownloads);
    await new Promise((resolve) => setTimeout(resolve, 4));
    activeDownloads -= 1;
    if (momentNumber === '4' && failMomentFour) {
      failMomentFour = false;
      return new Response('', { status: 503 });
    }
    return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const importOptions = {
    beginSelectionImport: queryService.beginImport,
    settleSelectionImport: queryService.settleImport,
    checkSourceKeys: checkMarkiSourceKeys,
    downloadMarkiPhoto,
    prepareStructuredImport: prepareMarkiStructuredImport,
    beginImportBatch: beginMarkiImportBatch,
    getImportBatch: getMarkiImportBatch,
    markBatchFailed: markMarkiImportBatchFailed,
    markBatchReady: markMarkiImportBatchReady,
    downloadOptions: { fetchImpl },
    orchestratorOptions: {
      loadConfigs: async () => ({
        projects: ['潇湘新区二期'],
        watermarkCategories: {
          '工程类专用': { items: ['设施巡查'] }
        }
      })
    }
  };
  const request = {
    credentials,
    documentsPath,
    userDataPath,
    request: {
      sessionId: secondPage.sessionId,
      selectionTokens: selectedTokens,
      templateFilter: 'all',
      importStatusFilter: 'all'
    }
  };
  const downloadFailed = await importMarkiPhotoQuerySelection(request, importOptions);
  assert.equal(downloadFailed.status, 'download_failed', '模拟链路应覆盖下载失败');
  assert.match(downloadFailed.batchId, /^marki-import-/, '下载失败时必须保留下载前生成的 lifecycle batchId');
  assert.equal(maxDownloads <= 3, true, '模拟链路下载并发不得超过三路');
  const retried = await importMarkiPhotoQuerySelection(request, importOptions);
  assert.equal(retried.status, 'ready', '下载失败后原 token 集合重试应生成 ready 批次');
  assert.equal(retried.reusedCount, 2, '重试应完整复用前次已成功 JPG');
  assert.equal(fetchCounts.get('1'), 1, '已成功 JPG 重试时不得再次请求网络');
  assert.equal(fetchCounts.get('3'), 1, '跨页选中的已成功 JPG 应直接复用');
  assert.equal(fetchCounts.get('4'), 2, '失败照片应在重试时再次下载');

  const readyBatches = await listReadyMarkiImportBatches(userDataPath);
  assert.equal(readyBatches.items.some((batch) => batch.batchId === retried.batchId), true, 'ready 批次应出现在发现入口');
  const readyBatch = await getMarkiImportBatch(userDataPath, retried.batchId);
  assert.equal(readyBatch.status, 'ready', '完整链路批次应为 ready');
  assert.equal(Boolean(readyBatch.workbenchImportPackage), true, 'ready 批次应保存五字段工作台包');
  assert.equal(
    JSON.stringify(readyBatch).includes('mock.invalid'),
    false,
    '批次不得保存 mock 远程 URL'
  );
  assert.equal(
    JSON.stringify(readyBatch).includes('CHAIN-'),
    false,
    '工作台批次不得保存防伪码'
  );

  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'markiWorkbenchImport.js')
  ).href;
  const { mergeMarkiWorkbenchImportPackage } = await import(
    `${moduleUrl}?endtoend=${Date.now()}`
  );
  const emptyState = {
    photos: [],
    recognitionResultsByPhoto: {},
    watermarkRecordsByPhoto: {},
    archiveSuggestionsByPhoto: {},
    selectedIds: [],
    activePhotoId: ''
  };
  const merged = mergeMarkiWorkbenchImportPackage(emptyState, readyBatch.workbenchImportPackage);
  assert.equal(merged.stats.addedCount, 3, 'ready 批次应追加到现有工作台');

  let failFirstConsumeRename = true;
  const oneShotConsumeFailureFileSystem = {
    mkdir: (...args) => fs.mkdir(...args),
    open: (...args) => fs.open(...args),
    readFile: (...args) => fs.readFile(...args),
    readdir: (...args) => fs.readdir(...args),
    rename: async (...args) => {
      if (failFirstConsumeRename) {
        failFirstConsumeRename = false;
        const error = new Error('injected consume rename failure');
        error.code = 'EPERM';
        throw error;
      }
      return fs.rename(...args);
    },
    rm: (...args) => fs.rm(...args)
  };
  await assert.rejects(
    () => consumeMarkiImportBatch(
      userDataPath,
      retried.batchId,
      { fs: oneShotConsumeFailureFileSystem }
    ),
    (error) => error?.code === 'marki_import_batch_save_failed',
    '第一次消费必须真实经历一次可控的原子替换失败'
  );
  const batchAfterConsumeFailure = await getMarkiImportBatch(userDataPath, retried.batchId);
  assert.equal(batchAfterConsumeFailure.status, 'ready', '消费写入失败后批次必须保持 ready');
  assert.equal(
    Boolean(batchAfterConsumeFailure.workbenchImportPackage),
    true,
    '消费写入失败不得形成半消费或清除工作台包'
  );
  const duplicateMerge = mergeMarkiWorkbenchImportPackage(
    merged,
    batchAfterConsumeFailure.workbenchImportPackage
  );
  assert.equal(duplicateMerge.stats.addedCount, 0, '消费失败后再次处理同一 ready 包不得重复追加');
  assert.equal(duplicateMerge.stats.duplicateCount, 3, '消费失败恢复时 sourceKey 全局重复统计应准确');
  assert.equal(duplicateMerge.photos, merged.photos, '消费失败后重试不得重复合并照片');
  assert.equal(
    duplicateMerge.recognitionResultsByPhoto,
    merged.recognitionResultsByPhoto,
    '消费失败后重试不得重复写入识别结果'
  );
  assert.equal(
    duplicateMerge.watermarkRecordsByPhoto,
    merged.watermarkRecordsByPhoto,
    '消费失败后重试不得重复写入水印记录'
  );
  assert.equal(
    duplicateMerge.archiveSuggestionsByPhoto,
    merged.archiveSuggestionsByPhoto,
    '消费失败后重试不得重复写入归档建议'
  );
  assert.equal(
    new Set(duplicateMerge.photos.map((photo) => photo.sourceKey)).size,
    duplicateMerge.photos.length,
    '消费失败后重试不得产生重复 sourceKey'
  );
  const consumed = await consumeMarkiImportBatch(userDataPath, retried.batchId);
  assert.equal(consumed.alreadyConsumed, false, '第二次使用同一 batchId 应成功完成首次真实消费');
  const repeatedConsume = await consumeMarkiImportBatch(userDataPath, retried.batchId);
  assert.equal(repeatedConsume.alreadyConsumed, true, '消费成功后再次调用应幂等返回 alreadyConsumed');
  assert.equal(
    (await getMarkiImportBatch(userDataPath, retried.batchId)).workbenchImportPackage,
    null,
    'consumed 墓碑必须清除工作台包'
  );

  const duplicateQueryService = createMarkiPhotoQuerySessionService({
    listMarkiMoments: async () => ({ moments: [moments[0], moments[2]], next: '', hasMore: false }),
    checkMarkiSourceKeys
  });
  const duplicateQuery = await duplicateQueryService.create({
    credentials,
    documentsPath,
    filters: {
      start: '2026-07-18 00:00:00',
      end: '2026-07-18 23:59:59'
    }
  });
  const nothingToImport = await importMarkiPhotoQuerySelection({
    credentials,
    documentsPath,
    userDataPath,
    request: {
      sessionId: duplicateQuery.sessionId,
      selectionTokens: duplicateQuery.photos.map((photo) => photo.selectionToken),
      templateFilter: 'all',
      importStatusFilter: 'all'
    }
  }, {
    ...importOptions,
    beginSelectionImport: duplicateQueryService.beginImport,
    settleSelectionImport: duplicateQueryService.settleImport
  });
  assert.equal(nothingToImport.status, 'nothing_to_import', '历史 imported 项普通导入应全部跳过');

  const metadataMoments = [moments[4], {
    ...moments[4],
    id: 'end-to-end-006',
    url: 'https://mock.invalid/end-to-end-6.jpg'
  }];
  const metadataQueryService = createMarkiPhotoQuerySessionService({
    listMarkiMoments: async () => ({ moments: metadataMoments, next: '', hasMore: false }),
    checkMarkiSourceKeys
  });
  const metadataQuery = await metadataQueryService.create({
    credentials,
    documentsPath,
    filters: {
      start: '2026-07-18 00:00:00',
      end: '2026-07-18 23:59:59'
    }
  });
  let metadataWritable = false;
  const metadataImportOptions = {
    ...importOptions,
    beginSelectionImport: metadataQueryService.beginImport,
    settleSelectionImport: metadataQueryService.settleImport,
    orchestratorOptions: {
      ...importOptions.orchestratorOptions,
      saveSourceMetadata: async (rootPath, record, saveOptions) => {
        if (!metadataWritable && record.sourceKey.endsWith(':end-to-end-006')) {
          const error = new Error('private metadata error');
          error.code = 'marki_source_metadata_save_failed';
          throw error;
        }
        return saveMarkiSourceMetadata(rootPath, record, saveOptions);
      }
    }
  };
  const metadataRequest = {
    credentials,
    documentsPath,
    userDataPath,
    request: {
      sessionId: metadataQuery.sessionId,
      selectionTokens: metadataQuery.photos.map((photo) => photo.selectionToken),
      templateFilter: 'all',
      importStatusFilter: 'all'
    }
  };
  const metadataFailure = await importMarkiPhotoQuerySelection(metadataRequest, metadataImportOptions);
  assert.equal(metadataFailure.status, 'metadata_failed', '模拟链路应覆盖来源元数据局部失败');
  assert.equal(
    (await getMarkiImportBatch(userDataPath, metadataFailure.batchId)).status,
    'failed',
    '元数据局部失败必须生成 failed 批次'
  );
  metadataWritable = true;
  const metadataRetry = await importMarkiPhotoQuerySelection(metadataRequest, metadataImportOptions);
  assert.equal(metadataRetry.status, 'ready', '来源元数据恢复后应完成 failed → preparing → ready');
  assert.equal(metadataRetry.batchId, metadataFailure.batchId, '元数据重试必须使用同一 batchId');
  assert.equal(metadataRetry.reusedCount, 2, '元数据重试应复验并复用 imported JPG');

  const serializedRendererResults = JSON.stringify({
    firstPage,
    secondPage,
    downloadFailed,
    retried,
    readyBatches,
    nothingToImport,
    metadataFailure,
    metadataRetry
  });
  for (const forbidden of ['mock.invalid', '"content"', '"sourceKey"', '"orgId"', '"localPath"', '"stack"']) {
    assert.equal(
      serializedRendererResults.includes(forbidden),
      false,
      `renderer 安全结果不得包含 ${forbidden}`
    );
  }
}

async function checkMarkiWorkbenchImport() {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'markiWorkbenchImport.js')
  ).href;
  const { mergeMarkiWorkbenchImportPackage } = await import(
    `${moduleUrl}?selfcheck=${Date.now()}`
  );
  const makePhoto = (id, sourceKey = `marki_api:12345:${id}`) => ({
    id,
    sourceType: 'marki_api',
    sourceKey,
    originalPath: `C:\\marki-import\\${id}.jpg`,
    originalName: `${id}.jpg`,
    sortStatus: 'recognized'
  });
  const makePackage = (photos, batchId = 'marki-workbench-self-check') => {
    const recognitionResultsByPhoto = {};
    const watermarkRecordsByPhoto = {};
    const archiveSuggestionsByPhoto = {};
    for (const photo of photos) {
      recognitionResultsByPhoto[photo.id] = { photoId: photo.id, status: 'recognized' };
      watermarkRecordsByPhoto[photo.id] = { photoId: photo.id, workContent: `内容-${photo.id}` };
      archiveSuggestionsByPhoto[photo.id] = { photoId: photo.id, status: 'suggestion_ready' };
    }
    return {
      batchId,
      photos,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto
    };
  };
  const makeState = (overrides = {}) => ({
    photos: [],
    recognitionResultsByPhoto: {},
    watermarkRecordsByPhoto: {},
    archiveSuggestionsByPhoto: {},
    selectedIds: [],
    activePhotoId: '',
    ...overrides
  });
  const copyJson = (value) => JSON.parse(JSON.stringify(value));
  let scenarioCount = 0;

  {
    const photos = [makePhoto('marki-1'), makePhoto('marki-2'), makePhoto('marki-3')];
    const result = mergeMarkiWorkbenchImportPackage(makeState(), makePackage(photos));
    assert.deepEqual(
      result.photos,
      photos.map((photo) => ({
        ...photo,
        sortStatus: 'unassigned',
        smartSortStatus: 'not_run'
      })),
      '空工作台应按输入顺序追加三张待智拣马克照片'
    );
    assert.equal(photos[0].sortStatus, 'recognized', '合并不得修改输入照片对象');
    assert.equal(result.stats.addedCount, 3, '空工作台应新增三张照片');
    scenarioCount += 1;
  }

  {
    const localPhoto = {
      id: 'local-1',
      originalPath: 'C:\\photos\\local-1.jpg',
      archiveInfo: { project: '原项目' },
      previewInfo: { targetName: '原预览.jpg' },
      archiveResult: { success: true },
      sortStatus: 'archived'
    };
    const incoming = makePhoto('marki-4');
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [localPhoto] }),
      makePackage([incoming])
    );
    assert.equal(result.photos[0], localPhoto, '旧照片对象必须原样保留');
    assert.deepEqual(
      result.photos[1],
      { ...incoming, sortStatus: 'unassigned', smartSortStatus: 'not_run' },
      '新照片只能以待智拣状态追加到旧数组末尾'
    );
    assert.notEqual(result.photos[1], incoming, '新照片状态初始化不得修改输入对象');
    assert.deepEqual(result.photos[0].archiveInfo, { project: '原项目' }, '旧归档信息不得改变');
    scenarioCount += 1;
  }

  {
    const incoming = makePhoto('marki-map');
    const packageValue = makePackage([incoming]);
    const result = mergeMarkiWorkbenchImportPackage(makeState(), packageValue);
    assert.equal(
      result.recognitionResultsByPhoto[incoming.id],
      packageValue.recognitionResultsByPhoto[incoming.id],
      '识别结果映射应随接受照片追加'
    );
    assert.equal(
      result.watermarkRecordsByPhoto[incoming.id],
      packageValue.watermarkRecordsByPhoto[incoming.id],
      '水印记录映射应随接受照片追加'
    );
    assert.equal(
      result.archiveSuggestionsByPhoto[incoming.id],
      packageValue.archiveSuggestionsByPhoto[incoming.id],
      '归档建议映射应随接受照片追加'
    );
    scenarioCount += 1;
  }

  {
    const protectedId = 'protected-map-id';
    const state = makeState({
      recognitionResultsByPhoto: { [protectedId]: { old: 'recognition' } },
      watermarkRecordsByPhoto: { [protectedId]: { old: 'watermark' } },
      archiveSuggestionsByPhoto: { [protectedId]: { old: 'suggestion' } }
    });
    const result = mergeMarkiWorkbenchImportPackage(state, makePackage([makePhoto(protectedId)]));
    assert.equal(result.stats.conflictCount, 1, '旧映射键占用的照片 ID 应按冲突跳过');
    assert.equal(result.recognitionResultsByPhoto[protectedId].old, 'recognition', '旧识别结果键不得覆盖');
    assert.equal(result.watermarkRecordsByPhoto[protectedId].old, 'watermark', '旧水印记录键不得覆盖');
    assert.equal(result.archiveSuggestionsByPhoto[protectedId].old, 'suggestion', '旧归档建议键不得覆盖');
    scenarioCount += 1;
  }

  {
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ selectedIds: ['local-1'] }),
      makePackage([makePhoto('marki-selected-1'), makePhoto('marki-selected-2')])
    );
    assert.deepEqual(
      result.selectedIds,
      ['local-1', 'marki-selected-1', 'marki-selected-2'],
      '新增照片应在保留原选择顺序后自动加入选择'
    );
    scenarioCount += 1;
  }

  {
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ activePhotoId: 'local-active' }),
      makePackage([makePhoto('marki-active-1'), makePhoto('marki-active-2')])
    );
    assert.equal(result.activePhotoId, 'marki-active-1', '当前照片应切换到第一张新增照片');
    scenarioCount += 1;
  }

  {
    const existing = makePhoto('marki-duplicate-same', 'marki_api:12345:duplicate-same');
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [existing] }),
      makePackage([makePhoto(existing.id, existing.sourceKey)])
    );
    assert.equal(result.stats.duplicateCount, 1, '相同 sourceKey 和相同 ID 应判定重复');
    assert.equal(result.stats.skippedItems[0].reason, 'duplicate_source_key', '重复原因应固定');
    scenarioCount += 1;
  }

  {
    const existing = makePhoto('existing-source-owner', 'marki_api:12345:shared-source');
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [existing] }),
      makePackage([makePhoto('incoming-other-id', existing.sourceKey)])
    );
    assert.equal(result.stats.duplicateCount, 1, '相同 sourceKey 和不同 ID 仍应判定重复');
    assert.equal(result.stats.skippedItems[0].existingPhotoId, existing.id, '重复项应指向已存在照片');
    scenarioCount += 1;
  }

  {
    const existing = makePhoto('shared-photo-id', 'marki_api:12345:existing-source');
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [existing] }),
      makePackage([makePhoto(existing.id, 'marki_api:12345:new-source')])
    );
    assert.equal(result.stats.conflictCount, 1, '相同 ID 和不同 sourceKey 应判定冲突');
    assert.equal(result.stats.skippedItems[0].reason, 'conflicting_photo_id', 'ID 冲突原因应固定');
    scenarioCount += 1;
  }

  {
    const localPhoto = { id: 'local-without-source', originalPath: 'C:\\photos\\local.jpg', sortStatus: 'assigned' };
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [localPhoto] }),
      makePackage([makePhoto('marki-after-local')])
    );
    assert.equal(result.photos[0], localPhoto, '没有 sourceKey 的本地照片必须保留');
    assert.equal(result.photos[0].sourceKey, undefined, '不得给旧本地照片补写 sourceKey');
    scenarioCount += 1;
  }

  {
    const first = makePhoto('batch-first', 'marki_api:12345:batch-shared');
    const second = makePhoto('batch-second', first.sourceKey);
    const result = mergeMarkiWorkbenchImportPackage(makeState(), makePackage([first, second]));
    assert.deepEqual(result.addedPhotoIds, [first.id], '同批 sourceKey 重复只能接受第一张');
    assert.equal(result.stats.duplicateCount, 1, '同批重复应计入 duplicateCount');
    scenarioCount += 1;
  }

  {
    const existing = makePhoto('duplicate-map-existing', 'marki_api:12345:duplicate-map');
    const duplicate = makePhoto('duplicate-map-incoming', existing.sourceKey);
    const packageValue = makePackage([duplicate]);
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [existing] }),
      packageValue
    );
    assert.equal(Object.hasOwn(result.recognitionResultsByPhoto, duplicate.id), false, '重复照片识别映射必须同步跳过');
    assert.equal(Object.hasOwn(result.watermarkRecordsByPhoto, duplicate.id), false, '重复照片水印映射必须同步跳过');
    assert.equal(Object.hasOwn(result.archiveSuggestionsByPhoto, duplicate.id), false, '重复照片建议映射必须同步跳过');
    scenarioCount += 1;
  }

  {
    const existing = makePhoto('conflict-map-id', 'marki_api:12345:old-conflict');
    const conflict = makePhoto(existing.id, 'marki_api:12345:new-conflict');
    const oldRecognition = { old: true };
    const oldWatermark = { old: true };
    const oldSuggestion = { old: true };
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({
        photos: [existing],
        recognitionResultsByPhoto: { [existing.id]: oldRecognition },
        watermarkRecordsByPhoto: { [existing.id]: oldWatermark },
        archiveSuggestionsByPhoto: { [existing.id]: oldSuggestion }
      }),
      makePackage([conflict])
    );
    assert.equal(result.recognitionResultsByPhoto[existing.id], oldRecognition, '冲突照片识别映射不得覆盖');
    assert.equal(result.watermarkRecordsByPhoto[existing.id], oldWatermark, '冲突照片水印映射不得覆盖');
    assert.equal(result.archiveSuggestionsByPhoto[existing.id], oldSuggestion, '冲突照片建议映射不得覆盖');
    scenarioCount += 1;
  }

  {
    const existing = makePhoto('all-duplicate-existing', 'marki_api:12345:all-duplicate');
    const state = makeState({
      photos: [existing],
      recognitionResultsByPhoto: { [existing.id]: { old: true } },
      watermarkRecordsByPhoto: { [existing.id]: { old: true } },
      archiveSuggestionsByPhoto: { [existing.id]: { old: true } },
      selectedIds: [existing.id],
      activePhotoId: existing.id
    });
    const result = mergeMarkiWorkbenchImportPackage(
      state,
      makePackage([makePhoto('all-duplicate-incoming', existing.sourceKey)])
    );
    assert.equal(result.photos, state.photos, '全部重复时照片数组应保持不变');
    assert.equal(result.recognitionResultsByPhoto, state.recognitionResultsByPhoto, '全部重复时识别映射应保持不变');
    assert.equal(result.watermarkRecordsByPhoto, state.watermarkRecordsByPhoto, '全部重复时水印映射应保持不变');
    assert.equal(result.archiveSuggestionsByPhoto, state.archiveSuggestionsByPhoto, '全部重复时建议映射应保持不变');
    assert.equal(result.selectedIds, state.selectedIds, '全部重复时选择应保持不变');
    assert.equal(result.activePhotoId, state.activePhotoId, '全部重复时当前照片应保持不变');
    scenarioCount += 1;
  }

  {
    const state = makeState({
      photos: [{ id: 'immutable-local', originalPath: 'C:\\photos\\immutable.jpg' }],
      selectedIds: ['immutable-local'],
      activePhotoId: 'immutable-local'
    });
    const packageValue = makePackage([makePhoto('immutable-marki')]);
    const stateSnapshot = copyJson(state);
    const packageSnapshot = copyJson(packageValue);
    mergeMarkiWorkbenchImportPackage(state, packageValue);
    assert.deepEqual(state, stateSnapshot, '纯合并不得修改当前状态输入');
    assert.deepEqual(packageValue, packageSnapshot, '纯合并不得修改工作台包输入');
    scenarioCount += 1;
  }

  {
    const packageValue = { ...makePackage([makePhoto('extra-field')]), extra: true };
    assert.throws(
      () => mergeMarkiWorkbenchImportPackage(makeState(), packageValue),
      (error) => error?.code === 'marki_workbench_package_invalid',
      '工作台包多出第六个顶层字段时必须拒绝'
    );
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('missing-source-key');
    delete photo.sourceKey;
    assert.throws(
      () => mergeMarkiWorkbenchImportPackage(makeState(), makePackage([photo])),
      (error) => error?.code === 'marki_workbench_photo_invalid',
      '马克照片缺少 sourceKey 时必须拒绝'
    );
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('wrong-source-type');
    photo.sourceType = 'local_folder';
    assert.throws(
      () => mergeMarkiWorkbenchImportPackage(makeState(), makePackage([photo])),
      (error) => error?.code === 'marki_workbench_photo_invalid',
      '非 marki_api 照片必须拒绝'
    );
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('missing-map-id');
    const packageValue = makePackage([photo]);
    delete packageValue.watermarkRecordsByPhoto[photo.id];
    assert.throws(
      () => mergeMarkiWorkbenchImportPackage(makeState(), packageValue),
      (error) => error?.code === 'marki_workbench_mapping_invalid',
      '任一 ByPhoto 映射缺少照片 ID 时必须拒绝'
    );
    scenarioCount += 1;
  }

  {
    const packageValue = makePackage([makePhoto('orphan-map-owner')]);
    packageValue.archiveSuggestionsByPhoto.orphan = { status: 'suggestion_ready' };
    assert.throws(
      () => mergeMarkiWorkbenchImportPackage(makeState(), packageValue),
      (error) => error?.code === 'marki_workbench_mapping_invalid',
      'ByPhoto 映射存在孤立照片 ID 时必须拒绝'
    );
    scenarioCount += 1;
  }

  {
    const packageValue = makePackage([makePhoto('special-key')]);
    packageValue.photos[0].payload = JSON.parse('{"__proto__":{"polluted":true}}');
    assert.throws(
      () => mergeMarkiWorkbenchImportPackage(makeState(), packageValue),
      (error) => error?.code === 'marki_workbench_special_key_rejected',
      '工作台包中的特殊对象键必须拒绝'
    );
    assert.equal({}.polluted, undefined, '特殊键检查不得污染对象原型');
    scenarioCount += 1;
  }

  {
    const existingDuplicate = makePhoto('stats-existing', 'marki_api:12345:stats-duplicate');
    const accepted = makePhoto('stats-added', 'marki_api:12345:stats-added');
    const duplicate = makePhoto('stats-duplicate-new-id', existingDuplicate.sourceKey);
    const conflict = makePhoto(existingDuplicate.id, 'marki_api:12345:stats-conflict');
    const result = mergeMarkiWorkbenchImportPackage(
      makeState({ photos: [existingDuplicate] }),
      makePackage([accepted, duplicate, conflict])
    );
    assert.deepEqual(
      result.stats,
      {
        inputCount: 3,
        addedCount: 1,
        duplicateCount: 1,
        conflictCount: 1,
        skippedItems: [
          {
            photoId: duplicate.id,
            sourceKey: duplicate.sourceKey,
            reason: 'duplicate_source_key',
            existingPhotoId: existingDuplicate.id
          },
          {
            photoId: conflict.id,
            sourceKey: conflict.sourceKey,
            reason: 'conflicting_photo_id',
            existingPhotoId: existingDuplicate.id
          }
        ]
      },
      'stats 和 skippedItems 应准确记录新增、重复与冲突'
    );
    scenarioCount += 1;
  }

  const mainRouterSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'pages', 'MainRouter.jsx'),
    'utf8'
  );
  const workspaceSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'),
    'utf8'
  );
  const glueStart = workspaceSource.indexOf("navigationRequest?.action !== 'appendMarkiImportBatch'");
  const glueEnd = workspaceSource.indexOf('}, [isSessionHydrated, navigationRequest]);', glueStart);
  const glueSource = workspaceSource.slice(glueStart, glueEnd);

  assert.equal(
    (mainRouterSource.match(/<SortWorkspacePage[^>]*navigationRequest=\{navigationRequest\}[^>]*\/>/g) || []).length,
    2,
    'MainRouter 的两个工作台入口都应传递 navigationRequest'
  );
  scenarioCount += 1;

  assert.equal(glueStart >= 0, true, '工作台只应识别 appendMarkiImportBatch 导航动作');
  assert.equal(
    (workspaceSource.match(/appendMarkiImportBatch/g) || []).length,
    1,
    '工作台不得新增其他马克批次导航动作'
  );
  scenarioCount += 1;

  assert.equal(
    glueSource.indexOf('getImportBatch(batchId)') < glueSource.indexOf('persistMarkiWorkbenchImport({')
      && glueSource.indexOf('persistMarkiWorkbenchImport({') < glueSource.indexOf('consumeImportBatch(batchId)'),
    true,
    '页面粘合层必须先查询，再通过持久化事务合并并消费批次'
  );
  scenarioCount += 1;

  const mergeCallIndex = glueSource.indexOf('persistMarkiWorkbenchImport({');
  assert.equal(
    mergeCallIndex >= 0
      && /catch\s*\{[\s\S]*工作台导入包校验失败，未修改当前工作台。[\s\S]*return;[\s\S]*\}/.test(glueSource.slice(mergeCallIndex)),
    true,
    '纯合并异常必须在消费前返回'
  );
  scenarioCount += 1;

  const addedBranch = glueSource.slice(
    glueSource.indexOf('prepareWorkspace:'),
    glueSource.indexOf('saveSnapshot:')
  );
  assert.equal(
    addedBranch.includes('prepareWorkspaceAfterPhotoAppend({'),
    true,
    '新增照片必须通过统一快照准备函数处理'
  );
  assert.equal(
    [
      'smartSortResult: null',
      'archivePreviewPlan: null',
      "smartSortViewMode: 'statusFilter'",
      "activeSmartSortGroupId: ''"
    ].some((token) => addedBranch.includes(token)),
    false,
    '新增照片不得在页面粘合层清空已有智拣、分组或预览'
  );
  scenarioCount += 1;

  assert.equal(glueSource.includes('setSortMode('), false, '马克批次合并不得修改当前 sortMode');
  scenarioCount += 1;

  const consumeFailureBranch = glueSource.slice(
    glueSource.indexOf("if (transactionResult.consumeResult?.success !== true)"),
    glueSource.indexOf('const { addedCount, duplicateCount, conflictCount }')
  );
  assert.equal(
    consumeFailureBranch.includes('照片已追加，但批次消费状态未更新；再次处理时会按 sourceKey 自动去重。'),
    true,
    '消费失败应提示可依靠 sourceKey 幂等恢复'
  );
  assert.equal(
    ['setPhotos(', 'setRecognitionResultsByPhoto(', 'setWatermarkRecordsByPhoto(', 'setArchiveSuggestionsByPhoto(']
      .some((token) => consumeFailureBranch.includes(token)),
    false,
    '消费失败不得回滚已合并工作台状态'
  );
  scenarioCount += 1;

  for (const forbidden of [
    'console.',
    'recordRuntimeLog',
    'userDataPath',
    'remoteUrl',
    'rawContent',
    'antiCounterfeitCode',
    '.stack'
  ]) {
    assert.equal(glueSource.includes(forbidden), false, `页面批次处理不得记录或展示 ${forbidden}`);
  }
  scenarioCount += 1;

  assert.equal(scenarioCount, 30, '马克批次进入工作台应完整执行 30 个自检场景');
}

async function checkSortWorkspaceSnapshot(root) {
  await fs.mkdir(root, { recursive: true });
  const servicePath = require.resolve('../electron/services/sortWorkspaceSnapshotService.cjs');
  const snapshotLoadOptions = { decodeImage: decodeSelfCheckImage };
  const snapshotUtilityUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'sortWorkspaceSnapshot.js')
  ).href;
  const workbenchUtilityUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'markiWorkbenchImport.js')
  ).href;
  const {
    buildSortWorkspaceSnapshotWorkspace,
    createDebouncedSnapshotSaver,
    persistMarkiWorkbenchImport
  } = await import(`${snapshotUtilityUrl}?snapshot-check=${Date.now()}`);
  const { mergeMarkiWorkbenchImportPackage } = await import(
    `${workbenchUtilityUrl}?snapshot-check=${Date.now()}`
  );
  let scenarioCount = 0;
  let assertionCount = 0;
  let sourceContractAssertionCount = 0;
  const equal = (actual, expected, message) => {
    assertionCount += 1;
    assert.equal(actual, expected, message);
  };
  const deepEqual = (actual, expected, message) => {
    assertionCount += 1;
    assert.deepEqual(actual, expected, message);
  };
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const makePhoto = (id, originalPath, sourceKey = '') => ({
    id,
    originalPath,
    originalName: `${id}.jpg`,
    extension: '.jpg',
    size: 4,
    width: 10,
    height: 10,
    modifiedAt: '2026-07-19T00:00:00.000Z',
    previewUrl: `local-photo://image/${encodeURIComponent(originalPath)}`,
    thumbnailPath: `local-photo://image/${encodeURIComponent(originalPath)}`,
    selected: false,
    sortStatus: sourceKey ? 'recognized' : 'assigned',
    smartSortStatus: 'completed',
    archiveInfo: sourceKey ? null : { project: '演示项目', workContent: '设备巡查', date: '2026-07-19' },
    previewInfo: sourceKey ? null : { targetName: `${id}-preview.jpg` },
    archiveResult: null,
    originalMissing: false,
    ...(sourceKey
      ? {
          sourceType: 'marki_api',
          sourceKey,
          sourceMetadataRef: sourceKey.replace('marki_api:', 'marki_source_metadata:')
        }
      : {})
  });
  const makeWorkspace = (photos, overrides = {}) => {
    const recognitionResultsByPhoto = {};
    const watermarkRecordsByPhoto = {};
    const archiveSuggestionsByPhoto = {};
    for (const photo of photos) {
      recognitionResultsByPhoto[photo.id] = {
        status: photo.sourceType === 'marki_api' ? 'recognized' : 'success',
        rawContent: '不得进入自动快照',
        nested: { url: 'https://private.invalid/photo.jpg' }
      };
      watermarkRecordsByPhoto[photo.id] = { workContent: `巡查-${photo.id}` };
      archiveSuggestionsByPhoto[photo.id] = { status: 'suggestion_ready', project: '演示项目' };
    }
    return buildSortWorkspaceSnapshotWorkspace({
      photos,
      selectedIds: photos.map((photo) => photo.id),
      activePhotoId: photos.at(-1)?.id || '',
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto,
      smartSortResult: {
        status: 'created',
        rules: [{ id: 'time_window', key: 'time_window', enabled: true }],
        groups: [{ id: 'group-1', title: '巡查组', photoIds: photos.map((photo) => photo.id) }]
      },
      smartSortViewMode: 'smartSortGroup',
      activeSmartSortGroupId: 'group-1',
      photoFolder: 'C:\\photos',
      archiveRoot: 'C:\\archive',
      filter: 'selected',
      sortMode: 'timeDesc',
      pageSize: 100,
      rightPanelMode: 'recognition',
      form: {
        project: '演示项目',
        watermarkCategory: '巡查检查类',
        workContent: '设备巡查',
        date: '2026-07-19'
      },
      searchText: '巡查',
      page: 2,
      viewMode: 'list',
      ...overrides
    });
  };
  const makePackage = (photo, batchId = 'snapshot-batch') => ({
    batchId,
    photos: [photo],
    recognitionResultsByPhoto: { [photo.id]: { status: 'recognized' } },
    watermarkRecordsByPhoto: { [photo.id]: { workContent: `巡查-${photo.id}` } },
    archiveSuggestionsByPhoto: { [photo.id]: { status: 'suggestion_ready', project: '演示项目' } }
  });

  const photoRoot = path.join(root, 'photos');
  await fs.mkdir(photoRoot, { recursive: true });
  const localPath = path.join(photoRoot, 'local.jpg');
  const markiPath = path.join(photoRoot, 'marki.jpg');
  const appendPath = path.join(photoRoot, 'append.jpg');
  const snapshotJpeg = createTestJpeg(10, 10);
  await fs.writeFile(localPath, snapshotJpeg);
  await fs.writeFile(markiPath, snapshotJpeg);
  await fs.writeFile(appendPath, snapshotJpeg);
  const localPhoto = makePhoto('local-photo', localPath);
  const markiPhoto = makePhoto('marki-photo', markiPath, 'marki_api:12345:moment-1');
  const missingPhoto = makePhoto(
    'missing-photo',
    path.join(photoRoot, 'missing.jpg'),
    'marki_api:12345:moment-missing'
  );

  {
    const result = await loadSortWorkspaceSnapshot(path.join(root, 'none'));
    equal(result.success, true, '无快照应返回安全成功');
    equal(result.found, false, '无快照应返回 found=false');
    scenarioCount += 1;
  }

  const persistenceRoot = path.join(root, 'persistence');
  const initialWorkspace = makeWorkspace([localPhoto, markiPhoto, missingPhoto]);
  {
    const result = await saveSortWorkspaceSnapshot(persistenceRoot, initialWorkspace, {
      now: () => new Date('2026-07-19T01:00:00.000Z')
    });
    equal(result.success, true, '完整统一照片池应保存成功');
    equal(result.photoCount, 3, '保存结果应返回照片数量');
    scenarioCount += 1;
  }

  let freshService;
  {
    delete require.cache[servicePath];
    freshService = require(servicePath);
    const result = await freshService.loadSortWorkspaceSnapshot(persistenceRoot, snapshotLoadOptions);
    equal(result.success, true, '全新服务实例应恢复快照');
    equal(result.snapshot.workspace.photos.length, 3, '重启后应恢复全部照片');
    deepEqual(result.snapshot.workspace.selectedIds, initialWorkspace.selectedIds, '重启后应恢复选择');
    equal(result.snapshot.workspace.activePhotoId, initialWorkspace.activePhotoId, '重启后应恢复当前照片');
    equal(result.snapshot.workspace.smartSortResult.rules[0].key, 'time_window', '智拣规则应完整恢复');
    equal(result.snapshot.workspace.activeSmartSortGroupId, 'group-1', '当前智拣分组应恢复');
    equal(result.snapshot.workspace.photos[0].smartSortStatus, 'completed', '本地照片 completed 智拣状态应恢复');
    equal(result.snapshot.workspace.photos[1].smartSortStatus, 'completed', 'Marki 照片 completed 智拣状态应恢复');
    equal(result.snapshot.workspace.photos[1].sourceKey, markiPhoto.sourceKey, 'Marki sourceKey 应恢复');
    equal(
      result.snapshot.workspace.photos[1].sourceMetadataRef,
      markiPhoto.sourceMetadataRef,
      'Marki 来源元数据引用应恢复'
    );
    equal(result.snapshot.workspace.recognitionResultsByPhoto[markiPhoto.id].status, 'recognized', '识别映射应恢复');
    equal(result.snapshot.workspace.watermarkRecordsByPhoto[markiPhoto.id].workContent, `巡查-${markiPhoto.id}`, '水印映射应恢复');
    equal(result.snapshot.workspace.archiveSuggestionsByPhoto[markiPhoto.id].project, '演示项目', '归档建议应恢复');
    scenarioCount += 1;
  }

  {
    const result = await freshService.loadSortWorkspaceSnapshot(persistenceRoot, snapshotLoadOptions);
    const missing = result.snapshot.workspace.photos.find((photo) => photo.id === missingPhoto.id);
    equal(missing.originalMissing, true, '缺失原图记录应保留并标记');
    equal(missing.missingSortStatus, missingPhoto.sortStatus, '缺失原图应保留原状态');
    equal(result.snapshot.workspace.photos[0].originalMissing, false, '其他照片应正常恢复');
    equal(result.snapshot.workspace.photos.length, 3, '单张缺失不得清空整个工作台');
    scenarioCount += 1;
  }

  {
    const legacyRoot = path.join(root, 'legacy-workspace-shape');
    const legacyPath = getSortWorkspaceSnapshotPath(legacyRoot);
    const legacySnapshot = JSON.parse(
      await fs.readFile(getSortWorkspaceSnapshotPath(persistenceRoot), 'utf8')
    );
    delete legacySnapshot.workspace.photoDraftByPhotoId;
    delete legacySnapshot.workspace.groupDraftByGroupId;
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, `${JSON.stringify(legacySnapshot, null, 2)}\n`, 'utf8');

    const restoredLegacy = await freshService.loadSortWorkspaceSnapshot(legacyRoot, snapshotLoadOptions);
    equal(restoredLegacy.success, true, '新增草稿映射前的旧快照应继续恢复');
    equal(restoredLegacy.snapshot.workspace.photos.length, 3, '旧快照恢复不得丢失原照片池');
    equal(
      Object.keys(restoredLegacy.snapshot.workspace.photoDraftByPhotoId).length,
      0,
      '旧快照应补空照片草稿映射'
    );
    equal(
      Object.keys(restoredLegacy.snapshot.workspace.groupDraftByGroupId).length,
      0,
      '旧快照应补空分组草稿映射'
    );

    const localAppend = makePhoto('legacy-local-append', appendPath);
    const localWorkspace = {
      ...restoredLegacy.snapshot.workspace,
      photos: [...restoredLegacy.snapshot.workspace.photos, localAppend],
      selectedIds: [...restoredLegacy.snapshot.workspace.selectedIds, localAppend.id],
      activePhotoId: localAppend.id
    };
    const localSaved = await freshService.saveSortWorkspaceSnapshot(legacyRoot, localWorkspace);
    equal(localSaved.success, true, '旧快照恢复后应允许追加本地照片并安全升级格式');

    const legacyMarkiAppend = makePhoto(
      'legacy-marki-append',
      appendPath,
      'marki_api:12345:legacy-shape-marki'
    );
    let committedWorkspace = null;
    const markiAppend = await persistMarkiWorkbenchImport({
      currentWorkspace: (await freshService.loadSortWorkspaceSnapshot(legacyRoot, snapshotLoadOptions)).snapshot.workspace,
      workbenchImportPackage: makePackage(legacyMarkiAppend, 'legacy-shape-marki-batch'),
      mergeWorkbenchImport: mergeMarkiWorkbenchImportPackage,
      saveSnapshot: (workspace) => freshService.saveSortWorkspaceSnapshot(legacyRoot, workspace),
      consumeBatch: async () => ({ success: true }),
      commitWorkspace: (_merged, workspace) => {
        committedWorkspace = workspace;
      }
    });
    equal(markiAppend.stage, 'completed', '旧快照升级后应允许追加 Marki 批次');
    deepEqual(
      committedWorkspace.photos.map((photo) => photo.id),
      [localPhoto.id, markiPhoto.id, missingPhoto.id, localAppend.id, legacyMarkiAppend.id],
      '本地与 Marki 追加必须保留旧照片并按顺序进入统一照片池'
    );
    equal(
      (await freshService.loadSortWorkspaceSnapshot(legacyRoot, snapshotLoadOptions)).snapshot.workspace.photos.length,
      5,
      '升级后的快照应持久保存旧照片、本地新增和 Marki 新增'
    );
    scenarioCount += 1;
  }

  {
    const text = await fs.readFile(getSortWorkspaceSnapshotPath(persistenceRoot), 'utf8');
    equal(text.includes('local-photo://'), false, '可重建本地预览 URL 不得落盘');
    equal(text.includes('private.invalid'), false, '远程 URL 不得落盘');
    equal(text.includes('不得进入自动快照'), false, '原始 content 不得落盘');
    equal(text.includes('"rawContent"'), false, 'rawContent 字段不得落盘');
    scenarioCount += 1;
  }

  {
    const before = await freshService.loadSortWorkspaceSnapshot(persistenceRoot, snapshotLoadOptions);
    const failed = await freshService.saveSortWorkspaceSnapshot(
      persistenceRoot,
      makeWorkspace([localPhoto], { searchText: 'newer' }),
      {
        fs: {
          ...fs,
          rename: async () => {
            const error = new Error('controlled rename failure');
            error.code = 'EACCES';
            throw error;
          }
        }
      }
    );
    equal(failed.success, false, '原子替换失败应安全返回');
    const after = await freshService.loadSortWorkspaceSnapshot(persistenceRoot, snapshotLoadOptions);
    equal(after.snapshot.savedAt, before.snapshot.savedAt, '原子替换失败应保留旧快照');
    const fileNames = await fs.readdir(path.dirname(getSortWorkspaceSnapshotPath(persistenceRoot)));
    equal(fileNames.some((name) => name.endsWith('.tmp')), false, '原子失败后应清理临时文件');
    scenarioCount += 1;
  }

  {
    const corruptRoot = path.join(root, 'corrupt');
    const corruptPath = getSortWorkspaceSnapshotPath(corruptRoot);
    await fs.mkdir(path.dirname(corruptPath), { recursive: true });
    await fs.writeFile(corruptPath, '{"schemaVersion":1,', 'utf8');
    const loaded = await freshService.loadSortWorkspaceSnapshot(corruptRoot);
    equal(loaded.success, false, '损坏 JSON 不得导致崩溃');
    equal(loaded.error.code, 'sort_workspace_snapshot_corrupt', '损坏 JSON 应返回固定错误码');
    equal(JSON.stringify(loaded).includes(corruptRoot), false, '损坏错误不得暴露 userData 路径');
    const overwrite = await freshService.saveSortWorkspaceSnapshot(corruptRoot, makeWorkspace([localPhoto]));
    equal(overwrite.success, false, '损坏快照不得被静默覆盖');
    equal(await fs.readFile(corruptPath, 'utf8'), '{"schemaVersion":1,', '损坏文件应保留');
    scenarioCount += 1;
  }

  {
    const incompatibleRoot = path.join(root, 'incompatible');
    const incompatiblePath = getSortWorkspaceSnapshotPath(incompatibleRoot);
    await fs.mkdir(path.dirname(incompatiblePath), { recursive: true });
    await fs.writeFile(incompatiblePath, JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1,
      savedAt: '2026-07-19T01:00:00.000Z',
      workspace: initialWorkspace
    }), 'utf8');
    const loaded = await freshService.loadSortWorkspaceSnapshot(incompatibleRoot);
    equal(loaded.success, false, '未知 schemaVersion 应拒绝');
    equal(loaded.error.code, 'sort_workspace_snapshot_incompatible', '未知版本应返回不兼容错误');
    scenarioCount += 1;
  }

  {
    const callbacks = new Map();
    const saves = [];
    let timerId = 0;
    const saver = createDebouncedSnapshotSaver({
      save: async (workspace) => {
        saves.push(workspace.searchText);
        return { success: true };
      },
      setTimer: (callback) => {
        timerId += 1;
        callbacks.set(timerId, callback);
        return timerId;
      },
      clearTimer: (id) => callbacks.delete(id)
    });
    saver.setEnabled(true);
    saver.schedule(makeWorkspace([localPhoto], { searchText: 'first' }));
    saver.schedule(makeWorkspace([localPhoto], { searchText: 'second' }));
    saver.schedule(makeWorkspace([localPhoto], { searchText: 'final' }));
    equal(callbacks.size, 1, '连续变化只保留一个防抖任务');
    callbacks.values().next().value();
    await saver.whenIdle();
    deepEqual(saves, ['final'], '防抖只应保存最终状态');
    scenarioCount += 1;
  }

  {
    const completed = [];
    let lastPage = 0;
    const saver = createDebouncedSnapshotSaver({
      save: async (workspace) => {
        if (workspace.page === 1) await delay(20);
        completed.push(workspace.page);
        lastPage = workspace.page;
        return { success: true };
      }
    });
    saver.setEnabled(true);
    await Promise.all([
      saver.flush(makeWorkspace([localPhoto], { page: 1 })),
      saver.flush(makeWorkspace([localPhoto], { page: 2 }))
    ]);
    deepEqual(completed, [1, 2], '写入应严格串行');
    equal(lastPage, 2, '旧状态不得晚于新状态覆盖');
    scenarioCount += 1;
  }

  {
    let attempt = 0;
    const saver = createDebouncedSnapshotSaver({
      save: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('controlled failure');
        return { success: true };
      }
    });
    saver.setEnabled(true);
    assertionCount += 1;
    await assert.rejects(() => saver.flush(makeWorkspace([localPhoto], { page: 1 })));
    const recovered = await saver.flush(makeWorkspace([localPhoto], { page: 2 }));
    equal(recovered.success, true, '保存失败后应允许后续保存');
    equal(attempt, 2, '保存失败不得永久锁死队列');
    scenarioCount += 1;
  }

  {
    let saveCount = 0;
    const saver = createDebouncedSnapshotSaver({
      save: async () => {
        saveCount += 1;
        return { success: true };
      }
    });
    saver.schedule(makeWorkspace([], { searchText: 'initial-empty' }));
    await saver.whenIdle();
    equal(saveCount, 0, '初始化完成前不得保存空工作台');
    scenarioCount += 1;
  }

  const appendedPhoto = makePhoto('marki-appended', appendPath, 'marki_api:12345:moment-appended');
  const workbenchPackage = makePackage(appendedPhoto);
  {
    const order = [];
    let committed = null;
    const result = await persistMarkiWorkbenchImport({
      currentWorkspace: makeWorkspace([localPhoto]),
      workbenchImportPackage: workbenchPackage,
      mergeWorkbenchImport: mergeMarkiWorkbenchImportPackage,
      saveSnapshot: async () => {
        order.push('snapshot');
        return { success: true };
      },
      consumeBatch: async () => {
        order.push('consume');
        return { success: true };
      },
      commitWorkspace: (_merged, workspace) => {
        order.push('commit');
        committed = workspace;
      }
    });
    deepEqual(order, ['snapshot', 'consume', 'commit'], 'Marki 必须先快照、后消费、再提交页面');
    equal(result.stage, 'completed', '完整事务应完成');
    equal(committed.photos.length, 2, '快照和页面应使用同一合并结果');
    scenarioCount += 1;
  }

  {
    let consumeCount = 0;
    let commitCount = 0;
    const result = await persistMarkiWorkbenchImport({
      currentWorkspace: makeWorkspace([localPhoto]),
      workbenchImportPackage: workbenchPackage,
      mergeWorkbenchImport: mergeMarkiWorkbenchImportPackage,
      saveSnapshot: async () => ({ success: false }),
      consumeBatch: async () => {
        consumeCount += 1;
        return { success: true };
      },
      commitWorkspace: () => {
        commitCount += 1;
      }
    });
    equal(result.stage, 'snapshot', '快照失败应终止事务');
    equal(consumeCount, 0, '快照失败不得消费批次');
    equal(commitCount, 0, '快照失败不得提交 React 状态');
    scenarioCount += 1;
  }

  {
    let currentWorkspace = makeWorkspace([localPhoto]);
    let persistedWorkspace = null;
    let consumeAttempt = 0;
    const run = () => persistMarkiWorkbenchImport({
      currentWorkspace,
      workbenchImportPackage: workbenchPackage,
      mergeWorkbenchImport: mergeMarkiWorkbenchImportPackage,
      saveSnapshot: async (workspace) => {
        persistedWorkspace = workspace;
        return { success: true };
      },
      consumeBatch: async () => {
        consumeAttempt += 1;
        return { success: consumeAttempt > 1 };
      },
      commitWorkspace: (_merged, workspace) => {
        currentWorkspace = workspace;
      }
    });
    const first = await run();
    equal(first.stage, 'consume', '首次消费失败时快照应已完成');
    equal(persistedWorkspace.photos.length, 2, '消费失败前快照应包含新照片');
    const second = await run();
    equal(second.stage, 'completed', '同一 batchId 重试应消费成功');
    equal(second.merged.stats.addedCount, 0, '重试应依赖 sourceKey 跳过重复');
    equal(currentWorkspace.photos.length, 2, '消费重试不得重复添加照片');
    const consumedAgain = mergeMarkiWorkbenchImportPackage(currentWorkspace, workbenchPackage);
    equal(consumedAgain.stats.addedCount, 0, 'consumed 后再次进入不得重复追加');
    scenarioCount += 1;
  }

  {
    const restartRoot = path.join(root, 'restart-append');
    const beforeRestart = makeWorkspace([localPhoto, markiPhoto]);
    equal((await freshService.saveSortWorkspaceSnapshot(restartRoot, beforeRestart)).success, true, '第一实例应保存快照');
    delete require.cache[servicePath];
    const restarted = require(servicePath);
    const restored = await restarted.loadSortWorkspaceSnapshot(restartRoot);
    equal(restored.success, true, '第二实例不依赖 renderer cache 即可恢复');
    let committed = null;
    const result = await persistMarkiWorkbenchImport({
      currentWorkspace: restored.snapshot.workspace,
      workbenchImportPackage: makePackage(appendedPhoto, 'snapshot-restart-batch'),
      mergeWorkbenchImport: mergeMarkiWorkbenchImportPackage,
      saveSnapshot: (workspace) => restarted.saveSortWorkspaceSnapshot(restartRoot, workspace),
      consumeBatch: async () => ({ success: true }),
      commitWorkspace: (_merged, workspace) => {
        committed = workspace;
      }
    });
    equal(result.stage, 'completed', '恢复后应可继续追加新批次');
    deepEqual(
      committed.photos.map((photo) => photo.id),
      [localPhoto.id, markiPhoto.id, appendedPhoto.id],
      '恢复后应保留旧照片并追加新照片'
    );
    equal(
      (await restarted.loadSortWorkspaceSnapshot(restartRoot)).snapshot.workspace.photos.length,
      3,
      '恢复后追加结果应再次落盘'
    );
    scenarioCount += 1;
  }

  {
    const mainSource = await fs.readFile(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
    const preloadSource = await fs.readFile(path.join(process.cwd(), 'electron', 'preload.cjs'), 'utf8');
    const pageSource = await fs.readFile(path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'), 'utf8');
    assert.match(mainSource, /sortWorkspaceSnapshot:save[\s\S]*app\.getPath\('userData'\)/);
    sourceContractAssertionCount += 1;
    assert.match(mainSource, /sortWorkspaceSnapshot:load[\s\S]*app\.getPath\('userData'\)/);
    sourceContractAssertionCount += 1;
    assert.match(preloadSource, /saveSortWorkspaceSnapshot: \(workspace\) => ipcRenderer\.invoke\('sortWorkspaceSnapshot:save', workspace\)/);
    sourceContractAssertionCount += 1;
    assert.match(preloadSource, /loadSortWorkspaceSnapshot: \(\) => ipcRenderer\.invoke\('sortWorkspaceSnapshot:load'\)/);
    sourceContractAssertionCount += 1;
    assert.match(pageSource, /loadSortWorkspaceSnapshot\(\)/);
    sourceContractAssertionCount += 1;
    assert.match(pageSource, /persistMarkiWorkbenchImport\(/);
    sourceContractAssertionCount += 1;
    assert.equal(pageSource.includes('saveSortWorkspaceSnapshot({ userDataPath'), false);
    sourceContractAssertionCount += 1;
    scenarioCount += 1;
  }

  console.log(
    `工作台自动快照自检通过：${scenarioCount} 个行为场景，${assertionCount} 个行为断言，${sourceContractAssertionCount} 个源码契约断言。`
  );
}

async function checkMarkiWorkbenchRehydration(root) {
  const documentsPath = path.join(root, 'documents');
  const userDataPath = path.join(root, 'user-data');
  const configs = {
    projects: ['测试小区'],
    watermarkCategories: {
      工程类专用: {
        items: ['设施巡查']
      }
    },
    keywords: []
  };
  const counters = {
    scenarioCount: 0,
    assertionCount: 0,
    sourceContractCount: 0
  };
  const check = (condition, message) => {
    assert.equal(Boolean(condition), true, message);
    counters.assertionCount += 1;
  };
  const scenario = () => {
    counters.scenarioCount += 1;
  };

  async function createImportedFixture({
    orgId,
    momentId,
    teamId = '11',
    withFile = true,
    withMetadata = true,
    projectName = '测试小区',
    photographerName = '测试人员'
  }) {
    const fileName = `${momentId}.jpg`;
    const relativePath = `${orgId}/${teamId}/2026-07-18/${fileName}`;
    const localPath = path.join(getMarkiImportRoot(documentsPath), ...relativePath.split('/'));
    const jpeg = createTestJpeg(12, 9);
    if (withFile) {
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, jpeg);
    }
    const inspection = {
      size: jpeg.length,
      width: 12,
      height: 9,
      sha256: createHash('sha256').update(jpeg).digest('hex')
    };
    const sourceKey = buildMarkiSourceKey(orgId, momentId);
    await upsertMarkiSourceRecords(documentsPath, orgId, [{
      momentId,
      teamId,
      uid: '21',
      postTime: 1784340000,
      markName: '工程类专用'
    }]);
    await updateMarkiSourceImportStatus(
      documentsPath,
      orgId,
      sourceKey,
      'downloading'
    );
    await updateMarkiSourceImportStatus(
      documentsPath,
      orgId,
      sourceKey,
      'imported',
      {
        downloadInfo: {
          relativePath,
          fileName,
          ...inspection,
          completedAt: '2026-07-18T03:00:00.000Z'
        }
      }
    );
    if (withMetadata) {
      await saveMarkiSourceMetadata(documentsPath, {
        orgId,
        momentId,
        teamId,
        uid: '21',
        postTime: 1784340000,
        capturedAt: '2026-07-18T10:00:00+08:00',
        markName: '工程类专用',
        antiCounterfeitCode: `safe-${momentId}`,
        parsedEntries: [
          { key: '日期', value: '2026-07-18' },
          { key: '小区名称', value: projectName },
          { key: '工作内容', value: '设施巡查' },
          { key: '上传人', value: photographerName },
          { key: '地点', value: '一号楼' }
        ]
      });
    }
    return {
      orgId,
      momentId,
      sourceKey,
      localPath,
      jpeg,
      inspection,
      relativePath,
      fileName
    };
  }

  await fs.mkdir(root, { recursive: true });

  const legacy = await createImportedFixture({
    orgId: '6101',
    momentId: 'legacy-photo'
  });
  const missingFile = await createImportedFixture({
    orgId: '6102',
    momentId: 'missing-file',
    withFile: false
  });
  const corrupted = await createImportedFixture({
    orgId: '6103',
    momentId: 'corrupted-file'
  });
  await fs.appendFile(corrupted.localPath, Buffer.from([0x00]));
  await createImportedFixture({
    orgId: '6104',
    momentId: 'missing-metadata',
    withMetadata: false
  });
  const mixedValid = await createImportedFixture({
    orgId: '6105',
    momentId: 'mixed-valid'
  });
  const mixedManifestPath = getMarkiSourceManifestPath(documentsPath, '6105');
  const mixedManifest = JSON.parse(await fs.readFile(mixedManifestPath, 'utf8'));
  mixedManifest.records['marki_api:6105:path-escape'] = {
    ...mixedManifest.records[mixedValid.sourceKey],
    sourceKey: 'marki_api:6105:path-escape',
    momentId: 'path-escape',
    downloadInfo: {
      ...mixedManifest.records[mixedValid.sourceKey].downloadInfo,
      relativePath: '../escape.jpg',
      fileName: 'path-escape.jpg'
    }
  };
  await fs.writeFile(mixedManifestPath, `${JSON.stringify(mixedManifest, null, 2)}\n`);
  const alreadyPresent = await createImportedFixture({
    orgId: '6106',
    momentId: 'already-present'
  });
  const alreadyArchived = await createImportedFixture({
    orgId: '6107',
    momentId: 'already-archived'
  });

  const initialWorkspace = {
    ...createEmptyWorkspace(),
    photos: [
      {
        id: 'local-existing',
        originalPath: path.join(root, 'local-existing.jpg'),
        originalName: 'local-existing.jpg',
        extension: '.jpg',
        size: 10,
        width: 1,
        height: 1,
        modifiedAt: '2026-07-18T00:00:00.000Z',
        capturedAt: '2026-07-18T00:00:00.000Z',
        selected: false,
        sortStatus: 'unassigned',
        archiveInfo: null,
        previewInfo: null,
        archiveResult: null,
        originalMissing: false
      },
      {
        id: 'marki-present',
        originalPath: alreadyPresent.localPath,
        originalName: alreadyPresent.fileName,
        extension: '.jpg',
        size: alreadyPresent.inspection.size,
        width: 12,
        height: 9,
        modifiedAt: '2026-07-18T03:00:00.000Z',
        capturedAt: '2026-07-18T02:00:00.000Z',
        selected: false,
        sortStatus: 'suggestion_ready',
        archiveInfo: null,
        previewInfo: null,
        archiveResult: null,
        originalMissing: false,
        sourceType: 'marki_api',
        sourceKey: alreadyPresent.sourceKey,
        sourceMetadataRef: buildMarkiSourceMetadataRef('6106', 'already-present')
      },
      {
        id: 'marki-archived',
        originalPath: alreadyArchived.localPath,
        originalName: alreadyArchived.fileName,
        extension: '.jpg',
        size: alreadyArchived.inspection.size,
        width: 12,
        height: 9,
        modifiedAt: '2026-07-18T03:00:00.000Z',
        capturedAt: '2026-07-18T02:00:00.000Z',
        selected: false,
        sortStatus: 'archived',
        archiveInfo: null,
        previewInfo: null,
        archiveResult: { success: true },
        originalMissing: false,
        sourceType: 'marki_api',
        sourceKey: alreadyArchived.sourceKey,
        sourceMetadataRef: buildMarkiSourceMetadataRef('6107', 'already-archived')
      }
    ]
  };
  await fs.writeFile(initialWorkspace.photos[0].originalPath, createTestJpeg(1, 1));
  check((await saveSortWorkspaceSnapshot(userDataPath, initialWorkspace)).success, '应建立含本地照片的初始自动快照');
  scenario();

  const legacyPackage = buildMarkiStructuredImportBundle({
    orgId: legacy.orgId,
    configs,
    items: [{
      moment: {
        id: legacy.momentId,
        uid: '21',
        teamId: '11',
        momentType: 1,
        content: JSON.stringify([
          ['日期', '2026-07-18'],
          ['小区名称', '测试小区'],
          ['工作内容', '设施巡查']
        ]),
        markName: '工程类专用',
        postTime: 1784340000
      },
      sourceMetadataRef: buildMarkiSourceMetadataRef(legacy.orgId, legacy.momentId),
      download: {
        sourceKey: legacy.sourceKey,
        importStatus: 'imported',
        localPath: legacy.localPath,
        fileName: legacy.fileName,
        ...legacy.inspection,
        completedAt: '2026-07-18T03:00:00.000Z'
      }
    }]
  }, { batchId: 'legacy-consumed-batch' }).workbenchImportPackage;
  const legacyDeduplication = {
    inputCount: 1,
    uniqueCount: 1,
    duplicateCount: 0,
    skippedItems: []
  };
  await beginMarkiImportBatch(userDataPath, {
    batchId: 'legacy-consumed-batch',
    inputCount: 1,
    deduplication: legacyDeduplication
  });
  await markMarkiImportBatchReady(userDataPath, {
    success: true,
    batchId: 'legacy-consumed-batch',
    inputCount: 1,
    metadataSavedCount: 1,
    failedCount: 0,
    failures: [],
    deduplication: legacyDeduplication,
    workbenchImportPackage: legacyPackage
  });
  await consumeMarkiImportBatch(userDataPath, 'legacy-consumed-batch');
  const consumedLegacy = await getMarkiImportBatch(userDataPath, 'legacy-consumed-batch');
  check(consumedLegacy.status === 'consumed' && consumedLegacy.workbenchImportPackage === null, '历史批次应已 consumed 且不再保留工作台包');
  scenario();

  const historyOnlyUserDataPath = path.join(root, 'history-only-user-data');
  const historyOnlyBatchId = 'history-only-consumed-batch';
  const historyOnlyPackage = {
    ...legacyPackage,
    batchId: historyOnlyBatchId
  };
  await beginMarkiImportBatch(historyOnlyUserDataPath, {
    batchId: historyOnlyBatchId,
    inputCount: 1,
    deduplication: legacyDeduplication
  });
  await markMarkiImportBatchReady(historyOnlyUserDataPath, {
    success: true,
    batchId: historyOnlyBatchId,
    inputCount: 1,
    metadataSavedCount: 1,
    failedCount: 0,
    failures: [],
    deduplication: legacyDeduplication,
    workbenchImportPackage: historyOnlyPackage
  });
  await consumeMarkiImportBatch(historyOnlyUserDataPath, historyOnlyBatchId);
  check(
    (await loadSortWorkspaceSnapshot(historyOnlyUserDataPath)).found === false,
    '修复前历史场景不得预先存在自动工作台快照'
  );
  const historyOnlyService = createMarkiWorkbenchRehydrateService({
    loadConfigs: async () => configs
  });
  const historyOnlyScan = await historyOnlyService.scanMarkiWorkbenchRecoveryCandidates({
    documentsPath,
    userDataPath: historyOnlyUserDataPath
  });
  const historyOnlyCandidate = historyOnlyScan.items.find((item) => item.status === 'recoverable');
  const historyOnlyRecovery = await historyOnlyService.recoverMarkiWorkbenchCandidates({
    documentsPath,
    userDataPath: historyOnlyUserDataPath,
    recoveryTokens: [historyOnlyCandidate.recoveryToken]
  });
  const historyOnlySnapshot = await loadSortWorkspaceSnapshot(historyOnlyUserDataPath);
  check(
    historyOnlyRecovery.success
      && historyOnlySnapshot.found
      && historyOnlySnapshot.snapshot.workspace.photos.length === 1,
    'consumed 包为空且没有旧快照时应仅依赖 manifest、JPG 和来源元数据恢复'
  );
  scenario();

  const sourceAwareModuleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'sourceAwareRecognition.js')
  ).href;
  const { orchestrateSourceAwareRecognition: orchestrateRecoveredMarki } = await import(
    `${sourceAwareModuleUrl}?rehydrated-marki=${Date.now()}`
  );
  const recoveredWorkspace = historyOnlySnapshot.snapshot.workspace;
  const recoveredPhoto = recoveredWorkspace.photos[0];
  const recoveredPlatformArtifacts = {
    recognitionResult: recoveredWorkspace.recognitionResultsByPhoto[recoveredPhoto.id],
    watermarkRecord: recoveredWorkspace.watermarkRecordsByPhoto[recoveredPhoto.id],
    archiveSuggestion: recoveredWorkspace.archiveSuggestionsByPhoto[recoveredPhoto.id]
  };
  let recoveredOcrCalls = 0;
  let recoveredStatusChecks = 0;
  let recoveredGroupCalls = 0;
  const runRecoveredMarki = (state) => orchestrateRecoveredMarki({
    photos: state.photos,
    recognitionResultsByPhoto: state.recognitionResultsByPhoto,
    watermarkRecordsByPhoto: state.watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto: state.archiveSuggestionsByPhoto,
    getOcrAvailability: async () => {
      recoveredStatusChecks += 1;
      return { available: false };
    },
    recognizePhoto: async () => {
      recoveredOcrCalls += 1;
      throw new Error('历史恢复的完整 Marki 不得执行 OCR');
    },
    buildOcrArtifacts: () => {
      throw new Error('历史恢复的完整 Marki 不得重新解析');
    },
    generateGroups: async ({ photos }) => {
      recoveredGroupCalls += 1;
      return { status: 'created', groupCount: 1, photoCount: photos.length };
    }
  });
  const firstRecoveredSmartSort = await runRecoveredMarki(recoveredWorkspace);
  const secondRecoveredSmartSort = await runRecoveredMarki(firstRecoveredSmartSort);
  check(recoveredOcrCalls === 0, '历史恢复完整 Marki 连续两次智拣 OCR 调用必须为零');
  check(recoveredStatusChecks === 0, '历史恢复完整 Marki 连续两次智拣不得检查 OCR 服务');
  check(recoveredGroupCalls === 2, '历史恢复完整 Marki 每次智拣各统一分组一次');
  check(
    JSON.stringify(secondRecoveredSmartSort.recognitionResultsByPhoto[recoveredPhoto.id])
      === JSON.stringify(recoveredPlatformArtifacts.recognitionResult),
    '历史恢复完整 Marki 重复智拣不得改写平台 recognition'
  );
  check(
    JSON.stringify(secondRecoveredSmartSort.watermarkRecordsByPhoto[recoveredPhoto.id])
      === JSON.stringify(recoveredPlatformArtifacts.watermarkRecord),
    '历史恢复完整 Marki 重复智拣不得改写平台 watermark'
  );
  check(
    JSON.stringify(secondRecoveredSmartSort.archiveSuggestionsByPhoto[recoveredPhoto.id])
      === JSON.stringify(recoveredPlatformArtifacts.archiveSuggestion),
    '历史恢复完整 Marki 重复智拣不得改写平台 suggestion'
  );
  scenario();

  const service = createMarkiWorkbenchRehydrateService({
    loadConfigs: async () => configs
  });
  const scanResult = await service.scanMarkiWorkbenchRecoveryCandidates({
    documentsPath,
    userDataPath
  });
  check(scanResult.success, '历史 Marki 来源扫描应成功');
  check(scanResult.counts.recoverable === 2, '应识别两张可恢复历史照片');
  check(scanResult.counts.already_in_workbench === 1, '应识别已在工作台的照片');
  check(scanResult.counts.already_archived === 1, '应识别工作台中已归档的照片');
  check(scanResult.counts.missing_file === 1, '应识别原图缺失');
  check(scanResult.counts.corrupted_file === 1, '应识别文件校验异常');
  check(scanResult.counts.missing_metadata === 1, '应识别来源元数据缺失');
  check(scanResult.counts.invalid_record === 1, '损坏记录应逐条隔离');
  scenario();

  check(
    scanResult.items.some((item) => item.status === 'already_in_workbench')
      && scanResult.items.some((item) => item.status === 'already_archived'),
    '当前快照中的历史来源应分别识别为已在工作台或已归档'
  );
  scenario();

  const legacyCandidate = scanResult.items.find((item) => item.status === 'recoverable');
  check(Boolean(legacyCandidate), '扫描应返回可恢复候选');
  check(
    Object.keys(legacyCandidate).sort().join('|') === [...SAFE_SUMMARY_FIELDS].sort().join('|'),
    'renderer 候选摘要必须严格只有六个安全字段'
  );
  scenario();

  const serializedSummary = JSON.stringify(scanResult);
  for (const secret of [
    'marki_api:',
    'marki_source_metadata:',
    'sourceKey',
    'momentId',
    'originalPath',
    'localPath',
    'antiCounterfeitCode',
    'parsedEntries',
    'content',
    legacy.localPath
  ]) {
    check(!serializedSummary.includes(secret), `恢复摘要不得包含 ${secret}`);
  }
  scenario();

  check(
    /^[a-f0-9-]{20,100}$/i.test(legacyCandidate.recoveryToken),
    '恢复候选必须使用不透明随机令牌'
  );
  check(!legacyCandidate.recoveryToken.includes(legacy.momentId), '恢复令牌不得编码 momentId');
  scenario();

  const manifestBefore = await fs.readFile(
    getMarkiSourceManifestPath(documentsPath, legacy.orgId)
  );
  const metadataBefore = await fs.readFile(
    getMarkiSourceMetadataPath(documentsPath, legacy.orgId, legacy.momentId)
  );
  const jpegBefore = await fs.readFile(legacy.localPath);
  const recoveryResult = await service.recoverMarkiWorkbenchCandidates({
    documentsPath,
    userDataPath,
    recoveryTokens: [legacyCandidate.recoveryToken]
  });
  check(recoveryResult.success && recoveryResult.status === 'recovered', '可恢复候选应成功写入工作台快照');
  check(recoveryResult.recoveredCount === 1, '应恢复一张历史 Marki 照片');
  scenario();

  const recoveredSnapshot = await loadSortWorkspaceSnapshot(userDataPath);
  check(recoveredSnapshot.success && recoveredSnapshot.found, '恢复后自动快照应可重新加载');
  check(recoveredSnapshot.snapshot.workspace.photos.length === 4, '恢复后应保留三张旧照片并新增一张');
  check(recoveredSnapshot.snapshot.workspace.photos[0].id === 'local-existing', '本地 OCR 照片对象和顺序必须保持');
  scenario();

  const restoredMarkiPhoto = recoveredSnapshot.snapshot.workspace.photos.find(
    (photo) => photo.sourceKey === legacy.sourceKey
  );
  check(Boolean(restoredMarkiPhoto), '自动快照应包含恢复的 Marki 照片');
  check(
    Object.hasOwn(recoveredSnapshot.snapshot.workspace.recognitionResultsByPhoto, restoredMarkiPhoto.id),
    '恢复照片必须带 recognition 结果'
  );
  check(
    Object.hasOwn(recoveredSnapshot.snapshot.workspace.watermarkRecordsByPhoto, restoredMarkiPhoto.id),
    '恢复照片必须带 watermark 记录'
  );
  check(
    Object.hasOwn(recoveredSnapshot.snapshot.workspace.archiveSuggestionsByPhoto, restoredMarkiPhoto.id),
    '恢复照片必须带 archive suggestion'
  );
  scenario();

  check(
    (await fs.readFile(getMarkiSourceManifestPath(documentsPath, legacy.orgId))).equals(manifestBefore),
    '恢复不得修改来源清单'
  );
  check(
    (await fs.readFile(getMarkiSourceMetadataPath(documentsPath, legacy.orgId, legacy.momentId))).equals(metadataBefore),
    '恢复不得修改来源元数据'
  );
  check((await fs.readFile(legacy.localPath)).equals(jpegBefore), '恢复不得修改来源 JPG');
  scenario();

  const batchAfterRecovery = await getMarkiImportBatch(userDataPath, 'legacy-consumed-batch');
  check(
    batchAfterRecovery.status === 'consumed' && batchAfterRecovery.workbenchImportPackage === null,
    '恢复不得重建或修改历史 consumed 批次'
  );
  scenario();

  const freshProcessSnapshot = await loadSortWorkspaceSnapshot(userDataPath);
  check(
    freshProcessSnapshot.snapshot.workspace.photos.some((photo) => photo.sourceKey === legacy.sourceKey),
    '模拟重启后仍应从自动快照恢复历史照片'
  );
  scenario();

  const rescan = await service.scanMarkiWorkbenchRecoveryCandidates({
    documentsPath,
    userDataPath
  });
  check(
    rescan.items.some((item) => item.status === 'already_in_workbench'),
    '再次扫描应把已恢复照片识别为已在工作台'
  );
  scenario();

  const repeated = await service.recoverMarkiWorkbenchCandidates({
    documentsPath,
    userDataPath,
    recoveryTokens: [legacyCandidate.recoveryToken]
  });
  check(repeated.success === false, '已失效的旧恢复令牌不得再次恢复');
  check(
    (await loadSortWorkspaceSnapshot(userDataPath)).snapshot.workspace.photos.length === 4,
    '重复恢复不得生成重复照片'
  );
  scenario();

  check(
    scanResult.items.some((item) => item.status === 'missing_file'),
    '原图不存在时应标记 missing_file'
  );
  scenario();

  check(
    scanResult.items.some((item) => item.status === 'corrupted_file'),
    'JPG 大小或 SHA-256 不一致时应标记 corrupted_file'
  );
  scenario();

  check(
    scanResult.items.some((item) => item.status === 'missing_metadata'),
    '来源元数据不存在时应标记 missing_metadata'
  );
  scenario();

  const tolerantManifest = await loadMarkiSourceManifestForRecovery(documentsPath, '6105');
  check(tolerantManifest.records.length === 1, '同一清单的合法记录应继续返回');
  check(tolerantManifest.invalidRecords.length === 1, '路径逃逸记录应被逐条隔离');
  scenario();

  check(
    scanResult.items.some((item) => item.projectName === '测试小区' && item.status === 'recoverable'),
    '损坏记录不得阻断同清单其他可恢复记录'
  );
  scenario();

  const unavailableSnapshotService = createMarkiWorkbenchRehydrateService({
    loadSnapshot: async () => ({
      success: false,
      found: true,
      snapshot: null
    })
  });
  const unavailableScan = await unavailableSnapshotService.scanMarkiWorkbenchRecoveryCandidates({
    documentsPath,
    userDataPath
  });
  check(
    unavailableScan.success === false
      && unavailableScan.error.code === 'marki_recovery_snapshot_unavailable',
    '当前快照不可读取时必须停止候选扫描'
  );
  scenario();

  const raceFixture = await createImportedFixture({
    orgId: '6108',
    momentId: 'race-photo',
    projectName: '竞态测试项目'
  });
  const raceService = createMarkiWorkbenchRehydrateService({
    loadConfigs: async () => configs
  });
  const raceScan = await raceService.scanMarkiWorkbenchRecoveryCandidates({
    documentsPath,
    userDataPath
  });
  const raceCandidate = raceScan.items.find((item) => (
    item.status === 'recoverable' && item.projectName === '竞态测试项目'
  ));
  const workspaceBeforeRace = (await loadSortWorkspaceSnapshot(userDataPath)).snapshot.workspace;
  const racePhoto = {
    ...restoredMarkiPhoto,
    id: 'race-existing',
    sourceKey: raceFixture.sourceKey,
    sourceMetadataRef: buildMarkiSourceMetadataRef(raceFixture.orgId, raceFixture.momentId)
  };
  await saveSortWorkspaceSnapshot(userDataPath, {
    ...workspaceBeforeRace,
    photos: [...workspaceBeforeRace.photos, racePhoto]
  });
  const raceResult = await raceService.recoverMarkiWorkbenchCandidates({
    documentsPath,
    userDataPath,
    recoveryTokens: [raceCandidate.recoveryToken]
  });
  check(raceResult.success && raceResult.status === 'nothing_to_recover', '恢复前再次发现相同 sourceKey 时应安全跳过');
  check(
    (await loadSortWorkspaceSnapshot(userDataPath)).snapshot.workspace.photos
      .filter((photo) => photo.sourceKey === raceFixture.sourceKey).length === 1,
    '扫描后竞态不得重复追加 sourceKey'
  );
  scenario();

  const saveFailureFixture = await createImportedFixture({
    orgId: '6109',
    momentId: 'snapshot-failure',
    projectName: '快照失败项目'
  });
  const stableSnapshotBeforeFailure = await fs.readFile(getSortWorkspaceSnapshotPath(userDataPath));
  const manifestBeforeSaveFailure = await fs.readFile(
    getMarkiSourceManifestPath(documentsPath, saveFailureFixture.orgId)
  );
  const saveFailureService = createMarkiWorkbenchRehydrateService({
    loadConfigs: async () => configs,
    saveSnapshot: async () => ({
      success: false,
      error: {
        code: 'sort_workspace_snapshot_save_failed',
        message: '测试注入失败'
      }
    })
  });
  const saveFailureScan = await saveFailureService.scanMarkiWorkbenchRecoveryCandidates({
    documentsPath,
    userDataPath
  });
  const saveFailureCandidate = saveFailureScan.items.find((item) => (
    item.status === 'recoverable' && item.projectName === '快照失败项目'
  ));
  const saveFailureResult = await saveFailureService.recoverMarkiWorkbenchCandidates({
    documentsPath,
    userDataPath,
    recoveryTokens: [saveFailureCandidate.recoveryToken]
  });
  check(
    saveFailureResult.success === false
      && saveFailureResult.error.code === 'marki_recovery_snapshot_save_failed',
    '自动快照保存失败时恢复必须整体失败'
  );
  check(
    (await fs.readFile(getSortWorkspaceSnapshotPath(userDataPath))).equals(stableSnapshotBeforeFailure),
    '快照保存失败不得改变原工作台快照'
  );
  check(
    (await fs.readFile(getMarkiSourceManifestPath(documentsPath, saveFailureFixture.orgId))).equals(manifestBeforeSaveFailure),
    '快照保存失败不得修改来源状态'
  );
  scenario();

  const invalidInput = await service.recoverMarkiWorkbenchCandidates({
    documentsPath,
    userDataPath,
    recoveryTokens: [],
    sourceKey: legacy.sourceKey
  });
  check(invalidInput.success === false, 'renderer 额外提交 sourceKey 时必须拒绝');
  scenario();

  const [
    serviceSource,
    coreSource,
    clientSource,
    mainSource,
    preloadSource,
    pageSource
  ] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'electron/services/markiWorkbenchRehydrateService.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/services/markiWorkbenchImportCore.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/utils/markiWorkbenchImport.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SortWorkspacePage.jsx'), 'utf8')
  ]);
  check(!serviceSource.includes('downloadMarkiPhoto'), '恢复服务不得调用照片下载服务');
  counters.sourceContractCount += 1;
  check(!serviceSource.includes('listMarkiMoments'), '恢复服务不得调用马克查询 API');
  counters.sourceContractCount += 1;
  check(
    clientSource.includes("../../electron/services/markiWorkbenchImportCore.js"),
    'renderer 应转发使用同一份工作台合并核心'
  );
  counters.sourceContractCount += 1;
  check(coreSource.includes('mergeMarkiWorkbenchImportPackage'), '共享合并核心应公开正式合并函数');
  counters.sourceContractCount += 1;
  check(
    /marki:scan-workbench-recovery-candidates[\s\S]*app\.getPath\('documents'\)[\s\S]*app\.getPath\('userData'\)/.test(mainSource),
    '恢复扫描路径必须由主进程注入'
  );
  counters.sourceContractCount += 1;
  check(
    /normalizeMarkiWorkbenchRecoveryRequest[\s\S]*Object\.keys\(input\)\.length !== 1/.test(mainSource),
    '恢复 IPC 必须拒绝 renderer 多余字段'
  );
  counters.sourceContractCount += 1;
  check(
    preloadSource.includes('scanWorkbenchRecoveryCandidates')
      && preloadSource.includes('recoverWorkbenchCandidates'),
    'preload 只应暴露扫描和令牌恢复方法'
  );
  counters.sourceContractCount += 1;
  check(
    pageSource.includes('恢复 Marki 照片')
      && pageSource.includes('recoveryTokens: safeRecoveryTokens'),
    '工作台应提供历史 Marki 照片恢复入口并只提交令牌'
  );
  counters.sourceContractCount += 1;
  check(
    !serviceSource.includes('markMarkiImportBatchReady')
      && !serviceSource.includes('consumeMarkiImportBatch'),
    '历史恢复不得创建或消费导入批次'
  );
  counters.sourceContractCount += 1;
  scenario();

  check(counters.scenarioCount === 27, '历史 Marki 工作台恢复应完整执行 27 个边界场景');
  console.log(
    `历史 Marki 工作台恢复自检通过：${counters.scenarioCount} 个行为场景，${counters.assertionCount} 个断言，其中 ${counters.sourceContractCount} 个源码契约断言。`
  );
}

async function checkSourceAwareRecognition(root) {
  await fs.mkdir(root, { recursive: true });
  const utilityUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'sourceAwareRecognition.js')
  ).href;
  const {
    buildSmartSortGroupMembershipByPhotoId,
    buildSourceAwareSmartSortPresentation,
    classifyPhotoRecognitionRoute,
    classifyPhotoSmartSortStage,
    completeSmartSortExecution,
    getMissingRequiredFields,
    getPhotoSmartSortStatusLabel,
    getSmartSortResultPhotoIds,
    invalidateSmartSortExecution,
    isPhotoPendingOrganize,
    isPhotoPendingSmartSort,
    mergeScopedSmartSortResult,
    mergeMarkiOcrSupplement,
    orchestrateSourceAwareRecognition
  } = await import(`${utilityUrl}?source-aware=${Date.now()}`);
  const workbenchImportUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'markiWorkbenchImport.js')
  ).href;
  const { mergeMarkiWorkbenchImportPackage } = await import(
    `${workbenchImportUrl}?source-aware=${Date.now()}`
  );
  let scenarioCount = 0;
  let assertionCount = 0;
  let sourceContractCount = 0;
  const equal = (actual, expected, message) => {
    assertionCount += 1;
    assert.equal(actual, expected, message);
  };
  const deepEqual = (actual, expected, message) => {
    assertionCount += 1;
    assert.deepEqual(actual, expected, message);
  };
  const check = (condition, message) => {
    assertionCount += 1;
    assert.ok(condition, message);
  };
  const requiredValues = {
    date: '2026-07-19',
    project: '测试小区',
    watermarkCategory: '巡查检查类',
    workContent: '设施巡查'
  };
  const makePhoto = (id, sourceType = 'marki_api', overrides = {}) => ({
    id,
    originalPath: path.join(root, `${id}.jpg`),
    originalName: `${id}.jpg`,
    size: 4,
    modifiedAt: '2026-07-19T02:00:00.000Z',
    sortStatus: 'needs_completion',
    sourceType,
    ...(sourceType === 'marki_api'
      ? {
          sourceKey: `marki_api:12345:${id}`,
          sourceMetadataRef: `marki_source_metadata:12345:${id}`
        }
      : {}),
    ...overrides
  });
  const makeMarkiArtifacts = (photoId, fields = requiredValues) => ({
    recognitionResult: {
      photoId,
      source: 'marki_api',
      providerId: 'marki_api',
      providerType: 'structured_data',
      status: 'recognized',
      success: true,
      rawText: '',
      parsedWatermark: {
        date: fields.date || null,
        projectName: fields.project || null,
        watermarkCategory: fields.watermarkCategory || null,
        workContent: fields.workContent || null
      }
    },
    watermarkRecord: {
      photoId,
      source: 'marki_api',
      captureDate: fields.date || '',
      projectText: fields.project || '',
      watermarkCategoryText: fields.watermarkCategory || '',
      workContentText: fields.workContent || '',
      locationText: '设备层',
      rawText: ''
    },
    archiveSuggestion: {
      photoId,
      source: 'marki_api',
      suggestedFields: {
        date: fields.date || '',
        project: fields.project || '',
        watermarkCategory: fields.watermarkCategory || '',
        workContent: fields.workContent || '',
        location: '设备层'
      },
      fieldSources: {
        date: 'marki.date',
        project: 'marki.project',
        watermarkCategory: 'marki.markName',
        workContent: 'marki.workContent'
      },
      confidenceByField: {
        date: 1,
        project: 1,
        watermarkCategory: 1,
        workContent: 1
      },
      missingRequiredFields: Object.entries({
        日期: fields.date,
        项目: fields.project,
        归档分类: fields.watermarkCategory,
        工作内容: fields.workContent
      }).filter(([, value]) => !value).map(([label]) => label),
      conflictFields: [],
      candidateFields: {},
      needsHumanReview: Object.values(fields).some((value) => !value),
      status: Object.values(fields).some((value) => !value) ? 'needs_completion' : 'suggestion_ready'
    }
  });
  const makeOcrArtifacts = (photoId, fields = requiredValues, status = 'success') => ({
    recognitionResult: {
      photoId,
      status,
      success: status === 'success',
      rawText: status === 'success' ? '本地 OCR 测试文本' : '',
      stagedResultId: `stage-${photoId}`,
      parsedWatermark: {
        date: fields.date || null,
        projectName: fields.project || null,
        watermarkCategory: fields.watermarkCategory || null,
        workContent: fields.workContent || null
      }
    },
    watermarkRecord: {
      photoId,
      captureDate: fields.date || '',
      projectText: fields.project || '',
      watermarkCategoryText: fields.watermarkCategory || '',
      workContentText: fields.workContent || '',
      locationText: 'OCR 地点',
      rawText: status === 'success' ? '本地 OCR 测试文本' : ''
    },
    archiveSuggestion: {
      photoId,
      suggestedFields: {
        date: fields.date || '',
        project: fields.project || '',
        watermarkCategory: fields.watermarkCategory || '',
        workContent: fields.workContent || ''
      },
      fieldSources: {},
      confidenceByField: {},
      missingRequiredFields: [],
      conflictFields: [],
      candidateFields: {},
      needsHumanReview: false,
      status: 'suggestion_ready'
    }
  });
  const makeMaps = (photoId, artifacts) => ({
    recognitionResultsByPhoto: { [photoId]: artifacts.recognitionResult },
    watermarkRecordsByPhoto: { [photoId]: artifacts.watermarkRecord },
    archiveSuggestionsByPhoto: { [photoId]: artifacts.archiveSuggestion }
  });
  const run = ({
    photos,
    maps = {
      recognitionResultsByPhoto: {},
      watermarkRecordsByPhoto: {},
      archiveSuggestionsByPhoto: {}
    },
    ocrAvailable = true,
    recognize = async (photo) => makeOcrArtifacts(photo.id).recognitionResult,
    build = ({ photo, recognitionResult }) => makeOcrArtifacts(
      photo.id,
      recognitionResult.testFields || requiredValues,
      recognitionResult.status
    ),
    generateGroups = async ({ photos: groupPhotos }) => ({
      status: 'created',
      groupCount: 1,
      photoCount: groupPhotos.length,
      groups: [{ id: 'group-1', photoIds: groupPhotos.map((photo) => photo.id) }]
    })
  }) => orchestrateSourceAwareRecognition({
    photos,
    ...maps,
    getOcrAvailability: async () => ({
      available: ocrAvailable,
      reason: ocrAvailable ? '' : '测试 OCR 不可用'
    }),
    recognizePhoto: recognize,
    buildOcrArtifacts: build,
    getPhotoSortStatus: (_result, suggestion) => suggestion?.status || 'needs_completion',
    generateGroups
  });
  const makeCompletePool = (count, prefix = 'scope') => {
    const photos = Array.from({ length: count }, (_, index) => makePhoto(
      `${prefix}-${index + 1}`,
      'marki_api',
      {
        smartSortStatus: 'not_run',
        sortStatus: 'suggestion_ready'
      }
    ));
    const recognitionResultsByPhoto = {};
    const watermarkRecordsByPhoto = {};
    const archiveSuggestionsByPhoto = {};
    for (const photo of photos) {
      const artifacts = makeMarkiArtifacts(photo.id);
      recognitionResultsByPhoto[photo.id] = artifacts.recognitionResult;
      watermarkRecordsByPhoto[photo.id] = artifacts.watermarkRecord;
      archiveSuggestionsByPhoto[photo.id] = artifacts.archiveSuggestion;
    }
    return {
      photos,
      maps: {
        recognitionResultsByPhoto,
        watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto
      }
    };
  };
  const getStageIds = (photos, membershipByPhotoId, expectedStage) => photos
    .filter((photo) => (
      classifyPhotoSmartSortStage(photo, membershipByPhotoId.has(photo.id))
      === expectedStage
    ))
    .map((photo) => photo.id);

  {
    const productionRoot = path.join(root, 'production-import-shape');
    const productionPhotoPath = path.join(productionRoot, 'moment-repeat-smart-sort.jpg');
    const productionJpeg = createTestJpeg(12, 9);
    await fs.mkdir(productionRoot, { recursive: true });
    await fs.writeFile(productionPhotoPath, productionJpeg);
    const productionConfigs = {
      projects: [{ name: '测试小区', aliases: ['测试项目别名'] }],
      watermarkCategories: {
        工程类专用: { items: ['设施巡查'] }
      }
    };
    const productionMoment = {
      id: 'moment-repeat-smart-sort',
      uid: 21,
      teamId: 11,
      momentType: 1,
      markName: '工程类专用',
      content: JSON.stringify([
        ['日期', '2026-07-19 08:30:00'],
        ['小区名称', '测试小区'],
        ['工作内容', '设施巡查'],
        ['上传人', '测试人员'],
        ['地点', '一号楼']
      ]),
      postTime: Math.floor(Date.parse('2026-07-19T01:00:00Z') / 1000)
    };
    const productionSourceKey = buildMarkiSourceKey('7201', productionMoment.id);
    const productionBundle = buildMarkiStructuredImportBundle({
      orgId: '7201',
      configs: productionConfigs,
      items: [{
        moment: productionMoment,
        download: {
          success: true,
          sourceKey: productionSourceKey,
          importStatus: 'imported',
          localPath: productionPhotoPath,
          fileName: path.basename(productionPhotoPath),
          size: productionJpeg.length,
          width: 12,
          height: 9,
          sha256: createHash('sha256').update(productionJpeg).digest('hex'),
          completedAt: '2026-07-19T01:01:00.000Z'
        }
      }]
    }, {
      batchId: 'source-aware-production-batch',
      now: () => new Date('2026-07-19T01:02:00.000Z')
    });
    const productionPackage = productionBundle.workbenchImportPackage;
    const productionPhoto = productionPackage.photos[0];
    const productionRecognition = productionPackage.recognitionResultsByPhoto[productionPhoto.id];
    const productionWatermark = productionPackage.watermarkRecordsByPhoto[productionPhoto.id];
    const productionSuggestion = productionPackage.archiveSuggestionsByPhoto[productionPhoto.id];
    equal(productionPhoto.sourceType, 'marki_api', '真实导入照片应保留 Marki 来源');
    equal(productionRecognition.source, 'marki_api', '真实导入 recognition 来源应为 Marki');
    equal(productionRecognition.providerType, 'structured_data', '真实导入 recognition 应保留结构化标志');
    equal(productionRecognition.missingRequiredFields, undefined, '真实 recognition 不承载 suggestion 的缺失字段');
    equal(productionWatermark.captureDate, '2026-07-19', '真实水印记录日期键应为 captureDate');
    equal(productionWatermark.projectText, '测试小区', '真实水印记录项目键应为 projectText');
    equal(productionWatermark.watermarkCategoryText, '工程类专用', '真实水印记录分类键应为 watermarkCategoryText');
    equal(productionWatermark.workContentText, '设施巡查', '真实水印记录工作内容键应为 workContentText');
    deepEqual(productionSuggestion.missingRequiredFields, [], '真实完整建议四项必要字段应无缺失');
    equal(Object.hasOwn(productionRecognition, 'sourceAwareProcessing'), false, '导入阶段不得自动标记已完成智拣');

    const mergedWorkspace = mergeMarkiWorkbenchImportPackage({
      photos: [],
      recognitionResultsByPhoto: {},
      watermarkRecordsByPhoto: {},
      archiveSuggestionsByPhoto: {},
      selectedIds: [],
      activePhotoId: ''
    }, productionPackage);
    const importedPhotos = invalidateSmartSortExecution(mergedWorkspace.photos);
    const productionSnapshotRoot = path.join(productionRoot, 'snapshot');
    const productionWorkspace = {
      ...createEmptyWorkspace(),
      photos: importedPhotos,
      selectedIds: mergedWorkspace.selectedIds,
      activePhotoId: mergedWorkspace.activePhotoId,
      recognitionResultsByPhoto: mergedWorkspace.recognitionResultsByPhoto,
      watermarkRecordsByPhoto: mergedWorkspace.watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto: mergedWorkspace.archiveSuggestionsByPhoto,
      smartSortResult: null
    };
    equal(productionWorkspace.photos[0].smartSortStatus, 'not_run', '真实 Marki 导入后智拣状态必须为 not_run');
    equal(
      getPhotoSmartSortStatusLabel(productionWorkspace.photos[0], false),
      '待智拣',
      '真实 Marki 导入后页面状态必须为待智拣'
    );
    equal(productionWorkspace.smartSortResult, null, '导入和合并阶段不得自动生成智拣分组');
    equal((await saveSortWorkspaceSnapshot(productionSnapshotRoot, productionWorkspace)).success, true, '真实导入工作台应可保存自动快照');
    const restoredProduction = await loadSortWorkspaceSnapshot(productionSnapshotRoot, {
      decodeImage: decodeSelfCheckImage
    });
    equal(restoredProduction.success, true, '真实导入工作台快照应可恢复');
    const restoredWorkspace = restoredProduction.snapshot.workspace;
    const platformBeforeSmartSort = {
      recognitionResult: restoredWorkspace.recognitionResultsByPhoto[productionPhoto.id],
      watermarkRecord: restoredWorkspace.watermarkRecordsByPhoto[productionPhoto.id],
      archiveSuggestion: restoredWorkspace.archiveSuggestionsByPhoto[productionPhoto.id]
    };
    let productionOcrCalls = 0;
    let productionStatusChecks = 0;
    let productionGroupCalls = 0;
    const runProductionSmartSort = async (state) => {
      const orchestration = await orchestrateSourceAwareRecognition({
        photos: state.photos,
        recognitionResultsByPhoto: state.recognitionResultsByPhoto,
        watermarkRecordsByPhoto: state.watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: state.archiveSuggestionsByPhoto,
        getOcrAvailability: async () => {
          productionStatusChecks += 1;
          return { available: false };
        },
        recognizePhoto: async () => {
          productionOcrCalls += 1;
          throw new Error('真实完整 Marki 不得进入 OCR');
        },
        buildOcrArtifacts: () => {
          throw new Error('真实完整 Marki 不得重新解析');
        },
        generateGroups: async ({ photos: groupPhotos }) => {
          productionGroupCalls += 1;
          return {
            status: 'created',
            groupCount: 1,
            photoCount: groupPhotos.length,
            groups: [{
              id: `production-group-${productionGroupCalls}`,
              photos: groupPhotos.map((photo) => ({ photoId: photo.id }))
            }]
          };
        }
      });
      return {
        ...state,
        photos: completeSmartSortExecution({
          photos: orchestration.photos,
          targetPhotoIds: state.photos.map((photo) => photo.id),
          processingResults: orchestration.processingResults,
          smartSortResult: orchestration.smartSortResult,
          smartSortError: orchestration.smartSortError
        }),
        recognitionResultsByPhoto: orchestration.recognitionResultsByPhoto,
        watermarkRecordsByPhoto: orchestration.watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: orchestration.archiveSuggestionsByPhoto,
        smartSortResult: orchestration.smartSortResult
      };
    };
    const firstProductionSmartSort = await runProductionSmartSort(restoredWorkspace);
    const firstMemberIds = getSmartSortResultPhotoIds(firstProductionSmartSort.smartSortResult);
    equal(firstProductionSmartSort.photos[0].smartSortStatus, 'completed', '第一次智拣后状态必须为 completed');
    check(firstMemberIds.has(productionPhoto.id), '第一次智拣结果必须包含真实 Marki 照片');
    equal(
      getPhotoSmartSortStatusLabel(firstProductionSmartSort.photos[0], true),
      '待整理',
      '第一次智拣后页面不得继续显示待智拣'
    );
    const firstPresentation = buildSourceAwareSmartSortPresentation({
      smartSortResult: firstProductionSmartSort.smartSortResult,
      currentActivePhotoId: productionPhoto.id
    });
    equal(firstPresentation.hasVisibleGroup, true, '第一次智拣后必须切换到可见分组');

    const resetProductionWorkspace = {
      ...firstProductionSmartSort,
      photos: invalidateSmartSortExecution(firstProductionSmartSort.photos),
      smartSortResult: null,
      smartSortViewMode: 'statusFilter',
      activeSmartSortGroupId: ''
    };
    equal(resetProductionWorkspace.photos[0].smartSortStatus, 'not_run', '重置后智拣状态必须回到 not_run');
    equal(
      getPhotoSmartSortStatusLabel(resetProductionWorkspace.photos[0], false),
      '待智拣',
      '重置后页面必须显示待智拣'
    );
    deepEqual(resetProductionWorkspace.selectedIds, productionWorkspace.selectedIds, '重置后照片选择必须保持');
    equal(resetProductionWorkspace.activePhotoId, productionWorkspace.activePhotoId, '重置后当前照片必须保持');
    deepEqual(resetProductionWorkspace.recognitionResultsByPhoto[productionPhoto.id], platformBeforeSmartSort.recognitionResult, '重置后平台 recognition 必须深比较不变');
    deepEqual(resetProductionWorkspace.watermarkRecordsByPhoto[productionPhoto.id], platformBeforeSmartSort.watermarkRecord, '重置后平台 watermark 必须深比较不变');
    deepEqual(resetProductionWorkspace.archiveSuggestionsByPhoto[productionPhoto.id], platformBeforeSmartSort.archiveSuggestion, '重置后平台 suggestion 必须深比较不变');

    const completedSnapshotRoot = path.join(productionRoot, 'completed-snapshot');
    equal((await saveSortWorkspaceSnapshot(completedSnapshotRoot, firstProductionSmartSort)).success, true, 'completed 智拣状态应可保存');
    const completedRestored = await loadSortWorkspaceSnapshot(completedSnapshotRoot, {
      decodeImage: decodeSelfCheckImage
    });
    equal(completedRestored.snapshot.workspace.photos[0].smartSortStatus, 'completed', '重启后 completed 状态应恢复');
    check(
      getSmartSortResultPhotoIds(completedRestored.snapshot.workspace.smartSortResult).has(productionPhoto.id),
      '重启后智拣分组成员应恢复'
    );

    const resetSnapshotRoot = path.join(productionRoot, 'reset-snapshot');
    equal((await saveSortWorkspaceSnapshot(resetSnapshotRoot, resetProductionWorkspace)).success, true, 'not_run 重置状态应可保存');
    const resetRestored = await loadSortWorkspaceSnapshot(resetSnapshotRoot, {
      decodeImage: decodeSelfCheckImage
    });
    equal(resetRestored.snapshot.workspace.photos[0].smartSortStatus, 'not_run', '重启后 not_run 状态应恢复');
    equal(resetRestored.snapshot.workspace.smartSortResult, null, '重启后旧智拣分组不得恢复');
    deepEqual(resetRestored.snapshot.workspace.recognitionResultsByPhoto[productionPhoto.id], platformBeforeSmartSort.recognitionResult, '重启后平台 recognition 基线应保留');

    const secondProductionSmartSort = await runProductionSmartSort(resetRestored.snapshot.workspace);
    equal(productionOcrCalls, 0, '真实新导入完整 Marki 第一次和第二次智拣 OCR 均为零');
    equal(productionStatusChecks, 0, '真实新导入完整 Marki 重复智拣无需 OCR 服务检查');
    equal(productionGroupCalls, 2, '真实新导入完整 Marki 两次智拣应各分组一次');
    equal(secondProductionSmartSort.photos[0].smartSortStatus, 'completed', '第二次智拣后状态必须再次为 completed');
    check(
      getSmartSortResultPhotoIds(secondProductionSmartSort.smartSortResult).has(productionPhoto.id),
      '第二次智拣必须再次生成真实分组成员'
    );
    deepEqual(
      secondProductionSmartSort.recognitionResultsByPhoto[productionPhoto.id],
      platformBeforeSmartSort.recognitionResult,
      '真实新导入完整 Marki 重复智拣 recognition 必须深比较不变'
    );
    deepEqual(
      secondProductionSmartSort.watermarkRecordsByPhoto[productionPhoto.id],
      platformBeforeSmartSort.watermarkRecord,
      '真实新导入完整 Marki 重复智拣 watermark 必须深比较不变'
    );
    deepEqual(
      secondProductionSmartSort.archiveSuggestionsByPhoto[productionPhoto.id],
      platformBeforeSmartSort.archiveSuggestion,
      '真实新导入完整 Marki 重复智拣 suggestion 必须深比较不变'
    );
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('complete-marki');
    const artifacts = makeMarkiArtifacts(photo.id);
    const maps = makeMaps(photo.id, artifacts);
    deepFreeze(photo);
    deepFreeze(maps);
    let ocrCalls = 0;
    let statusChecks = 0;
    let groupCalls = 0;
    const firstResult = await orchestrateSourceAwareRecognition({
      photos: [photo],
      ...maps,
      getOcrAvailability: async () => {
        statusChecks += 1;
        return { available: false };
      },
      recognizePhoto: async () => {
        ocrCalls += 1;
        throw new Error('完整 Marki 不得进入 OCR');
      },
      buildOcrArtifacts: () => {
        throw new Error('完整 Marki 不得重新解析');
      },
      generateGroups: async ({ photos: groupPhotos }) => {
        groupCalls += 1;
        return { status: 'created', groupCount: 1, photoCount: groupPhotos.length };
      }
    });
    const secondResult = await orchestrateSourceAwareRecognition({
      photos: firstResult.photos,
      recognitionResultsByPhoto: firstResult.recognitionResultsByPhoto,
      watermarkRecordsByPhoto: firstResult.watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto: firstResult.archiveSuggestionsByPhoto,
      getOcrAvailability: async () => {
        statusChecks += 1;
        return { available: false };
      },
      recognizePhoto: async () => {
        ocrCalls += 1;
        throw new Error('重复智拣时完整 Marki 仍不得进入 OCR');
      },
      buildOcrArtifacts: () => {
        throw new Error('重复智拣时完整 Marki 仍不得重新解析');
      },
      generateGroups: async ({ photos: groupPhotos }) => {
        groupCalls += 1;
        return { status: 'created', groupCount: 1, photoCount: groupPhotos.length };
      }
    });
    equal(classifyPhotoRecognitionRoute({ photo, ...artifacts }), 'marki_platform_only', '完整 Marki 应直用平台数据');
    equal(ocrCalls, 0, '完整 Marki 连续两次智拣的 OCR 调用次数必须始终为零');
    equal(statusChecks, 0, '完整 Marki 连续两次智拣均不得检查 OCR 服务');
    equal(groupCalls, 2, '完整 Marki 每次智拣各统一分组一次');
    deepEqual(firstResult.recognitionResultsByPhoto[photo.id], artifacts.recognitionResult, '首次智拣后完整 Marki recognitionResult 必须深比较不变');
    deepEqual(firstResult.watermarkRecordsByPhoto[photo.id], artifacts.watermarkRecord, '首次智拣后完整 Marki watermarkRecord 必须深比较不变');
    deepEqual(firstResult.archiveSuggestionsByPhoto[photo.id], artifacts.archiveSuggestion, '首次智拣后完整 Marki archiveSuggestion 必须深比较不变');
    deepEqual(secondResult.recognitionResultsByPhoto[photo.id], artifacts.recognitionResult, '再次智拣后完整 Marki recognitionResult 必须深比较不变');
    deepEqual(secondResult.watermarkRecordsByPhoto[photo.id], artifacts.watermarkRecord, '再次智拣后完整 Marki watermarkRecord 必须深比较不变');
    deepEqual(secondResult.archiveSuggestionsByPhoto[photo.id], artifacts.archiveSuggestion, '再次智拣后完整 Marki archiveSuggestion 必须深比较不变');
    equal(firstResult.stats.platformOnlyCount, 1, '首次智拣完整 Marki 应计入平台直用统计');
    equal(secondResult.stats.platformOnlyCount, 1, '再次智拣完整 Marki 仍应计入平台直用统计');
    equal(secondResult.stats.existingSupplementCount, 0, '完整平台数据不得误计为 OCR 补充复用');
    equal(photo.sortStatus, 'needs_completion', '来源感知编排不得修改输入照片对象');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('missing-project');
    const platform = makeMarkiArtifacts(photo.id, { ...requiredValues, project: '' });
    const maps = makeMaps(photo.id, platform);
    let ocrCalls = 0;
    const firstResult = await run({
      photos: [photo],
      maps,
      recognize: async () => {
        ocrCalls += 1;
        return { ...makeOcrArtifacts(photo.id).recognitionResult, testFields: requiredValues };
      }
    });
    const secondResult = await run({
      photos: firstResult.photos,
      maps: {
        recognitionResultsByPhoto: firstResult.recognitionResultsByPhoto,
        watermarkRecordsByPhoto: firstResult.watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: firstResult.archiveSuggestionsByPhoto
      },
      recognize: async () => {
        ocrCalls += 1;
        throw new Error('已经补齐的 Marki 不得重复 OCR');
      }
    });
    equal(classifyPhotoRecognitionRoute({ photo, ...platform }), 'marki_ocr_fallback', '缺项目 Marki 应进入 OCR 兜底');
    deepEqual(getMissingRequiredFields(platform), ['project'], '只缺项目时仅返回 project canonical key');
    equal(ocrCalls, 1, '缺项目 Marki 首次补齐后再次智拣不得重复 OCR');
    equal(firstResult.archiveSuggestionsByPhoto[photo.id].suggestedFields.project, requiredValues.project, 'OCR 应补入缺失项目');
    equal(firstResult.archiveSuggestionsByPhoto[photo.id].suggestedFields.date, requiredValues.date, '平台日期必须保留');
    equal(firstResult.archiveSuggestionsByPhoto[photo.id].suggestedFields.watermarkCategory, requiredValues.watermarkCategory, '平台分类必须保留');
    equal(firstResult.archiveSuggestionsByPhoto[photo.id].suggestedFields.workContent, requiredValues.workContent, '平台工作内容必须保留');
    deepEqual(
      firstResult.recognitionResultsByPhoto[photo.id].sourceAwareProcessing.supplementedFields,
      ['project'],
      '补充层只应记录 project'
    );
    deepEqual(firstResult.recognitionResultsByPhoto[photo.id].sourceAwareProcessing.unresolvedFields, [], '项目补齐后不应遗留缺失字段');
    equal(firstResult.recognitionResultsByPhoto[photo.id].sourceAwareProcessing.strategy, 'platform_plus_ocr', 'Marki 兜底策略应明确');
    equal(firstResult.stats.markiOcrFallbackCount, 1, '首次不完整 Marki 应计入 OCR 补充统计');
    equal(secondResult.stats.markiOcrFallbackCount, 0, '再次智拣不得重复计入 OCR 补充');
    equal(secondResult.stats.existingSupplementCount, 1, '再次智拣应复用已有 OCR 补充');
    equal(secondResult.processingResults[0].route, 'marki_existing_supplement', '已补齐 Marki 应进入稳定复用路由');
    deepEqual(
      secondResult.recognitionResultsByPhoto[photo.id].sourceAwareProcessing,
      firstResult.recognitionResultsByPhoto[photo.id].sourceAwareProcessing,
      '复用已有补充时来源分层不得变化'
    );
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('date-conflict');
    const platform = makeMarkiArtifacts(photo.id, {
      ...requiredValues,
      project: '',
      workContent: ''
    });
    const ocrFields = {
      ...requiredValues,
      date: '2026-07-18',
      workContent: ''
    };
    const firstMerged = mergeMarkiOcrSupplement({
      ...platform,
      ocrRecognitionResult: makeOcrArtifacts(photo.id, ocrFields).recognitionResult,
      ocrWatermarkRecord: makeOcrArtifacts(photo.id, ocrFields).watermarkRecord,
      ocrArchiveSuggestion: makeOcrArtifacts(photo.id, ocrFields).archiveSuggestion
    });
    const secondMerged = mergeMarkiOcrSupplement({
      recognitionResult: firstMerged.recognitionResult,
      watermarkRecord: firstMerged.watermarkRecord,
      archiveSuggestion: firstMerged.archiveSuggestion,
      ocrRecognitionResult: makeOcrArtifacts(photo.id, ocrFields).recognitionResult,
      ocrWatermarkRecord: makeOcrArtifacts(photo.id, ocrFields).watermarkRecord,
      ocrArchiveSuggestion: makeOcrArtifacts(photo.id, ocrFields).archiveSuggestion
    });
    equal(secondMerged.archiveSuggestion.suggestedFields.date, requiredValues.date, '重复 OCR 的冲突日期不得覆盖平台日期');
    equal(secondMerged.watermarkRecord.captureDate, requiredValues.date, '重复 OCR 的冲突日期不得覆盖平台水印事实');
    equal(secondMerged.recognitionResult.parsedWatermark.date, requiredValues.date, '重复 OCR 的冲突日期不得覆盖平台识别结构');
    equal(secondMerged.sourceAwareProcessing.conflicts.length, 1, '相同日期冲突重复智拣不得膨胀');
    equal(secondMerged.sourceAwareProcessing.conflicts[0].field, 'date', '冲突字段应使用 canonical key');
    equal(secondMerged.sourceAwareProcessing.conflicts[0].platformValue, requiredValues.date, '冲突应保留平台值');
    equal(secondMerged.sourceAwareProcessing.conflicts[0].ocrValue, ocrFields.date, '冲突应保留 OCR 候选值');
    deepEqual(secondMerged.sourceAwareProcessing.unresolvedFields, ['workContent'], '仍缺工作内容时应允许后续继续兜底');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('still-missing');
    const platform = makeMarkiArtifacts(photo.id, { ...requiredValues, workContent: '' });
    const ocrFields = { ...requiredValues, workContent: '' };
    let ocrCalls = 0;
    const firstResult = await run({
      photos: [photo],
      maps: makeMaps(photo.id, platform),
      recognize: async () => {
        ocrCalls += 1;
        return { ...makeOcrArtifacts(photo.id, ocrFields).recognitionResult, testFields: ocrFields };
      }
    });
    const secondResult = await run({
      photos: firstResult.photos,
      maps: {
        recognitionResultsByPhoto: firstResult.recognitionResultsByPhoto,
        watermarkRecordsByPhoto: firstResult.watermarkRecordsByPhoto,
        archiveSuggestionsByPhoto: firstResult.archiveSuggestionsByPhoto
      },
      recognize: async () => {
        ocrCalls += 1;
        return { ...makeOcrArtifacts(photo.id, ocrFields).recognitionResult, testFields: ocrFields };
      }
    });
    equal(ocrCalls, 2, '仍缺工作内容的 Marki 第二次智拣应允许再次 OCR');
    equal(firstResult.archiveSuggestionsByPhoto[photo.id].suggestedFields.workContent, '', '首次 OCR 无结果时不得伪造工作内容');
    equal(secondResult.archiveSuggestionsByPhoto[photo.id].suggestedFields.workContent, '', '再次 OCR 无结果时仍不得伪造工作内容');
    deepEqual(
      secondResult.recognitionResultsByPhoto[photo.id].sourceAwareProcessing.unresolvedFields,
      ['workContent'],
      '重复 OCR 后仍缺工作内容应保留 canonical 缺失项'
    );
    equal(secondResult.processingResults[0].route, 'marki_ocr_fallback', '仍缺必要字段时重复智拣应继续走 OCR 兜底');
    equal(secondResult.archiveSuggestionsByPhoto[photo.id].status, 'needs_completion', '仍缺必要字段时应待人工补充');
    equal(secondResult.stats.needsManualCount, 1, '仍不完整照片应计入人工完善');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('fallback-throws');
    const platform = makeMarkiArtifacts(photo.id, { ...requiredValues, project: '' });
    const maps = makeMaps(photo.id, platform);
    let groupCalls = 0;
    const result = await run({
      photos: [photo],
      maps,
      recognize: async () => {
        throw new Error('controlled OCR failure');
      },
      generateGroups: async () => {
        groupCalls += 1;
        return { status: 'created', groupCount: 1, photoCount: 1 };
      }
    });
    deepEqual(result.recognitionResultsByPhoto[photo.id], platform.recognitionResult, 'fallback 抛错后平台 recognitionResult 必须不变');
    deepEqual(result.watermarkRecordsByPhoto[photo.id], platform.watermarkRecord, 'fallback 抛错后平台 watermarkRecord 必须不变');
    deepEqual(result.archiveSuggestionsByPhoto[photo.id], platform.archiveSuggestion, 'fallback 抛错后平台 archiveSuggestion 必须不变');
    equal(result.processingResults[0].reason, 'ocr_fallback_failed', 'fallback 失败应隔离为单张安全状态');
    equal(groupCalls, 0, 'fallback 失败照片不得保留或生成失效 membership');
    scenarioCount += 1;
  }

  {
    const localPhoto = makePhoto('mixed-local', 'local_file');
    const completePhoto = makePhoto('mixed-complete');
    const supplementedPhoto = makePhoto('mixed-supplemented');
    const fallbackPhoto = makePhoto('mixed-fallback');
    const complete = makeMarkiArtifacts(completePhoto.id);
    const supplementedPlatform = makeMarkiArtifacts(
      supplementedPhoto.id,
      { ...requiredValues, project: '' }
    );
    const supplemented = mergeMarkiOcrSupplement({
      ...supplementedPlatform,
      ocrRecognitionResult: makeOcrArtifacts(supplementedPhoto.id).recognitionResult,
      ocrWatermarkRecord: makeOcrArtifacts(supplementedPhoto.id).watermarkRecord,
      ocrArchiveSuggestion: makeOcrArtifacts(supplementedPhoto.id).archiveSuggestion
    });
    const fallback = makeMarkiArtifacts(fallbackPhoto.id, { ...requiredValues, workContent: '' });
    const maps = {
      recognitionResultsByPhoto: {
        [completePhoto.id]: complete.recognitionResult,
        [supplementedPhoto.id]: supplemented.recognitionResult,
        [fallbackPhoto.id]: fallback.recognitionResult
      },
      watermarkRecordsByPhoto: {
        [completePhoto.id]: complete.watermarkRecord,
        [supplementedPhoto.id]: supplemented.watermarkRecord,
        [fallbackPhoto.id]: fallback.watermarkRecord
      },
      archiveSuggestionsByPhoto: {
        [completePhoto.id]: complete.archiveSuggestion,
        [supplementedPhoto.id]: supplemented.archiveSuggestion,
        [fallbackPhoto.id]: fallback.archiveSuggestion
      }
    };
    const ocrPhotoIds = [];
    let groupCalls = 0;
    const result = await run({
      photos: [localPhoto, completePhoto, supplementedPhoto, fallbackPhoto],
      maps,
      recognize: async (photo) => {
        ocrPhotoIds.push(photo.id);
        return { ...makeOcrArtifacts(photo.id).recognitionResult, testFields: requiredValues };
      },
      generateGroups: async ({ photos: groupPhotos }) => {
        groupCalls += 1;
        return {
          status: 'created',
          groupCount: 1,
          photoCount: groupPhotos.length,
          groups: [{ id: 'mixed-group', photoIds: groupPhotos.map((photo) => photo.id) }]
        };
      }
    });
    deepEqual(ocrPhotoIds, [localPhoto.id, fallbackPhoto.id], '混合选择仅本地和仍缺字段 Marki 执行 OCR');
    equal(result.stats.ocrCallCount, 2, '混合选择 OCR 总调用次数应为 2');
    equal(groupCalls, 1, '混合选择只应统一分组一次');
    equal(result.smartSortResult.groups[0].photoIds.length, 4, '四种来源路径应进入同一业务分组');
    deepEqual(
      result.photos.map((photo) => photo.sourceType),
      ['local_file', 'marki_api', 'marki_api', 'marki_api'],
      '来源字段必须保持不变'
    );
    deepEqual(result.recognitionResultsByPhoto[completePhoto.id], complete.recognitionResult, '混合选择不得改写完整 Marki');
    equal(result.stats.existingSupplementCount, 1, '混合选择应复用已补齐 Marki');
    equal(result.processingResults.length, 4, '混合选择每张照片都应有独立处理结果');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('local-regression', 'local_file');
    const expected = makeOcrArtifacts(photo.id);
    let groupCalls = 0;
    const result = await run({
      photos: [photo],
      recognize: async () => expected.recognitionResult,
      build: () => expected,
      generateGroups: async () => {
        groupCalls += 1;
        return { status: 'created', groupCount: 1, photoCount: 1 };
      }
    });
    deepEqual(result.recognitionResultsByPhoto[photo.id], expected.recognitionResult, '纯本地 recognition 输出应保持现有产物');
    deepEqual(result.watermarkRecordsByPhoto[photo.id], expected.watermarkRecord, '纯本地 watermark 输出应保持现有产物');
    deepEqual(result.archiveSuggestionsByPhoto[photo.id], expected.archiveSuggestion, '纯本地 suggestion 输出应保持现有产物');
    equal(Object.hasOwn(result.recognitionResultsByPhoto[photo.id], 'sourceAwareProcessing'), false, '本地照片不得生成 Marki 补充层');
    equal(groupCalls, 1, '纯本地成功后仍只分组一次');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('local-unavailable', 'local_file');
    let ocrCalls = 0;
    let groupCalls = 0;
    const result = await run({
      photos: [photo],
      ocrAvailable: false,
      recognize: async () => {
        ocrCalls += 1;
        return makeOcrArtifacts(photo.id).recognitionResult;
      },
      generateGroups: async () => {
        groupCalls += 1;
        return {};
      }
    });
    equal(ocrCalls, 0, 'OCR 服务不可用时纯本地不得调用 OCR');
    equal(groupCalls, 0, 'OCR 服务不可用且无可信平台数据时不得伪造分组');
    deepEqual(result.recognitionResultsByPhoto, {}, 'OCR 服务不可用时纯本地识别映射保持不变');
    equal(result.processingResults[0].reason, 'ocr_unavailable', '纯本地应保留现有 OCR 不可用错误语义');
    scenarioCount += 1;
  }

  {
    const completePhoto = makePhoto('available-split-complete');
    const localPhoto = makePhoto('available-split-local', 'local_file');
    const complete = makeMarkiArtifacts(completePhoto.id);
    let groupCalls = 0;
    const result = await run({
      photos: [completePhoto, localPhoto],
      maps: makeMaps(completePhoto.id, complete),
      ocrAvailable: false,
      generateGroups: async ({ photos: groupPhotos }) => {
        groupCalls += 1;
        return { status: 'created', groupCount: 1, photoCount: groupPhotos.length };
      }
    });
    equal(result.stats.platformOnlyCount, 1, 'OCR 不可用时完整 Marki 仍应完成');
    equal(result.stats.ocrUnavailableCount, 1, '需 OCR 的本地照片应单独报告不可用');
    equal(groupCalls, 1, 'OCR 不可用不得阻断完整 Marki 分组');
    equal(result.smartSortResult.photoCount, 1, '分组只应包含可用平台照片');
    deepEqual(result.recognitionResultsByPhoto[completePhoto.id], complete.recognitionResult, 'OCR 不可用不得清除平台基线');
    scenarioCount += 1;
  }

  {
    const archived = makePhoto('archived-local', 'local_file', { sortStatus: 'archived' });
    const missing = makePhoto('missing-local', 'local_file', { originalMissing: true });
    const ignored = makePhoto('ignored-local', 'local_file', { sortStatus: 'ignored' });
    equal(classifyPhotoRecognitionRoute({ photo: archived, eligible: false }), 'skip', '已归档照片应按现有 eligibility 跳过');
    equal(isPhotoPendingSmartSort(archived), false, '已归档照片不得进入待智拣筛选');
    equal(classifyPhotoRecognitionRoute({ photo: missing, eligible: false }), 'skip', '原图缺失照片应按现有 eligibility 跳过');
    equal(classifyPhotoRecognitionRoute({ photo: ignored, eligible: false }), 'skip', '已忽略照片应按现有 eligibility 跳过');
    equal(classifyPhotoRecognitionRoute({ photo: makePhoto('legacy-local', '') }), 'local_ocr', '旧本地照片缺少 sourceType 时应兼容本地 OCR');
    equal(classifyPhotoRecognitionRoute({ photo: makePhoto('unsupported', 'remote_unknown') }), 'unsupported', '非法来源不得静默当作完整 Marki');
    equal(
      classifyPhotoRecognitionRoute({
        photo: {
          ...makePhoto('missing-source-with-marki-key', ''),
          sourceKey: 'marki_api:12345:missing-source-with-marki-key'
        }
      }),
      'unsupported',
      '缺失来源但带 Marki 身份的照片不得默认走本地 OCR'
    );
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('unmatched-platform-candidate');
    const platform = makeMarkiArtifacts(photo.id, { ...requiredValues, project: '' });
    platform.watermarkRecord.projectText = '未匹配候选小区';
    platform.recognitionResult.parsedWatermark.projectName = null;
    deepEqual(getMissingRequiredFields(platform), ['project'], '未匹配的项目候选文本不得冒充正式项目');
    equal(classifyPhotoRecognitionRoute({ photo, ...platform }), 'marki_ocr_fallback', '未匹配项目仍应进入必要字段兜底');
    scenarioCount += 1;
  }

  {
    const {
      getIgnoredRecognitionStageStatus,
      ignorePhotosInWorkspace,
      restoreIgnoredPhotosInWorkspace
    } = await import(pathToFileURL(path.resolve(process.cwd(), 'src/utils/ignoredPhotoState.js')).href);
    const fixedNow = () => '2026-07-19T08:00:00.000Z';
    const makeGroupResult = (id, groupId, members) => ({
      id,
      status: 'created',
      groupCount: 1,
      photoCount: members.length,
      groups: [{
        id: groupId,
        title: `分组-${groupId}`,
        photoIds: members.map((photo) => photo.id),
        photos: members.map((photo) => ({
          photoId: photo.id,
          filePath: photo.originalPath,
          fileName: photo.originalName,
          modifiedAt: photo.modifiedAt
        })),
        photoCount: members.length
      }]
    });

    const localNotRun = {
      ...makePhoto('ignored-local-not-run', 'local_file'),
      sortStatus: 'unassigned',
      smartSortStatus: 'not_run',
      previewInfo: { status: 'ready' },
      manualDraft: { remark: '保留人工草稿' }
    };
    const localMaps = makeMaps(localNotRun.id, makeOcrArtifacts(localNotRun.id));
    const localMapsBefore = structuredClone(localMaps);
    const ignoredLocal = ignorePhotosInWorkspace({
      photos: [localNotRun],
      targetPhotoIds: [localNotRun.id],
      recognitionStageStatusByPhotoId: { [localNotRun.id]: 'staged' },
      now: fixedNow
    });
    equal(ignoredLocal.photos[0].sortStatus, 'ignored', 'not_run 本地照片应进入 ignored 独立状态');
    equal(ignoredLocal.photos[0].ignoredPreviousState.smartSortStatus, 'not_run', '忽略前 not_run 阶段必须保存');
    deepEqual(localMaps, localMapsBefore, '忽略不得修改本地三个识别 Map');
    deepEqual(ignoredLocal.photos[0].previewInfo, localNotRun.previewInfo, '忽略不得清除本地预览');
    deepEqual(ignoredLocal.photos[0].manualDraft, localNotRun.manualDraft, '忽略不得清除人工草稿');
    const restoredLocal = restoreIgnoredPhotosInWorkspace({
      photos: ignoredLocal.photos,
      targetPhotoIds: [localNotRun.id],
      now: fixedNow
    });
    equal(restoredLocal.photos[0].sortStatus, 'unassigned', '还原后应恢复原 sortStatus');
    equal(restoredLocal.photos[0].smartSortStatus, 'not_run', '还原后应恢复 not_run');
    equal(Boolean(restoredLocal.photos[0].ignoredPreviousState), false, '还原后应清除已消费的忽略前态');
    equal(getIgnoredRecognitionStageStatus(ignoredLocal.photos[0]), 'staged', 'OCR 后台阶段前态应可恢复');
    scenarioCount += 1;

    const completedLocal = {
      ...makePhoto('ignored-local-completed', 'local_file'),
      sortStatus: 'recognized',
      smartSortStatus: 'completed',
      archiveInfo: { project: '示例项目' }
    };
    const completedResult = makeGroupResult('result-local-completed', 'group-local-completed', [completedLocal]);
    const ignoredCompleted = ignorePhotosInWorkspace({
      photos: [completedLocal],
      smartSortResult: completedResult,
      targetPhotoIds: [completedLocal.id],
      now: fixedNow
    });
    equal(ignoredCompleted.smartSortResult.groupCount, 0, '忽略唯一成员后空分组应删除');
    equal(ignoredCompleted.smartSortResult.photoCount, 0, '忽略后有效 membership 计数应重算');
    const restoredCompleted = restoreIgnoredPhotosInWorkspace({
      photos: ignoredCompleted.photos,
      smartSortResult: ignoredCompleted.smartSortResult,
      targetPhotoIds: [completedLocal.id],
      now: fixedNow
    });
    equal(restoredCompleted.photos[0].smartSortStatus, 'completed', '原分组仍有效时应恢复 completed');
    equal(restoredCompleted.membershipRestoredPhotoIds[0], completedLocal.id, '已完成本地照片应恢复原 membership');
    equal(
      buildSmartSortGroupMembershipByPhotoId(restoredCompleted.smartSortResult).get(completedLocal.id),
      'group-local-completed',
      '还原不得重新 OCR 或重新生成整套分组'
    );
    equal(restoredCompleted.photos[0].archiveInfo, completedLocal.archiveInfo, '人工整理信息应保持原引用');
    scenarioCount += 1;

    const markiPhoto = {
      ...makePhoto('ignored-marki-completed'),
      sortStatus: 'recognized',
      smartSortStatus: 'completed',
      sourceType: 'marki_api',
      sourceKey: 'marki_api:org-ignore:moment-ignore',
      sourceMetadataRef: 'marki_source_metadata:org-ignore:moment-ignore'
    };
    const markiArtifacts = makeMarkiArtifacts(markiPhoto.id);
    markiArtifacts.recognitionResult.platformBaseline = {
      recognition: { source: 'marki_api' },
      watermark: { project: '平台项目' },
      suggestion: { status: 'suggestion_ready' }
    };
    const markiBefore = structuredClone(markiArtifacts);
    const ignoredMarki = ignorePhotosInWorkspace({
      photos: [markiPhoto],
      smartSortResult: makeGroupResult('result-marki-completed', 'group-marki-completed', [markiPhoto]),
      targetPhotoIds: [markiPhoto.id],
      now: fixedNow
    });
    const restoredMarki = restoreIgnoredPhotosInWorkspace({
      photos: ignoredMarki.photos,
      smartSortResult: ignoredMarki.smartSortResult,
      targetPhotoIds: [markiPhoto.id],
      now: fixedNow
    });
    deepEqual(markiArtifacts, markiBefore, 'Marki recognition、watermark、suggestion 和平台基线必须深比较不变');
    equal(restoredMarki.photos[0].sourceType, 'marki_api', 'Marki sourceType 必须保留');
    equal(restoredMarki.photos[0].sourceKey, markiPhoto.sourceKey, 'Marki sourceKey 必须保留');
    equal(restoredMarki.photos[0].sourceMetadataRef, markiPhoto.sourceMetadataRef, 'Marki metadata 引用必须保留');
    equal(
      classifyPhotoRecognitionRoute({ photo: restoredMarki.photos[0], ...markiArtifacts }),
      'marki_platform_only',
      '完整 Marki 还原后再次智拣仍应平台直用且 OCR 为 0'
    );
    scenarioCount += 1;

    const stalePhoto = {
      ...makePhoto('ignored-stale-group', 'local_file'),
      sortStatus: 'recognized',
      smartSortStatus: 'needs_completion'
    };
    const ignoredStale = ignorePhotosInWorkspace({
      photos: [stalePhoto],
      smartSortResult: makeGroupResult('result-before-rebuild', 'group-before-rebuild', [stalePhoto]),
      targetPhotoIds: [stalePhoto.id],
      now: fixedNow
    });
    const staleRestored = restoreIgnoredPhotosInWorkspace({
      photos: ignoredStale.photos,
      smartSortResult: {
        ...makeGroupResult('result-after-rebuild', 'group-after-rebuild', []),
        groups: [],
        groupCount: 0,
        photoCount: 0
      },
      targetPhotoIds: [stalePhoto.id],
      now: fixedNow
    });
    equal(staleRestored.photos[0].smartSortStatus, 'not_run', '旧分组整体失效后应安全回到待智拣');
    equal(staleRestored.photos[0].ignoredMembershipRestoreStatus, 'membership_expired', '过期 membership 必须明确记录');
    equal(staleRestored.membershipRestoredPhotoIds.length, 0, '不得把照片挂回已重建的错误分组');
    equal(staleRestored.smartSortResult.photoCount, 0, '失效还原不得修改当前新分组');
    scenarioCount += 1;

    const poolPhotos = Array.from({ length: 20 }, (_, index) => ({
      ...makePhoto(`ignored-pool-${index + 1}`, index % 2 ? 'local_file' : 'marki_api'),
      sortStatus: 'recognized',
      smartSortStatus: 'completed'
    }));
    const poolResult = makeGroupResult('result-pool', 'group-pool', poolPhotos);
    const untouchedBefore = poolPhotos.slice(3);
    const locallyIgnored = ignorePhotosInWorkspace({
      photos: poolPhotos,
      smartSortResult: poolResult,
      targetPhotoIds: poolPhotos.slice(0, 3).map((photo) => photo.id),
      now: fixedNow
    });
    equal(locallyIgnored.ignoredPhotoIds.length, 3, '20 张中只应忽略选中的 3 张');
    equal(buildSmartSortGroupMembershipByPhotoId(locallyIgnored.smartSortResult).size, 17, '未选中 17 张 membership 必须保留');
    locallyIgnored.photos.slice(3).forEach((photo, index) => {
      equal(photo, untouchedBefore[index], '局部忽略不得重建未选中照片对象');
    });
    const partiallyRestored = restoreIgnoredPhotosInWorkspace({
      photos: locallyIgnored.photos,
      smartSortResult: locallyIgnored.smartSortResult,
      targetPhotoIds: poolPhotos.slice(0, 2).map((photo) => photo.id),
      now: fixedNow
    });
    equal(partiallyRestored.restoredPhotoIds.length, 2, '局部还原只应恢复选中的 2 张');
    equal(partiallyRestored.photos.filter((photo) => photo.sortStatus === 'ignored').length, 1, '未选择还原的 1 张必须继续 ignored');
    equal(buildSmartSortGroupMembershipByPhotoId(partiallyRestored.smartSortResult).size, 19, '局部还原后 membership 应为 19');
    scenarioCount += 1;

    const repeatedIgnore = ignorePhotosInWorkspace({
      photos: ignoredCompleted.photos,
      smartSortResult: ignoredCompleted.smartSortResult,
      targetPhotoIds: [completedLocal.id],
      now: () => '2026-07-19T09:00:00.000Z'
    });
    equal(repeatedIgnore.photos[0], ignoredCompleted.photos[0], '重复忽略不得覆盖第一次保存的前态');
    equal(repeatedIgnore.ignoredPhotoIds.length, 0, '重复忽略应幂等跳过');
    const repeatedRestore = restoreIgnoredPhotosInWorkspace({
      photos: restoredCompleted.photos,
      smartSortResult: restoredCompleted.smartSortResult,
      targetPhotoIds: [completedLocal.id],
      now: fixedNow
    });
    equal(repeatedRestore.photos[0], restoredCompleted.photos[0], '重复还原不得再次修改照片');
    equal(repeatedRestore.restoredPhotoIds.length, 0, '重复还原应幂等跳过');
    equal(
      buildSmartSortGroupMembershipByPhotoId(repeatedRestore.smartSortResult).size,
      1,
      '重复还原不得产生重复 membership'
    );
    scenarioCount += 1;

    const archivedPhoto = {
      ...makePhoto('ignored-archived', 'local_file'),
      sortStatus: 'archived',
      archiveResult: { success: true, status: '归档成功' }
    };
    const archivingPhoto = {
      ...makePhoto('ignored-archiving', 'local_file'),
      sortStatus: 'archiving'
    };
    const missingPhoto = {
      ...makePhoto('ignored-missing', 'local_file'),
      originalMissing: true
    };
    const protectedResult = ignorePhotosInWorkspace({
      photos: [archivedPhoto, archivingPhoto, missingPhoto],
      targetPhotoIds: [archivedPhoto.id, archivingPhoto.id, missingPhoto.id],
      now: fixedNow
    });
    equal(protectedResult.ignoredPhotoIds.length, 0, '归档、归档中和原图缺失照片均不得普通忽略');
    deepEqual(protectedResult.photos, [archivedPhoto, archivingPhoto, missingPhoto], '高优先级照片状态不得被忽略破坏');
    scenarioCount += 1;

    const mixedLocal = {
      ...makePhoto('ignored-mixed-local', 'local_file'),
      sortStatus: 'recognized',
      smartSortStatus: 'completed'
    };
    const mixedMarki = {
      ...makePhoto('ignored-mixed-marki'),
      sortStatus: 'recognized',
      smartSortStatus: 'completed',
      sourceType: 'marki_api',
      sourceKey: 'marki_api:org-ignore:mixed'
    };
    const mixedIgnored = ignorePhotosInWorkspace({
      photos: [mixedLocal, mixedMarki],
      smartSortResult: makeGroupResult('result-mixed-ignore', 'group-mixed-ignore', [mixedLocal, mixedMarki]),
      targetPhotoIds: [mixedLocal.id, mixedMarki.id],
      now: fixedNow
    });
    const mixedRestored = restoreIgnoredPhotosInWorkspace({
      photos: mixedIgnored.photos,
      smartSortResult: mixedIgnored.smartSortResult,
      targetPhotoIds: [mixedLocal.id, mixedMarki.id],
      now: fixedNow
    });
    equal(mixedRestored.photos[0].sourceType, 'local_file', '混合还原应保留本地来源');
    equal(mixedRestored.photos[1].sourceType, 'marki_api', '混合还原应保留 Marki 来源');
    equal(buildSmartSortGroupMembershipByPhotoId(mixedRestored.smartSortResult).size, 2, '混合来源应分别恢复原分组成员关系');
    scenarioCount += 1;

    const snapshotRoot = path.join(root, 'ignored-snapshot');
    await fs.writeFile(
      markiPhoto.originalPath,
      createTestJpeg(10, 10)
    );
    const ignoredSnapshotWorkspace = {
      ...createEmptyWorkspace(),
      photos: ignoredMarki.photos,
      selectedIds: [],
      activePhotoId: '',
      recognitionResultsByPhoto: {
        [markiPhoto.id]: markiArtifacts.recognitionResult
      },
      watermarkRecordsByPhoto: {
        [markiPhoto.id]: markiArtifacts.watermarkRecord
      },
      archiveSuggestionsByPhoto: {
        [markiPhoto.id]: markiArtifacts.archiveSuggestion
      },
      smartSortResult: ignoredMarki.smartSortResult
    };
    equal((await saveSortWorkspaceSnapshot(snapshotRoot, ignoredSnapshotWorkspace)).success, true, '忽略状态必须写入自动快照');
    const ignoredSnapshotRestored = await loadSortWorkspaceSnapshot(snapshotRoot, {
      decodeImage: decodeSelfCheckImage
    });
    equal(ignoredSnapshotRestored.success, true, '全新实例应恢复忽略快照');
    const restoredWorkspacePhoto = ignoredSnapshotRestored.snapshot.workspace.photos[0];
    equal(restoredWorkspacePhoto.sortStatus, 'ignored', '重启后照片仍应保持 ignored');
    equal(
      buildSmartSortGroupMembershipByPhotoId(ignoredSnapshotRestored.snapshot.workspace.smartSortResult).size,
      0,
      '重启后 ignored 照片不得重新进入有效 membership'
    );
    deepEqual(
      JSON.parse(JSON.stringify(
        ignoredSnapshotRestored.snapshot.workspace.recognitionResultsByPhoto[markiPhoto.id]
      )),
      JSON.parse(JSON.stringify(markiArtifacts.recognitionResult)),
      '重启后平台 recognition 必须完整'
    );
    const restoredAfterRestart = restoreIgnoredPhotosInWorkspace({
      photos: ignoredSnapshotRestored.snapshot.workspace.photos,
      smartSortResult: ignoredSnapshotRestored.snapshot.workspace.smartSortResult,
      targetPhotoIds: [markiPhoto.id],
      now: fixedNow
    });
    equal(restoredAfterRestart.photos[0].smartSortStatus, 'completed', '重启后仍应按忽略前阶段还原');
    equal(buildSmartSortGroupMembershipByPhotoId(restoredAfterRestart.smartSortResult).size, 1, '重启后还原应恢复有效 membership');
    const secondSnapshotRoot = path.join(root, 'ignored-restored-snapshot');
    const restoredWorkspace = {
      ...ignoredSnapshotRestored.snapshot.workspace,
      photos: restoredAfterRestart.photos,
      smartSortResult: restoredAfterRestart.smartSortResult
    };
    equal((await saveSortWorkspaceSnapshot(secondSnapshotRoot, restoredWorkspace)).success, true, '还原后状态必须再次写入快照');
    const secondRestart = await loadSortWorkspaceSnapshot(secondSnapshotRoot, {
      decodeImage: decodeSelfCheckImage
    });
    equal(secondRestart.snapshot.workspace.photos[0].sortStatus, 'recognized', '再次重启后应保持已还原阶段');
    equal(buildSmartSortGroupMembershipByPhotoId(secondRestart.snapshot.workspace.smartSortResult).size, 1, '再次重启后 membership 应保持');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('auxiliary-fields-missing');
    const platform = makeMarkiArtifacts(photo.id);
    platform.archiveSuggestion.missingRequiredFields = ['位置', '备注'];
    deepEqual(getMissingRequiredFields(platform), [], '位置和备注缺失不得触发 OCR');
    equal(classifyPhotoRecognitionRoute({ photo, ...platform }), 'marki_platform_only', '辅助字段缺失仍应直用完整平台数据');
    scenarioCount += 1;
  }

  {
    const photo = makePhoto('snapshot-fallback');
    await fs.writeFile(photo.originalPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const platform = makeMarkiArtifacts(photo.id, { ...requiredValues, project: '' });
    const result = await run({
      photos: [photo],
      maps: makeMaps(photo.id, platform),
      recognize: async () => ({
        ...makeOcrArtifacts(photo.id).recognitionResult,
        testFields: { ...requiredValues, date: '2026-07-18' }
      })
    });
    const workspace = {
      ...createEmptyWorkspace(),
      photos: result.photos,
      selectedIds: [photo.id],
      activePhotoId: photo.id,
      recognitionResultsByPhoto: result.recognitionResultsByPhoto,
      watermarkRecordsByPhoto: result.watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto: result.archiveSuggestionsByPhoto,
      smartSortResult: result.smartSortResult
    };
    equal(result.stats.conflictCount, 1, '平台与 OCR 字段冲突应计入待核查照片统计');
    equal(result.stats.needsManualCount, 1, '存在字段冲突的照片应计入人工完善统计');
    const snapshotRoot = path.join(root, 'snapshot');
    equal((await saveSortWorkspaceSnapshot(snapshotRoot, workspace)).success, true, '来源感知智拣结果应写入自动快照');
    const restored = await loadSortWorkspaceSnapshot(snapshotRoot);
    equal(restored.success, true, '全新快照读取应成功');
    deepEqual(
      JSON.parse(JSON.stringify(restored.snapshot.workspace.recognitionResultsByPhoto[photo.id].sourceAwareProcessing)),
      JSON.parse(JSON.stringify(result.recognitionResultsByPhoto[photo.id].sourceAwareProcessing)),
      '重启后应恢复 OCR 补充和冲突元数据'
    );
    equal(
      restored.snapshot.workspace.recognitionResultsByPhoto[photo.id].sourceAwareProcessing.conflicts.length,
      1,
      '重启后应保留平台与 OCR 的字段冲突'
    );
    equal(restored.snapshot.workspace.recognitionResultsByPhoto[photo.id].source, 'marki_api', '重启后平台来源标志应保留');
    const snapshotText = await fs.readFile(getSortWorkspaceSnapshotPath(snapshotRoot), 'utf8');
    equal(snapshotText.includes('https://'), false, '来源感知快照不得包含 URL');
    equal(snapshotText.includes('"content"'), false, '来源感知快照不得包含 content');
    equal(snapshotText.includes('"moment"'), false, '来源感知快照不得包含 moment');
    equal(snapshotText.includes('"apiKey"'), false, '来源感知快照不得包含 KEY');
    scenarioCount += 1;
  }

  {
    const photos = Array.from({ length: 5 }, (_, index) => makePhoto(`many-${index + 1}`, 'local_file'));
    let groupCalls = 0;
    await run({
      photos,
      recognize: async (photo) => {
        if (photo.id === 'many-3') throw new Error('controlled single failure');
        return makeOcrArtifacts(photo.id).recognitionResult;
      },
      generateGroups: async () => {
        groupCalls += 1;
        return { status: 'created', groupCount: 1, photoCount: 4 };
      }
    });
    equal(groupCalls, 1, '多张照片和单项失败时最终分组最多执行一次');
    scenarioCount += 1;
  }

  {
    const pool = makeCompletePool(20, 'partial-first');
    const targetPhotos = pool.photos.slice(0, 6);
    const unselectedPhotosBefore = pool.photos.slice(6);
    const unselectedMapValuesBefore = Object.fromEntries(unselectedPhotosBefore.map((photo) => [
      photo.id,
      {
        recognition: pool.maps.recognitionResultsByPhoto[photo.id],
        watermark: pool.maps.watermarkRecordsByPhoto[photo.id],
        suggestion: pool.maps.archiveSuggestionsByPhoto[photo.id],
        sourceType: photo.sourceType,
        sourceKey: photo.sourceKey
      }
    ]));
    let groupedPhotoIds = [];
    const orchestration = await run({
      photos: targetPhotos,
      maps: pool.maps,
      generateGroups: async ({ photos: groupPhotos }) => {
        groupedPhotoIds = groupPhotos.map((photo) => photo.id);
        return {
          status: 'created',
          groupCount: 1,
          photoCount: groupPhotos.length,
          groups: [{ id: 'partial-first-group', photoIds: groupedPhotoIds }]
        };
      }
    });
    const mergedResult = mergeScopedSmartSortResult({
      previousSmartSortResult: null,
      nextSmartSortResult: orchestration.smartSortResult,
      targetPhotoIds: targetPhotos.map((photo) => photo.id)
    });
    const completedPhotos = completeSmartSortExecution({
      photos: pool.photos,
      targetPhotoIds: targetPhotos.map((photo) => photo.id),
      processingResults: orchestration.processingResults,
      smartSortResult: mergedResult
    });
    const membership = buildSmartSortGroupMembershipByPhotoId(mergedResult);
    const pendingSortIds = getStageIds(completedPhotos, membership, 'pending_sort');
    const pendingOrganizeIds = getStageIds(completedPhotos, membership, 'pending_organize');
    deepEqual(groupedPhotoIds, targetPhotos.map((photo) => photo.id), '20 张照片局部智拣时分组输入只能包含选中的 6 张');
    equal(orchestration.processingResults.length, 6, '来源路由只能处理选中的 6 张');
    equal(membership.size, 6, '首次局部智拣最终 membership 必须为 6');
    equal(pendingOrganizeIds.length, 6, '首次局部智拣待整理必须为 6');
    equal(pendingSortIds.length, 14, '首次局部智拣待智拣必须为 14');
    equal(new Set([...pendingSortIds, ...pendingOrganizeIds]).size, 20, '待智拣和待整理并集必须覆盖 20 张照片');
    equal(pendingSortIds.some((photoId) => pendingOrganizeIds.includes(photoId)), false, '待智拣和待整理必须互斥');
    completedPhotos.slice(6).forEach((photo, index) => {
      equal(photo, unselectedPhotosBefore[index], `未选中照片 ${index + 1} 必须保持原对象引用`);
      const before = unselectedMapValuesBefore[photo.id];
      deepEqual(orchestration.recognitionResultsByPhoto[photo.id], before.recognition, '未选中 recognition 必须深比较不变');
      deepEqual(orchestration.watermarkRecordsByPhoto[photo.id], before.watermark, '未选中 watermark 必须深比较不变');
      deepEqual(orchestration.archiveSuggestionsByPhoto[photo.id], before.suggestion, '未选中 suggestion 必须深比较不变');
      equal(photo.sourceType, before.sourceType, '未选中来源类型必须保持');
      equal(photo.sourceKey, before.sourceKey, '未选中来源键必须保持');
    });
    scenarioCount += 1;
  }

  {
    const pool = makeCompletePool(20, 'partial-append');
    const existingPhotos = pool.photos.map((photo, index) => (
      index < 15 ? { ...photo, smartSortStatus: 'completed' } : photo
    ));
    const previousGroup = {
      id: 'existing-fifteen',
      title: '原有待整理分组',
      photoIds: existingPhotos.slice(0, 15).map((photo) => photo.id),
      photoCount: 15
    };
    const previousResult = {
      id: 'existing-result',
      status: 'created',
      groupCount: 1,
      photoCount: 15,
      groups: [previousGroup]
    };
    const targetPhotos = existingPhotos.slice(15, 17);
    const orchestration = await run({ photos: targetPhotos, maps: pool.maps });
    const mergedResult = mergeScopedSmartSortResult({
      previousSmartSortResult: previousResult,
      nextSmartSortResult: orchestration.smartSortResult,
      targetPhotoIds: targetPhotos.map((photo) => photo.id)
    });
    const completedPhotos = completeSmartSortExecution({
      photos: existingPhotos,
      targetPhotoIds: targetPhotos.map((photo) => photo.id),
      processingResults: orchestration.processingResults,
      smartSortResult: mergedResult
    });
    const membership = buildSmartSortGroupMembershipByPhotoId(mergedResult);
    deepEqual(mergedResult.groups[0], previousGroup, '追加两张照片时原 15 张分组必须深比较保持');
    equal(membership.size, 17, '已有 15 张后追加智拣 2 张，最终 membership 必须为 17');
    equal(mergedResult.groupCount, 2, '旧分组和本次新分组应共同保留');
    equal(mergedResult.photoCount, 17, '合并结果照片数量必须重新计算为 17');
    equal(getStageIds(completedPhotos, membership, 'pending_organize').length, 17, '追加后待整理必须为 17');
    equal(getStageIds(completedPhotos, membership, 'pending_sort').length, 3, '追加后待智拣必须为 3');
    scenarioCount += 1;
  }

  {
    const pool = makeCompletePool(20, 'partial-rerun');
    const existingPhotos = pool.photos.map((photo, index) => (
      index < 15 ? { ...photo, smartSortStatus: 'completed' } : photo
    ));
    const previousResult = {
      id: 'rerun-result',
      status: 'created',
      groupCount: 1,
      photoCount: 15,
      groups: [{
        id: 'rerun-existing-fifteen',
        title: '原有十五张',
        photos: existingPhotos.slice(0, 15).map((photo) => ({
          photoId: photo.id,
          modifiedAt: photo.modifiedAt
        })),
        photoCount: 15
      }]
    };
    const targetPhotos = existingPhotos.slice(0, 3);
    const orchestration = await run({
      photos: targetPhotos,
      maps: pool.maps,
      generateGroups: async ({ photos: groupPhotos }) => ({
        status: 'created',
        groupCount: 1,
        photoCount: groupPhotos.length,
        groups: [{
          id: 'rerun-latest-three',
          photos: groupPhotos.map((photo) => ({
            photoId: photo.id,
            modifiedAt: photo.modifiedAt
          })),
          photoCount: groupPhotos.length
        }]
      })
    });
    const mergedResult = mergeScopedSmartSortResult({
      previousSmartSortResult: previousResult,
      nextSmartSortResult: orchestration.smartSortResult,
      targetPhotoIds: targetPhotos.map((photo) => photo.id)
    });
    const membership = buildSmartSortGroupMembershipByPhotoId(mergedResult);
    const allMembershipIds = mergedResult.groups.flatMap((group) => (
      [...buildSmartSortGroupMembershipByPhotoId({ groups: [group] }).keys()]
    ));
    equal(membership.size, 15, '重新智拣原分组 3 张后最终成员仍应为 15');
    equal(new Set(allMembershipIds).size, allMembershipIds.length, '重新智拣后同一 photoId 不得出现在两个分组');
    existingPhotos.slice(3, 15).forEach((photo) => {
      equal(membership.get(photo.id), 'rerun-existing-fifteen', '未选中的 12 张必须保留原 membership');
    });
    targetPhotos.forEach((photo) => {
      equal(membership.get(photo.id), 'rerun-latest-three', '选中的 3 张必须替换为本次最新 membership');
    });
    equal(mergedResult.groups[0].photoCount, 12, '移除选中照片后旧分组照片数必须重算为 12');
    equal(mergedResult.groups[1].photoCount, 3, '本次新分组照片数必须为 3');
    equal(mergedResult.photoCount, 15, '重新智拣后的总照片数必须重算为 15');
    scenarioCount += 1;
  }

  {
    const pool = makeCompletePool(20, 'partial-failure');
    const existingPhotos = pool.photos.map((photo, index) => (
      index < 15 ? { ...photo, smartSortStatus: 'completed' } : photo
    ));
    const previousResult = {
      id: 'failure-result',
      status: 'created',
      groupCount: 1,
      photoCount: 15,
      groups: [{
        id: 'failure-existing-fifteen',
        photoIds: existingPhotos.slice(0, 15).map((photo) => photo.id),
        photoCount: 15
      }]
    };
    const targetPhotos = existingPhotos.slice(0, 3);
    const successfulIds = targetPhotos.slice(0, 2).map((photo) => photo.id);
    const failedId = targetPhotos[2].id;
    const mergedResult = mergeScopedSmartSortResult({
      previousSmartSortResult: previousResult,
      nextSmartSortResult: {
        status: 'created',
        groupCount: 1,
        photoCount: 2,
        groups: [{ id: 'failure-latest-two', photoIds: successfulIds, photoCount: 2 }]
      },
      targetPhotoIds: targetPhotos.map((photo) => photo.id)
    });
    const completedPhotos = completeSmartSortExecution({
      photos: existingPhotos,
      targetPhotoIds: targetPhotos.map((photo) => photo.id),
      processingResults: [
        ...successfulIds.map((photoId) => ({
          photoId,
          status: 'completed',
          missingRequiredFields: []
        })),
        {
          photoId: failedId,
          status: 'failed',
          missingRequiredFields: []
        }
      ],
      smartSortResult: mergedResult
    });
    const membership = buildSmartSortGroupMembershipByPhotoId(mergedResult);
    equal(membership.has(failedId), false, '本次失败照片不得继续保留失效的旧 membership');
    equal(completedPhotos.find((photo) => photo.id === failedId).smartSortStatus, 'failed', '本次失败照片状态必须为 failed');
    successfulIds.forEach((photoId) => {
      equal(membership.get(photoId), 'failure-latest-two', '本次成功照片必须写入最新分组');
    });
    existingPhotos.slice(3, 15).forEach((photo, index) => {
      equal(completedPhotos[index + 3], existingPhotos[index + 3], '未选中照片必须保持原对象');
      equal(membership.get(photo.id), 'failure-existing-fifteen', '未选中照片必须保留旧 membership');
    });
    equal(getStageIds(completedPhotos, membership, 'pending_organize').length, 14, '一张重智拣失败后待整理应为 14');
    equal(getStageIds(completedPhotos, membership, 'pending_sort').length, 6, '一张重智拣失败后待智拣应为 6');
    equal(isPhotoPendingSmartSort(completedPhotos.find((photo) => photo.id === failedId), false), true, '失败照片应重新进入待智拣');
    equal(isPhotoPendingOrganize(completedPhotos.find((photo) => photo.id === failedId), false), false, '失败照片不得同时进入待整理');
    scenarioCount += 1;
  }

  {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'), 'utf8');
    const utilitySource = await fs.readFile(path.join(process.cwd(), 'src', 'utils', 'sourceAwareRecognition.js'), 'utf8');
    const structuredImportSource = await fs.readFile(
      path.join(process.cwd(), 'electron', 'services', 'markiStructuredImportService.cjs'),
      'utf8'
    );
    const rehydrateSource = await fs.readFile(
      path.join(process.cwd(), 'electron', 'services', 'markiWorkbenchRehydrateService.cjs'),
      'utf8'
    );
    assert.match(source, /orchestrateSourceAwareRecognition\(/);
    sourceContractCount += 1;
    assert.match(source, /getOcrAvailability:[\s\S]*getRecognitionStatus\(\)/);
    sourceContractCount += 1;
    assert.equal(source.includes('routeText ==='), false);
    sourceContractCount += 1;
    assert.match(source, /saveAutomaticSnapshotImmediately\(nextWorkspace\)/);
    sourceContractCount += 1;
    assert.match(source, /route === 'marki_ocr_fallback'[\s\S]*currentProject: ''/);
    sourceContractCount += 1;
    assert.equal(utilitySource.includes('originalPath.includes'), false);
    sourceContractCount += 1;
    assert.equal(utilitySource.includes('fileName.includes'), false);
    sourceContractCount += 1;
    assert.equal(utilitySource.includes('window.'), false);
    sourceContractCount += 1;
    assert.equal(utilitySource.includes('sourceKey.includes'), false);
    sourceContractCount += 1;
    assert.match(source, /buildSourceAwareRecognitionNotice\(stats, \{ supersedeSyncFailedCount \}\)/);
    sourceContractCount += 1;
    assert.match(source, /completeSmartSortExecution\(\{/);
    sourceContractCount += 1;
    assert.match(source, /smartSortGroupPhotoIds\.has\(photo\.id\)/);
    sourceContractCount += 1;
    assert.match(source, /rebuildSmartSortResult\(\{/);
    sourceContractCount += 1;
    assert.match(source, /getWorkflowFilterCount\(key, photos, selectedIds, smartSortGroupMembershipByPhotoId\)/);
    sourceContractCount += 1;
    assert.match(source, /getPhotoWorkflowStageLabel\(photo, smartSortGroupMember\)/);
    sourceContractCount += 1;
    assert.match(source, /resetSelectedSmartSortResults\(\{/);
    sourceContractCount += 1;
    assert.match(utilitySource, /export function resetSelectedSmartSortResults\(\{/);
    sourceContractCount += 1;
    assert.doesNotMatch(
      source,
      /photos: invalidateSmartSortExecution\(workspace\.photos\)/,
      '追加照片不得全量失效已有智拣状态'
    );
    sourceContractCount += 1;
    assert.match(utilitySource, /marki_existing_supplement/);
    sourceContractCount += 1;
    assert.equal(structuredImportSource.includes('sourceAwareRecognition'), false);
    sourceContractCount += 1;
    assert.equal(structuredImportSource.includes('generateSmartSortGroups'), false);
    sourceContractCount += 1;
    assert.equal(rehydrateSource.includes('sourceAwareRecognition'), false);
    sourceContractCount += 1;
    assert.equal(rehydrateSource.includes('generateSmartSortGroups'), false);
    sourceContractCount += 1;
    scenarioCount += 1;
  }

  check(assertionCount >= 70, '来源感知智拣应执行至少 70 个行为断言');
  console.log(
    `来源感知智拣自检通过：${scenarioCount} 个行为场景，${assertionCount} 个行为断言，${sourceContractCount} 个源码契约断言。`
  );
}

async function checkSmartGroupDateBoundaries(root) {
  const {
    buildSmartGroupDescriptor,
    normalizeSmartGroupDate
  } = await import(pathToFileURL(
    path.resolve(process.cwd(), 'src/utils/smartGroupKey.js')
  ).href);
  const {
    buildSmartSortGroupMembershipByPhotoId,
    mergeScopedSmartSortResult,
    orchestrateSourceAwareRecognition
  } = await import(pathToFileURL(
    path.resolve(process.cwd(), 'src/utils/sourceAwareRecognition.js')
  ).href);
  const {
    buildArchiveFormSeed,
    resolveCanonicalPhotoResult
  } = await import(pathToFileURL(
    path.resolve(process.cwd(), 'src/utils/sortRightPanelState.js')
  ).href);
  await fs.mkdir(root, { recursive: true });

  let behaviorAssertionCount = 0;
  let sourceContractAssertionCount = 0;
  const equal = (...args) => {
    behaviorAssertionCount += 1;
    return assert.equal(...args);
  };
  const deepEqual = (...args) => {
    behaviorAssertionCount += 1;
    return assert.deepEqual(...args);
  };
  const check = (value, message) => {
    behaviorAssertionCount += 1;
    return assert.ok(value, message);
  };
  const sourceCheck = (value, message) => {
    sourceContractAssertionCount += 1;
    return assert.ok(value, message);
  };
  const fields = {
    project: '嘉恒花园',
    watermarkCategory: '巡查检查',
    workContent: '电梯巡查'
  };
  const makeArtifacts = (photoId, date) => ({
    recognitionResult: {
      photoId,
      source: 'marki_api',
      providerType: 'structured_data',
      status: 'recognized',
      parsedFields: {
        date,
        project: fields.project,
        watermarkCategory: fields.watermarkCategory,
        workContent: fields.workContent
      }
    },
    watermarkRecord: {
      photoId,
      source: 'marki_api',
      captureDate: date,
      projectText: fields.project,
      watermarkCategoryText: fields.watermarkCategory,
      workContentText: fields.workContent
    },
    archiveSuggestion: {
      photoId,
      source: 'marki_api',
      status: 'suggestion_ready',
      suggestedFields: {
        date,
        ...fields
      },
      missingRequiredFields: []
    }
  });
  const makeSmartPhoto = ({
    id,
    date = '',
    capturedAt = '',
    sourceType = 'marki_api',
    artifacts = makeArtifacts(id, date)
  }) => {
    const photo = {
      id,
      originalPath: path.join(root, `${id}.jpg`),
      originalName: `${id}.jpg`,
      sourceType,
      capturedAt,
      modifiedAt: capturedAt
    };
    const canonicalFields = resolveCanonicalPhotoResult({
      photo,
      recognitionResult: artifacts.recognitionResult,
      watermarkRecord: artifacts.watermarkRecord,
      archiveSuggestion: artifacts.archiveSuggestion,
      configs: {
        projects: [fields.project],
        watermarkCategories: {
          [fields.watermarkCategory]: { items: [fields.workContent] }
        }
      }
    });
    return {
      photoId: id,
      filePath: photo.originalPath,
      fileName: photo.originalName,
      sourceType,
      capturedAt: capturedAt || null,
      modifiedAt: capturedAt || null,
      recognition: artifacts.recognitionResult,
      watermarkRecord: artifacts.watermarkRecord,
      archiveSuggestion: artifacts.archiveSuggestion,
      smartGrouping: buildSmartGroupDescriptor({
        photo,
        recognitionResult: artifacts.recognitionResult,
        watermarkRecord: artifacts.watermarkRecord,
        archiveSuggestion: artifacts.archiveSuggestion,
        canonicalFields
      })
    };
  };
  const getMemberIds = (result) => (result.groups || [])
    .flatMap((group) => (group.photos || []).map((photo) => photo.photoId));

  const differentDates = await generateSmartSortGroups(
    path.join(root, 'different-dates'),
    {
      photos: [
        makeSmartPhoto({ id: 'date-12', date: '2026-06-12' }),
        makeSmartPhoto({ id: 'date-13', date: '2026-06-13' })
      ]
    }
  );
  equal(differentDates.groupCount, 2, '不同日期且业务字段相同的照片必须拆成两个分组');
  equal(new Set(differentDates.groups.map((group) => group.groupKey)).size, 2, '不同日期必须生成不同 groupKey');
  equal(new Set(getMemberIds(differentDates)).size, 2, '每张照片只能拥有一个 membership');
  deepEqual(
    differentDates.groups.map((group) => group.suggestedFields.date).sort(),
    ['2026-06-12', '2026-06-13'],
    '两个分组必须保留各自归一化日期'
  );

  const sameDateDifferentTimes = await generateSmartSortGroups(
    path.join(root, 'same-date'),
    {
      photos: [
        makeSmartPhoto({
          id: 'same-date-morning',
          date: '',
          capturedAt: '2026-06-12T09:00:00+08:00',
          artifacts: makeArtifacts('same-date-morning', '')
        }),
        makeSmartPhoto({
          id: 'same-date-evening',
          date: '',
          capturedAt: '2026-06-12T17:30:00+08:00',
          artifacts: makeArtifacts('same-date-evening', '')
        })
      ]
    }
  );
  equal(sameDateDifferentTimes.groupCount, 1, '同一天不同时刻且业务字段一致时应进入同一分组');
  equal(sameDateDifferentTimes.groups[0].photoCount, 2, '同日分组应包含两张照片');
  equal(sameDateDifferentTimes.groups[0].suggestedFields.date, '2026-06-12', '同日时间必须归一为同一业务日期');

  const crossSourceSameDate = await generateSmartSortGroups(
    path.join(root, 'cross-source-same-date'),
    {
      photos: [
        makeSmartPhoto({ id: 'marki-same-day', date: '2026-06-12', sourceType: 'marki_api' }),
        makeSmartPhoto({ id: 'local-same-day', date: '2026-06-12', sourceType: 'local_file' })
      ]
    }
  );
  equal(crossSourceSameDate.groupCount, 1, 'Marki 与本地照片四维签名一致时应跨来源同组');
  deepEqual(
    crossSourceSameDate.groups[0].photos.map((photo) => photo.sourceType).sort(),
    ['local_file', 'marki_api'],
    '跨来源分组必须保留照片来源字段'
  );
  const crossSourceNextDate = await generateSmartSortGroups(
    path.join(root, 'cross-source-next-date'),
    {
      photos: [
        makeSmartPhoto({ id: 'marki-day-one', date: '2026-06-12', sourceType: 'marki_api' }),
        makeSmartPhoto({ id: 'local-day-two', date: '2026-06-13', sourceType: 'local_file' })
      ]
    }
  );
  equal(crossSourceNextDate.groupCount, 2, '跨来源照片日期不同时必须拆组');

  equal(
    normalizeSmartGroupDate('2026-06-12T16:30:00.000Z'),
    '2026-06-13',
    'UTC 16:30 必须按固定 UTC+8 归入次日'
  );
  equal(
    normalizeSmartGroupDate('2026-06-13T00:30:00+08:00'),
    '2026-06-13',
    '显式 UTC+8 午夜时间不得漂移到前一天'
  );
  equal(
    normalizeSmartGroupDate('2026-06-13 00:30:00'),
    '2026-06-13',
    '无时区业务时间应按冻结的 UTC+8 日期语义取日'
  );

  const explicitAndMissing = await generateSmartSortGroups(
    path.join(root, 'explicit-and-missing'),
    {
      photos: [
        makeSmartPhoto({ id: 'dated-photo', date: '2026-06-12' }),
        makeSmartPhoto({
          id: 'missing-photo',
          date: '',
          artifacts: makeArtifacts('missing-photo', '')
        })
      ]
    }
  );
  equal(explicitAndMissing.groupCount, 2, '缺失日期照片不得与明确日期照片合并');
  equal(
    explicitAndMissing.groups.find((group) => group.suggestedFields.date === '')?.warnings.length > 0,
    true,
    '缺失日期分组必须提示人工补充'
  );
  const bothMissing = await generateSmartSortGroups(
    path.join(root, 'both-missing'),
    {
      photos: [
        makeSmartPhoto({ id: 'missing-one', date: '', artifacts: makeArtifacts('missing-one', '') }),
        makeSmartPhoto({ id: 'missing-two', date: '', artifacts: makeArtifacts('missing-two', '') })
      ]
    }
  );
  equal(bothMissing.groupCount, 2, '两张日期均缺失的照片不得因空日期合并');
  equal(new Set(bothMissing.groups.map((group) => group.groupKey)).size, 2, '缺失日期签名必须按 photoId 隔离');

  const initialThree = [
    makeSmartPhoto({ id: 'partial-one', date: '2026-06-12' }),
    makeSmartPhoto({ id: 'partial-two', date: '2026-06-12' }),
    makeSmartPhoto({ id: 'partial-three', date: '2026-06-12' })
  ];
  const initialResult = await generateSmartSortGroups(
    path.join(root, 'partial-initial'),
    { photos: initialThree }
  );
  const movedPhoto = makeSmartPhoto({ id: 'partial-three', date: '2026-06-13' });
  const movedResult = await generateSmartSortGroups(
    path.join(root, 'partial-moved'),
    { photos: [movedPhoto] }
  );
  const mergedPartial = mergeScopedSmartSortResult({
    previousSmartSortResult: initialResult,
    nextSmartSortResult: movedResult,
    targetPhotoIds: ['partial-three'],
    groupContextByPhotoId: Object.fromEntries([
      ...initialThree.slice(0, 2),
      movedPhoto
    ].map((photo) => [photo.photoId, photo]))
  });
  equal(mergedPartial.groupCount, 2, '局部重智拣改为次日后必须拆成两个分组');
  equal(mergedPartial.groups.find((group) => group.suggestedFields.date === '2026-06-12')?.photoCount, 2, '原日期分组必须保留未选中的两张');
  equal(mergedPartial.groups.find((group) => group.suggestedFields.date === '2026-06-13')?.photoCount, 1, '改期照片必须进入新的次日分组');
  equal(buildSmartSortGroupMembershipByPhotoId(mergedPartial).size, 3, '局部重分组不得产生重复 membership');

  const pollutedOldGroup = {
    ...initialResult,
    groups: [{
      ...initialResult.groups[0],
      groupKey: '',
      suggestedFields: {},
      photos: [
        initialThree[0],
        makeSmartPhoto({ id: 'old-next-date', date: '2026-06-13' })
      ],
      photoCount: 2
    }]
  };
  const rebuiltOldGroup = await generateSmartSortGroups(
    path.join(root, 'polluted-old-group-rebuild'),
    { photos: pollutedOldGroup.groups[0].photos }
  );
  equal(rebuiltOldGroup.groupCount, 2, '旧无日期 groupKey 的混日分组必须按成员 canonical 日期重建');

  const formConfigs = {
    projects: [fields.project],
    watermarkCategories: {
      [fields.watermarkCategory]: { items: [fields.workContent] }
    }
  };
  const formArtifacts = makeArtifacts('form-consistency', '2026-06-12');
  const formPhoto = {
    id: 'form-consistency',
    sourceType: 'marki_api',
    originalPath: path.join(root, 'form-consistency.jpg')
  };
  const formResult = await generateSmartSortGroups(
    path.join(root, 'form-consistency'),
    {
      photos: [
        makeSmartPhoto({ id: formPhoto.id, date: '2026-06-12' }),
        makeSmartPhoto({ id: 'form-consistency-two', date: '2026-06-12' })
      ]
    }
  );
  const form = buildArchiveFormSeed({
    photo: formPhoto,
    recognitionResult: formArtifacts.recognitionResult,
    watermarkRecord: formArtifacts.watermarkRecord,
    archiveSuggestion: formArtifacts.archiveSuggestion,
    group: formResult.groups[0],
    configs: formConfigs
  });
  equal(formResult.groups[0].suggestedFields.date, '2026-06-12', '左侧分组必须保存 canonical 日期');
  equal(form.date, '2026-06-12', '右侧表单日期必须与分组日期一致');
  equal(
    formResult.groups[0].photos.every((photo) => photo.smartGrouping.fields.date === form.date),
    true,
    '多照片组内全部成员 canonical 日期必须与右侧表单一致'
  );

  const markiPhoto = {
    id: 'marki-regression',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:100:marki-regression',
    originalPath: path.join(root, 'marki-regression.jpg'),
    originalName: 'marki-regression.jpg',
    capturedAt: '2026-06-12T09:00:00+08:00'
  };
  const markiArtifacts = makeArtifacts(markiPhoto.id, '2026-06-12');
  const originalRecognition = structuredClone(markiArtifacts.recognitionResult);
  const originalWatermark = structuredClone(markiArtifacts.watermarkRecord);
  const originalSuggestion = structuredClone(markiArtifacts.archiveSuggestion);
  let ocrCalls = 0;
  let groupCalls = 0;
  const markiResult = await orchestrateSourceAwareRecognition({
    photos: [markiPhoto],
    recognitionResultsByPhoto: { [markiPhoto.id]: markiArtifacts.recognitionResult },
    watermarkRecordsByPhoto: { [markiPhoto.id]: markiArtifacts.watermarkRecord },
    archiveSuggestionsByPhoto: { [markiPhoto.id]: markiArtifacts.archiveSuggestion },
    getOcrAvailability: async () => {
      throw new Error('完整 Marki 不应检查 OCR');
    },
    recognizePhoto: async () => {
      ocrCalls += 1;
      throw new Error('完整 Marki 不应执行 OCR');
    },
    buildOcrArtifacts: async () => {
      throw new Error('完整 Marki 不应构建 OCR 产物');
    },
    generateGroups: async ({ photos, recognitionResultsByPhoto, watermarkRecordsByPhoto, archiveSuggestionsByPhoto }) => {
      groupCalls += 1;
      return generateSmartSortGroups(path.join(root, 'marki-regression-group'), {
        photos: photos.map((photo) => {
          const canonicalFields = resolveCanonicalPhotoResult({
            photo,
            recognitionResult: recognitionResultsByPhoto[photo.id],
            watermarkRecord: watermarkRecordsByPhoto[photo.id],
            archiveSuggestion: archiveSuggestionsByPhoto[photo.id],
            configs: formConfigs
          });
          return {
            photoId: photo.id,
            filePath: photo.originalPath,
            fileName: photo.originalName,
            sourceType: photo.sourceType,
            capturedAt: photo.capturedAt,
            recognition: recognitionResultsByPhoto[photo.id],
            watermarkRecord: watermarkRecordsByPhoto[photo.id],
            archiveSuggestion: archiveSuggestionsByPhoto[photo.id],
            smartGrouping: buildSmartGroupDescriptor({
              photo,
              recognitionResult: recognitionResultsByPhoto[photo.id],
              watermarkRecord: watermarkRecordsByPhoto[photo.id],
              archiveSuggestion: archiveSuggestionsByPhoto[photo.id],
              canonicalFields
            })
          };
        })
      });
    }
  });
  equal(ocrCalls, 0, '完整 Marki 日期分组回归中 OCR 调用必须为 0');
  equal(groupCalls, 1, '完整 Marki 必须正常执行一次最终分组');
  equal(markiResult.smartSortResult.groupCount, 1, '完整 Marki 必须生成可见分组');
  deepEqual(markiResult.recognitionResultsByPhoto[markiPhoto.id], originalRecognition, '日期分组修复不得改写平台 recognition');
  deepEqual(markiResult.watermarkRecordsByPhoto[markiPhoto.id], originalWatermark, '日期分组修复不得改写平台 watermark');
  deepEqual(markiResult.archiveSuggestionsByPhoto[markiPhoto.id], originalSuggestion, '日期分组修复不得改写平台 suggestion');

  const builderSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'utils', 'smartGroupBuilder.js'),
    'utf8'
  );
  const pageSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'),
    'utf8'
  );
  const sourceAwareSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'utils', 'sourceAwareRecognition.js'),
    'utf8'
  );
  const keySource = await fs.readFile(
    path.join(process.cwd(), 'src', 'utils', 'smartGroupKey.js'),
    'utf8'
  );
  sourceCheck(builderSource.includes("basis: 'business_fields'"), '快照内分组重建必须使用四维业务分组描述');
  sourceCheck(pageSource.includes('buildSmartSortCanonicalMaps({'), '页面必须先构建照片级 canonical 后全量重建');
  sourceCheck(pageSource.includes('rebuildSmartSortResult({'), '页面必须只写 WorkspaceSnapshot 智拣结果');
  sourceCheck(sourceAwareSource.includes('mergeSmartSortGroupsByKey'), '局部分组必须按 groupKey 合并');
  sourceCheck(keySource.includes('BUSINESS_TIMEZONE_OFFSET_MS'), '日期归一化必须固定使用 UTC+8');

  console.log(
    `智拣日期硬边界自检通过：8 个行为场景，${behaviorAssertionCount} 个行为断言，${sourceContractAssertionCount} 个源码契约断言。`
  );
}

async function checkUnifiedPhotoPool(root) {
  await fs.mkdir(root, { recursive: true });
  const poolModuleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'unifiedPhotoPool.js')
  ).href;
  const {
    mergeScannedLocalPhotoSubpool
  } = await import(`${poolModuleUrl}?unified-pool=${Date.now()}`);
  const sourceAwareModuleUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'utils', 'sourceAwareRecognition.js')
  ).href;
  const {
    buildSourceAwareRecognitionNotice,
    buildSourceAwareSmartSortPresentation,
    orchestrateSourceAwareRecognition
  } = await import(`${sourceAwareModuleUrl}?unified-pool=${Date.now()}`);
  let scenarioCount = 0;
  let assertionCount = 0;
  let sourceContractCount = 0;
  const check = (condition, message) => {
    assertionCount += 1;
    assert.ok(condition, message);
  };
  const equal = (actual, expected, message) => {
    assertionCount += 1;
    assert.equal(actual, expected, message);
  };
  const deepEqual = (actual, expected, message) => {
    assertionCount += 1;
    assert.deepEqual(actual, expected, message);
  };
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const localDirectoryA = path.join(root, 'local-a');
  const localDirectoryB = path.join(root, 'local-b');
  await fs.mkdir(localDirectoryA, { recursive: true });
  await fs.mkdir(localDirectoryB, { recursive: true });
  const markiBytes1 = createTestJpeg(11, 11);
  const markiBytes2 = createTestJpeg(12, 12);
  const localBytesA = createTestJpeg(13, 13);
  const localBytesB = createTestJpeg(14, 14);
  const localBytesC = createTestJpeg(15, 15);
  await fs.writeFile(path.join(localDirectoryA, 'local-a.jpg'), localBytesA);
  await fs.writeFile(path.join(localDirectoryA, 'local-b.jpg'), localBytesB);
  await fs.writeFile(path.join(localDirectoryA, 'duplicate-marki.jpg'), markiBytes1);
  await fs.writeFile(path.join(localDirectoryB, 'duplicate-local-a.jpg'), localBytesA);
  await fs.writeFile(path.join(localDirectoryB, 'local-c.jpg'), localBytesC);
  const scannedA = (await scanImagesWithHealth(localDirectoryA, {
    decodeImage: decodeSelfCheckImage
  })).photos;
  const scannedB = (await scanImagesWithHealth(localDirectoryB, {
    decodeImage: decodeSelfCheckImage
  })).photos;
  check(scannedA.every((photo) => /^[a-f0-9]{64}$/.test(photo.sha256)), '扫描服务必须为每张本地照片返回 SHA-256');
  equal(scannedA.find((photo) => photo.name === 'local-a.jpg').sha256, digest(localBytesA), '扫描 SHA-256 必须匹配真实文件内容');
  scenarioCount += 1;

  const markiPhoto1 = {
    id: 'marki-photo-1',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:100:moment-1',
    sourceMetadataRef: 'marki_source_metadata:100:moment-1',
    originalPath: path.join(root, 'marki-1.jpg'),
    originalName: 'marki-1.jpg',
    size: markiBytes1.length,
    sha256: digest(markiBytes1),
    sortStatus: 'suggestion_ready',
    smartSortStatus: 'completed',
    archiveInfo: { project: '平台项目一' },
    previewInfo: { project: '平台项目一' }
  };
  const markiPhoto2 = {
    id: 'marki-photo-2',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:100:moment-2',
    sourceMetadataRef: 'marki_source_metadata:100:moment-2',
    originalPath: path.join(root, 'marki-2.jpg'),
    originalName: 'marki-2.jpg',
    size: markiBytes2.length,
    sha256: digest(markiBytes2),
    sortStatus: 'confirmed',
    smartSortStatus: 'completed',
    archiveInfo: { project: '平台项目二' },
    previewInfo: { project: '平台项目二' }
  };
  await fs.writeFile(markiPhoto1.originalPath, markiBytes1);
  await fs.writeFile(markiPhoto2.originalPath, markiBytes2);
  const platformRecognition = {
    source: 'marki_api',
    providerType: 'structured_data',
    status: 'recognized',
    missingRequiredFields: [],
    parsedFields: {
      date: '2026-07-19',
      projectName: '测试小区',
      watermarkCategory: '巡查检查类',
      workContent: '设施巡查'
    }
  };
  const platformWatermark = {
    source: 'marki_api',
    captureDate: '2026-07-19',
    projectText: '测试小区',
    watermarkCategoryText: '巡查检查类',
    workContentText: '设施巡查'
  };
  const platformSuggestion = {
    source: 'marki_api',
    status: 'suggestion_ready',
    suggestedFields: {
      date: '2026-07-19',
      project: '测试小区',
      watermarkCategory: '巡查检查类',
      workContent: '设施巡查'
    },
    missingRequiredFields: []
  };
  const recognitionMap = {
    [markiPhoto1.id]: platformRecognition,
    [markiPhoto2.id]: { ...platformRecognition, photoId: markiPhoto2.id }
  };
  const watermarkMap = {
    [markiPhoto1.id]: platformWatermark,
    [markiPhoto2.id]: { ...platformWatermark, photoId: markiPhoto2.id }
  };
  const suggestionMap = {
    [markiPhoto1.id]: platformSuggestion,
    [markiPhoto2.id]: { ...platformSuggestion, photoId: markiPhoto2.id }
  };
  const mergedA = mergeScannedLocalPhotoSubpool({
    currentPhotos: [markiPhoto1, markiPhoto2],
    scannedPhotos: scannedA,
    recognitionResultsByPhoto: recognitionMap,
    watermarkRecordsByPhoto: watermarkMap,
    archiveSuggestionsByPhoto: suggestionMap,
    selectedIds: [markiPhoto1.id],
    activePhotoId: markiPhoto2.id
  });
  equal(mergedA.photos.length, 4, '两张 Marki 加两张唯一本地照片后统一照片池应有四张');
  equal(mergedA.stats.addedLocalCount, 2, '首次目录应追加两张唯一本地照片');
  equal(mergedA.stats.duplicateCount, 1, '与 Marki 内容相同的本地照片必须按 SHA-256 跳过');
  equal(mergedA.photos[0].smartSortStatus, 'completed', '追加本地照片后第一张 Marki 旧智拣状态必须保持');
  equal(mergedA.photos[1].smartSortStatus, 'completed', '追加本地照片后第二张 Marki 旧智拣状态必须保持');
  equal(mergedA.photos[0].sourceKey, markiPhoto1.sourceKey, '追加不得改写 Marki sourceKey');
  equal(mergedA.photos[1].sourceMetadataRef, markiPhoto2.sourceMetadataRef, '追加不得改写 Marki 元数据引用');
  deepEqual(mergedA.photos[0].archiveInfo, markiPhoto1.archiveInfo, '追加不得改写 Marki 人工归档信息');
  deepEqual(mergedA.photos[1].previewInfo, markiPhoto2.previewInfo, '追加不得改写 Marki 预览信息');
  equal(mergedA.photos[2].smartSortStatus, 'not_run', '新增本地照片必须单独进入待智拣');
  equal(mergedA.photos[3].smartSortStatus, 'not_run', '同批新增本地照片必须单独进入待智拣');
  equal(mergedA.recognitionResultsByPhoto, recognitionMap, 'Marki recognition Map 必须保持原引用');
  equal(mergedA.watermarkRecordsByPhoto, watermarkMap, 'Marki watermark Map 必须保持原引用');
  equal(mergedA.archiveSuggestionsByPhoto, suggestionMap, 'Marki suggestion Map 必须保持原引用');
  deepEqual(mergedA.photos.slice(0, 2), [markiPhoto1, markiPhoto2], '已有 Marki 照片对象和值必须完整保持');
  check(mergedA.selectedIds.includes(markiPhoto1.id), '原有 Marki 选择必须保留');
  check(mergedA.selectedIds.includes(`local-${digest(localBytesA)}`), '新增本地照片必须自动选中');
  equal(mergedA.activePhotoId, markiPhoto2.id, '仍存在的活动 Marki 照片必须保持');
  equal(new Set(mergedA.photos.map((photo) => photo.sourceKey).filter(Boolean)).size, 2, 'Marki sourceKey 不得产生重复');
  scenarioCount += 1;

  const mergedB = mergeScannedLocalPhotoSubpool({
    currentPhotos: mergedA.photos,
    scannedPhotos: scannedB,
    recognitionResultsByPhoto: mergedA.recognitionResultsByPhoto,
    watermarkRecordsByPhoto: mergedA.watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto: mergedA.archiveSuggestionsByPhoto,
    selectedIds: mergedA.selectedIds,
    activePhotoId: mergedA.activePhotoId
  });
  equal(mergedB.photos.length, 5, '切换到目录 B 后必须保留目录 A、Marki 并追加唯一新照片');
  equal(mergedB.stats.addedLocalCount, 1, '目录 B 只应追加一张唯一内容');
  equal(mergedB.stats.duplicateCount, 1, '目录 B 中与目录 A 内容相同的照片必须跳过');
  deepEqual(mergedB.photos.slice(0, 4), mergedA.photos, '追加模式不得重建或覆盖任何已有照片对象');
  equal(mergedB.recognitionResultsByPhoto, recognitionMap, '跨目录扫描不得清空 recognition Map');
  equal(mergedB.watermarkRecordsByPhoto, watermarkMap, '跨目录扫描不得清空 watermark Map');
  equal(mergedB.archiveSuggestionsByPhoto, suggestionMap, '跨目录扫描不得清空 suggestion Map');
  equal(mergedB.localPoolChanged, true, '真正追加本地照片后必须报告照片池发生变化');
  scenarioCount += 1;

  const completeMarki = markiPhoto1;
  const completeMaps = {
    recognitionResultsByPhoto: { [completeMarki.id]: platformRecognition },
    watermarkRecordsByPhoto: { [completeMarki.id]: platformWatermark },
    archiveSuggestionsByPhoto: { [completeMarki.id]: platformSuggestion }
  };
  let ocrCalls = 0;
  let ocrStatusChecks = 0;
  let groupCalls = 0;
  const smartSortRoot = path.join(root, 'marki-smart-sort');
  const runMarkiSmartSort = (state) => orchestrateSourceAwareRecognition({
    photos: [completeMarki],
    recognitionResultsByPhoto: state.recognitionResultsByPhoto,
    watermarkRecordsByPhoto: state.watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto: state.archiveSuggestionsByPhoto,
    getOcrAvailability: async () => {
      ocrStatusChecks += 1;
      return { available: false };
    },
    recognizePhoto: async () => {
      ocrCalls += 1;
      throw new Error('完整 Marki 不得执行 OCR');
    },
    buildOcrArtifacts: () => {
      throw new Error('完整 Marki 不得构建 OCR 结果');
    },
    getPhotoSortStatus: (_recognition, suggestion) => suggestion.status,
    generateGroups: async ({
      photos,
      recognitionResultsByPhoto,
      watermarkRecordsByPhoto,
      archiveSuggestionsByPhoto
    }) => {
      groupCalls += 1;
      return generateSmartSortGroups(smartSortRoot, {
        photos: photos.map((photo, index) => ({
          photoId: photo.id,
          filePath: photo.originalPath,
          fileName: photo.originalName,
          index,
          capturedAt: photo.capturedAt || null,
          modifiedAt: photo.modifiedAt || null,
          sortStatus: photo.sortStatus,
          archiveSuggestion: archiveSuggestionsByPhoto[photo.id],
          watermarkRecord: watermarkRecordsByPhoto[photo.id],
          recognition: recognitionResultsByPhoto[photo.id]
        }))
      });
    }
  });
  const firstSmartSort = await runMarkiSmartSort(completeMaps);
  const firstPresentation = buildSourceAwareSmartSortPresentation({
    smartSortResult: firstSmartSort.smartSortResult,
    currentActivePhotoId: completeMarki.id
  });
  equal(ocrCalls, 0, '完整 Marki 第一次智拣 OCR 调用必须为零');
  equal(ocrStatusChecks, 0, '完整 Marki 第一次智拣不得检查 OCR 服务');
  equal(groupCalls, 1, '完整 Marki 第一次智拣必须调用一次生产分组服务');
  equal(firstSmartSort.stats.platformOnlyCount, 1, '完整 Marki 必须计入平台数据直用');
  check(firstSmartSort.smartSortResult?.groupCount > 0, '生产分组服务必须为四项完整 Marki 生成分组');
  check(
    firstSmartSort.smartSortResult.groups.some((group) => (
      group.photos.some((photo) => photo.photoId === completeMarki.id)
    )),
    '生产 smartSortResult 分组必须包含完整 Marki 照片'
  );
  equal(firstPresentation.smartSortViewMode, 'smartSortGroup', '页面提交适配必须切换到可见分组视图');
  equal(firstPresentation.activePhotoId, completeMarki.id, '页面提交适配必须聚焦分组中的 Marki 照片');
  check(
    buildSourceAwareRecognitionNotice(firstSmartSort.stats).includes('平台数据直用 1 张'),
    '页面完成 notice 必须显示平台数据直用数量'
  );
  deepEqual(firstSmartSort.recognitionResultsByPhoto[completeMarki.id], platformRecognition, '第一次智拣不得改写平台 recognition');
  deepEqual(firstSmartSort.watermarkRecordsByPhoto[completeMarki.id], platformWatermark, '第一次智拣不得改写平台 watermark');
  deepEqual(firstSmartSort.archiveSuggestionsByPhoto[completeMarki.id], platformSuggestion, '第一次智拣不得改写平台 suggestion');
  const secondSmartSort = await runMarkiSmartSort(firstSmartSort);
  equal(ocrCalls, 0, '完整 Marki 第二次智拣 OCR 调用仍必须为零');
  equal(ocrStatusChecks, 0, '完整 Marki 第二次智拣仍不得检查 OCR 服务');
  equal(groupCalls, 2, '完整 Marki 第二次智拣必须重新计算一次分组');
  deepEqual(secondSmartSort.recognitionResultsByPhoto[completeMarki.id], platformRecognition, '第二次智拣不得改写平台 recognition');
  deepEqual(secondSmartSort.watermarkRecordsByPhoto[completeMarki.id], platformWatermark, '第二次智拣不得改写平台 watermark');
  deepEqual(secondSmartSort.archiveSuggestionsByPhoto[completeMarki.id], platformSuggestion, '第二次智拣不得改写平台 suggestion');
  scenarioCount += 1;

  const localPhoto = mergedA.photos.find((photo) => photo.sourceType === 'local_file');
  const localOcrFields = {
    date: '2026-07-19',
    project: '测试小区',
    watermarkCategory: '巡查检查类',
    workContent: '设施巡查'
  };
  let mixedOcrCalls = 0;
  let mixedGroupCalls = 0;
  const mixedResult = await orchestrateSourceAwareRecognition({
    photos: [completeMarki, localPhoto],
    ...completeMaps,
    getOcrAvailability: async () => ({ available: true }),
    recognizePhoto: async (photo) => {
      mixedOcrCalls += 1;
      return {
        photoId: photo.id,
        status: 'success',
        success: true,
        rawText: '本地 OCR 测试文本',
        testFields: localOcrFields
      };
    },
    buildOcrArtifacts: ({ photo, recognitionResult }) => ({
      recognitionResult,
      watermarkRecord: {
        photoId: photo.id,
        captureDate: localOcrFields.date,
        projectText: localOcrFields.project,
        watermarkCategoryText: localOcrFields.watermarkCategory,
        workContentText: localOcrFields.workContent
      },
      archiveSuggestion: {
        photoId: photo.id,
        status: 'suggestion_ready',
        suggestedFields: localOcrFields,
        missingRequiredFields: []
      }
    }),
    getPhotoSortStatus: (_recognition, suggestion) => suggestion.status,
    generateGroups: async ({ photos }) => {
      mixedGroupCalls += 1;
      return {
        status: 'created',
        groupCount: 1,
        photoCount: photos.length,
        groups: [{
          id: 'mixed-group',
          photos: photos.map((photo) => ({ photoId: photo.id }))
        }]
      };
    }
  });
  equal(mixedOcrCalls, 1, '混合池智拣只能对一张本地照片执行 OCR');
  equal(mixedResult.stats.platformOnlyCount, 1, '混合池应有一张 Marki 平台直用');
  equal(mixedGroupCalls, 1, '混合池所有照片收口后只能统一分组一次');
  equal(mixedResult.smartSortResult.groups[0].photos.length, 2, '本地与 Marki 必须进入同一业务分组');
  scenarioCount += 1;

  const snapshotRoot = path.join(root, 'snapshot');
  const presentation = buildSourceAwareSmartSortPresentation({
    smartSortResult: firstSmartSort.smartSortResult,
    currentActivePhotoId: completeMarki.id
  });
  const snapshotWorkspace = {
    ...createEmptyWorkspace(),
    photos: mergedB.photos,
    selectedIds: mergedB.selectedIds,
    activePhotoId: presentation.activePhotoId,
    recognitionResultsByPhoto: mixedResult.recognitionResultsByPhoto,
    watermarkRecordsByPhoto: mixedResult.watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto: mixedResult.archiveSuggestionsByPhoto,
    smartSortResult: firstSmartSort.smartSortResult,
    smartSortViewMode: presentation.smartSortViewMode,
    activeSmartSortGroupId: presentation.activeSmartSortGroupId,
    searchText: presentation.searchText,
    page: presentation.page
  };
  equal((await saveSortWorkspaceSnapshot(snapshotRoot, snapshotWorkspace)).success, true, '统一照片池与可见智拣结果必须可立即写入自动快照');
  const restoredSnapshot = await loadSortWorkspaceSnapshot(snapshotRoot);
  equal(restoredSnapshot.found, true, '全新实例必须能恢复统一照片池快照');
  equal(restoredSnapshot.snapshot.workspace.photos.length, mergedB.photos.length, '恢复后目录 A、目录 B 和 Marki 照片必须全部存在');
  equal(restoredSnapshot.snapshot.workspace.smartSortResult.groupCount, firstSmartSort.smartSortResult.groupCount, '恢复后 smartSortResult 必须存在');
  equal(restoredSnapshot.snapshot.workspace.smartSortViewMode, 'smartSortGroup', '恢复后必须保持可见分组视图');
  equal(restoredSnapshot.snapshot.workspace.activeSmartSortGroupId, presentation.activeSmartSortGroupId, '恢复后必须保持当前分组');
  check(
    restoredSnapshot.snapshot.workspace.photos.every((photo) => /^[a-f0-9]{64}$/.test(photo.sha256)),
    '恢复后的统一照片池必须保留或补齐全部内容 SHA-256'
  );
  scenarioCount += 1;

  {
    const pageSource = await fs.readFile(path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'), 'utf8');
    const poolSource = await fs.readFile(path.join(process.cwd(), 'src', 'utils', 'unifiedPhotoPool.js'), 'utf8');
    const fileServiceSource = await fs.readFile(path.join(process.cwd(), 'electron', 'services', 'fileService.cjs'), 'utf8');
    const scanHandlerSource = pageSource
      .split('async function scanPhotos', 2)[1]
      ?.split('async function importOrScanPhotos', 1)[0] || '';
    assert.match(pageSource, /mergeScannedLocalPhotoSubpool\(\{/);
    sourceContractCount += 1;
    assert.match(pageSource, /setPhotos\(mergedPool\.photos\)/);
    sourceContractCount += 1;
    assert.equal(pageSource.includes('setPhotos(scanned)'), false);
    sourceContractCount += 1;
    assert.match(pageSource, /buildSourceAwareSmartSortPresentation\(\{/);
    sourceContractCount += 1;
    assert.match(pageSource, /setSmartSortViewMode\(nextSmartSortViewMode\)/);
    sourceContractCount += 1;
    assert.match(pageSource, /saveAutomaticSnapshotImmediately\(scannedWorkspace\)/);
    sourceContractCount += 1;
    assert.equal(poolSource.includes('originalPath.includes'), false);
    sourceContractCount += 1;
    assert.match(
      fileServiceSource,
      /sha256: health\.currentSha256 \|\| await hashFile\(file\.path\)/
    );
    sourceContractCount += 1;
    assert.match(
      scanHandlerSource,
      /const nextSmartSortResult = smartSortResult/,
      '本地扫描追加必须保留已有智拣结果'
    );
    sourceContractCount += 1;
    assert.equal(scanHandlerSource.includes('orchestrateSourceAwareRecognition'), false);
    sourceContractCount += 1;
    assert.equal(scanHandlerSource.includes('generateSmartSortGroups('), false);
    sourceContractCount += 1;
  }

  check(scenarioCount === 6, '统一照片池和可见 Marki 智拣应执行六个真实行为场景');
  console.log(
    `统一照片池与可见 Marki 智拣自检通过：${scenarioCount} 个行为场景，${assertionCount} 个行为断言，${sourceContractCount} 个源码契约断言。`
  );
}

async function checkCurrentFormContract(root) {
  const {
    buildArchiveFormSeed,
    buildArchiveSuggestion,
    buildCurrentPhotoArchiveServiceForm,
    confirmArchiveSuggestion,
    parseWatermarkRecord,
    resolveCanonicalPhotoResult,
    updateArchiveSuggestion,
    validateRequiredArchiveFields,
    validateSortForm
  } = await import('../src/utils/sortRightPanelState.js');
  const configs = {
    projects: ['潇湘新区二期'],
    watermarkCategories: {
      巡查检查: { items: ['秩序巡查'] },
      机动车违规管理: { items: ['随意停放阻碍通行'] }
    }
  };
  const recognition = {
    photoId: 'photo-form',
    status: 'success',
    success: true,
    rawText: [
      '日期：2026-06-12',
      '时间：16:05',
      '小区名称：潇湘新区二期',
      '工作内容：随意停放阻碍通行'
    ].join('\n')
  };
  const watermark = parseWatermarkRecord(recognition);
  const suggestion = buildArchiveSuggestion(watermark, {
    configs,
    currentProject: '潇湘新区二期'
  });
  assert.equal(watermark.locationText, '', '只有项目名称时，位置/区域必须保持为空');
  assert.equal(suggestion.suggestedFields.location, '', '项目名称不得重复写入位置/区域');
  const validForm = {
    watermarkTemplateType: 'standard_work_record',
    project: '潇湘新区二期',
    date: '2026-06-12',
    watermarkCategory: '巡查检查',
    workContent: '秩序巡查',
    location: '',
    keywords: '',
    remark: ''
  };
  assert.deepEqual(validateSortForm(validForm, configs), [], '项目、归档分类、工作内容和日期全部有效时应通过校验');
  assert.deepEqual(validateRequiredArchiveFields(validForm, configs), [], '工作台四项必填校验应复用生产校验规则');
  assert.deepEqual(
    validateRequiredArchiveFields(validForm, null),
    ['项目', '归档分类', '工作内容'],
    '配置尚未加载时工作台校验不得抛错，配置依赖字段应保持未完成'
  );
  assert.deepEqual(validateSortForm({ ...validForm, project: '' }, configs), ['项目'], '项目为空时应阻止确认和预览');
  assert.deepEqual(validateSortForm({ ...validForm, project: '   ' }, configs), ['项目'], '项目只有空格时应视为空');
  assert.deepEqual(validateSortForm({ ...validForm, project: '未配置项目' }, configs), ['项目'], '项目不在当前配置中时应校验失败');
  const invalidProjectConfirmation = confirmArchiveSuggestion({
    suggestedFields: { ...validForm, project: '未配置项目' }
  }, configs);
  assert.equal(invalidProjectConfirmation.ok, false, '无效项目不得通过归档建议确认');
  assert.deepEqual(invalidProjectConfirmation.missingRequiredFields, ['项目'], '无效项目确认失败时应明确提示项目');
  assert.deepEqual(validateSortForm({ ...validForm, date: '' }, configs), ['日期'], '日期缺失时应保持原有校验失败');
  assert.deepEqual(
    validateSortForm({ ...validForm, watermarkCategory: '' }, configs),
    ['归档分类', '工作内容'],
    '归档分类缺失时分类及其工作内容应校验失败'
  );
  assert.deepEqual(
    validateSortForm({ ...validForm, watermarkCategory: '未配置分类' }, configs),
    ['归档分类', '工作内容'],
    '归档分类无效时分类及其工作内容应校验失败'
  );
  assert.deepEqual(validateSortForm({ ...validForm, workContent: '' }, configs), ['工作内容'], '工作内容缺失时应校验失败');
  assert.deepEqual(validateSortForm({ ...validForm, workContent: '不属于当前分类' }, configs), ['工作内容'], '工作内容不属于当前分类时应校验失败');

  const emptyProjectServiceForm = buildCurrentPhotoArchiveServiceForm({ ...validForm, project: '' }, configs);
  assert.equal(emptyProjectServiceForm.project, '', '项目为空时归档服务表单不得使用首项目兜底');
  assert.notEqual(emptyProjectServiceForm.project, configs.projects[0], '空项目不得静默变成第一个配置项目');
  const validProjectServiceForm = buildCurrentPhotoArchiveServiceForm(validForm, configs);
  assert.equal(validProjectServiceForm.project, validForm.project, '有效项目进入归档服务表单时应保持原值');

  const markiUnmatchedProjectForm = {
    ...validForm,
    project: '',
    projectCandidates: ['马克未匹配项目']
  };
  assert.deepEqual(
    validateRequiredArchiveFields(markiUnmatchedProjectForm, configs),
    ['项目'],
    'Marki 未匹配项目只能保留候选值，不得通过工作台四项必填校验'
  );

  await fs.mkdir(root, { recursive: true });
  const canonicalConfigs = {
    projects: ['测试小区'],
    watermarkCategories: {
      工程: { items: ['电梯故障维修', '消防设施维修'] },
      巡查检查: {
        items: [
          '电梯巡查',
          '消防设施巡查',
          '水泵房巡检',
          '人工复核电梯巡查'
        ]
      }
    }
  };
  const createLocalArtifacts = (photoId, workContent) => {
    const archiveCategory = workContent.includes('维修') ? '工程' : '巡查检查';
    const recognitionResult = {
      photoId,
      status: 'success',
      success: true,
      rawText: [
        '日期：2026-07-19',
        '小区名称：测试小区',
        `水印类型：${archiveCategory}`,
        `工作内容：${workContent}`,
        '工作备注：自检记录'
      ].join('\n')
    };
    const watermarkRecord = parseWatermarkRecord(recognitionResult);
    const archiveSuggestion = buildArchiveSuggestion(watermarkRecord, {
      configs: canonicalConfigs,
      currentProject: '测试小区'
    });
    const photo = {
      id: photoId,
      sourceType: 'local_file',
      originalName: `${photoId}.jpg`,
      originalPath: path.join(root, `${photoId}.jpg`),
      smartSortStatus: 'completed',
      sortStatus: archiveSuggestion.status
    };
    const group = {
      id: `group-${photoId}`,
      title: archiveSuggestion.suggestedFields.workContent,
      basis: 'archive_suggestion_work_content',
      photos: [{
        photoId,
        archiveSuggestion
      }],
      photoCount: 1
    };
    return {
      photo,
      recognitionResult,
      watermarkRecord,
      archiveSuggestion,
      group
    };
  };

  const elevator = createLocalArtifacts('local-elevator-inspection', '电梯巡查');
  assert.equal(elevator.group.title, '电梯巡查', '本地 OCR 左侧分组应读取电梯巡查');
  assert.equal(elevator.archiveSuggestion.suggestedFields.watermarkCategory, '巡查检查', '巡查行为不得按设备对象误判为工程');
  assert.equal(elevator.archiveSuggestion.suggestedFields.workContent, '电梯巡查', '本地 OCR 建议应保留有效电梯巡查工作内容');
  const elevatorCanonical = resolveCanonicalPhotoResult({
    ...elevator,
    configs: canonicalConfigs
  });
  assert.equal(elevatorCanonical.watermarkCategory, '巡查检查', '本地 canonical 分类必须为巡查检查');
  assert.equal(elevatorCanonical.workContent, '电梯巡查', '本地 canonical 工作内容必须为电梯巡查');
  assert.equal(elevatorCanonical.fieldSources.watermarkCategory, 'watermark_exact', '本地 canonical 应保留固定水印分类的精确来源');
  const elevatorForm = buildArchiveFormSeed({
    ...elevator,
    configs: canonicalConfigs
  });
  assert.equal(elevatorForm.watermarkCategory, '巡查检查', '右侧归档分类必须与本地分组一致');
  assert.equal(elevatorForm.workContent, '电梯巡查', '右侧工作内容必须与本地分组一致且不得为空');
  assert.deepEqual(validateSortForm(elevatorForm, canonicalConfigs), [], '本地 canonical 表单四项应通过正式校验');

  const fireInspection = createLocalArtifacts('local-fire-inspection', '消防设施巡查');
  const pumpInspection = createLocalArtifacts('local-pump-inspection', '水泵房巡检');
  const elevatorRepair = createLocalArtifacts('local-elevator-repair', '电梯故障维修');
  assert.equal(fireInspection.archiveSuggestion.suggestedFields.watermarkCategory, '巡查检查', '消防设施巡查应按巡查行为分类');
  assert.equal(pumpInspection.archiveSuggestion.suggestedFields.watermarkCategory, '巡查检查', '水泵房巡检应按巡检行为分类');
  assert.equal(elevatorRepair.archiveSuggestion.suggestedFields.watermarkCategory, '工程', '电梯故障维修应进入维修分类');
  assert.equal(elevatorRepair.archiveSuggestion.suggestedFields.workContent, '电梯故障维修', '维修工作内容必须保持');

  const markiRecognition = {
    photoId: 'marki-canonical',
    source: 'marki_api',
    providerType: 'structured_data',
    status: 'recognized',
    sourceAwareProcessing: {
      platformBaseline: {
        requiredFields: {
          date: '2026-07-19',
          project: '测试小区',
          watermarkCategory: '巡查检查',
          workContent: '消防设施巡查'
        }
      },
      effectiveResult: {
        requiredFields: {
          date: '2026-07-19',
          project: '测试小区',
          watermarkCategory: '巡查检查',
          workContent: '消防设施巡查'
        }
      },
      conflicts: []
    }
  };
  const markiWatermark = {
    photoId: 'marki-canonical',
    captureDate: '2026-07-19',
    projectText: '测试小区',
    watermarkCategoryText: '巡查检查',
    workContentText: '消防设施巡查'
  };
  const markiSuggestion = {
    photoId: 'marki-canonical',
    suggestedFields: {
      date: '2026-07-19',
      project: '测试小区',
      watermarkCategory: '巡查检查',
      workContent: '消防设施巡查'
    },
    fieldSources: {
      date: 'marki_api',
      project: 'marki_api',
      watermarkCategory: 'marki_api',
      workContent: 'marki_api'
    },
    missingRequiredFields: [],
    status: 'suggestion_ready'
  };
  const markiBefore = structuredClone({
    recognitionResult: markiRecognition,
    watermarkRecord: markiWatermark,
    archiveSuggestion: markiSuggestion
  });
  const markiForm = buildArchiveFormSeed({
    photo: {
      id: 'marki-canonical',
      sourceType: 'marki_api'
    },
    recognitionResult: markiRecognition,
    watermarkRecord: markiWatermark,
    archiveSuggestion: markiSuggestion,
    configs: canonicalConfigs
  });
  assert.equal(markiForm.watermarkCategory, '巡查检查', 'Marki 正确分类必须保持');
  assert.equal(markiForm.workContent, '消防设施巡查', 'Marki 正确工作内容必须保持');
  assert.deepEqual(
    {
      recognitionResult: markiRecognition,
      watermarkRecord: markiWatermark,
      archiveSuggestion: markiSuggestion
    },
    markiBefore,
    'canonical 表单适配不得修改 Marki 三个可信对象'
  );

  const switchToFire = buildArchiveFormSeed({
    ...fireInspection,
    configs: canonicalConfigs
  });
  const switchBackToElevator = buildArchiveFormSeed({
    ...elevator,
    configs: canonicalConfigs
  });
  assert.equal(switchToFire.workContent, '消防设施巡查', '切换到消防分组时表单必须使用消防巡查');
  assert.equal(switchBackToElevator.workContent, '电梯巡查', '从消防分组返回后不得残留上一组字段');
  assert.notEqual(switchToFire.workContent, switchBackToElevator.workContent, '两个本地分组表单不得串值');

  const manualElevatorSuggestion = updateArchiveSuggestion(
    elevator.archiveSuggestion,
    { workContent: '人工复核电梯巡查' },
    { configs: canonicalConfigs, photoId: elevator.photo.id }
  );
  const manualElevatorForm = buildArchiveFormSeed({
    ...elevator,
    archiveSuggestion: manualElevatorSuggestion,
    configs: canonicalConfigs
  });
  assert.equal(manualElevatorForm.workContent, '人工复核电梯巡查', '人工草稿必须优先于 canonical 自动结果');
  const afterManualSwitchBack = buildArchiveFormSeed({
    ...elevator,
    archiveSuggestion: manualElevatorSuggestion,
    configs: canonicalConfigs
  });
  assert.equal(afterManualSwitchBack.workContent, '人工复核电梯巡查', '切换后返回必须恢复当前照片人工草稿');

  await fs.writeFile(elevator.photo.originalPath, createTestJpeg(7, 5));
  const snapshotWorkspace = {
    ...createEmptyWorkspace(),
    photos: [elevator.photo],
    selectedIds: [elevator.photo.id],
    activePhotoId: elevator.photo.id,
    recognitionResultsByPhoto: {
      [elevator.photo.id]: elevator.recognitionResult
    },
    watermarkRecordsByPhoto: {
      [elevator.photo.id]: elevator.watermarkRecord
    },
    archiveSuggestionsByPhoto: {
      [elevator.photo.id]: manualElevatorSuggestion
    },
    smartSortResult: {
      id: 'canonical-snapshot-result',
      status: 'created',
      groupCount: 1,
      photoCount: 1,
      groups: [elevator.group]
    },
    smartSortViewMode: 'smartSortGroup',
    activeSmartSortGroupId: elevator.group.id,
    form: manualElevatorForm
  };
  assert.equal((await saveSortWorkspaceSnapshot(root, snapshotWorkspace)).success, true, 'canonical 表单状态应写入自动快照');
  const restoredCanonical = await loadSortWorkspaceSnapshot(root);
  const restoredPhoto = restoredCanonical.snapshot.workspace.photos[0];
  const restoredGroup = restoredCanonical.snapshot.workspace.smartSortResult.groups[0];
  const restoredForm = buildArchiveFormSeed({
    photo: restoredPhoto,
    recognitionResult: restoredCanonical.snapshot.workspace.recognitionResultsByPhoto[restoredPhoto.id],
    watermarkRecord: restoredCanonical.snapshot.workspace.watermarkRecordsByPhoto[restoredPhoto.id],
    archiveSuggestion: restoredCanonical.snapshot.workspace.archiveSuggestionsByPhoto[restoredPhoto.id],
    group: restoredGroup,
    configs: canonicalConfigs
  });
  assert.equal(restoredGroup.title, '电梯巡查', '快照恢复后左侧分组内容必须保持');
  assert.equal(restoredForm.watermarkCategory, '巡查检查', '快照恢复后右侧分类必须与分组一致');
  assert.equal(restoredForm.workContent, '人工复核电梯巡查', '快照恢复后人工草稿必须保持');

  const pageSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'),
    'utf8'
  );
  assert.match(pageSource, /setForm\(buildArchiveFormSeed\(\{/);
  assert.match(pageSource, /group: currentPanelSmartGroup/);
  console.log('统一照片整理结果自检通过：8 个行为场景，25 个行为断言，2 个源码契约断言。');
}

async function checkWatermarkTemplateFormContract(root) {
  const adapter = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/watermarkTemplateAdapter.js')).href}?template-form=${Date.now()}`
  );
  const validation = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/archiveFormValidation.js')).href}?template-form=${Date.now()}`
  );
  const rightPanel = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/sortRightPanelState.js')).href}?template-form=${Date.now()}`
  );
  const sourceAware = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/sourceAwareRecognition.js')).href}?template-form=${Date.now()}`
  );
  const smartGroup = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/smartGroupKey.js')).href}?template-form=${Date.now()}`
  );
  const {
    WATERMARK_TEMPLATE_TYPES,
    NOT_APPLICABLE_WORK_CONTENT,
    buildTemplateDrivenCanonical,
    buildTemplateDrivenFormSeed,
    getAvailableConstructionUnits,
    isolateTemplateSpecificFields
  } = adapter;
  const { validateArchiveFormByTemplate } = validation;

  let scenarioCount = 0;
  let assertionCount = 0;
  let sourceContractCount = 0;
  const check = (condition, message) => {
    assertionCount += 1;
    assert.ok(condition, message);
  };
  const equal = (actual, expected, message) => {
    assertionCount += 1;
    assert.equal(actual, expected, message);
  };
  const deepEqual = (actual, expected, message) => {
    assertionCount += 1;
    assert.deepEqual(actual, expected, message);
  };
  const scenario = (name, callback) => {
    callback();
    scenarioCount += 1;
  };

  await fs.mkdir(root, { recursive: true });
  const legacyConfig = await loadUserConfigs(root);
  const projectOne = {
    id: 'project-current-1',
    name: '潇湘新区二期',
    enabled: true,
    sort: 10,
    isDefault: true,
    description: ''
  };
  const projectTwo = {
    id: 'project-current-2',
    name: '香辰康园',
    enabled: true,
    sort: 20,
    isDefault: false,
    description: ''
  };
  const category = (id, name, items, sort) => ({
    id,
    name,
    enabled: true,
    sort,
    description: '',
    items: items.map((item, index) => ({
      id: `${id}-work-${index + 1}`,
      name: item,
      enabled: true,
      sort: (index + 1) * 10,
      description: '',
      keywords: [],
      remarkTemplate: ''
    }))
  });
  const categories = [
    category('category-safety', '安全管理工作记录', ['安全巡查'], 10),
    category('category-engineering', '工程类工作记录', ['水电设施设备维修'], 20),
    category('category-inspection', '巡查检查工作记录', ['秩序巡查'], 30),
    category('category-time-location', '时间地点水印', ['历史占位工作内容'], 40),
    category('category-vehicle', '机动车违规管理', ['占用消防通道', '随意停放阻碍通行'], 50)
  ];
  const firstUnitVersion = [
    {
      id: 'construction-unit-global',
      name: '通用维保单位',
      aliases: ['通用维保'],
      enabled: true,
      projectIds: []
    },
    {
      id: 'construction-unit-project-one',
      name: '恒安建设',
      aliases: ['恒安施工'],
      enabled: true,
      projectIds: [projectOne.id]
    },
    {
      id: 'construction-unit-disabled',
      name: '停用施工单位',
      aliases: [],
      enabled: false,
      projectIds: []
    }
  ];
  const savedConfig = await saveAllUserConfigs(root, {
    ...legacyConfig.editableConfigs,
    projects: [projectOne, projectTwo],
    constructionUnits: firstUnitVersion,
    watermarkCategories: categories
  });
  const renamedUnits = savedConfig.editableConfigs.constructionUnits.map((item) => (
    item.id === 'construction-unit-project-one'
      ? { ...item, name: '恒安建设集团' }
      : item
  ));
  const loadedConfig = await saveAllUserConfigs(root, {
    ...savedConfig.editableConfigs,
    constructionUnits: renamedUnits
  });
  const configs = loadedConfig.runtimeConfigs;
  const configSnapshot = structuredClone(configs);

  const recognition = (structuredFields, watermarkTemplateName) => ({
    source: 'marki_api',
    providerType: 'structured_data',
    status: 'recognized',
    watermarkTemplateName,
    structuredFields
  });
  const canonical = (structuredFields, watermarkTemplateName) => (
    buildTemplateDrivenCanonical({
      recognitionResult: recognition(structuredFields, watermarkTemplateName),
      configs
    })
  );
  const standardFields = {
    date: '2026-07-19',
    projectOriginalText: projectOne.name,
    communityName: projectOne.name,
    archiveCategory: '巡查检查工作记录',
    workContent: '秩序巡查',
    remarks: '夜班报时打卡',
    propertyCompany: '测试物业公司'
  };
  const engineeringFields = {
    ...standardFields,
    archiveCategory: '工程类工作记录',
    workContent: '水电设施设备维修',
    constructionUnitOriginalText: '恒安建设集团'
  };
  const timeLocationFields = {
    date: '2026-07-19',
    projectOriginalText: projectOne.name,
    communityName: projectOne.name,
    archiveCategory: '时间地点水印',
    locationArea: '地下车库负一层',
    propertyCompany: '测试物业公司'
  };
  const vehicleFields = {
    date: '2026-07-19',
    projectOriginalText: projectOne.name,
    communityName: projectOne.name,
    archiveCategory: '机动车违规管理',
    vehiclePlate: '云D12345',
    violationType: '占用消防通道',
    propertyCompany: '测试物业公司'
  };
  const standardCanonical = canonical(standardFields, '巡查检查工作记录');
  const engineeringCanonical = canonical(engineeringFields, '工程类工作记录');
  const timeCanonical = canonical(timeLocationFields, '时间地点水印');
  const vehicleCanonical = canonical(vehicleFields, '机动车违规管理');

  scenario('1 当前分类配置由 configService 读取', () => {
    deepEqual(
      Object.keys(configs.watermarkCategories),
      categories.map((item) => item.name),
      '运行时分类必须来自 configService 当前启用配置'
    );
  });
  scenario('2 当前配置同名精确匹配', () => {
    equal(standardCanonical.archiveCategory, '巡查检查工作记录', '当前正式分类应精确匹配');
    equal(standardCanonical.workContent, '秩序巡查', '工作内容应在当前分类下精确匹配');
  });
  scenario('3 未登记分类保持 unresolved', () => {
    const result = canonical({ ...standardFields, archiveCategory: '巡查检查类' }, '巡查检查类');
    equal(result.archiveCategory, '', '未登记旧分类名称不得自动兼容');
    check(result.unresolvedFields.includes('archiveCategory'), '未登记分类应进入 unresolvedFields');
  });
  scenario('4 不创建旧名称别名', () => {
    const result = mapMarkiMoment({
      id: 'old-category-name',
      uid: 1,
      teamId: 1,
      momentType: 1,
      markName: '时间地点（兜底选择）',
      content: JSON.stringify([
        ['日期', '2026-07-19'],
        ['小区名称', projectOne.name],
        ['地点', '一号门']
      ]),
      postTime: 1784390400
    }, configs);
    equal(result.suggestedFields.watermarkCategory, '', 'Marki 当前运行链不得维护旧分类别名');
  });
  scenario('5 映射不修改当前配置', () => {
    deepEqual(configs, configSnapshot, '模板映射不得修改运行时配置');
  });

  scenario('6 旧配置无施工单位安全读取', () => {
    deepEqual(legacyConfig.editableConfigs.constructionUnits, [], '旧 projects 数组配置应读取为空施工单位');
  });
  scenario('7 新增施工单位持久化', () => {
    equal(configs.constructionUnits.length, 3, '施工单位应通过现有 configService 持久化');
  });
  scenario('8 施工单位完整字段恢复', () => {
    const restored = configs.constructionUnits.find((item) => item.id === 'construction-unit-project-one');
    equal(restored.name, '恒安建设集团', '正式名称应恢复');
    deepEqual(restored.aliases, ['恒安施工'], '别名应恢复');
    deepEqual(restored.projectIds, [projectOne.id], '项目稳定 ID 关联应恢复');
  });
  scenario('9 停用项不进入新选择', () => {
    check(
      !getAvailableConstructionUnits(configs, projectOne.id)
        .some((item) => item.id === 'construction-unit-disabled'),
      '停用施工单位不得进入新的普通选择列表'
    );
  });
  scenario('10 全局施工单位可用于所有项目', () => {
    check(
      getAvailableConstructionUnits(configs, projectTwo.id)
        .some((item) => item.id === 'construction-unit-global'),
      'projectIds 为空的施工单位应对所有项目可用'
    );
  });
  scenario('11 项目关联单位仅用于对应项目', () => {
    check(
      getAvailableConstructionUnits(configs, projectOne.id)
        .some((item) => item.id === 'construction-unit-project-one'),
      '项目关联施工单位应在对应项目可选'
    );
    check(
      !getAvailableConstructionUnits(configs, projectTwo.id)
        .some((item) => item.id === 'construction-unit-project-one'),
      '项目关联施工单位不得在其他项目可选'
    );
  });
  scenario('12 名称修改不改变稳定 ID', () => {
    equal(
      configs.constructionUnits.find((item) => item.name === '恒安建设集团')?.id,
      'construction-unit-project-one',
      '施工单位修改名称后稳定 ID 必须保持'
    );
  });
  scenario('13 不自动生成示例单位', () => {
    equal(legacyConfig.editableConfigs.constructionUnits.length, 0, '旧配置加载不得自动生成示例施工单位');
  });

  scenario('14 普通工作记录精确匹配分类和内容', () => {
    equal(standardCanonical.watermarkTemplateType, WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD, '普通工作记录模板应识别');
    equal(standardCanonical.archiveCategory, '巡查检查工作记录', '固定水印类型应保持');
    equal(standardCanonical.workContent, '秩序巡查', '固定工作内容应保持');
  });
  scenario('15 工作备注完整进入 remarks', () => {
    equal(standardCanonical.remarks, '夜班报时打卡', '工作备注原文应完整进入 remarks');
  });
  scenario('16 工作备注不默认移动到位置', () => {
    equal(standardCanonical.locationArea, '', '普通工作备注不得默认搬入 locationArea');
  });

  scenario('17 工程类仍是标准工作记录模板', () => {
    equal(engineeringCanonical.watermarkTemplateType, WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD, '工程类不得成为第四种模板');
  });
  scenario('18 工程分类精确匹配', () => {
    equal(engineeringCanonical.archiveCategory, '工程类工作记录', '工程类应使用当前正式分类名称');
  });
  scenario('19 施工单位与物业公司分别解析', () => {
    equal(engineeringCanonical.constructionUnitName, '恒安建设集团', '施工单位应进入独立字段');
    equal(engineeringCanonical.propertyCompany, '测试物业公司', '物业公司应保持独立来源字段');
    check(engineeringCanonical.constructionUnitName !== engineeringCanonical.propertyCompany, '施工单位不得使用物业公司冒充');
  });
  scenario('20 施工单位正式名称精确匹配', () => {
    equal(engineeringCanonical.constructionUnitId, 'construction-unit-project-one', '正式名称应匹配稳定 ID');
    equal(engineeringCanonical.constructionUnitSource, 'watermark_match', '可靠匹配应标记水印匹配来源');
  });
  scenario('21 施工单位 alias 精确匹配', () => {
    const result = canonical({
      ...engineeringFields,
      constructionUnitOriginalText: '恒安施工'
    }, '工程类工作记录');
    equal(result.constructionUnitId, 'construction-unit-project-one', '施工单位 alias 应精确匹配');
  });
  scenario('22 无匹配施工单位保留原文', () => {
    const result = canonical({
      ...engineeringFields,
      constructionUnitOriginalText: '未登记施工单位'
    }, '工程类工作记录');
    equal(result.constructionUnitId, '', '无可靠匹配时不得自动选择');
    equal(result.constructionUnitOriginalText, '未登记施工单位', '无匹配时应保留水印原文');
    equal(result.constructionUnitConfirmed, false, '无匹配时不得确认');
  });
  scenario('23 施工单位占位文本视为缺失', () => {
    const result = canonical({
      ...engineeringFields,
      constructionUnitOriginalText: '请选择'
    }, '工程类工作记录');
    equal(result.constructionUnitOriginalText, '', '占位文字不得当作施工单位值');
    check(result.unresolvedFields.includes('constructionUnit'), '占位单位应保持 unresolved');
  });
  scenario('24 工程类缺施工单位校验失败', () => {
    const result = canonical({
      ...engineeringFields,
      constructionUnitOriginalText: ''
    }, '工程类工作记录');
    deepEqual(validateArchiveFormByTemplate(result, configs), ['施工单位'], '工程类缺单位应只提示施工单位');
  });
  scenario('25 人工选择施工单位后校验通过', () => {
    const result = canonical({
      ...engineeringFields,
      constructionUnitOriginalText: '未登记施工单位'
    }, '工程类工作记录');
    const manual = {
      ...result,
      constructionUnitId: 'construction-unit-project-one',
      constructionUnitName: '恒安建设集团',
      constructionUnitConfirmed: true,
      constructionUnitSource: 'manual'
    };
    deepEqual(validateArchiveFormByTemplate(manual, configs), [], '人工选择正式施工单位后应通过');
    equal(manual.constructionUnitOriginalText, '未登记施工单位', '人工选择不得覆盖原始水印文本');
  });

  scenario('26 时间地点模板识别', () => {
    equal(timeCanonical.watermarkTemplateType, WATERMARK_TEMPLATE_TYPES.TIME_LOCATION, '时间地点模板应可靠识别');
  });
  scenario('27 时间地点分类精确匹配', () => {
    equal(timeCanonical.archiveCategory, '时间地点水印', '时间地点分类应来自当前配置');
  });
  scenario('28 时间地点工作内容不适用', () => {
    equal(timeCanonical.workContent, NOT_APPLICABLE_WORK_CONTENT, '时间地点应使用稳定不适用语义');
  });
  scenario('29 时间地点不提示工作内容缺失', () => {
    deepEqual(validateArchiveFormByTemplate(timeCanonical, configs), [], '时间地点三项完整时应通过校验');
  });
  scenario('30 时间地点地址进入位置', () => {
    equal(timeCanonical.locationArea, '地下车库负一层', '时间地点地址应进入 locationArea');
  });
  scenario('31 时间地点不携带专用字段', () => {
    const isolated = isolateTemplateSpecificFields({
      ...timeCanonical,
      constructionUnitId: 'stale-unit',
      constructionUnitName: '串值单位',
      vehiclePlate: '云D00000',
      violationType: '占用消防通道'
    });
    equal(isolated.constructionUnitId, '', '时间地点不得携带施工单位');
    equal(isolated.vehiclePlate, '', '时间地点不得携带车牌');
    equal(isolated.violationType, '', '时间地点不得携带违停类型');
  });

  scenario('32 机动车专用模板识别', () => {
    equal(vehicleCanonical.watermarkTemplateType, WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION, '机动车专用模板应可靠识别');
  });
  scenario('33 机动车分类精确匹配', () => {
    equal(vehicleCanonical.archiveCategory, '机动车违规管理', '机动车分类应来自当前配置');
  });
  scenario('34 车牌独立保存', () => {
    equal(vehicleCanonical.vehiclePlate, '云D12345', '车牌必须保存在独立字段');
  });
  scenario('35 违停类型独立保存', () => {
    equal(vehicleCanonical.violationType, '占用消防通道', '违停类型必须保存在独立字段');
  });
  scenario('36 违停类型按当前分类精确匹配', () => {
    const unresolved = canonical({
      ...vehicleFields,
      violationType: '未配置违停类型'
    }, '机动车违规管理');
    equal(unresolved.violationType, '', '未配置违停类型不得模糊匹配');
  });
  scenario('37 公共工作内容同步违停类型', () => {
    equal(vehicleCanonical.workContent, vehicleCanonical.violationType, '机动车公共工作内容应同步违停类型');
  });
  scenario('38 机动车缺车牌校验失败', () => {
    const missingPlate = canonical({
      ...vehicleFields,
      vehiclePlate: ''
    }, '机动车违规管理');
    deepEqual(
      validateArchiveFormByTemplate(missingPlate, configs),
      ['车牌号码'],
      '机动车缺车牌应阻止后续预览'
    );
  });
  scenario('39 机动车缺违停类型校验失败', () => {
    const missingViolation = canonical({
      ...vehicleFields,
      violationType: ''
    }, '机动车违规管理');
    deepEqual(
      validateArchiveFormByTemplate(missingViolation, configs),
      ['违停类型'],
      '机动车缺违停类型应阻止后续预览'
    );
  });
  scenario('40 机动车不携带施工单位', () => {
    equal(vehicleCanonical.constructionUnitId, '', '机动车模板不得携带施工单位');
  });

  scenario('41 项目可靠匹配自动选择正式值', () => {
    equal(standardCanonical.projectId, projectOne.id, '可靠项目应匹配稳定 ID');
    equal(standardCanonical.projectName, projectOne.name, '可靠项目应匹配正式名称');
  });
  scenario('42 项目无匹配时保持待选择', () => {
    const result = canonical({
      ...standardFields,
      projectOriginalText: '未登记小区',
      communityName: '未登记小区'
    }, '巡查检查工作记录');
    equal(result.projectId, '', '无可靠项目不得自动选择');
    equal(result.projectName, '', '无可靠项目名称应为空');
    check(result.unresolvedFields.includes('project'), '无匹配项目应保持 unresolved');
  });
  scenario('43 人工项目选择后校验通过', () => {
    const result = canonical({
      ...standardFields,
      projectOriginalText: '未登记小区',
      communityName: '未登记小区'
    }, '巡查检查工作记录');
    deepEqual(validateArchiveFormByTemplate({
      ...result,
      project: projectOne.name,
      projectId: projectOne.id,
      projectName: projectOne.name,
      projectConfirmed: true,
      projectSource: 'manual'
    }, configs), [], '人工选择正式项目后应通过');
  });
  scenario('44 项目不得默认选择首项', () => {
    const result = canonical({
      ...standardFields,
      projectOriginalText: '',
      communityName: ''
    }, '巡查检查工作记录');
    equal(result.projectName, '', '项目为空时不得使用首项目兜底');
    check(result.projectName !== configs.projects[0], '首项目不得静默进入正式字段');
  });
  scenario('45 项目原始文本保留', () => {
    const result = canonical({
      ...standardFields,
      projectOriginalText: '未登记小区',
      communityName: '未登记小区'
    }, '巡查检查工作记录');
    equal(result.projectOriginalText, '未登记小区', '项目匹配失败时应保留原始小区名称');
  });
  scenario('46 不同分组项目草稿不串值', () => {
    const draftOne = buildTemplateDrivenFormSeed(standardCanonical, {
      project: projectTwo.name,
      projectId: projectTwo.id,
      projectName: projectTwo.name,
      projectConfirmed: true,
      projectSource: 'manual'
    });
    const draftTwo = buildTemplateDrivenFormSeed(standardCanonical, {
      project: projectOne.name,
      projectId: projectOne.id,
      projectName: projectOne.name,
      projectConfirmed: true,
      projectSource: 'manual'
    });
    equal(draftOne.projectId, projectTwo.id, '第一分组应保留自己的项目草稿');
    equal(draftTwo.projectId, projectOne.id, '第二分组应保留自己的项目草稿');
  });

  scenario('47 工程普通切换保留工程草稿并隔离当前值', () => {
    const engineeringDraft = buildTemplateDrivenFormSeed(engineeringCanonical, {
      constructionUnitId: 'construction-unit-project-one',
      constructionUnitName: '恒安建设集团',
      constructionUnitConfirmed: true,
      constructionUnitSource: 'manual'
    });
    const ordinary = isolateTemplateSpecificFields(standardCanonical);
    const engineeringBack = buildTemplateDrivenFormSeed(engineeringCanonical, engineeringDraft);
    equal(ordinary.constructionUnitId, '', '普通工作记录当前表单不得携带施工单位');
    equal(engineeringBack.constructionUnitId, 'construction-unit-project-one', '切回工程分组应恢复单位草稿');
  });
  scenario('48 机动车时间地点切换保留机动车草稿', () => {
    const vehicleDraft = buildTemplateDrivenFormSeed(vehicleCanonical, {
      vehiclePlate: '云D88888',
      violationType: '随意停放阻碍通行',
      workContent: '随意停放阻碍通行'
    });
    const timeForm = isolateTemplateSpecificFields(timeCanonical);
    const vehicleBack = buildTemplateDrivenFormSeed(vehicleCanonical, vehicleDraft);
    equal(timeForm.vehiclePlate, '', '时间地点当前表单不得携带车牌');
    equal(vehicleBack.vehiclePlate, '云D88888', '切回机动车分组应恢复车牌草稿');
    equal(vehicleBack.violationType, '随意停放阻碍通行', '切回机动车分组应恢复违停草稿');
  });
  scenario('49 专用字段不串入其他模板', () => {
    const standard = isolateTemplateSpecificFields({
      ...standardCanonical,
      vehiclePlate: '云D99999',
      violationType: '占用消防通道',
      constructionUnitId: 'stale'
    });
    equal(standard.vehiclePlate, '', '普通模板不得携带机动车字段');
    equal(standard.constructionUnitId, '', '非工程普通模板不得携带施工单位');
  });

  const markiMapped = mapMarkiMoment({
    id: 'marki-template-complete',
    uid: 100,
    teamId: 200,
    momentType: 1,
    markName: '巡查检查工作记录',
    content: JSON.stringify([
      ['日期', '2026-07-19 08:30:00'],
      ['小区名称', projectOne.name],
      ['工作内容', '秩序巡查'],
      ['工作备注', '夜班报时打卡'],
      ['物业公司', '测试物业公司']
    ]),
    postTime: 1784390400
  }, configs);
  const markiPhoto = {
    id: 'marki-template-complete',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:test:template-complete'
  };
  const markiRecognition = {
    photoId: markiPhoto.id,
    source: 'marki_api',
    providerType: 'structured_data',
    status: 'recognized',
    watermarkTemplateName: markiMapped.watermarkTemplateName,
    structuredFields: markiMapped.structuredFields,
    parsedWatermark: markiMapped.parsedFields,
    missingRequiredFields: []
  };
  const markiWatermark = {
    photoId: markiPhoto.id,
    ...markiMapped.watermarkRecord
  };
  const markiSuggestion = {
    photoId: markiPhoto.id,
    source: 'marki_api',
    suggestedFields: markiMapped.suggestedFields,
    fieldSources: markiMapped.fieldSources,
    missingRequiredFields: [],
    status: 'suggestion_ready'
  };
  const markiBefore = structuredClone({
    recognition: markiRecognition,
    watermark: markiWatermark,
    suggestion: markiSuggestion
  });
  let ocrCallCount = 0;
  let ocrAvailabilityCount = 0;
  const markiRecognitionResult = await sourceAware.orchestrateSourceAwareRecognition({
    photos: [markiPhoto],
    recognitionResultsByPhoto: { [markiPhoto.id]: markiRecognition },
    watermarkRecordsByPhoto: { [markiPhoto.id]: markiWatermark },
    archiveSuggestionsByPhoto: { [markiPhoto.id]: markiSuggestion },
    getOcrAvailability: async () => {
      ocrAvailabilityCount += 1;
      return { available: false };
    },
    recognizePhoto: async () => {
      ocrCallCount += 1;
      throw new Error('完整 Marki 不得调用 OCR');
    },
    buildOcrArtifacts: () => {
      throw new Error('完整 Marki 不得构建 OCR 产物');
    },
    generateGroups: async () => ({
      status: 'created',
      groups: [{
        id: 'platform-group',
        photos: [{ photoId: markiPhoto.id }]
      }]
    })
  });
  scenario('50 完整 Marki OCR 为零', () => {
    equal(ocrCallCount, 0, '完整 Marki 不得执行 OCR');
    equal(ocrAvailabilityCount, 0, '完整 Marki 不得检查 OCR 服务');
    equal(markiRecognitionResult.stats.platformOnlyCount, 1, '完整 Marki 应直接使用平台数据');
  });
  scenario('51 Marki 平台可信对象保持不变', () => {
    deepEqual(markiRecognitionResult.recognitionResultsByPhoto[markiPhoto.id], markiBefore.recognition, '平台 recognition 应深比较不变');
    deepEqual(markiRecognitionResult.watermarkRecordsByPhoto[markiPhoto.id], markiBefore.watermark, '平台 watermark 应深比较不变');
    deepEqual(markiRecognitionResult.archiveSuggestionsByPhoto[markiPhoto.id], markiBefore.suggestion, '平台 suggestion 应深比较不变');
  });
  scenario('52 Marki 专用字段进入统一 canonical', () => {
    const mappedEngineering = canonical({
      ...engineeringFields,
      constructionUnitOriginalText: '恒安施工'
    }, '工程类工作记录');
    equal(mappedEngineering.constructionUnitId, 'construction-unit-project-one', 'Marki 工程单位应进入统一 canonical');
    equal(vehicleCanonical.vehiclePlate, '云D12345', 'Marki 车牌应进入统一 canonical');
  });

  const localEngineeringRecognition = {
    photoId: 'local-template-engineering',
    status: 'success',
    success: true,
    rawText: [
      '日期：2026-07-19',
      `小区名称：${projectOne.name}`,
      '水印类型：工程类工作记录',
      '工作内容：水电设施设备维修',
      '工作备注：设备运行正常',
      '施工单位：恒安施工',
      '物业公司：测试物业公司'
    ].join('\n')
  };
  const localEngineeringWatermark = rightPanel.parseWatermarkRecord(localEngineeringRecognition);
  const localEngineeringSuggestion = rightPanel.buildArchiveSuggestion(
    localEngineeringWatermark,
    { configs }
  );
  const localEngineeringCanonical = buildTemplateDrivenCanonical({
    recognitionResult: localEngineeringRecognition,
    watermarkRecord: localEngineeringWatermark,
    configs
  });
  scenario('53 本地 OCR 明确标签正确解析', () => {
    equal(localEngineeringCanonical.archiveCategory, '工程类工作记录', '本地明确水印类型应精确映射');
    equal(localEngineeringCanonical.constructionUnitId, 'construction-unit-project-one', '本地明确施工单位标签应匹配');
    equal(localEngineeringSuggestion.suggestedFields.watermarkTemplateType, WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD, '本地建议应持久化模板类型');
    equal(localEngineeringSuggestion.suggestedFields.constructionUnitId, 'construction-unit-project-one', '本地建议应持久化施工单位');
  });
  scenario('54 物业公司不冒充施工单位', () => {
    const withoutUnit = buildTemplateDrivenCanonical({
      recognitionResult: {
        ...localEngineeringRecognition,
        rawText: localEngineeringRecognition.rawText
          .split('\n')
          .filter((line) => !line.startsWith('施工单位：'))
          .join('\n')
      },
      configs
    });
    equal(withoutUnit.propertyCompany, '测试物业公司', '物业公司来源值应保留');
    equal(withoutUnit.constructionUnitId, '', '物业公司不得匹配为施工单位');
  });
  scenario('55 本地分组与右侧表单使用同一 canonical', () => {
    const descriptor = smartGroup.buildSmartGroupDescriptor({
      photo: { id: 'local-template-engineering', sourceType: 'local_file' },
      canonicalFields: localEngineeringCanonical
    });
    const form = rightPanel.buildArchiveFormSeed({
      photo: { id: 'local-template-engineering', sourceType: 'local_file' },
      recognitionResult: localEngineeringRecognition,
      watermarkRecord: localEngineeringWatermark,
      configs
    });
    equal(descriptor.fields.watermarkCategory, form.watermarkCategory, '左侧分组和右侧表单分类应一致');
    equal(descriptor.fields.workContent, form.workContent, '左侧分组和右侧表单工作内容应一致');
  });
  scenario('56 固定分类不被泛化关键词覆盖', () => {
    const result = canonical({
      ...standardFields,
      remarks: '已通知工程处理，消防设备运行正常'
    }, '巡查检查工作记录');
    equal(result.archiveCategory, '巡查检查工作记录', '备注关键词不得覆盖水印固定分类');
  });

  const snapshotForms = [
    standardCanonical,
    {
      ...engineeringCanonical,
      constructionUnitSource: 'manual'
    },
    timeCanonical,
    {
      ...vehicleCanonical,
      vehiclePlate: '云D88888'
    }
  ];
  const snapshotPhotos = [];
  const snapshotSuggestions = {};
  for (let index = 0; index < snapshotForms.length; index += 1) {
    const photoId = `template-snapshot-${index + 1}`;
    const originalPath = path.join(root, `${photoId}.jpg`);
    await fs.writeFile(originalPath, createTestJpeg(8 + index, 6 + index));
    snapshotPhotos.push({
      id: photoId,
      sourceType: 'local_file',
      originalName: `${photoId}.jpg`,
      originalPath,
      smartSortStatus: 'completed',
      sortStatus: 'suggestion_ready'
    });
    snapshotSuggestions[photoId] = {
      photoId,
      suggestedFields: snapshotForms[index],
      fieldSources: snapshotForms[index].fieldSources,
      missingRequiredFields: validateArchiveFormByTemplate(snapshotForms[index], configs),
      status: 'suggestion_ready'
    };
  }
  const snapshotWorkspace = {
    ...createEmptyWorkspace(),
    photos: snapshotPhotos,
    selectedIds: snapshotPhotos.map((photo) => photo.id),
    activePhotoId: snapshotPhotos[0].id,
    archiveSuggestionsByPhoto: snapshotSuggestions,
    form: snapshotForms[3]
  };
  const snapshotSave = await saveSortWorkspaceSnapshot(root, snapshotWorkspace);
  scenario('57 四种表单形态写入快照', () => {
    equal(snapshotSave.success, true, '四种表单形态应写入自动快照');
  });
  const snapshotLoad = await loadSortWorkspaceSnapshot(root);
  scenario('58 全新实例恢复快照', () => {
    equal(snapshotLoad.success, true, '全新实例应读取自动快照');
    equal(snapshotLoad.found, true, '快照应真实恢复');
  });
  scenario('59 专用字段和人工草稿恢复', () => {
    const restoredSuggestions = snapshotLoad.snapshot.workspace.archiveSuggestionsByPhoto;
    equal(restoredSuggestions['template-snapshot-2'].suggestedFields.constructionUnitId, 'construction-unit-project-one', '工程单位应恢复');
    equal(restoredSuggestions['template-snapshot-3'].suggestedFields.workContent, NOT_APPLICABLE_WORK_CONTENT, '时间地点不适用语义应恢复');
    equal(restoredSuggestions['template-snapshot-4'].suggestedFields.vehiclePlate, '云D88888', '机动车人工车牌应恢复');
  });
  scenario('60 快照恢复后条件校验一致', () => {
    for (const item of Object.values(snapshotLoad.snapshot.workspace.archiveSuggestionsByPhoto)) {
      deepEqual(
        validateArchiveFormByTemplate(item.suggestedFields, configs),
        [],
        '快照恢复后各模板条件校验应保持'
      );
    }
  });
  scenario('61 快照恢复不调用网络或 OCR', () => {
    equal(ocrCallCount, 0, '快照测试不得调用 OCR');
    equal(ocrAvailabilityCount, 0, '快照测试不得检查 OCR 网络服务');
  });

  scenario('62 时间地点分组使用 not_applicable', () => {
    const descriptor = smartGroup.buildSmartGroupDescriptor({
      photo: { id: 'time-location-group' },
      canonicalFields: timeCanonical
    });
    equal(descriptor.fields.workContent, NOT_APPLICABLE_WORK_CONTENT, '时间地点分组应使用稳定不适用签名');
  });
  scenario('63 不同日期继续硬拆组', () => {
    const first = smartGroup.buildSmartGroupKey({
      ...standardCanonical,
      date: '2026-07-19'
    });
    const second = smartGroup.buildSmartGroupKey({
      ...standardCanonical,
      date: '2026-07-20'
    });
    check(first !== second, '不同日期的四维分组键必须不同');
  });
  scenario('64 同四维字段保持当前分组语义', () => {
    const first = smartGroup.buildSmartGroupKey(standardCanonical);
    const second = smartGroup.buildSmartGroupKey({ ...standardCanonical });
    equal(first, second, '同日期、项目、分类和内容应生成稳定相同分组键');
  });
  scenario('65 专用字段不改变四维分组键', () => {
    const engineeringOne = smartGroup.buildSmartGroupKey(engineeringCanonical);
    const engineeringTwo = smartGroup.buildSmartGroupKey({
      ...engineeringCanonical,
      constructionUnitId: 'another-unit',
      constructionUnitName: '另一施工单位'
    });
    const vehicleOne = smartGroup.buildSmartGroupKey(vehicleCanonical);
    const vehicleTwo = smartGroup.buildSmartGroupKey({
      ...vehicleCanonical,
      vehiclePlate: '云D00000'
    });
    equal(engineeringOne, engineeringTwo, '施工单位不得自行加入四维分组键');
    equal(vehicleOne, vehicleTwo, '车牌不得自行加入四维分组键');
  });

  const configManagerSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'components', 'ConfigManager.jsx'),
    'utf8'
  );
  const pageSource = await fs.readFile(
    path.join(process.cwd(), 'src', 'pages', 'SortWorkspacePage.jsx'),
    'utf8'
  );
  const structuredImportSource = await fs.readFile(
    path.join(process.cwd(), 'electron', 'services', 'markiStructuredImportService.cjs'),
    'utf8'
  );
  const sourceCheck = (condition, message) => {
    sourceContractCount += 1;
    assert.ok(condition, message);
  };
  sourceCheck(configManagerSource.includes("key: 'constructionUnits'"), '设置页必须提供施工单位配置入口');
  sourceCheck(configManagerSource.includes('projectIds'), '施工单位配置必须按稳定项目 ID 关联');
  sourceCheck(pageSource.includes('label="项目"'), '右侧表单必须提供项目选择控件');
  sourceCheck(pageSource.includes('currentIsTimeLocation'), '右侧表单必须按时间地点模板条件显示');
  sourceCheck(pageSource.includes('currentIsVehicleViolation'), '右侧表单必须按机动车模板条件显示');
  sourceCheck(pageSource.includes('currentIsEngineering'), '右侧表单必须按工程分类显示施工单位');
  sourceCheck(structuredImportSource.includes("'时间地点兜底选择': '时间地点水印'") === false, '生产链不得维护旧分类别名');
  sourceCheck(pageSource.includes('configs.projects[0]') === false, '项目控件不得静默选择首项目');

  equal(scenarioCount, 65, '水印模板和条件表单应完整执行 65 个行为场景');
  console.log(
    `水印模板与条件表单自检通过：${scenarioCount} 个行为场景，${assertionCount} 个行为断言，${sourceContractCount} 个源码契约断言。`
  );
}

async function checkSmartClassificationBusinessClosure(root) {
  const adapter = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/watermarkTemplateAdapter.js')).href}?business-closure=${Date.now()}`
  );
  const canonicalModule = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/photoCanonical.js')).href}?business-closure=${Date.now()}`
  );
  const groupKeyModule = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/smartGroupKey.js')).href}?business-closure=${Date.now()}`
  );
  const groupBuilderModule = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/smartGroupBuilder.js')).href}?business-closure=${Date.now()}`
  );
  const validationModule = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/archiveFormValidation.js')).href}?business-closure=${Date.now()}`
  );
  const {
    WATERMARK_TEMPLATE_TYPES,
    NOT_APPLICABLE_WORK_CONTENT,
    resolveWatermarkTemplateType
  } = adapter;
  const {
    buildCanonicalArchiveFormSeed,
    buildGroupCanonical,
    buildSourceCanonical,
    resolveEffectivePhotoArchiveInfo
  } = canonicalModule;
  const {
    buildSmartGroupDescriptor
  } = groupKeyModule;
  const {
    migrateGroupDraftsByGroupKey,
    rebuildSmartSortResult
  } = groupBuilderModule;
  const { validateArchiveFormByTemplate } = validationModule;

  const configs = {
    projects: ['潇湘新区二期', '香辰康园'],
    projectOptions: [
      { id: 'project-xiao-xiang', name: '潇湘新区二期' },
      { id: 'project-xiang-chen', name: '香辰康园' }
    ],
    watermarkCategories: {
      工程类工作记录: { items: ['电梯维修维保'] },
      安全管理工作记录: { items: ['治理飞线充电'] },
      时间地点水印: { items: ['标题/内容自定义'] },
      机动车违规管理: { items: ['占用消防通道'] }
    },
    constructionUnits: [
      {
        id: 'unit-a',
        name: '示例施工单位',
        enabled: true,
        projectIds: ['project-xiao-xiang'],
        aliases: []
      }
    ]
  };
  const source = (templateName, fields = {}, extra = {}) => ({
    photo: {
      id: extra.photoId || 'photo-1',
      sourceType: extra.sourceType || 'marki_api',
      originalPath: path.join(root, `${extra.photoId || 'photo-1'}.jpg`)
    },
    recognitionResult: {
      source: extra.sourceType || 'marki_api',
      providerType: extra.sourceType === 'local_file' ? 'ocr' : 'structured_data',
      watermarkTemplateName: templateName,
      structuredFields: {
        ...fields
      },
      rawText: extra.rawText || ''
    },
    watermarkRecord: {
      watermarkTemplateName: templateName,
      captureDate: fields.date || '',
      projectText: fields.projectOriginalText || fields.communityName || '',
      watermarkCategoryText: fields.archiveCategory || '',
      workContentText: fields.workContent || '',
      locationText: fields.locationArea || '',
      remarkText: fields.remarks || '',
      rawText: extra.rawText || ''
    },
    configs
  });
  const complete = {
    date: '2026-07-20',
    projectOriginalText: '潇湘新区二期',
    archiveCategory: '安全管理工作记录',
    workContent: '治理飞线充电',
    locationArea: '地下车库',
    remarks: '现场已处理'
  };
  let scenarioCount = 0;
  let behaviorAssertions = 0;
  let snapshotAssertions = 0;
  let markiZeroIoAssertions = 0;
  let sourceContractAssertions = 0;
  const equal = (actual, expected, message) => {
    behaviorAssertions += 1;
    assert.equal(actual, expected, message);
  };
  const ok = (value, message) => {
    behaviorAssertions += 1;
    assert.ok(value, message);
  };
  const deepEqual = (actual, expected, message) => {
    behaviorAssertions += 1;
    assert.deepEqual(actual, expected, message);
  };
  const scenario = async (name, callback) => {
    await callback();
    scenarioCount += 1;
    assert.ok(name);
  };

  const templateCases = [
    ['标准工作记录标题', source('安全管理工作记录', complete), WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD],
    ['工程仍为标准工作记录', source('工程类工作记录', { ...complete, archiveCategory: '工程类工作记录', workContent: '电梯维修维保', constructionUnitOriginalText: '示例施工单位' }), WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD],
    ['时间地点可信标题', source('时间地点（兜底选择）', { date: complete.date, projectOriginalText: complete.projectOriginalText, locationArea: '南门' }), WATERMARK_TEMPLATE_TYPES.TIME_LOCATION],
    ['机动车可信标题', source('机动车违规管理', { ...complete, archiveCategory: '机动车违规管理', vehiclePlate: '湘A12345', violationType: '占用消防通道' }), WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION],
    ['机动车双字段', source('', { vehiclePlate: '湘A12345', violationType: '占用消防通道' }), WATERMARK_TEMPLATE_TYPES.VEHICLE_VIOLATION],
    ['单个车辆词不判机动车', source('', {}, { rawText: '车辆停放巡查' }), WATERMARK_TEMPLATE_TYPES.UNRESOLVED],
    ['分类不能反推机动车', { watermarkRecord: { watermarkCategoryText: '机动车违规管理' } }, WATERMARK_TEMPLATE_TYPES.UNRESOLVED],
    ['分类不能反推时间地点', { watermarkRecord: { watermarkCategoryText: '时间地点水印', captureDate: complete.date, locationText: '南门' } }, WATERMARK_TEMPLATE_TYPES.UNRESOLVED],
    ['OCR 明确时间地点标题', source('', { date: complete.date, locationArea: '南门' }, { rawText: '时间地点水印\n地址：南门' }), WATERMARK_TEMPLATE_TYPES.TIME_LOCATION],
    ['OCR 明确工作记录标题', source('', { workContent: '治理飞线充电' }, { rawText: '安全管理工作记录\n工作内容：治理飞线充电' }), WATERMARK_TEMPLATE_TYPES.STANDARD_WORK_RECORD]
  ];
  for (const [name, input, expected] of templateCases) {
    await scenario(name, () => equal(resolveWatermarkTemplateType(input), expected, name));
  }

  const canonicalCases = [
    ['项目精确匹配', source('安全管理工作记录', complete), 'projectName', '潇湘新区二期'],
    ['项目 NFKC 空白规范化', source('安全管理工作记录', { ...complete, projectOriginalText: ' 潇湘新区二期 ' }), 'projectName', '潇湘新区二期'],
    ['项目不模糊包含', source('安全管理工作记录', { ...complete, projectOriginalText: '潇湘新区' }), 'projectName', ''],
    ['项目不使用默认首项', source('安全管理工作记录', { ...complete, projectOriginalText: '' }), 'projectName', ''],
    ['分类精确匹配', source('安全管理工作记录', complete), 'archiveCategory', '安全管理工作记录'],
    ['分类不模糊包含', source('安全管理工作记录', { ...complete, archiveCategory: '安全管理' }), 'archiveCategory', ''],
    ['工作内容分类内精确匹配', source('安全管理工作记录', complete), 'workContent', '治理飞线充电'],
    ['工作内容不得跨分类借用', source('安全管理工作记录', { ...complete, archiveCategory: '工程类工作记录' }), 'workContent', ''],
    ['时间地点固定不适用', source('时间地点', { date: complete.date, projectOriginalText: complete.projectOriginalText, locationArea: '南门' }), 'workContent', NOT_APPLICABLE_WORK_CONTENT],
    ['机动车工作内容同步违停类型', source('机动车违规管理', { date: complete.date, projectOriginalText: complete.projectOriginalText, vehiclePlate: '湘A12345', violationType: '占用消防通道' }), 'workContent', '占用消防通道']
  ];
  for (const [name, input, key, expected] of canonicalCases) {
    await scenario(name, () => equal(buildSourceCanonical(input)[key], expected, name));
  }

  const baseCanonical = buildSourceCanonical(source('安全管理工作记录', complete));
  const descriptor = (photoId, patch = {}) => buildSmartGroupDescriptor({
    photo: { id: photoId },
    canonicalFields: { ...baseCanonical, ...patch }
  });
  const descriptorCases = [
    ['完整四维键稳定', descriptor('a').groupKey, descriptor('b').groupKey, true],
    ['日期不同拆组', descriptor('a').groupKey, descriptor('b', { date: '2026-07-21' }).groupKey, false],
    ['项目不同拆组', descriptor('a').groupKey, descriptor('b', { project: '香辰康园', projectName: '香辰康园' }).groupKey, false],
    ['分类不同拆组', descriptor('a').groupKey, descriptor('b', { archiveCategory: '工程类工作记录', watermarkCategory: '工程类工作记录' }).groupKey, false],
    ['工作内容不同拆组', descriptor('a').groupKey, descriptor('b', { workContent: '其他工作' }).groupKey, false],
    ['缺日期照片级隔离', descriptor('a', { date: '' }).groupKey, descriptor('b', { date: '' }).groupKey, false],
    ['缺项目照片级隔离', descriptor('a', { project: '', projectName: '' }).groupKey, descriptor('b', { project: '', projectName: '' }).groupKey, false],
    ['缺分类照片级隔离', descriptor('a', { archiveCategory: '', watermarkCategory: '' }).groupKey, descriptor('b', { archiveCategory: '', watermarkCategory: '' }).groupKey, false],
    ['缺工作内容照片级隔离', descriptor('a', { workContent: '' }).groupKey, descriptor('b', { workContent: '' }).groupKey, false],
    ['时间地点不适用键稳定', descriptor('a', { watermarkTemplateType: 'time_location', workContent: '' }).fields.workContent, 'not_applicable', true],
    ['缺日期标识', descriptor('a', { date: '' }).missingFields.includes('date'), true, true],
    ['缺项目标识', descriptor('a', { project: '', projectName: '' }).missingFields.includes('project'), true, true],
    ['缺分类标识', descriptor('a', { archiveCategory: '', watermarkCategory: '' }).missingFields.includes('archiveCategory'), true, true],
    ['缺内容标识', descriptor('a', { workContent: '' }).missingFields.includes('workContent'), true, true],
    ['标题包含四维提示', descriptor('a').title.includes('潇湘新区二期｜安全管理工作记录｜治理飞线充电'), true, true]
  ];
  for (const [name, left, right, same] of descriptorCases) {
    await scenario(name, () => same ? equal(left, right, name) : assert.notEqual(left, right, name));
    if (!same) behaviorAssertions += 1;
  }

  const member = (photoId, patch = {}) => ({ photoId, effectiveInfo: { ...baseCanonical, ...patch } });
  const groupCases = [
    ['四维一致合法', [member('a'), member('b')], 'groupValidity', 'valid'],
    ['日期冲突非法', [member('a'), member('b', { date: '2026-07-21' })], 'groupValidity', 'invalid_group'],
    ['项目冲突非法', [member('a'), member('b', { project: '香辰康园', projectName: '香辰康园' })], 'groupValidity', 'invalid_group'],
    ['分类冲突非法', [member('a'), member('b', { archiveCategory: '工程类工作记录', watermarkCategory: '工程类工作记录' })], 'groupValidity', 'invalid_group'],
    ['内容冲突非法', [member('a'), member('b', { workContent: '其他工作' })], 'groupValidity', 'invalid_group'],
    ['模板冲突非法', [member('a'), member('b', { watermarkTemplateType: 'time_location' })], 'groupValidity', 'invalid_group'],
    ['共同字段一空一有非法', [member('a'), member('b', { workContent: '' })], 'groupValidity', 'invalid_group'],
    ['单照片缺字段待补全', [member('a', { workContent: '' })], 'groupValidity', 'needs_completion'],
    ['车牌不同仍合法', [member('a', { vehiclePlate: '湘A1' }), member('b', { vehiclePlate: '湘A2' })], 'groupValidity', 'valid'],
    ['施工单位不同仍合法', [member('a', { constructionUnitName: '甲' }), member('b', { constructionUnitName: '乙' })], 'groupValidity', 'valid'],
    ['位置不同仍合法', [member('a', { locationArea: '南门' }), member('b', { locationArea: '北门' })], 'groupValidity', 'valid'],
    ['备注不同仍合法', [member('a', { remarks: '甲' }), member('b', { remarks: '乙' })], 'groupValidity', 'valid'],
    ['关键词不同仍合法', [member('a', { keywords: '甲' }), member('b', { keywords: '乙' })], 'groupValidity', 'valid'],
    ['车牌标记 mixed', [member('a', { vehiclePlate: '湘A1' }), member('b', { vehiclePlate: '湘A2' })], 'mixedFields', 'vehiclePlate'],
    ['施工单位标记 mixed', [member('a', { constructionUnitName: '甲' }), member('b', { constructionUnitName: '乙' })], 'mixedFields', 'constructionUnitName'],
    ['照片专用值按 ID 隔离', [member('a', { vehiclePlate: '湘A1' }), member('b', { vehiclePlate: '湘A2' })], 'photoSpecificFields', '湘A2'],
    ['共同项目来自成员一致值', [member('a'), member('b')], 'groupCommonFields', '潇湘新区二期']
  ];
  for (const [name, members, key, expected] of groupCases) {
    await scenario(name, () => {
      const result = buildGroupCanonical(members);
      if (key === 'mixedFields') ok(result.mixedFields.includes(expected), name);
      else if (key === 'photoSpecificFields') equal(result.photoSpecificFields.b.vehiclePlate, expected, name);
      else if (key === 'groupCommonFields') equal(result.groupCommonFields.projectName, expected, name);
      else equal(result[key], expected, name);
    });
  }

  const validGroupCanonical = buildGroupCanonical([member('a'), member('b')]);
  const timeCanonical = buildSourceCanonical(source('时间地点', {
    date: complete.date,
    projectOriginalText: complete.projectOriginalText,
    locationArea: '南门'
  }));
  const vehicleCanonical = buildSourceCanonical(source('机动车违规管理', {
    date: complete.date,
    projectOriginalText: complete.projectOriginalText,
    vehiclePlate: '湘A12345',
    violationType: '占用消防通道'
  }));
  const formCases = [
    ['共同日期进入表单', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical }, 'date', complete.date],
    ['共同项目进入表单', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical }, 'projectName', complete.projectOriginalText],
    ['共同分类进入表单', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical }, 'archiveCategory', complete.archiveCategory],
    ['共同内容进入表单', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical }, 'workContent', complete.workContent],
    ['照片车牌进入表单', { groupCanonical: buildGroupCanonical([member('a', vehicleCanonical)]), activePhotoEffectiveInfo: vehicleCanonical }, 'vehiclePlate', '湘A12345'],
    ['照片备注进入表单', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical }, 'remarks', '现场已处理'],
    ['照片草稿优先', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical, photoDraft: { remarks: '人工备注' } }, 'remarks', '人工备注'],
    ['组草稿优先', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical, groupDraft: { workContent: '人工共同内容' } }, 'workContent', '人工共同内容'],
    ['空照片草稿不覆盖 canonical', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical, photoDraft: { projectName: '' } }, 'projectName', complete.projectOriginalText],
    ['空组草稿不覆盖共同值', { groupCanonical: validGroupCanonical, activePhotoEffectiveInfo: baseCanonical, groupDraft: { archiveCategory: '' } }, 'archiveCategory', complete.archiveCategory],
    ['时间地点模板保留', { groupCanonical: buildGroupCanonical([member('a', timeCanonical)]), activePhotoEffectiveInfo: timeCanonical }, 'watermarkTemplateType', 'time_location'],
    ['时间地点内容不适用', { groupCanonical: buildGroupCanonical([member('a', timeCanonical)]), activePhotoEffectiveInfo: timeCanonical }, 'workContent', 'not_applicable'],
    ['机动车模板保留', { groupCanonical: buildGroupCanonical([member('a', vehicleCanonical)]), activePhotoEffectiveInfo: vehicleCanonical }, 'watermarkTemplateType', 'vehicle_violation'],
    ['机动车违停同步', { groupCanonical: buildGroupCanonical([member('a', vehicleCanonical)]), activePhotoEffectiveInfo: vehicleCanonical }, 'violationType', '占用消防通道'],
    ['非法混合组不借共同值', { groupCanonical: buildGroupCanonical([member('a'), member('b', { workContent: '其他工作' })]), activePhotoEffectiveInfo: baseCanonical }, 'workContent', complete.workContent]
  ];
  for (const [name, input, key, expected] of formCases) {
    await scenario(name, () => equal(buildCanonicalArchiveFormSeed(input)[key], expected, name));
  }

  const validationCases = [
    ['普通完整通过', baseCanonical, 0],
    ['普通缺日期', { ...baseCanonical, date: '' }, 1],
    ['普通缺项目', { ...baseCanonical, project: '', projectName: '' }, 1],
    ['普通缺分类', { ...baseCanonical, archiveCategory: '', watermarkCategory: '' }, 2],
    ['普通缺内容', { ...baseCanonical, workContent: '' }, 1],
    ['时间地点完整通过', timeCanonical, 0],
    ['时间地点不要求内容', { ...timeCanonical, workContent: '' }, 0],
    ['时间地点缺项目只报一项', { ...timeCanonical, project: '', projectName: '' }, 1],
    ['机动车完整通过', vehicleCanonical, 0],
    ['机动车缺车牌', { ...vehicleCanonical, vehiclePlate: '' }, 1],
    ['机动车缺违停类型', { ...vehicleCanonical, violationType: '', workContent: '' }, 1],
    ['工程缺施工单位', buildSourceCanonical(source('工程类工作记录', { ...complete, archiveCategory: '工程类工作记录', workContent: '电梯维修维保' })), 1],
    ['工程施工单位匹配通过', buildSourceCanonical(source('工程类工作记录', { ...complete, archiveCategory: '工程类工作记录', workContent: '电梯维修维保', constructionUnitOriginalText: '示例施工单位' })), 0],
    ['unresolved 要求模板', { ...baseCanonical, watermarkTemplateType: 'unresolved' }, 1],
    ['不适用字段不进入缺失', { ...timeCanonical, constructionUnitName: '', vehiclePlate: '' }, 0]
  ];
  for (const [name, form, expectedCount] of validationCases) {
    await scenario(name, () => equal(validateArchiveFormByTemplate(form, configs).length, expectedCount, name));
  }

  const fourPhotos = [
    { id: 'time', sourceType: 'marki_api', originalPath: path.join(root, 'time.jpg'), smartSortStatus: 'completed' },
    { id: 'vehicle', sourceType: 'marki_api', originalPath: path.join(root, 'vehicle.jpg'), smartSortStatus: 'completed' },
    { id: 'elevator', sourceType: 'marki_api', originalPath: path.join(root, 'elevator.jpg'), smartSortStatus: 'completed' },
    { id: 'charging', sourceType: 'local_file', originalPath: path.join(root, 'charging.jpg'), smartSortStatus: 'completed' }
  ];
  const effectiveById = {
    time: timeCanonical,
    vehicle: vehicleCanonical,
    elevator: buildSourceCanonical(source('工程类工作记录', {
      ...complete,
      archiveCategory: '工程类工作记录',
      workContent: '电梯维修维保',
      constructionUnitOriginalText: '示例施工单位'
    }, { photoId: 'elevator' })),
    charging: baseCanonical
  };
  const oldMixed = {
    status: 'created',
    groups: [{
      id: 'old-project-only-group',
      groupKey: 'legacy-project-only',
      title: '潇湘新区二期',
      photoIds: fourPhotos.map((photo) => photo.id),
      photos: fourPhotos.map((photo) => ({ photoId: photo.id }))
    }]
  };
  const rebuilt = rebuildSmartSortResult({
    photos: fourPhotos,
    effectiveArchiveInfoByPhotoId: effectiveById,
    previousSmartSortResult: oldMixed
  });
  const rebuiltWithoutMembership = rebuildSmartSortResult({
    photos: fourPhotos,
    effectiveArchiveInfoByPhotoId: effectiveById,
    previousSmartSortResult: { status: 'created', groups: [] }
  });
  const rebuiltWithNewPhotoOutsideMembership = rebuildSmartSortResult({
    photos: fourPhotos,
    effectiveArchiveInfoByPhotoId: effectiveById,
    previousSmartSortResult: {
      status: 'created',
      groups: [{
        id: 'old-time-only',
        groupKey: buildSmartGroupDescriptor({
          photo: fourPhotos[0],
          canonicalFields: effectiveById.time
        }).groupKey,
        photoIds: ['time']
      }]
    }
  });
  const rebuildCases = [
    ['旧 membership 为空仍全量重建', () => equal(rebuiltWithoutMembership.photoCount, 4, '空旧 membership 不得丢失当前有效照片')],
    ['新增照片不在旧 membership 仍进入分组', () => equal(rebuiltWithNewPhotoOutsideMembership.photoCount, 4, '重建资格不得依赖旧 membership')],
    ['旧项目混合组拆为四组', () => equal(rebuilt.groupCount, 4, '旧项目混合组必须拆分')],
    ['四张照片各有唯一 membership', () => equal(rebuilt.photoCount, 4, '四张照片应各归属一组')],
    ['时间地点独立组', () => ok(rebuilt.groups.some((group) => group.photoIds.includes('time')), '时间地点组存在')],
    ['机动车独立组', () => ok(rebuilt.groups.some((group) => group.photoIds.includes('vehicle')), '机动车组存在')],
    ['电梯维保独立组', () => ok(rebuilt.groups.some((group) => group.photoIds.includes('elevator')), '电梯维保组存在')],
    ['治理飞线独立组', () => ok(rebuilt.groups.some((group) => group.photoIds.includes('charging')), '治理飞线组存在')],
    ['旧项目组 ID 被移除', () => equal(rebuilt.groups.some((group) => group.id === 'old-project-only-group'), false, '旧组不得保留')],
    ['没有重复 photoId', () => equal(new Set(rebuilt.groups.flatMap((group) => group.photoIds)).size, 4, 'membership 必须唯一')],
    ['每组 key 均不相同', () => equal(new Set(rebuilt.groups.map((group) => group.groupKey)).size, 4, '四维 key 应不同')],
    ['每组只有一个成员', () => ok(rebuilt.groups.every((group) => group.photoIds.length === 1), '四个业务组均应单成员')],
    ['标题不再仅为项目', () => ok(rebuilt.groups.every((group) => group.title !== '潇湘新区二期'), '标题必须体现完整业务维度')],
    ['时间组保持模板', () => equal(effectiveById.time.watermarkTemplateType, 'time_location', '时间模板应保留')],
    ['电梯与飞线 key 不同', () => assert.notEqual(rebuilt.groups.find((group) => group.photoIds.includes('elevator')).groupKey, rebuilt.groups.find((group) => group.photoIds.includes('charging')).groupKey)],
    ['旧同 key 草稿可迁移', () => {
      const old = { groups: [{ id: 'old', groupKey: rebuilt.groups[0].groupKey }] };
      const migrated = migrateGroupDraftsByGroupKey(old, rebuilt, { old: { remarks: '保留' } });
      equal(Object.values(migrated)[0]?.remarks, '保留', '同 key 草稿应迁移');
    }],
    ['不同 key 草稿不迁移', () => {
      const migrated = migrateGroupDraftsByGroupKey(oldMixed, rebuilt, { 'old-project-only-group': { remarks: '不得复制' } });
      equal(Object.keys(migrated).length, 0, '旧混合组草稿不得复制到拆分组');
    }]
  ];
  for (const [name, callback] of rebuildCases) await scenario(name, callback);
  await scenario('真实 smart sort service 按四维 descriptor 拆组', async () => {
    const serviceResult = await generateSmartSortGroups(path.join(root, 'smart-sort-service'), {
      photos: fourPhotos.map((photo) => ({
        photoId: photo.id,
        filePath: photo.originalPath,
        fileName: `${photo.id}.jpg`,
        sourceType: photo.sourceType,
        smartGrouping: buildSmartGroupDescriptor({
          photo,
          canonicalFields: effectiveById[photo.id]
        })
      }))
    });
    equal(serviceResult.groupCount, 4, '真实服务必须输出四个叶子业务组');
    equal(new Set(serviceResult.groups.map((group) => group.groupKey)).size, 4, '真实服务 groupKey 必须唯一');
    ok(serviceResult.groups.every((group) => group.suggestedFields.watermarkTemplateType), '真实服务不得丢失模板类型');
  });

  await fs.mkdir(root, { recursive: true });
  const snapshotPhotoPath = path.join(root, 'snapshot-photo.jpg');
  await fs.writeFile(snapshotPhotoPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const snapshotPhoto = {
    id: 'snapshot-photo',
    originalPath: snapshotPhotoPath,
    originalName: 'snapshot-photo.jpg',
    extension: '.jpg',
    size: 4,
    width: 1,
    height: 1,
    sha256: createHash('sha256').update(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).digest('hex'),
    modifiedAt: '2026-07-20T00:00:00.000Z',
    capturedAt: '2026-07-20T00:00:00.000Z',
    selected: true,
    sortStatus: 'assigned',
    smartSortStatus: 'completed',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:test:snapshot-photo',
    sourceMetadataRef: 'marki_source_metadata:test:snapshot-photo'
  };
  const snapshotWorkspace = {
    ...createEmptyWorkspace(),
    photos: [snapshotPhoto],
    selectedIds: [snapshotPhoto.id],
    activePhotoId: snapshotPhoto.id,
    recognitionResultsByPhoto: {
      [snapshotPhoto.id]: source('时间地点', {
        date: complete.date,
        projectOriginalText: complete.projectOriginalText,
        locationArea: '南门'
      }).recognitionResult
    },
    watermarkRecordsByPhoto: {
      [snapshotPhoto.id]: source('时间地点', {
        date: complete.date,
        projectOriginalText: complete.projectOriginalText,
        locationArea: '南门'
      }).watermarkRecord
    },
    photoDraftByPhotoId: {
      [snapshotPhoto.id]: { remarks: '照片草稿' }
    },
    groupDraftByGroupId: {
      'snapshot-group': { keywords: '组草稿' }
    },
    smartSortResult: {
      status: 'created',
      groups: [{
        id: 'snapshot-group',
        groupKey: descriptor('snapshot-photo', {
          ...timeCanonical,
          watermarkTemplateType: 'time_location'
        }).groupKey,
        title: '时间地点水印',
        photoIds: [snapshotPhoto.id],
        photos: [{ photoId: snapshotPhoto.id }]
      }]
    }
  };
  const snapshotRoot = path.join(root, 'snapshot-user-data');
  const saveResult = await saveSortWorkspaceSnapshot(snapshotRoot, snapshotWorkspace);
  const loadResult = await loadSortWorkspaceSnapshot(snapshotRoot);
  const restored = loadResult.snapshot.workspace;
  const snapshotCases = [
    ['快照保存成功', () => { snapshotAssertions += 1; assert.equal(saveResult.success, true); }],
    ['快照恢复成功', () => { snapshotAssertions += 1; assert.equal(loadResult.success, true); }],
    ['照片草稿保持', () => { snapshotAssertions += 1; assert.equal(restored.photoDraftByPhotoId[snapshotPhoto.id].remarks, '照片草稿'); }],
    ['组草稿保持', () => { snapshotAssertions += 1; assert.equal(restored.groupDraftByGroupId['snapshot-group'].keywords, '组草稿'); }],
    ['模板可信字段保持', () => { snapshotAssertions += 1; assert.equal(restored.recognitionResultsByPhoto[snapshotPhoto.id].watermarkTemplateName, '时间地点'); }],
    ['照片来源保持', () => { snapshotAssertions += 1; assert.equal(restored.photos[0].sourceType, 'marki_api'); }],
    ['membership 保持可离线重建', () => { snapshotAssertions += 1; assert.equal(restored.smartSortResult.groups[0].photoIds[0], snapshotPhoto.id); }],
    ['恢复不需要网络字段', () => { snapshotAssertions += 1; assert.equal(Object.hasOwn(restored, 'url'), false); }],
    ['恢复不需要 OCR', () => { snapshotAssertions += 1; assert.equal(Object.hasOwn(restored, 'ocrRequest'), false); }],
    ['时间模板恢复后仍不适用', () => {
      const restoredCanonical = buildSourceCanonical({
        photo: restored.photos[0],
        recognitionResult: restored.recognitionResultsByPhoto[snapshotPhoto.id],
        watermarkRecord: restored.watermarkRecordsByPhoto[snapshotPhoto.id],
        configs
      });
      snapshotAssertions += 1;
      assert.equal(restoredCanonical.workContent, 'not_applicable');
    }]
  ];
  for (const [name, callback] of snapshotCases) await scenario(name, callback);

  const trustedInput = source('时间地点', {
    date: complete.date,
    projectOriginalText: complete.projectOriginalText,
    locationArea: '南门'
  });
  const trustedBefore = structuredClone(trustedInput);
  const trustedCanonical = buildSourceCanonical(trustedInput);
  const trustedEffective = resolveEffectivePhotoArchiveInfo({
    photo: trustedInput.photo,
    sourceCanonical: trustedCanonical
  });
  const safetyCases = [
    ['来源对象不变', () => deepEqual(trustedInput, trustedBefore, 'canonical 不得修改来源')],
    ['canonical 为新对象', () => assert.notEqual(trustedCanonical, trustedInput.recognitionResult)],
    ['effective 为新对象', () => assert.notEqual(trustedEffective, trustedCanonical)],
    ['时间模板贯穿 canonical', () => equal(trustedCanonical.watermarkTemplateType, 'time_location', '模板应进入 canonical')],
    ['时间模板贯穿 effective', () => equal(trustedEffective.watermarkTemplateType, 'time_location', '模板应进入 effective')],
    ['时间模板贯穿 group descriptor', () => equal(buildSmartGroupDescriptor({ photo: trustedInput.photo, canonicalFields: trustedEffective }).fields.watermarkTemplateType, 'time_location', '模板应进入 group')],
    ['时间模板贯穿 form seed', () => equal(buildCanonicalArchiveFormSeed({ activePhotoEffectiveInfo: trustedEffective }).watermarkTemplateType, 'time_location', '模板应进入 form')],
    ['Marki 不产生网络调用', () => { markiZeroIoAssertions += 1; assert.equal(Object.hasOwn(trustedCanonical, 'url'), false); }],
    ['Marki 不产生 OCR 调用', () => { markiZeroIoAssertions += 1; assert.equal(Object.hasOwn(trustedCanonical, 'rawText'), false); }],
    ['平台输入深比较不变', () => { markiZeroIoAssertions += 1; assert.deepEqual(trustedInput, trustedBefore); }]
  ];
  for (const [name, callback] of safetyCases) {
    await scenario(name, () => {
      callback();
      if (!name.includes('Marki') && name !== '平台输入深比较不变') behaviorAssertions += 1;
    });
  }

  const pageSource = await fs.readFile(path.resolve(process.cwd(), 'src/pages/SortWorkspacePage.jsx'), 'utf8');
  const rightPanelSource = await fs.readFile(path.resolve(process.cwd(), 'src/utils/sortRightPanelState.js'), 'utf8');
  const sourceContracts = [
    [pageSource.includes('currentTemplateType === WATERMARK_TEMPLATE_TYPES.TIME_LOCATION'), true],
    [pageSource.includes('archiveCategory === TIME_LOCATION_ARCHIVE_CATEGORY'), false],
    [pageSource.includes('currentIsTimeLocation && ('), true],
    [rightPanelSource.includes("['effective_result'"), false],
    [rightPanelSource.includes("['smart_sort_group'"), false],
    [rightPanelSource.includes('getGroupCanonicalFields(group'), false]
  ];
  sourceContracts.forEach(([actual, expected]) => {
    sourceContractAssertions += 1;
    assert.equal(actual, expected);
  });

  assert.ok(scenarioCount >= 100, 'P0 智拣业务闭环必须至少覆盖 100 个行为场景');
  console.log(
    `智能分类业务闭环自检通过：${scenarioCount} 个行为场景，${behaviorAssertions} 个行为断言，`
    + `${sourceContractAssertions} 个源码契约断言，${snapshotAssertions} 个快照恢复断言，`
    + `${markiZeroIoAssertions} 个 Marki 零网络/零 OCR 断言。`
  );
}

async function checkSmartSortOutcomes(userDataDir) {
  const { rebuildSmartSortResult } = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/smartGroupBuilder.js')).href}?outcomes=${Date.now()}`
  );
  const photos = [
    {
      id: 'filtered-unwatermarked',
      originalPath: path.join(userDataDir, 'filtered-unwatermarked.jpg'),
      smartSortStatus: 'completed',
      watermarkStatus: 'unwatermarked'
    },
    {
      id: 'recognition-failed',
      originalPath: path.join(userDataDir, 'recognition-failed.jpg'),
      smartSortStatus: 'failed'
    },
    {
      id: 'running',
      originalPath: path.join(userDataDir, 'running.jpg'),
      smartSortStatus: 'running'
    }
  ];
  const excluded = rebuildSmartSortResult({
    photos,
    effectiveArchiveInfoByPhotoId: {}
  });
  assert.equal(excluded.photoCount, 0, '无水印、失败和运行中照片不得进入业务 membership');
  const completedPhoto = {
    id: 'completed-business-photo',
    originalPath: path.join(userDataDir, 'completed.jpg'),
    smartSortStatus: 'completed'
  };
  const completed = rebuildSmartSortResult({
    photos: [completedPhoto],
    effectiveArchiveInfoByPhotoId: {
      [completedPhoto.id]: {
        watermarkTemplateType: 'standard_work_record',
        date: '2026-07-23',
        projectId: 'project-1',
        projectName: '测试项目',
        archiveCategory: '巡查检查',
        workContent: '日常巡查'
      }
    }
  });
  assert.equal(completed.photoCount, 1, '已完成照片必须从当前工作池进入快照内四维分组');
  await assert.rejects(
    () => fs.access(path.join(process.cwd(), 'electron/services/smartSortService.cjs')),
    (error) => error?.code === 'ENOENT',
    '旧 smartSort 独立持久化服务必须删除'
  );
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8')
  ]);
  assert.equal(mainSource.includes("smartSort:generateGroups"), false, '主进程不得保留旧 smartSort IPC');
  assert.equal(preloadSource.includes('smartSort:'), false, 'preload 不得暴露旧 smartSort 客户端');
}

async function checkArchiveFlow(root) {
  const sourceDirectory = path.join(root, 'source');
  const archiveRoot = path.join(root, 'archive');
  await fs.mkdir(sourceDirectory, { recursive: true });
  const sourcePath = path.join(sourceDirectory, 'original.jpg');
  const originalContent = Buffer.from('AAAA-BBBB-CCCC');
  await fs.writeFile(sourcePath, originalContent);
  const form = {
    project: '潇湘新区二期',
    watermarkCategory: '机动车违规管理',
    workContent: '随意停放阻碍通行',
    date: '2026-06-12',
    location: '',
    keywords: '车辆停放',
    remark: '核心流程自检',
    vehiclePlate: '湘A12345',
    violationType: '随意停放阻碍通行'
  };
  const photo = {
    id: 'archive-photo',
    path: sourcePath,
    name: 'original.jpg',
    extension: '.jpg'
  };

  const preview = await buildArchivePreview({ form, photos: [photo], archiveRoot });
  assert.equal(preview.success, true, '预览应返回冻结 PreviewPlan');
  assert.equal(preview.items[0].location, '现场', '空位置应在归档服务中统一归一为“现场”');
  assert.equal(preview.items[0].vehiclePlate, '湘A12345', '车牌号码必须进入 PreviewPlan 安全预览项');
  assert.equal(preview.items[0].violationType, form.workContent, '违停类型必须与公共工作内容同步进入 PreviewPlan');
  assert.equal(preview.previewPlan.items[0].ledgerRow.vehiclePlate, '湘A12345', '车牌号码必须进入冻结 ledgerRow');
  assert.equal(await pathExists(preview.items[0].targetPath), false, '生成预览不得创建目标文件');
  assert.equal(
    await pathExists(getArchiveTransactionDirectory(archiveRoot)),
    false,
    '生成预览不得创建归档事务目录'
  );

  const archiveResult = await archivePhotos({ previewPlan: preview.previewPlan });
  assert.equal(archiveResult.success, true, '归档复制应成功');
  assert.equal(archiveResult.items[0].targetPath, preview.items[0].targetPath, '正式归档必须使用预览冻结的目标路径');
  assert.deepEqual(await fs.readFile(sourcePath), originalContent, '归档不得移动、删除或修改原始照片');

  const ledger = await loadLedgerRecords(archiveRoot);
  assert.equal(ledger.records.length, 1, '归档成功应追加一条台账记录');
  assert.equal(ledger.records[0].watermarkCategory, form.watermarkCategory, '台账归档分类字段应正确');
  assert.equal(ledger.records[0].workContent, form.workContent, '台账工作内容字段应正确');
  assert.equal(ledger.records[0].vehiclePlate, form.vehiclePlate, '机动车车牌必须进入 Excel 台账');
  assert.equal(ledger.records[0].violationType, form.violationType, '机动车违停类型必须进入 Excel 台账');
  assert.equal(ledger.records[0].location, '现场', '台账位置字段应正确');
  assert.equal(ledger.records[0].fileExists, true, '台账归档文件应能被后续页面找到');
  assert.equal(ledger.records[0].sourceType, 'local_file', '本地归档台账应记录来源类型');
  assert.equal(ledger.records[0].photoId, photo.id, '台账应记录稳定照片 ID');
  assert.equal(ledger.records[0].sourcePath, sourcePath, '台账应记录来源文件路径用于追溯');
  assert.match(ledger.records[0].sourceSha256, /^[a-f0-9]{64}$/, '台账应记录来源文件 SHA-256');
  assert.equal(ledger.records[0].archiveSha256, ledger.records[0].sourceSha256, '复制归档的来源与归档指纹应一致');
  assert.match(ledger.records[0].transactionId, /^[a-f0-9-]{16,64}$/i, '台账应记录归档事务 ID');

  const renamedCopy = path.join(sourceDirectory, 'renamed.jpg');
  const sameNameDifferentContent = path.join(sourceDirectory, 'original-copy.jpg');
  await fs.writeFile(renamedCopy, originalContent);
  await fs.writeFile(sameNameDifferentContent, Buffer.from('ZZZZ-YYYY-XXXX'));
  const matches = await matchArchivedPhotos(archiveRoot, [
    { id: 'renamed', path: renamedCopy, size: originalContent.length },
    { id: 'different', path: sameNameDifferentContent, size: originalContent.length }
  ]);
  assert.equal(Boolean(matches.matches.renamed), true, '同内容改名照片应识别为已归档');
  assert.equal(Boolean(matches.matches.different), false, '同大小不同内容照片不得误判为已归档');

  const failedArchiveRoot = path.join(root, 'failed-archive');
  await assert.rejects(
    () => buildArchivePreview({
      form,
      photos: [{ ...photo, id: 'missing-source', path: path.join(sourceDirectory, 'missing.jpg') }],
      archiveRoot: failedArchiveRoot
    }),
    '原图缺失时不得生成可确认的预览计划'
  );
  assert.equal((await loadLedgerRecords(failedArchiveRoot)).records.length, 0, '预览失败不得写入台账');

  await checkDownstreamPages({ root, archiveRoot, ledgerRecord: ledger.records[0] });
}

async function checkArchiveTransactionRecovery(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '归档事务自检必须使用系统临时目录'
  );

  const single = await createArchiveTransactionTestPlan(path.join(root, 'single'), { count: 1, tag: 'single' });
  const singleResult = await archivePhotos({ previewPlan: single.preview });
  assert.equal(singleResult.status, 'committed', '单张照片应完整提交');
  assert.equal(singleResult.committedCount, 1, '单张照片应提交一条台账');
  const singleTransaction = JSON.parse(await fs.readFile(
    path.join(getArchiveTransactionDirectory(single.archiveRoot), `${singleResult.transactionId}.json`),
    'utf8'
  ));
  assert.equal(path.isAbsolute(singleTransaction.items[0].targetRelativePath), false, '事务日志不得保存绝对目标路径');
  assert.equal(Object.prototype.hasOwnProperty.call(singleTransaction.items[0], 'targetPath'), false, '事务日志不得持久化 targetPath');

  const legacyHeaders = [
    '日期',
    '项目',
    '归档分类',
    '工作内容',
    '具体位置',
    '新文件名',
    '原文件名',
    '关键词',
    '备注',
    '归档路径',
    '归档时间'
  ];
  const normalizedLegacyRows = normalizeExistingLedgerRows([
    legacyHeaders,
    ['2026-07-17', '旧项目', '旧分类', '旧工作', '旧位置', 'new.jpg', 'old.jpg', '', '', 'C:\\archive\\new.jpg', '2026-07-17 10:00:00']
  ]);
  assert.equal(normalizedLegacyRows[0].length, 27, '旧台账加载后应补齐来源追溯和条件字段列');
  assert.deepEqual(
    normalizedLegacyRows[1].slice(0, 4),
    ['2026-07-17', '旧项目', '旧分类', '旧工作'],
    '旧台账原有业务列应保持'
  );
  assert.equal(normalizedLegacyRows[1].slice(11).every((value) => value === ''), true, '旧台账缺失的追溯列应安全补空');

  const currentTwentyHeaders = [
    ...legacyHeaders,
    '来源类型',
    '来源标识',
    '照片ID',
    '来源文件路径',
    '来源文件SHA-256',
    '归档文件SHA-256',
    '归档事务ID',
    '水印模板',
    '识别处理方式'
  ];
  const normalizedCurrentRows = normalizeExistingLedgerRows([
    currentTwentyHeaders,
    [
      '2026-07-17', '当前项目', '当前分类', '当前工作', '当前位置',
      'new-current.jpg', 'old-current.jpg', '', '', 'C:\\archive\\new-current.jpg',
      '2026-07-17 10:00:00', 'marki_api', 'marki_api:10001:current', 'photo-current',
      'C:\\source\\current.jpg', 'a'.repeat(64), 'a'.repeat(64), 'transaction-current',
      'standard_work_record', 'platform_only'
    ]
  ]);
  assert.equal(normalizedCurrentRows[0].length, 27, '当前 20 列台账加载后应只在末尾追加条件字段列');
  assert.deepEqual(
    normalizedCurrentRows[1].slice(0, 20),
    [
      '2026-07-17', '当前项目', '当前分类', '当前工作', '当前位置',
      'new-current.jpg', 'old-current.jpg', '', '', 'C:\\archive\\new-current.jpg',
      '2026-07-17 10:00:00', 'marki_api', 'marki_api:10001:current', 'photo-current',
      'C:\\source\\current.jpg', 'a'.repeat(64), 'a'.repeat(64), 'transaction-current',
      'standard_work_record', 'platform_only'
    ],
    '当前 20 列业务和追溯数据不得丢失或换序'
  );
  assert.equal(normalizedCurrentRows[1].slice(20).every((value) => value === ''), true, '当前台账缺失的七个条件字段应安全补空');

  const conditionFields = {
    watermarkCategory: '工程类工作记录',
    workContent: '电梯维修维保',
    constructionUnitId: 'construction-unit-001',
    constructionUnitName: '示例施工单位',
    constructionUnitOriginalText: '示例施工单位（现场水印）',
    constructionUnitConfirmed: true,
    constructionUnitSource: 'watermark_match'
  };
  const conditionPlan = await createArchiveTransactionTestPlan(path.join(root, 'condition-fields'), {
    count: 1,
    tag: 'condition-fields',
    formPatch: conditionFields
  });
  assert.equal(
    conditionPlan.preview.items[0].ledgerRow.constructionUnitId,
    conditionFields.constructionUnitId,
    '工程施工单位 ID 必须进入冻结 PreviewPlan'
  );
  assert.equal(
    conditionPlan.preview.items[0].ledgerRow.constructionUnitOriginalText,
    conditionFields.constructionUnitOriginalText,
    '工程施工单位原文必须进入冻结 PreviewPlan'
  );
  const conditionResult = await archivePhotos({ previewPlan: conditionPlan.preview });
  const conditionTransaction = JSON.parse(await fs.readFile(
    path.join(
      getArchiveTransactionDirectory(conditionPlan.archiveRoot),
      `${conditionResult.transactionId}.json`
    ),
    'utf8'
  ));
  assert.equal(
    conditionTransaction.items[0].ledgerRow.constructionUnitName,
    conditionFields.constructionUnitName,
    '施工单位正式名称必须进入归档事务文件'
  );
  const conditionLedger = await loadLedgerRecords(conditionPlan.archiveRoot);
  assert.equal(conditionLedger.records[0].constructionUnitId, conditionFields.constructionUnitId, '施工单位 ID 必须进入 Excel');
  assert.equal(conditionLedger.records[0].constructionUnitName, conditionFields.constructionUnitName, '施工单位名称必须进入 Excel');
  assert.equal(
    conditionLedger.records[0].constructionUnitOriginalText,
    conditionFields.constructionUnitOriginalText,
    '施工单位原文必须进入 Excel'
  );
  const tamperedConditionPlan = JSON.parse(JSON.stringify(conditionPlan.preview));
  tamperedConditionPlan.items[0].ledgerRow.constructionUnitName = '被篡改施工单位';
  await assert.rejects(
    () => archivePhotos({ previewPlan: tamperedConditionPlan }),
    (error) => error?.code === 'archive_preview_plan_tampered',
    '新增条件字段必须参与 PreviewPlan 哈希校验'
  );

  const multiple = await createArchiveTransactionTestPlan(path.join(root, 'multiple'), { count: 3, tag: 'multiple' });
  const multipleResult = await archivePhotos({ previewPlan: multiple.preview });
  assert.equal(multipleResult.committedCount, 3, '多张照片应全部提交');
  assert.equal((await loadLedgerRecords(multiple.archiveRoot)).records.length, 3, '多张归档应写入三条台账');

  const markiTrace = await createArchiveTransactionTestPlan(path.join(root, 'marki-trace'), {
    count: 1,
    tag: 'marki-trace',
    sourceKeys: ['marki_api:10001:moment-trace-1']
  });
  await archivePhotos({ previewPlan: markiTrace.preview });
  const markiTraceRecord = (await loadLedgerRecords(markiTrace.archiveRoot)).records[0];
  assert.equal(markiTraceRecord.sourceType, 'marki_api', 'Marki 归档台账应保留来源类型');
  assert.equal(markiTraceRecord.sourceKey, 'marki_api:10001:moment-trace-1', 'Marki 归档台账应保留来源标识');
  assert.match(markiTraceRecord.transactionId, /^[a-f0-9-]{16,64}$/i, 'Marki 归档应可追溯到事务');

  const firstFailure = await createArchiveTransactionTestPlan(path.join(root, 'first-failure'), { count: 2, tag: 'first-failure' });
  const firstFailureResult = await archivePhotos(
    { previewPlan: firstFailure.preview },
    { copyFile: createSelectiveCopyFailure('source-1.jpg') }
  );
  assert.equal(firstFailureResult.status, 'partial', '首张复制失败时其余照片应正常提交');
  assert.equal(firstFailureResult.items[0].stage, 'copy_failed', '首张复制失败应返回逐项失败');
  assert.equal(firstFailureResult.committedCount, 1, '首张失败时第二张应正常提交');

  const middleFailure = await createArchiveTransactionTestPlan(path.join(root, 'middle-failure'), { count: 3, tag: 'middle-failure' });
  const middleFailureResult = await archivePhotos(
    { previewPlan: middleFailure.preview },
    { copyFile: createSelectiveCopyFailure('source-2.jpg') }
  );
  assert.equal(middleFailureResult.items[1].stage, 'copy_failed', '中间照片复制失败应准确定位');
  assert.equal(middleFailureResult.committedCount, 2, '中间照片失败不应阻止其他成功项写入台账');
  assert.equal((await loadLedgerRecords(middleFailure.archiveRoot)).records.length, 2, '中间失败时台账只写成功项');

  const ledgerRetry = await createArchiveTransactionTestPlan(path.join(root, 'ledger-retry'), { count: 1, tag: 'ledger-retry' });
  const ledgerPendingResult = await archivePhotos(
    { previewPlan: ledgerRetry.preview },
    { excelOptions: { hooks: { writeWorkbook: async () => { throw createInjectedError('EPERM'); } } } }
  );
  assert.equal(ledgerPendingResult.status, 'ledger_pending', 'Excel 首次失败时应保留 ledger_pending');
  assert.equal(ledgerPendingResult.pendingLedgerCount, 1, 'Excel 失败应逐项返回待补记');
  assert.equal((await listArchiveTestImages(ledgerRetry.archiveRoot)).length, 1, 'Excel 失败后归档照片必须保留');
  const frozenName = path.basename(ledgerPendingResult.items[0].targetPath);
  const ledgerRetryResult = await archivePhotos({
    archiveRoot: ledgerRetry.archiveRoot,
    transactionId: ledgerPendingResult.transactionId
  });
  assert.equal(ledgerRetryResult.status, 'committed', 'Excel 恢复后应补记同一事务');
  assert.equal(path.basename(ledgerRetryResult.items[0].targetPath), frozenName, '重试必须复用冻结目标路径');
  assert.equal((await listArchiveTestImages(ledgerRetry.archiveRoot)).some((name) => /_01\./i.test(name)), false, '重试不得生成 _01');

  const restart = await createArchiveTransactionTestPlan(path.join(root, 'restart'), { count: 1, tag: 'restart' });
  const restartPending = await archivePhotos(
    { previewPlan: restart.preview },
    { excelOptions: { hooks: { writeWorkbook: async () => { throw createInjectedError('EPERM'); } } } }
  );
  assert.equal(restartPending.pendingLedgerCount, 1, '进程重启场景应先形成待补记事务');
  const archiveServicePath = require.resolve('../electron/services/archiveService.cjs');
  const transactionServicePath = require.resolve('../electron/services/archiveTransactionService.cjs');
  delete require.cache[archiveServicePath];
  delete require.cache[transactionServicePath];
  const restartedArchiveService = require('../electron/services/archiveService.cjs');
  const restartRecovery = await restartedArchiveService.recoverPendingArchiveTransactions(restart.archiveRoot);
  assert.equal(restartRecovery.committedCount, 1, '删除 require cache 后应能从磁盘事务恢复台账');
  assert.equal((await listArchiveTestImages(restart.archiveRoot)).length, 1, '重启恢复不得重复复制照片');

  const conflict = await createArchiveTransactionTestPlan(path.join(root, 'conflict'), { count: 1, tag: 'conflict' });
  const unknownContent = Buffer.from('unknown-existing-target');
  const frozenConflictTarget = conflict.previewItems[0].targetPath;
  await fs.mkdir(path.dirname(frozenConflictTarget), { recursive: true });
  await fs.writeFile(frozenConflictTarget, unknownContent);
  const conflictResult = await archivePhotos({ previewPlan: conflict.preview });
  assert.equal(conflictResult.conflictCount, 1, '冻结目标存在不同内容时应返回 target_conflict');
  assert.equal(conflictResult.items[0].stage, 'target_conflict', '冲突项状态必须明确');
  assert.deepEqual(await fs.readFile(conflictResult.items[0].targetPath), unknownContent, '未知目标文件不得覆盖或删除');
  assert.equal((await listArchiveTestImages(conflict.archiveRoot)).length, 1, '目标冲突不得静默改名生成第二份归档照片');
  assert.equal(firstFailureResult.failedCount, 1, 'partial 返回的失败数量应准确');
  assert.equal(firstFailureResult.committedCount, 1, 'partial 返回的成功数量应准确');

  const isolatedConflict = await createArchiveTransactionTestPlan(path.join(root, 'isolated-conflict'), {
    count: 3,
    tag: 'isolated-conflict'
  });
  const isolatedConflictBytes = Buffer.from('occupied-by-unrelated-file');
  await fs.mkdir(path.dirname(isolatedConflict.previewItems[1].targetPath), { recursive: true });
  await fs.writeFile(isolatedConflict.previewItems[1].targetPath, isolatedConflictBytes);
  const isolatedConflictResult = await archivePhotos({ previewPlan: isolatedConflict.preview });
  assert.equal(isolatedConflictResult.committedCount, 2, '三张中一张目标冲突时其他两张必须继续归档');
  assert.equal(isolatedConflictResult.conflictCount, 1, '逐项目标冲突统计必须准确');
  assert.equal(isolatedConflictResult.items[1].stage, 'target_conflict', '目标冲突必须只落入对应 transaction item');
  assert.equal((await loadLedgerRecords(isolatedConflict.archiveRoot)).records.length, 2, '目标冲突批次只能为成功两张追加台账');
  assert.deepEqual(
    await fs.readFile(isolatedConflict.previewItems[1].targetPath),
    isolatedConflictBytes,
    '冲突目标文件不得被覆盖'
  );

  const sourceChanged = await createArchiveTransactionTestPlan(path.join(root, 'source-changed'), {
    count: 1,
    tag: 'source-changed'
  });
  await fs.writeFile(sourceChanged.sources[0].path, Buffer.from('changed-after-preview'));
  const sourceChangedResult = await archivePhotos({ previewPlan: sourceChanged.preview });
  assert.equal(sourceChangedResult.items[0].errorCode, 'archive_preview_source_changed', '预览后原图变化必须使计划失效');
  assert.equal(sourceChangedResult.committedCount, 0, '来源变化时不得复制或写台账');
  assert.equal(
    await pathExists(getArchiveTransactionDirectory(sourceChanged.archiveRoot)),
    true,
    '来源预检失败必须写入对应 transaction item 供审计'
  );

  const isolatedSourceChanged = await createArchiveTransactionTestPlan(path.join(root, 'isolated-source-changed'), {
    count: 3,
    tag: 'isolated-source-changed'
  });
  await fs.writeFile(isolatedSourceChanged.sources[1].path, Buffer.from('changed-after-preview'));
  const isolatedSourceChangedResult = await archivePhotos({ previewPlan: isolatedSourceChanged.preview });
  assert.equal(isolatedSourceChangedResult.committedCount, 2, '三张中一张来源变化时其他两张必须继续归档');
  assert.equal(isolatedSourceChangedResult.failedCount, 1, '逐项来源变化失败统计必须准确');
  assert.equal(
    isolatedSourceChangedResult.items[1].errorCode,
    'archive_preview_source_changed',
    '来源变化必须只落入对应 transaction item'
  );
  assert.equal((await loadLedgerRecords(isolatedSourceChanged.archiveRoot)).records.length, 2, '来源变化批次只能为成功两张追加台账');

  const tampered = await createArchiveTransactionTestPlan(path.join(root, 'tampered'), {
    count: 1,
    tag: 'tampered'
  });
  const tamperedPlan = JSON.parse(JSON.stringify(tampered.preview));
  tamperedPlan.items[0].ledgerRow.remark = 'renderer-tampered';
  await assert.rejects(
    () => archivePhotos({ previewPlan: tamperedPlan }),
    (error) => error?.code === 'archive_preview_plan_tampered',
    'PreviewPlan 任意字段被修改后必须拒绝执行'
  );

  const stagedRecovery = await createArchiveTransactionTestPlan(path.join(root, 'staged-recovery'), {
    count: 1,
    tag: 'staged-recovery'
  });
  const stagedFailure = await archivePhotos(
    { previewPlan: stagedRecovery.preview },
    { linkFile: async () => { throw createInjectedError('EIO'); } }
  );
  assert.equal(stagedFailure.items[0].stage, 'copy_failed', '原子安装中断时必须留下可恢复事务');
  assert.equal(await pathExists(stagedFailure.items[0].targetPath), false, '原子安装失败不得暴露半成品目标文件');
  assert.equal((await listArchiveStagingFiles(stagedRecovery.archiveRoot)).length, 1, '中断后应保留同事务暂存文件');
  const stagedRecovered = await recoverPendingArchiveTransactions(stagedRecovery.archiveRoot);
  assert.equal(stagedRecovered.committedCount, 1, '恢复流程应安装已经完整校验的暂存文件');
  assert.equal((await listArchiveStagingFiles(stagedRecovery.archiveRoot)).length, 0, '恢复成功后应清理同事务暂存文件');

  const occupied = await createArchiveTransactionTestPlan(path.join(root, 'occupied'), { count: 1, tag: 'occupied-base' });
  await archivePhotos({ previewPlan: occupied.preview });
  const ledgerBeforeOccupied = await fs.readFile(getLedgerPath(occupied.archiveRoot));
  const occupiedNext = await createArchiveTransactionTestPlan(path.join(root, 'occupied-next'), {
    archiveRoot: occupied.archiveRoot,
    count: 1,
    tag: 'occupied-next',
    formPatch: { workContent: '第二项工作' }
  });
  const occupiedResult = await archivePhotos(
    { previewPlan: occupiedNext.preview },
    { excelOptions: { hooks: { afterBackup: async () => { throw createInjectedError('EPERM'); } } } }
  );
  assert.equal(occupiedResult.pendingLedgerCount, 1, 'Excel 被占用时应保留 ledger_pending');
  assert.deepEqual(await fs.readFile(getLedgerPath(occupied.archiveRoot)), ledgerBeforeOccupied, 'Excel 写入失败时旧台账必须保持完整');

  const corruptLedger = await createArchiveTransactionTestPlan(path.join(root, 'corrupt-ledger'), { count: 1, tag: 'corrupt-ledger' });
  await fs.mkdir(corruptLedger.archiveRoot, { recursive: true });
  const corruptLedgerBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
  await fs.writeFile(getLedgerPath(corruptLedger.archiveRoot), corruptLedgerBytes);
  const corruptLedgerResult = await archivePhotos({ previewPlan: corruptLedger.preview });
  assert.equal(corruptLedgerResult.pendingLedgerCount, 1, '损坏台账应拒绝覆盖并保留待补记');
  assert.deepEqual(await fs.readFile(getLedgerPath(corruptLedger.archiveRoot)), corruptLedgerBytes, '损坏台账内容不得被覆盖');

  const corruptTransactionRoot = path.join(root, 'corrupt-transaction');
  const corruptTransactionDirectory = getArchiveTransactionDirectory(corruptTransactionRoot);
  await fs.mkdir(corruptTransactionDirectory, { recursive: true });
  const corruptTransactionPath = path.join(corruptTransactionDirectory, '00000000-0000-4000-8000-000000000000.json');
  await fs.writeFile(corruptTransactionPath, '{"schemaVersion":1,"items":', 'utf8');
  const corruptTransactionBytes = await fs.readFile(corruptTransactionPath);
  const corruptTransactionRecovery = await recoverPendingArchiveTransactions(corruptTransactionRoot);
  assert.equal(corruptTransactionRecovery.errors.length, 1, '损坏事务日志应返回安全错误');
  assert.deepEqual(await fs.readFile(corruptTransactionPath), corruptTransactionBytes, '损坏事务日志不得被覆盖');

  assert.deepEqual(await listLedgerSwapFiles(single.archiveRoot), [], '正常提交后不得遗留 Excel 临时文件或 backup');
  assert.doesNotThrow(() => JSON.stringify(multipleResult), '归档返回结构必须可 JSON 序列化');

  const concurrent = await createArchiveTransactionTestPlan(path.join(root, 'concurrent'), { count: 1, tag: 'concurrent' });
  const concurrentResults = await Promise.all([
    archivePhotos({ previewPlan: concurrent.preview }),
    archivePhotos({ previewPlan: concurrent.preview })
  ]);
  assert.equal(concurrentResults[0].transactionId, concurrentResults[1].transactionId, '并发重复归档必须复用同一事务');
  assert.equal((await listArchiveTestImages(concurrent.archiveRoot)).length, 1, '并发重复归档只能生成一份文件');
  assert.equal((await loadLedgerRecords(concurrent.archiveRoot)).records.length, 1, '并发重复归档只能生成一行台账');

  const localIdentityPath = path.join(root, 'identity', 'photo.jpg');
  const localHash = 'a'.repeat(64);
  const localIdentity = buildArchiveSourceIdentity({ sourceSha256: localHash, originalPath: localIdentityPath });
  assert.equal(localIdentity.startsWith(`local:${localHash}:`), true, '本地照片身份必须包含 SHA-256 和规范化路径');
  assert.equal(
    buildArchiveSourceIdentity({ sourceKey: 'marki_api:12345:moment-1', sourceSha256: localHash, originalPath: localIdentityPath }),
    'marki:marki_api:12345:moment-1',
    'Marki 照片身份必须优先使用 sourceKey'
  );

  for (const testPlan of [single, multiple, markiTrace, firstFailure, middleFailure, ledgerRetry, restart, conflict, occupied, occupiedNext, corruptLedger, concurrent]) {
    for (const source of testPlan.sources) {
      assert.deepEqual(await fs.readFile(source.path), source.content, '归档事务不得移动、删除或修改原图');
    }
  }

  const ledgerAlreadyWritten = await createArchiveTransactionTestPlan(path.join(root, 'ledger-already-written'), {
    count: 1,
    tag: 'ledger-already-written'
  });
  const ledgerAlreadyPending = await archivePhotos(
    { previewPlan: ledgerAlreadyWritten.preview },
    { hooks: { afterLedgerAppend: async () => { throw createInjectedError('SIMULATED_EXIT'); } } }
  );
  assert.equal(ledgerAlreadyPending.pendingLedgerCount, 1, 'Excel 已写而事务未更新时应保持 ledger_pending');
  assert.equal((await loadLedgerRecords(ledgerAlreadyWritten.archiveRoot)).records.length, 1, '模拟退出前 Excel 行应已经写入');
  const ledgerAlreadyRecovered = await archivePhotos({
    archiveRoot: ledgerAlreadyWritten.archiveRoot,
    transactionId: ledgerAlreadyPending.transactionId
  });
  assert.equal(ledgerAlreadyRecovered.status, 'committed', '恢复时应通过归档路径发现已存在台账行');
  assert.equal((await loadLedgerRecords(ledgerAlreadyWritten.archiveRoot)).records.length, 1, '补记恢复不得重复追加 Excel 行');

  const committedRepeat = await archivePhotos({
    archiveRoot: ledgerAlreadyWritten.archiveRoot,
    transactionId: ledgerAlreadyRecovered.transactionId
  });
  assert.equal(committedRepeat.transactionId, ledgerAlreadyRecovered.transactionId, 'committed 事务再次调用应返回原事务');
  assert.equal((await listArchiveTestImages(ledgerAlreadyWritten.archiveRoot)).length, 1, 'committed 事务再次调用不得复制第二份文件');

  const operationIdentityItems = [
    {
      sourceIdentity: localIdentity,
      ledgerRow: { project: '项目', watermarkCategory: '分类', workContent: '工作 A', date: '2026-07-17', location: '现场' }
    },
    {
      sourceIdentity: 'marki:marki_api:12345:moment-1',
      ledgerRow: { project: '项目', watermarkCategory: '分类', workContent: '工作 A', date: '2026-07-17', location: '现场' }
    }
  ];
  const operationKey = buildArchiveOperationKey(operationIdentityItems);
  assert.equal(operationKey, buildArchiveOperationKey([...operationIdentityItems].reverse()), '照片输入顺序变化不得改变 operationKey');
  assert.notEqual(
    operationKey,
    buildArchiveOperationKey(operationIdentityItems.map((item) => ({
      ...item,
      ledgerRow: { ...item.ledgerRow, workContent: '工作 B' }
    }))),
    '不同归档信息必须生成不同 operationKey'
  );

  const swapRecovery = await createArchiveTransactionTestPlan(path.join(root, 'swap-recovery'), { count: 1, tag: 'swap-recovery' });
  await archivePhotos({ previewPlan: swapRecovery.preview });
  const swapLedgerPath = getLedgerPath(swapRecovery.archiveRoot);
  const swapBackupPath = path.join(swapRecovery.archiveRoot, '.photo-ledger-swap-manual.backup.xlsx');
  const swapLedgerBytes = await fs.readFile(swapLedgerPath);
  await fs.rename(swapLedgerPath, swapBackupPath);
  const swapRecoveryResult = await recoverLedgerSwapArtifacts(swapRecovery.archiveRoot);
  assert.equal(swapRecoveryResult.recovered, true, '可恢复替换中断后应从唯一有效 backup 恢复台账');
  assert.deepEqual(await fs.readFile(swapLedgerPath), swapLedgerBytes, '恢复后的台账必须与原台账一致');
  assert.deepEqual(await listLedgerSwapFiles(swapRecovery.archiveRoot), [], '台账恢复成功后不得遗留交换文件');
}

async function createArchiveTransactionTestPlan(root, options = {}) {
  const count = Number(options.count) || 1;
  const tag = String(options.tag || 'test');
  const sourceDirectory = path.join(root, `source-${tag}`);
  const archiveRoot = options.archiveRoot || path.join(root, 'archive');
  await fs.mkdir(sourceDirectory, { recursive: true });
  const form = {
    project: '事务测试项目',
    watermarkCategory: '事务测试分类',
    workContent: '事务测试工作',
    date: '2026-07-17',
    location: '现场',
    keywords: '',
    remark: '',
    ...(options.formPatch || {})
  };
  const photos = [];
  const sources = [];
  for (let index = 0; index < count; index += 1) {
    const sourcePath = path.join(sourceDirectory, `source-${index + 1}.jpg`);
    const content = Buffer.from(`archive-transaction-${tag}-${index + 1}`);
    await fs.writeFile(sourcePath, content);
    photos.push({
      id: `${tag}-photo-${index + 1}`,
      path: sourcePath,
      name: path.basename(sourcePath),
      extension: '.jpg',
      sourceType: options.sourceKeys?.[index] ? 'marki_api' : 'local_folder',
      sourceKey: options.sourceKeys?.[index] || ''
    });
    sources.push({ path: sourcePath, content });
  }
  const previewResult = await buildArchivePreview({ form, photos, archiveRoot });
  return {
    root,
    archiveRoot,
    form,
    photos,
    preview: previewResult.previewPlan,
    previewItems: previewResult.items,
    sources
  };
}

function createSelectiveCopyFailure(blockedName) {
  return async (sourcePath, targetPath, mode) => {
    if (path.basename(sourcePath) === blockedName) throw createInjectedError('EACCES');
    return fs.copyFile(sourcePath, targetPath, mode);
  };
}

function createInjectedError(code) {
  const error = new Error('injected_failure');
  error.code = code;
  return error;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listArchiveTestImages(root) {
  const files = [];
  async function walk(directory) {
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) files.push(entry.name);
    }
  }
  await walk(root);
  return files.sort();
}

async function listArchiveStagingFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.name.endsWith('.archive-stage')) files.push(fullPath);
    }
  }
  await walk(root);
  return files.sort();
}

async function listLedgerSwapFiles(archiveRoot) {
  const entries = await fs.readdir(archiveRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('.photo-ledger-swap-'))
    .map((entry) => entry.name)
    .sort();
}

async function checkDownstreamPages({ root, archiveRoot, ledgerRecord }) {
  const documentsPath = path.join(root, 'documents');
  const packageTargetRoot = path.join(root, 'packages');
  await fs.mkdir(packageTargetRoot, { recursive: true });
  await saveSettings(documentsPath, {
    defaultArchiveRoot: archiveRoot,
    lastArchiveRoot: archiveRoot,
    defaultPhotoFolder: '',
    lastPhotoFolder: '',
    defaultArchivePackageRoot: packageTargetRoot
  });

  const packagePlan = buildPackagePlan([ledgerRecord], packageTargetRoot);
  assert.equal(packagePlan.existsCount, 1, '资料包预检查应识别可复制的归档照片');
  assert.equal(packagePlan.missingCount, 0, '资料包预检查不应误报文件缺失');
  const packageResult = await generateArchivePackage([
    ledgerRecord,
    { ...ledgerRecord, id: 'missing-package-record', archivePath: path.join(root, 'missing-package.jpg') }
  ], { targetRoot: packageTargetRoot });
  assert.equal(packageResult.copiedCount, 1, '资料包应复制存在的归档照片');
  assert.equal(packageResult.missingCount, 1, '资料包应记录并跳过缺失照片');
  assert.equal(await isFile(ledgerRecord.archivePath), true, '生成资料包不得移动或删除归档照片');

  const rectification = await saveRectificationItem(documentsPath, {
    project: ledgerRecord.project,
    responsibleDepartment: '秩序',
    watermarkCategory: ledgerRecord.watermarkCategory,
    workContent: ledgerRecord.workContent,
    location: ledgerRecord.location,
    title: `${ledgerRecord.workContent}整改`,
    description: ledgerRecord.remark || '现场问题',
    requirement: '请核实并完成整改。',
    deadline: '2026-06-20',
    status: '待整改',
    keywords: ledgerRecord.keywords,
    photos: {
      before: [{ filePath: ledgerRecord.archivePath, fileName: ledgerRecord.newFileName, stage: 'before', sourceType: '归档记录' }],
      during: [],
      after: []
    }
  });
  assert.equal(rectification.item.watermarkCategory, ledgerRecord.watermarkCategory, '整改事项应沿用归档分类');
  assert.equal(rectification.item.workContent, ledgerRecord.workContent, '整改事项应沿用工作内容');

  const summary = await loadSummaryData({ archiveRoot, documentsPath, projectRoot: process.cwd() });
  assert.equal(summary.photoRecords.length, 1, '资料汇总中心应读取归档照片记录');
  assert.equal(summary.rectificationItems.length, 1, '资料汇总中心应读取整改事项');
  assert.equal(summary.photoRecords[0].fileExists, true, '资料汇总中心应正确判断归档文件状态');

  const dashboard = await loadDashboardData({ documentsPath, projectRoot: process.cwd() });
  assert.equal(dashboard.archiveMetrics.total, 1, '首页归档总数应与台账一致');
  assert.equal(dashboard.archiveMetrics.missingCount, 0, '首页不应误报归档文件缺失');
  assert.equal(dashboard.rectificationMetrics.total, 1, '首页整改总数应与整改数据一致');

  const maintenance = await getDataMaintenanceReport({ documentsPath, projectRoot: process.cwd() });
  assert.equal(maintenance.ledgerStatus.total, 1, '数据维护中心台账统计应与归档记录一致');
  assert.equal(maintenance.ledgerStatus.missingCount, 0, '数据维护中心不应误报归档文件缺失');
}

async function checkSourceContracts() {
  const [
    mainSource,
    preloadSource,
    workspaceSource,
    settingsSource,
    serviceBriefSource,
    appConstantsSource,
    mainRouterSource,
    markiImportPageSource,
    markiClientSource,
    mainCssSource
  ] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SortWorkspacePage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SettingsPage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/ServiceBriefPage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/constants/app.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/MainRouter.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/MarkiPhotoImportPage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/utils/markiClient.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/styles/main.css'), 'utf8')
  ]);
  const invokedChannels = new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const handledChannels = new Set([...mainSource.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const missingHandlers = [...invokedChannels].filter((channel) => !handledChannels.has(channel));
  assert.deepEqual(missingHandlers, [], `preload 中存在无主进程处理器的 IPC：${missingHandlers.join(', ')}`);
  assert.equal(invokedChannels.has('archive:recoverPendingTransactions'), true, 'preload 应暴露最小归档事务恢复接口');
  assert.equal(workspaceSource.includes('recoverPendingArchiveTransactions'), true, '工作台应在归档根目录可用时恢复待补记事务');
  assert.equal(
    workspaceSource.includes('const effectivePhotoFolder = photoFolder;'),
    true,
    '工作台照片目录应只使用 RuntimeConfiguration 下发的权威值'
  );
  assert.equal(
    workspaceSource.includes('window.archiveAssistant.scanConfiguredImages()'),
    true,
    '工作台扫描应通过受控配置目录 IPC 执行'
  );
  assert.equal(workspaceSource.includes('|| pagePhotos[0] || photos[0] || null'), false, '空筛选组不得显示组外照片');
  assert.equal(workspaceSource.includes("['assigned', '待预览']"), false, '状态筛选不应重新出现冗余的“待预览”组');
  assert.equal(workspaceSource.includes('采用智拣结果'), false, '批量整理不应保留隐藏的自动采纳建议分支');
  assert.equal(workspaceSource.includes('套用并预览'), true, '当前表单应通过单一入口完成套用和预览');
  assert.equal(workspaceSource.includes('applyCurrentInfoAndBuildPreview'), true, '套用和预览应使用同一条业务路径');
  assert.equal(workspaceSource.includes('setSelectedIds(selectableGroupPhotos.map((photo) => photo.id))'), true, '进入智能分组时应自动选择本组可处理照片');
  assert.equal(workspaceSource.includes('重选本组'), true, '智能分组内应提供明确的重新全选入口');
  assert.equal(workspaceSource.includes('未自动选择照片'), false, '智能分组提示不应继续宣称不会自动选择');
  assert.equal(/function isSmartGroupBatchSelectable[\s\S]*?!hasArchivedPhotoState\(photo\)/.test(workspaceSource), true, '分组选择判断应使用组件外可访问的归档状态函数');
  assert.equal(workspaceSource.includes('canRestorePreviousGroup'), true, '取消预览时应优先恢复发起预览前的智能分组');
  assert.equal(workspaceSource.includes('并返回之前选择的智能分组'), true, '取消预览应明确反馈已返回原智能分组');
  assert.equal(/项目部门照片来源/.test(settingsSource), false, '系统设置不应继续暴露已停用的旧版基础数据入口');
  assert.equal(serviceBriefSource.includes('archivedDateCounts'), true, '每日服务简报日期选择器应统计有归档的日期');
  assert.equal(serviceBriefSource.includes('archive-date-dot'), true, '每日服务简报日历应显示归档日期圆点');
  assert.match(
    appConstantsSource,
    /dashboard[\s\S]*markiImport[\s\S]*sortWorkspace/,
    '工作台导航顺序应为首页、马克照片导入、照片分拣工作台'
  );
  assert.equal(mainRouterSource.includes('MarkiPhotoImportPage'), true, '主路由应接入马克照片导入页');
  assert.equal(
    settingsSource.includes('listMarkiTeams') || settingsSource.includes('listMarkiMembers'),
    false,
    '设置页不得继续承担团队和成员筛选'
  );
  for (const method of [
    'startMarkiPhotoQuerySession',
    'getMarkiPhotoQuerySession',
    'loadNextMarkiPhotoQueryPage',
    'destroyMarkiPhotoQuerySession',
    'importMarkiPhotoQuerySelection',
    'listReadyMarkiImportBatches'
  ]) {
    assert.equal(markiImportPageSource.includes(method), true, `马克照片导入页应使用 ${method}`);
    assert.equal(markiClientSource.includes(`function ${method}`), true, `Marki 客户端应公开 ${method}`);
  }
  assert.equal(markiImportPageSource.includes('sessionStorage'), true, '马克照片查询会话应支持页面刷新恢复');
  assert.equal(markiImportPageSource.includes('appendMarkiImportBatch'), true, 'ready 批次应导航到现有工作台');
  assert.equal(markiImportPageSource.includes('selectionToken'), true, '页面选择只能使用不透明 selectionToken');
  assert.equal(
    markiImportPageSource.includes("isRefreshingReadyBatches ? '刷新中...'"),
    true,
    '待处理批次刷新按钮应显示独立加载状态'
  );
  assert.equal(
    markiImportPageSource.includes('setNotice(result.notice)'),
    true,
    '待处理批次刷新结果必须进入页面可见提示'
  );
  assert.equal(
    markiImportPageSource.includes('createMarkiReadyBatchRefresh'),
    true,
    '待处理批次刷新必须使用单飞控制器避免并发请求'
  );
  assert.equal(markiImportPageSource.includes('.url'), false, '页面不得读取远程照片 URL');
  assert.equal(markiImportPageSource.includes('momentId'), false, '页面不得读取真实 momentId');
  assert.equal(markiImportPageSource.includes('sourceKey'), false, '页面不得读取 sourceKey');
  assert.equal(mainCssSource.includes('.marki-import-page'), true, '马克导入页面样式应使用独立前缀');
  assert.match(
    mainSource,
    /marki:import-photo-query-selection[\s\S]*safeMarkiCall/,
    '可信照片导入 IPC 必须由主进程加载凭证'
  );
  assert.match(
    mainSource,
    /marki:list-ready-import-batches[\s\S]*safeMarkiLocalCall/,
    'ready 批次发现 IPC 不得依赖马克凭证'
  );
  assert.equal(
    /marki:import-photo-query-selection[\s\S]{0,500}getWritableDocumentsPath/.test(mainSource),
    false,
    '正式马克来源目录不得回退到 userData'
  );
}

async function checkSortWorkspaceToolbar(root) {
  await fs.mkdir(root, { recursive: true });
  const sourceAwareModule = await import(
    pathToFileURL(path.resolve(process.cwd(), 'src/utils/sourceAwareRecognition.js')).href
  );
  const workflowModule = await import(
    pathToFileURL(path.resolve(process.cwd(), 'src/utils/photoWorkflowStage.js')).href
  );
  const snapshotModule = await import(
    pathToFileURL(path.resolve(process.cwd(), 'src/utils/sortWorkspaceSnapshot.js')).href
  );
  const recoveryModule = await import(
    pathToFileURL(path.resolve(process.cwd(), 'src/utils/markiRecoveryDialog.js')).href
  );
  let scenarioCount = 0;
  let assertionCount = 0;
  let sourceContractCount = 0;
  const check = (condition, message) => {
    assert.equal(Boolean(condition), true, message);
    assertionCount += 1;
  };
  const equal = (actual, expected, message) => {
    assert.equal(actual, expected, message);
    assertionCount += 1;
  };
  const deepEqual = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    assertionCount += 1;
  };

  const makePhoto = (index, overrides = {}) => ({
    id: `toolbar-photo-${index}`,
    originalPath: path.join(root, `photo-${index}.jpg`),
    originalName: `照片-${String(index).padStart(2, '0')}.jpg`,
    extension: '.jpg',
    size: 100 + index,
    modifiedAt: `2026-07-${String(Math.min(index, 28)).padStart(2, '0')}T08:00:00.000Z`,
    sourceType: 'local_file',
    sortStatus: 'recognized',
    smartSortStatus: index <= 15 ? 'completed' : 'not_run',
    ...overrides
  });
  const photos = Array.from({ length: 20 }, (_, index) => makePhoto(index + 1));
  photos[0] = makePhoto(1, {
    sourceType: 'marki_api',
    sourceKey: 'marki_api:100:photo-1',
    sourceMetadataRef: 'marki_source_metadata:100:photo-1'
  });
  const platformArtifacts = {
    recognitionResult: {
      source: 'marki_api',
      providerType: 'structured_data',
      photoId: 'toolbar-photo-1',
      parsedWatermark: {
        date: '2026-07-19',
        projectName: '测试项目',
        watermarkCategory: '巡查',
        workContent: '设备巡查'
      },
      platformBaseline: {
        requiredFields: {
          date: '2026-07-19',
          project: '测试项目',
          watermarkCategory: '巡查',
          workContent: '设备巡查'
        }
      }
    },
    watermarkRecord: {
      source: 'marki_api',
      photoId: 'toolbar-photo-1',
      captureDate: '2026-07-19',
      projectText: '测试项目',
      watermarkCategoryText: '巡查',
      workContentText: '设备巡查'
    },
    archiveSuggestion: {
      source: 'marki_api',
      photoId: 'toolbar-photo-1',
      suggestedFields: {
        date: '2026-07-19',
        project: '测试项目',
        watermarkCategory: '巡查',
        workContent: '设备巡查'
      }
    }
  };
  const recognitionResultsByPhoto = Object.fromEntries(photos.map((photo) => [
    photo.id,
    photo.id === photos[0].id
      ? structuredClone(platformArtifacts.recognitionResult)
      : { source: 'local_ocr', rawText: `识别-${photo.id}` }
  ]));
  const watermarkRecordsByPhoto = Object.fromEntries(photos.map((photo) => [
    photo.id,
    photo.id === photos[0].id
      ? structuredClone(platformArtifacts.watermarkRecord)
      : { workContentText: `巡查-${photo.id}` }
  ]));
  const archiveSuggestionsByPhoto = Object.fromEntries(photos.map((photo) => [
    photo.id,
    photo.id === photos[0].id
      ? structuredClone(platformArtifacts.archiveSuggestion)
      : { suggestedFields: { workContent: `巡查-${photo.id}` } }
  ]));
  const smartSortResult = {
    status: 'created',
    groups: [
      {
        id: 'group-a',
        title: 'A 组',
        photoIds: photos.slice(0, 10).map((photo) => photo.id),
        photoCount: 10
      },
      {
        id: 'group-b',
        title: 'B 组',
        photoIds: photos.slice(10, 15).map((photo) => photo.id),
        photoCount: 5
      }
    ],
    groupCount: 2,
    photoCount: 15
  };

  const reset = sourceAwareModule.resetSelectedSmartSortResults({
    photos,
    selectedPhotoIds: photos.slice(0, 3).map((photo) => photo.id),
    recognitionResultsByPhoto,
    watermarkRecordsByPhoto,
    archiveSuggestionsByPhoto,
    smartSortResult
  });
  scenarioCount += 1;
  equal(reset.targetPhotoIds.length, 3, '局部重置只能命中三个已选且可重置照片');
  deepEqual(
    reset.photos.slice(0, 3).map((photo) => photo.smartSortStatus),
    ['not_run', 'not_run', 'not_run'],
    '三个目标照片应回到待智拣'
  );
  check(
    reset.photos.slice(3, 15).every((photo, index) => photo === photos[index + 3]),
    '未选中的十二张已分组照片必须保持原对象'
  );
  equal(
    sourceAwareModule.buildSmartSortGroupMembershipByPhotoId(reset.smartSortResult).size,
    12,
    '局部重置后应保留十二张未选中照片的 membership'
  );
  equal(reset.smartSortResult.groups.length, 2, '非空旧分组必须保留');

  scenarioCount += 1;
  deepEqual(
    reset.recognitionResultsByPhoto[photos[0].id],
    platformArtifacts.recognitionResult,
    'Marki recognition 平台基线必须完整保留'
  );
  deepEqual(
    reset.watermarkRecordsByPhoto[photos[0].id],
    platformArtifacts.watermarkRecord,
    'Marki watermark 平台基线必须完整保留'
  );
  deepEqual(
    reset.archiveSuggestionsByPhoto[photos[0].id],
    platformArtifacts.archiveSuggestion,
    'Marki suggestion 平台基线必须完整保留'
  );
  equal(
    sourceAwareModule.classifyPhotoRecognitionRoute({
      photo: reset.photos[0],
      recognitionResult: reset.recognitionResultsByPhoto[photos[0].id],
      watermarkRecord: reset.watermarkRecordsByPhoto[photos[0].id],
      archiveSuggestion: reset.archiveSuggestionsByPhoto[photos[0].id]
    }),
    'marki_platform_only',
    '完整 Marki 重置后再次智拣仍应跳过 OCR'
  );

  scenarioCount += 1;
  for (const localPhoto of photos.slice(1, 3)) {
    equal(reset.recognitionResultsByPhoto[localPhoto.id], undefined, '本地 OCR recognition 应清除');
    equal(reset.watermarkRecordsByPhoto[localPhoto.id], undefined, '本地 OCR watermark 应清除');
    equal(reset.archiveSuggestionsByPhoto[localPhoto.id], undefined, '本地 OCR suggestion 应清除');
  }
  check(reset.photos.includes(photos[3]), '本地源照片记录必须保留');

  scenarioCount += 1;
  const protectedPhotos = [
    makePhoto(21, { smartSortStatus: 'completed', sortStatus: 'archived' }),
    makePhoto(22, { smartSortStatus: 'completed', sortStatus: 'archiving' }),
    makePhoto(23, { smartSortStatus: 'completed', originalMissing: true })
  ];
  const protectedReset = sourceAwareModule.resetSelectedSmartSortResults({
    photos: protectedPhotos,
    selectedPhotoIds: protectedPhotos.map((photo) => photo.id),
    smartSortResult: {
      groups: [{ id: 'protected', photoIds: protectedPhotos.map((photo) => photo.id) }]
    }
  });
  equal(protectedReset.targetPhotoIds.length, 0, '归档、归档中和原图缺失照片不得被普通重置');
  check(
    protectedReset.photos.every((photo, index) => photo === protectedPhotos[index]),
    '高优先级照片必须保持原对象'
  );

  const localPool = Array.from({ length: 20 }, (_, index) => makePhoto(index + 101, {
    smartSortStatus: index < 6 ? 'completed' : 'not_run'
  }));
  const sixMemberships = new Map(
    localPool.slice(0, 6).map((photo) => [photo.id, 'six-group'])
  );
  scenarioCount += 1;
  equal(
    workflowModule.getWorkflowFilterCount('pending_sort', localPool, [], sixMemberships),
    14,
    '20 张照片局部智拣 6 张后待智拣应为 14'
  );
  equal(
    workflowModule.getWorkflowFilterCount('pending_organize', localPool, [], sixMemberships),
    6,
    '20 张照片局部智拣 6 张后待整理应为 6'
  );
  const pendingSortIds = new Set(
    workflowModule.getVisibleWorkflowPhotos({
      photos: localPool,
      groupMembershipByPhotoId: sixMemberships,
      filter: 'pending_sort'
    }).map((photo) => photo.id)
  );
  const pendingOrganizeIds = new Set(
    workflowModule.getVisibleWorkflowPhotos({
      photos: localPool,
      groupMembershipByPhotoId: sixMemberships,
      filter: 'pending_organize'
    }).map((photo) => photo.id)
  );
  check(
    [...pendingSortIds].every((photoId) => !pendingOrganizeIds.has(photoId)),
    '待智拣和待整理必须互斥'
  );
  equal(new Set([...pendingSortIds, ...pendingOrganizeIds]).size, 20, '两个主阶段并集应覆盖 20 张照片');

  scenarioCount += 1;
  const seventeenPool = localPool.map((photo, index) => ({
    ...photo,
    smartSortStatus: index < 17 ? 'completed' : 'not_run'
  }));
  const seventeenMemberships = new Map(
    seventeenPool.slice(0, 17).map((photo) => [photo.id, 'existing-group'])
  );
  equal(
    workflowModule.getWorkflowFilterCount('pending_organize', seventeenPool, [], seventeenMemberships),
    17,
    '已有 15 张待整理再智拣 2 张后待整理应为 17'
  );
  equal(
    workflowModule.getWorkflowFilterCount('pending_sort', seventeenPool, [], seventeenMemberships),
    3,
    '已有 15 张待整理再智拣 2 张后待智拣应为 3'
  );

  scenarioCount += 1;
  const specialPhoto = makePhoto(130, {
    originalMissing: true,
    sortStatus: 'archived',
    smartSortStatus: 'completed'
  });
  equal(
    workflowModule.classifyPhotoWorkflowStage(specialPhoto, true),
    'original_missing',
    '原图缺失应优先于归档和智拣阶段'
  );
  equal(
    workflowModule.getWorkflowFilterCount('original_missing', [specialPhoto], [], new Map([[specialPhoto.id, 'g']])),
    1,
    '徽标和筛选应复用同一高优先级阶段'
  );

  scenarioCount += 1;
  const displayInput = localPool.slice(0, 4);
  const displayBefore = structuredClone(displayInput);
  const searched = workflowModule.getVisibleWorkflowPhotos({
    photos: displayInput,
    groupMembershipByPhotoId: new Map(),
    filter: 'all',
    searchText: '照片-',
    selectedIds: [displayInput[3].id],
    sortMode: 'nameDesc'
  });
  equal(searched.length, 4, '搜索应支持当前照片命名');
  check(
    searched[0].originalName.localeCompare(searched[1].originalName, 'zh-CN') >= 0,
    '名称降序应只改变返回顺序'
  );
  deepEqual(displayInput, displayBefore, '搜索和排序不得修改照片业务对象');
  equal(
    workflowModule.getVisibleWorkflowPhotos({
      photos: displayInput,
      groupMembershipByPhotoId: new Map(),
      filter: 'all',
      searchText: ''
    }).length,
    4,
    '清空搜索后全部照片应恢复'
  );

  scenarioCount += 1;
  const localDirectory = workflowModule.resolvePhotoDirectoryTarget({
    photos: [displayInput[0]],
    activePhotoId: displayInput[0].id,
    photoFolder: path.join(root, 'local-photos')
  });
  equal(localDirectory.sourceType, 'local_file', '本地照片应打开当前本地来源目录');
  equal(localDirectory.targetPath, path.join(root, 'local-photos'), '本地照片目录目标必须稳定');
  const markiDirectory = workflowModule.resolvePhotoDirectoryTarget({
    photos: [photos[0]],
    activePhotoId: photos[0].id,
    photoFolder: path.join(root, 'local-photos')
  });
  equal(markiDirectory.sourceType, 'marki_api', 'Marki 照片应打开软件管理目录');
  equal(markiDirectory.targetPath, path.dirname(photos[0].originalPath), 'Marki 目录应取托管 JPG 所在目录');
  equal(
    workflowModule.resolveArchiveDirectoryTarget('').success,
    false,
    '归档目录未配置时必须明确失败'
  );

  const manualPhotos = [
    makePhoto(201, {
      sourceType: 'marki_api',
      sourceKey: 'marki_api:200:201',
      sourceMetadataRef: 'marki_source_metadata:200:201',
      previewUrl: 'local-photo://image/secret',
      thumbnailPath: 'local-photo://image/secret',
      smartSortStatus: 'completed'
    }),
    makePhoto(202, {
      sortStatus: 'ignored',
      ignoredPreviousSortStatus: 'recognized',
      ignoredPreviousState: { smartSortStatus: 'completed' }
    })
  ];
  await Promise.all(manualPhotos.map((photo) => fs.writeFile(photo.originalPath, `photo-${photo.id}`)));
  const manualWorkspace = {
    photos: manualPhotos,
    selectedIds: [manualPhotos[0].id],
    activePhotoId: manualPhotos[0].id,
    recognitionResultsByPhoto: {
      [manualPhotos[0].id]: {
        ...platformArtifacts.recognitionResult,
        sourceAwareProcessing: {
          strategy: 'platform_only',
          conflicts: []
        }
      }
    },
    watermarkRecordsByPhoto: {
      [manualPhotos[0].id]: platformArtifacts.watermarkRecord
    },
    archiveSuggestionsByPhoto: {
      [manualPhotos[0].id]: platformArtifacts.archiveSuggestion
    },
    smartSortResult: {
      status: 'created',
      groups: [{ id: 'manual-group', photoIds: [manualPhotos[0].id], photoCount: 1 }]
    },
    smartSortViewMode: 'smartSortGroup',
    activeSmartSortGroupId: 'manual-group',
    photoFolder: path.join(root, 'manual-local'),
    archiveRoot: path.join(root, 'manual-archive'),
    filter: 'pending_organize',
    sortMode: 'nameDesc',
    pageSize: 100,
    rightPanelMode: 'recognition',
    form: { project: '人工项目', workContent: '人工内容' },
    searchText: '设备',
    page: 2,
    viewMode: 'list'
  };
  scenarioCount += 1;
  const manualDraft = snapshotModule.buildSortWorkspaceManualDraft(manualWorkspace, {
    savedAt: '2026-07-19T08:00:00.000Z'
  });
  const manualText = JSON.stringify(manualDraft);
  check(!manualText.includes('local-photo://'), '手工草稿不得保存 Electron 临时预览 URL');
  check(!manualText.includes('"previewUrl"'), '手工草稿不得保存 previewUrl');
  check(!manualText.includes('"thumbnailPath"'), '手工草稿不得保存 thumbnailPath');
  const parsedDraft = snapshotModule.readSortWorkspaceManualDraft(manualDraft);
  deepEqual(parsedDraft.workspace.selectedIds, manualWorkspace.selectedIds, '手工草稿应保存选择');
  equal(parsedDraft.workspace.activePhotoId, manualWorkspace.activePhotoId, '手工草稿应保存当前照片');
  equal(parsedDraft.workspace.viewMode, 'list', '手工草稿应保存列表视图');
  equal(parsedDraft.workspace.sortMode, 'nameDesc', '手工草稿应保存排序');
  equal(parsedDraft.workspace.searchText, '设备', '手工草稿应保存搜索');
  equal(parsedDraft.workspace.filter, 'pending_organize', '手工草稿应保存筛选');
  equal(parsedDraft.workspace.smartSortResult.groups.length, 1, '手工草稿应保存 membership');
  equal(
    parsedDraft.workspace.recognitionResultsByPhoto[manualPhotos[0].id].sourceAwareProcessing.strategy,
    'platform_only',
    '手工草稿应保存来源感知处理层'
  );

  scenarioCount += 1;
  const legacyDraft = snapshotModule.readSortWorkspaceManualDraft({
    version: '1.3.3',
    photos: [makePhoto(203)],
    recognitionResultsByPhoto: {},
    watermarkRecordsByPhoto: {},
    archiveSuggestionsByPhoto: {}
  });
  equal(legacyDraft.workspace.viewMode, 'grid', '旧草稿缺少 viewMode 时应使用安全默认值');
  equal(legacyDraft.workspace.sortMode, 'timeAsc', '旧草稿缺少 sortMode 时应使用安全默认值');
  equal(legacyDraft.workspace.smartSortResult, null, '旧草稿缺少分组时不得伪造 membership');

  scenarioCount += 1;
  assert.throws(
    () => snapshotModule.readSortWorkspaceManualDraft({
      photos: [makePhoto(204), makePhoto(204)]
    }),
    /重复照片/,
    '损坏草稿包含重复照片时必须整体拒绝'
  );
  assertionCount += 1;

  scenarioCount += 1;
  const snapshotRoot = path.join(root, 'snapshot');
  const snapshotSave = await saveSortWorkspaceSnapshot(snapshotRoot, parsedDraft.workspace, {
    now: new Date('2026-07-19T08:05:00.000Z')
  });
  equal(snapshotSave.success, true, '手工恢复结果应能立即进入自动快照');
  const snapshotLoad = await loadSortWorkspaceSnapshot(snapshotRoot);
  equal(snapshotLoad.success, true, '全新实例应能加载手工恢复后的自动快照');
  equal(snapshotLoad.snapshot.workspace.photos.length, 2, '自动快照应恢复 Marki 和本地照片');
  equal(snapshotLoad.snapshot.workspace.viewMode, 'list', '自动快照应恢复展示方式');
  equal(
    snapshotLoad.snapshot.workspace.smartSortResult.groups[0].photoIds[0],
    manualPhotos[0].id,
    '自动快照应恢复唯一 membership'
  );

  scenarioCount += 1;
  const recoverySummary = recoveryModule.summarizeMarkiRecoveryCandidates([
    { recoveryToken: 'a', status: 'recoverable' },
    { recoveryToken: 'b', status: 'already_in_workbench' },
    { recoveryToken: 'c', status: 'already_archived' },
    { recoveryToken: 'd', status: 'missing_file' },
    { recoveryToken: 'e', status: 'corrupted_file' },
    { recoveryToken: 'f', status: 'invalid_record' }
  ]);
  deepEqual(recoverySummary, {
    recoverable: 1,
    alreadyInWorkbench: 1,
    alreadyArchived: 1,
    missingFile: 1,
    abnormal: 2
  }, '恢复弹窗应逐项统计五类安全状态');
  deepEqual(
    recoveryModule.getRecoverableMarkiRecoveryTokens([
      { recoveryToken: 'a', status: 'recoverable' },
      { recoveryToken: 'a', status: 'recoverable' },
      { recoveryToken: 'b', status: 'already_in_workbench' }
    ]),
    ['a'],
    '恢复全部只能提交唯一的可恢复令牌'
  );
  equal(
    recoveryModule.buildMarkiRecoveryCompletionNotice({
      recoveredCount: 2,
      skippedCount: 1,
      failedCount: 1
    }),
    '恢复完成：新增 2 张，跳过重复 1 张，失败 1 张。',
    '恢复完成反馈必须包含新增、重复和失败统计'
  );

  scenarioCount += 1;
  const pageSource = await fs.readFile(
    path.resolve(process.cwd(), 'src/pages/SortWorkspacePage.jsx'),
    'utf8'
  );
  const dialogSource = await fs.readFile(
    path.resolve(process.cwd(), 'src/components/MarkiRehydrateDialog.jsx'),
    'utf8'
  );
  const cssSource = await fs.readFile(
    path.resolve(process.cwd(), 'src/styles/main.css'),
    'utf8'
  );
  const sourceCheck = (condition, message) => {
    assert.equal(Boolean(condition), true, message);
    sourceContractCount += 1;
  };
  sourceCheck(pageSource.includes('ref={moreMenuRef}'), '更多菜单必须可受控关闭');
  sourceCheck(pageSource.includes('moreMenuRef.current.open = false'), '打开恢复弹窗前必须关闭更多菜单');
  sourceCheck(pageSource.includes('>恢复 Marki 照片</button>'), '更多菜单应使用可完整显示的短文案');
  sourceCheck(pageSource.includes('<MarkiRehydrateDialog'), '恢复内容必须由独立弹窗承载');
  sourceCheck(!pageSource.includes('aria-label="已下载马克照片恢复"'), '恢复面板不得继续内嵌在照片池');
  sourceCheck(dialogSource.includes('createPortal'), '恢复弹窗必须使用 React portal');
  sourceCheck(dialogSource.includes('document.body'), '恢复弹窗必须挂载到 document.body');
  sourceCheck(dialogSource.includes('document.body.style.overflow = \'hidden\''), '弹窗打开时必须锁定背景滚动');
  sourceCheck(dialogSource.includes('role="dialog"'), '恢复容器必须声明 dialog 语义');
  sourceCheck(dialogSource.includes('aria-modal="true"'), '恢复容器必须阻止背景交互语义');
  sourceCheck(dialogSource.includes('marki-rehydrate-table-wrap'), '长列表必须使用独立滚动容器');
  sourceCheck(dialogSource.includes('恢复全部可恢复项'), '弹窗必须保留恢复全部入口');
  sourceCheck(!dialogSource.includes('sourceKey'), '恢复弹窗不得显示 sourceKey');
  sourceCheck(!dialogSource.includes('originalPath'), '恢复弹窗不得显示完整路径');
  sourceCheck(!dialogSource.includes('url'), '恢复弹窗不得显示 URL');
  sourceCheck(cssSource.includes('width: min(840px, 90vw)'), '恢复弹窗宽度必须受视口约束');
  sourceCheck(cssSource.includes('max-height: 80vh'), '恢复弹窗高度必须受视口约束');
  sourceCheck(cssSource.includes('grid-template-rows: auto auto minmax(0, 1fr) auto'), '标题、列表和底部操作区必须保持稳定布局');

  scenarioCount += 1;
  const searchHandlerSource = pageSource.slice(
    pageSource.indexOf('function handleSearchTextChange'),
    pageSource.indexOf('function handlePhotoClick')
  );
  sourceCheck(!searchHandlerSource.includes('setSelectedIds([])'), '搜索不得清除跨页选择');
  sourceCheck(!searchHandlerSource.includes('setActivePhotoId('), '搜索不得改写当前照片');
  const filterHandlerSource = pageSource.slice(
    pageSource.indexOf('function applyStatusFilter'),
    pageSource.indexOf('function viewSmartGroup')
  );
  sourceCheck(!filterHandlerSource.includes('setSelectedIds([])'), '状态筛选不得清除选择');
  sourceCheck(!filterHandlerSource.includes('setActivePhotoId('), '状态筛选不得改写当前照片');
  sourceCheck(pageSource.includes('getWorkflowFilterCount(key, photos'), '筛选数量必须复用统一逐照片分类');
  sourceCheck(pageSource.includes('getPhotoWorkflowStageLabel(photo'), '状态徽标必须复用统一逐照片分类');
  sourceCheck(pageSource.includes('buildSortWorkspaceManualDraft'), '手工保存必须复用完整工作台序列化');
  sourceCheck(pageSource.includes('readSortWorkspaceManualDraft'), '手工恢复必须先完成安全解析');
  sourceCheck(pageSource.includes('saveAutomaticSnapshotImmediately(restoredWorkspace)'), '手工恢复成功前必须先写自动快照');

  check(scenarioCount === 16, '照片池工具栏闭环应执行十六个真实行为场景');
  console.log(
    `照片池工具栏闭环自检通过：${scenarioCount} 个行为场景，${assertionCount} 个行为断言，${sourceContractCount} 个源码契约断言。`
  );
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
    || seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

async function checkMarkiImportLifecycleClosure(root) {
  const documentsPath = path.join(root, 'Documents');
  const userDataPath = path.join(root, 'userData');
  await fs.mkdir(documentsPath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  const lifecycleModule = await import(
    `${pathToFileURL(path.resolve(process.cwd(), 'src/utils/markiImportLifecycle.js')).href}?lifecycle=${Date.now()}`
  );
  let behaviorAssertionCount = 0;
  let sourceContractCount = 0;
  const behavior = (condition, message) => {
    assert.equal(Boolean(condition), true, message);
    behaviorAssertionCount += 1;
  };
  const sourceContract = (condition, message) => {
    assert.equal(Boolean(condition), true, message);
    sourceContractCount += 1;
  };

  const queryPhotos = [
    {
      selectionToken: 'token-a',
      displayId: '1',
      templateName: ' 时间地点（兜底选择） ',
      templateKey: 'name:时间地点（兜底选择）',
      selectedSourceStatus: 'discovered'
    },
    {
      selectionToken: 'token-b',
      displayId: '2',
      templateName: '工程记录',
      templateKey: 'name:工程记录',
      selectedSourceStatus: 'imported_active'
    },
    {
      selectionToken: 'token-c',
      displayId: '3',
      templateName: '',
      templateKey: 'template_unknown',
      selectedSourceStatus: 'discovered'
    },
    {
      selectionToken: 'token-d',
      displayId: '4',
      templateName: '工程记录',
      templateKey: 'name:工程记录',
      selectedSourceStatus: 'removed_reimportable'
    },
    {
      selectionToken: 'token-e',
      displayId: '5',
      templateName: '工程记录',
      templateKey: 'name:工程记录',
      selectedSourceStatus: 'failed_retryable'
    },
    {
      selectionToken: 'token-f',
      displayId: '6',
      templateName: '',
      templateKey: 'template_unknown',
      selectedSourceStatus: 'archived_locked'
    }
  ];
  const rawCopy = structuredClone(queryPhotos);
  const templateOptions = lifecycleModule.buildMarkiTemplateFilterOptions(queryPhotos);
  behavior(templateOptions[0].value === 'all', '模板筛选默认入口必须为全部模板');
  behavior(templateOptions.some((item) => item.label === '时间地点(兜底选择)'), 'markName 必须经规范化后动态生成具体模板选项');
  behavior(templateOptions.some((item) => item.value === 'name:工程记录'), '相同模板名称必须合并为一个筛选选项');
  behavior(templateOptions.some((item) => item.value === 'template_unknown'), 'markName 为空时必须提供模板未知选项');
  behavior(!templateOptions.some((item) => item.value === 'watermarked'), '不得再生成虚构的全部有水印筛选');
  behavior(!templateOptions.some((item) => item.value === 'unwatermarked'), '不得再生成无水印筛选');
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'all',
      importStatusFilter: 'all'
    }).length === 6,
    '全部模板必须保留所有已加载记录'
  );
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'name:工程记录',
      importStatusFilter: 'all'
    }).length === 3,
    '具体模板筛选必须精确匹配'
  );
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'template_unknown',
      importStatusFilter: 'all'
    }).map((item) => item.selectionToken).join(',') === 'token-c,token-f',
    '模板未知筛选必须只返回 markName 为空的照片'
  );
  behavior(
    lifecycleModule.normalizeStoredTemplateFilter('name: 工程　记录') === 'name:工程 记录',
    '旧 name:* 水印筛选必须迁移为同值模板筛选'
  );
  behavior(lifecycleModule.normalizeStoredTemplateFilter('watermarked') === 'all', '其他旧水印筛选必须迁移为全部模板');
  behavior(lifecycleModule.isMarkiQueryPhotoSelectable(queryPhotos[2]), '模板未知但生命周期为 discovered 的照片必须可选择');
  behavior(!lifecycleModule.isMarkiQueryPhotoSelectable(queryPhotos[5]), '已归档照片不得重复选择');
  behavior(!lifecycleModule.isMarkiQueryPhotoSelectable(queryPhotos[1]), '已在工作池照片不得选择');
  behavior(lifecycleModule.isMarkiQueryPhotoSelectable(queryPhotos[0]), 'discovered 照片必须可选择');
  behavior(lifecycleModule.isMarkiQueryPhotoSelectable(queryPhotos[3]), '已撤销照片必须可重新选择');
  behavior(lifecycleModule.isMarkiQueryPhotoSelectable(queryPhotos[4]), '失败照片必须可重试选择');
  behavior(
    lifecycleModule.selectMarkiFilteredTokens(queryPhotos).join(',') === 'token-a,token-c,token-d,token-e',
    '全选资格必须只由生命周期状态决定'
  );
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'all',
      importStatusFilter: 'not_imported'
    }).map((item) => item.selectionToken).join(',') === 'token-a,token-c',
    '未导入状态筛选必须准确'
  );
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'all',
      importStatusFilter: 'imported_active'
    })[0].selectionToken === 'token-b',
    '已在工作池状态筛选必须准确'
  );
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'all',
      importStatusFilter: 'removed_reimportable'
    })[0].selectionToken === 'token-d',
    '可重新导入状态筛选必须准确'
  );
  behavior(
    lifecycleModule.filterMarkiQueryPhotos(queryPhotos, {
      templateFilter: 'all',
      importStatusFilter: 'failed_retryable'
    })[0].selectionToken === 'token-e',
    '失败状态筛选必须准确'
  );
  const querySummary = lifecycleModule.summarizeMarkiQueryResults(
    queryPhotos,
    queryPhotos.slice(0, 3),
    ['token-a', 'token-c', 'token-d']
  );
  behavior(querySummary.loadedCount === 6, '已加载数量必须来自原始结果');
  behavior(querySummary.filteredCount === 3, '当前筛选数量必须来自筛选结果');
  behavior(querySummary.selectedCount === 2, '已选择数量必须只统计当前可见选择');
  behavior(!Object.hasOwn(querySummary, 'unwatermarkedCount'), '新摘要不得产生无水印数量');
  behavior(!Object.hasOwn(querySummary, 'watermarkUnknownCount'), '新摘要不得产生水印状态待确认数量');
  behavior(querySummary.selectableCount === 2, '可选择数量必须只按生命周期计算');
  behavior(JSON.stringify(queryPhotos) === JSON.stringify(rawCopy), '客户端筛选不得修改原始查询结果');
  behavior(lifecycleModule.normalizeMarkiTemplateName(' 工程　记录 ') === '工程 记录', '模板名称必须执行 NFKC 和安全空白规范化');

  const occupancyBase = {
    id: 'workspace-marki-photo',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:12345:workspace-marki-photo',
    fileHealth: {
      exists: true,
      healthStatus: 'healthy'
    }
  };
  behavior(
    resolveWorkspaceSourceOccupancy(occupancyBase).occupancy === 'healthy_active',
    '健康且指纹可信的工作池 Marki 照片必须形成 active 占用'
  );
  behavior(
    resolveWorkspaceSourceOccupancy({
      ...occupancyBase,
      originalMissing: true,
      fileHealth: { exists: false, healthStatus: 'missing' }
    }).sourceStatus === 'workspace_file_repairable',
    '工作池文件缺失必须进入可修复生命周期'
  );
  behavior(
    resolveWorkspaceSourceOccupancy({
      ...occupancyBase,
      fileHealth: { exists: true, healthStatus: 'fingerprint_changed' }
    }).occupancy === 'repairable_corrupt',
    '工作池文件指纹变化必须判为可修复损坏'
  );
  behavior(
    resolveWorkspaceSourceOccupancy({
      ...occupancyBase,
      fileHealth: { exists: true, healthStatus: 'decode_failed' }
    }).sourceStatus === 'workspace_file_repairable',
    '工作池文件真实解码失败必须进入可修复生命周期'
  );
  behavior(
    resolveWorkspaceSourceOccupancy({
      ...occupancyBase,
      sortStatus: 'archived',
      originalMissing: true,
      fileHealth: { exists: false, healthStatus: 'missing' }
    }).occupancy === 'archived_locked',
    '已归档照片即使缓存缺失也必须保持归档锁定'
  );
  behavior(
    resolveWorkspaceSourceOccupancy({
      id: 'local-photo',
      sourceType: 'local_file',
      fileHealth: { exists: true, healthStatus: 'healthy' }
    }).occupancy === 'absent',
    '没有 Marki sourceKey 的工作池照片不得形成 Marki 来源占用'
  );
  const repairWorkspace = {
    photos: [{
      ...occupancyBase,
      id: 'stable-photo-id',
      originalPath: 'C:\\stale\\photo.jpg',
      originalMissing: true,
      fileHealth: { exists: false, healthStatus: 'missing' },
      smartSortStatus: 'needs_completion'
    }],
    photoDraftByPhotoId: {
      'stable-photo-id': { remarks: '人工草稿必须保留' }
    },
    recognitionResultsByPhoto: {
      'stable-photo-id': { source: 'marki_api', text: '平台识别基线' }
    }
  };
  const repairedWorkspace = lifecycleModule.prepareMarkiWorkspaceFileRepairs(
    repairWorkspace,
    {
      photos: [{
        id: 'incoming-generated-id',
        sourceType: 'marki_api',
        sourceKey: occupancyBase.sourceKey,
        originalPath: 'C:\\managed\\repaired.jpg',
        originalName: 'repaired.jpg',
        extension: '.jpg',
        size: 2048,
        sha256: 'a'.repeat(64),
        width: 1200,
        height: 900,
        modifiedAt: '2026-07-23T00:00:00.000Z',
        thumbnailPath: 'C:\\managed\\thumb.jpg',
        previewUrl: 'file:///managed/repaired.jpg'
      }]
    }
  );
  behavior(repairedWorkspace.repairedCount === 1, '可信同源照片必须修复一条工作池记录');
  behavior(repairedWorkspace.workspace.photos[0].id === 'stable-photo-id', '文件修复必须保留原 photoId');
  behavior(
    repairedWorkspace.workspace.photoDraftByPhotoId['stable-photo-id'].remarks === '人工草稿必须保留',
    '文件修复必须保留人工草稿'
  );
  behavior(
    repairedWorkspace.workspace.recognitionResultsByPhoto['stable-photo-id'].text === '平台识别基线',
    '文件修复不得覆盖平台识别基线或触发 OCR'
  );
  behavior(
    repairedWorkspace.workspace.photos[0].fileHealth.healthStatus === 'healthy'
      && repairedWorkspace.workspace.photos[0].sha256 === 'a'.repeat(64),
    '文件修复成功后必须原位更新路径、指纹、尺寸和健康状态'
  );
  const unrepairedWorkspace = lifecycleModule.prepareMarkiWorkspaceFileRepairs(
    repairWorkspace,
    { photos: [] }
  );
  behavior(unrepairedWorkspace.workspace === repairWorkspace, '修复失败或没有可信文件时不得修改原工作池对象');

  let workspace = {
    photos: [],
    selectedIds: [],
    activePhotoId: '',
    recognitionResultsByPhoto: {},
    watermarkRecordsByPhoto: {},
    archiveSuggestionsByPhoto: {},
    photoDraftByPhotoId: {},
    groupDraftByGroupId: {},
    smartSortResult: null,
    activeSmartSortGroupId: '',
    smartSortViewMode: 'statusFilter'
  };
  let failSnapshotSave = false;
  const snapshotOptions = {
    loadSnapshot: async () => ({
      success: true,
      found: true,
      snapshot: { workspace: structuredClone(workspace) }
    }),
    saveSnapshot: async (_path, nextWorkspace) => {
      if (failSnapshotSave) return { success: false };
      workspace = structuredClone(nextWorkspace);
      return { success: true };
    }
  };
  const batchId = 'marki-import-lifecycle-001';
  const sourceOne = 'marki_api:12345:lifecycle-001';
  const sourceTwo = 'marki_api:12345:lifecycle-002';
  const beginInput = {
    batchId,
    querySummary: {
      teamId: '10',
      start: '2026-07-20 00:00:00',
      end: '2026-07-20 23:59:59',
      watermarkFilter: 'name:时间地点',
      importStatusFilter: 'all',
      loadedCount: 4,
      selectedCount: 2,
      unwatermarkedCount: 1,
      duplicateCount: 1
    },
    items: [
      { sourceKey: sourceOne, displayId: '1', markName: '时间地点' },
      { sourceKey: sourceTwo, displayId: '2', markName: '工程记录' }
    ]
  };
  const created = await beginMarkiImportLifecycleBatch(userDataPath, beginInput, snapshotOptions);
  behavior(created.status === 'created', '新批次必须从 created 开始');
  behavior(created.totalCount === 2, '新批次总数必须准确');
  behavior(created.querySummary.templateFilter === 'name:时间地点', '旧 name:* 水印筛选必须迁移为同值 templateFilter');
  behavior(!Object.hasOwn(created.querySummary, 'watermarkFilter'), '新生命周期摘要不得再写 watermarkFilter');
  behavior(!Object.hasOwn(created.querySummary, 'unwatermarkedCount'), '新生命周期摘要不得再写 unwatermarkedCount');
  behavior(!Object.hasOwn(created, 'filteredCount'), '新生命周期结果不得再派生虚构水印过滤数量');
  behavior(created.duplicateCount === 1, '活跃重复统计必须单独保存');
  behavior(created.items.every((item) => item.status === 'queued'), '新批次单项必须进入 queued');
  const legacyOtherFilter = await beginMarkiImportLifecycleBatch(
    path.join(root, 'legacy-other-filter'),
    {
      batchId: 'legacy-watermark-filter',
      querySummary: {
        watermarkFilter: 'watermarked',
        importStatusFilter: 'all',
        loadedCount: 1,
        selectedCount: 1
      },
      items: [{ sourceKey: 'marki_api:12345:legacy-filter', displayId: '1', markName: '' }]
    },
    snapshotOptions
  );
  behavior(legacyOtherFilter.querySummary.templateFilter === 'all', '其他旧 watermarkFilter 必须迁移为全部模板');
  const downloading = await markMarkiImportLifecycleDownloading(userDataPath, batchId, snapshotOptions);
  behavior(downloading.status === 'downloading', '批次必须进入 downloading');
  behavior(downloading.items.every((item) => item.status === 'downloading'), '下载项必须进入 downloading');
  const partial = await settleMarkiImportLifecycleDownloads(userDataPath, {
    batchId,
    items: [
      { sourceKey: sourceOne, success: true },
      {
        sourceKey: sourceTwo,
        success: false,
        code: 'marki_download_failed',
        message: '照片下载失败，请重试。'
      }
    ]
  }, snapshotOptions);
  behavior(partial.status === 'partial_failed', '部分下载失败必须进入 partial_failed');
  behavior(partial.downloadedCount === 1, '部分失败必须保留成功下载数');
  behavior(partial.failedCount === 1, '部分失败必须记录失败数');
  behavior(partial.retryableCount === 1, '部分失败必须记录可重试数');
  behavior(
    partial.items.find((item) => item.displayId === '2').message === '照片下载失败，请重试。',
    '失败明细必须保存安全用户消息'
  );
  const retryBegin = await beginMarkiImportLifecycleBatch(userDataPath, beginInput, snapshotOptions);
  behavior(retryBegin.status === 'downloading', '失败批次必须允许原集合重试');
  behavior(
    retryBegin.items.find((item) => item.displayId === '1').status === 'downloaded',
    '重试不得回退已下载成功项'
  );
  behavior(
    retryBegin.items.find((item) => item.displayId === '2').status === 'queued',
    '重试只能把失败项重新排队'
  );
  await markMarkiImportLifecycleDownloading(userDataPath, batchId, snapshotOptions);
  const downloadsComplete = await settleMarkiImportLifecycleDownloads(userDataPath, {
    batchId,
    items: [
      { sourceKey: sourceOne, success: true },
      { sourceKey: sourceTwo, success: true }
    ]
  }, snapshotOptions);
  behavior(downloadsComplete.failedCount === 0, '重试成功后失败数必须归零');
  behavior(downloadsComplete.downloadedCount === 2, '重试成功后两项必须保持下载完成');
  const ready = await markMarkiImportLifecycleReady(userDataPath, {
    batchId,
    photos: [
      { sourceKey: sourceOne, photoId: 'photo-lifecycle-001' },
      { sourceKey: sourceTwo, photoId: 'photo-lifecycle-002' }
    ]
  }, snapshotOptions);
  behavior(ready.status === 'ready_to_append', '下载和结构化完成后必须进入 ready_to_append');
  behavior(ready.items.every((item) => item.status === 'append_pending'), 'ready 批次单项必须进入 append_pending');
  const pendingStatuses = await resolveMarkiImportSourceStatuses({
    documentsPath,
    userDataPath,
    orgId: '12345',
    sourceKeys: [sourceOne, sourceTwo]
  }, {
    ...snapshotOptions,
    loadManifest: async () => ({ records: {} })
  });
  behavior(pendingStatuses.bySourceKey[sourceOne] === 'append_pending', '未完成批次必须形成活跃 sourceKey 占用');
  behavior(pendingStatuses.bySourceKey[sourceTwo] === 'append_pending', '活跃占用必须覆盖同批次全部待追加项');
  await markMarkiImportLifecycleAppending(userDataPath, batchId, snapshotOptions);
  workspace.photos = [
    {
      id: 'photo-lifecycle-001',
      sourceType: 'marki_api',
      sourceKey: sourceOne,
      sortStatus: 'pending'
    },
    {
      id: 'photo-lifecycle-002',
      sourceType: 'marki_api',
      sourceKey: sourceTwo,
      sortStatus: 'pending'
    }
  ];
  workspace.selectedIds = ['photo-lifecycle-001', 'photo-lifecycle-002'];
  workspace.activePhotoId = 'photo-lifecycle-001';
  workspace.recognitionResultsByPhoto = {
    'photo-lifecycle-001': { text: 'one' },
    'photo-lifecycle-002': { text: 'two' }
  };
  workspace.watermarkRecordsByPhoto = {
    'photo-lifecycle-001': { project: '甲' },
    'photo-lifecycle-002': { project: '乙' }
  };
  workspace.archiveSuggestionsByPhoto = {
    'photo-lifecycle-001': { project: '甲' },
    'photo-lifecycle-002': { project: '乙' }
  };
  const completed = await completeMarkiImportLifecycleBatch(userDataPath, batchId, snapshotOptions);
  behavior(completed.status === 'completed', '工作池快照存在后批次必须进入 completed');
  behavior(completed.appendedCount === 2, '工作池追加成功数必须准确');
  behavior(completed.items.every((item) => item.status === 'imported_active'), '工作池保存后单项才能标记 imported_active');
  const activeStatuses = await resolveMarkiImportSourceStatuses({
    documentsPath,
    userDataPath,
    orgId: '12345',
    sourceKeys: [sourceOne]
  }, {
    ...snapshotOptions,
    loadManifest: async () => ({ records: {} })
  });
  behavior(activeStatuses.bySourceKey[sourceOne] === 'imported_active', '工作池照片必须阻止重复导入');

  failSnapshotSave = true;
  await assert.rejects(
    () => undoMarkiImportLifecycleBatch(userDataPath, batchId, snapshotOptions),
    (error) => error?.code === 'marki_import_undo_snapshot_failed',
    '撤销保存失败必须拒绝'
  );
  behavior(workspace.photos.length === 2, '撤销保存失败不得修改工作池内存基线');
  const afterFailedUndo = await listMarkiImportLifecycleRecords(userDataPath, snapshotOptions);
  behavior(afterFailedUndo.items[0].activeCount === 2, '撤销保存失败不得提前更新 ledger');
  failSnapshotSave = false;
  const undone = await undoMarkiImportLifecycleBatch(userDataPath, batchId, snapshotOptions);
  behavior(undone.removedCount === 2, '撤销必须移除当前批次未归档照片');
  behavior(workspace.photos.length === 0, '撤销必须从统一工作池移除照片');
  behavior(workspace.selectedIds.length === 0, '撤销必须清理照片选择');
  behavior(workspace.activePhotoId === '', '撤销必须修正 activePhoto');
  behavior(Object.keys(workspace.recognitionResultsByPhoto).length === 0, '撤销必须清理 recognition 映射');
  behavior(Object.keys(workspace.watermarkRecordsByPhoto).length === 0, '撤销必须清理 watermark 映射');
  behavior(Object.keys(workspace.archiveSuggestionsByPhoto).length === 0, '撤销必须清理 suggestion 映射');
  behavior(undone.record.status === 'cancelled', '整批撤销后批次必须进入 cancelled');
  behavior(undone.record.removedCount === 2, '整批撤销后必须记录 removed_reimportable');
  const removedStatuses = await resolveMarkiImportSourceStatuses({
    documentsPath,
    userDataPath,
    orgId: '12345',
    sourceKeys: [sourceOne]
  }, {
    ...snapshotOptions,
    loadManifest: async () => ({
      records: {
        [sourceOne]: { importStatus: 'imported' }
      }
    })
  });
  behavior(removedStatuses.bySourceKey[sourceOne] === 'removed_reimportable', '撤销照片必须允许重新导入');
  await assert.rejects(
    () => clearMarkiImportLifecycleRecord(userDataPath, batchId, snapshotOptions),
    (error) => error?.code === 'marki_import_record_not_clearable',
    '存在可重新导入项时不得清除记录'
  );
  behavior(true, '清除拒绝不得删除工作池或来源数据');

  const cacheRoot = getMarkiImportRoot(documentsPath);
  const cacheRelativePath = '12345/2026-07-20/lifecycle-001.jpg';
  const cachePath = path.join(cacheRoot, ...cacheRelativePath.split('/'));
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, Buffer.from('temporary cache'));
  const cacheResult = await cleanupMarkiImportLifecycleCache(
    documentsPath,
    userDataPath,
    batchId,
    {
      ...snapshotOptions,
      getSourceRecord: async (_documentsPath, _orgId, sourceKey) => ({
        sourceKey,
        downloadInfo: { relativePath: cacheRelativePath }
      })
    }
  );
  behavior(cacheResult.removedCount >= 1, '安全缓存清理必须删除未被工作池引用的重试缓存');
  behavior(!(await isFile(cachePath)), '安全缓存清理后目标缓存必须不存在');
  behavior(cacheResult.failedCount === 0, '安全缓存清理成功不得产生失败');
  const afterCleanup = await listMarkiImportLifecycleRecords(userDataPath, snapshotOptions);
  behavior(afterCleanup.items[0].removedCount === 2, '缓存清理不得改变 removed_reimportable 状态');

  const interruptedBatchId = 'marki-import-lifecycle-002';
  await beginMarkiImportLifecycleBatch(userDataPath, {
    batchId: interruptedBatchId,
    querySummary: {},
    items: [{ sourceKey: 'marki_api:12345:interrupted', displayId: '1', markName: '巡查' }]
  }, snapshotOptions);
  await markMarkiImportLifecycleDownloading(userDataPath, interruptedBatchId, snapshotOptions);
  const recovered = await recoverMarkiImportLifecycle(userDataPath, snapshotOptions);
  behavior(recovered.changedCount >= 1, '启动恢复必须处理 downloading 中断任务');
  const recoveredRecords = await listMarkiImportLifecycleRecords(userDataPath, snapshotOptions);
  const interruptedRecord = recoveredRecords.items.find((item) => item.batchId === interruptedBatchId);
  behavior(interruptedRecord.status === 'failed', '下载中断批次必须恢复为 failed');
  behavior(interruptedRecord.failedCount === 1, '下载中断单项必须恢复为 failed_retryable');
  behavior(interruptedRecord.retryableCount === 1, '下载中断项必须允许用户主动重试');

  const clearableBatchId = 'marki-import-lifecycle-003';
  workspace.photos = [{
    id: 'photo-clearable',
    sourceType: 'marki_api',
    sourceKey: 'marki_api:12345:clearable',
    sortStatus: 'pending'
  }];
  await beginMarkiImportLifecycleBatch(userDataPath, {
    batchId: clearableBatchId,
    querySummary: {},
    items: [{ sourceKey: 'marki_api:12345:clearable', displayId: '1', markName: '巡查' }]
  }, snapshotOptions);
  await markMarkiImportLifecycleDownloading(userDataPath, clearableBatchId, snapshotOptions);
  await settleMarkiImportLifecycleDownloads(userDataPath, {
    batchId: clearableBatchId,
    items: [{ sourceKey: 'marki_api:12345:clearable', success: true }]
  }, snapshotOptions);
  await markMarkiImportLifecycleReady(userDataPath, {
    batchId: clearableBatchId,
    photos: [{ sourceKey: 'marki_api:12345:clearable', photoId: 'photo-clearable' }]
  }, snapshotOptions);
  await markMarkiImportLifecycleAppending(userDataPath, clearableBatchId, snapshotOptions);
  await completeMarkiImportLifecycleBatch(userDataPath, clearableBatchId, snapshotOptions);
  const cleared = await clearMarkiImportLifecycleRecord(userDataPath, clearableBatchId, snapshotOptions);
  behavior(cleared.status === 'cleared', 'completed 批次必须允许软清除记录');
  behavior(workspace.photos.length === 1, '清除记录不得删除工作池照片');
  const visibleRecords = await listMarkiImportLifecycleRecords(userDataPath, snapshotOptions);
  behavior(!visibleRecords.items.some((item) => item.batchId === clearableBatchId), '软清除记录不得继续出现在列表');
  const activeAfterClear = await resolveMarkiImportSourceStatuses({
    documentsPath,
    userDataPath,
    orgId: '12345',
    sourceKeys: ['marki_api:12345:clearable']
  }, {
    ...snapshotOptions,
    loadManifest: async () => ({ records: {} })
  });
  behavior(activeAfterClear.bySourceKey['marki_api:12345:clearable'] === 'imported_active', '清除记录不得释放工作池活跃 sourceKey');

  const pageSource = await fs.readFile(
    path.resolve(process.cwd(), 'src/pages/MarkiPhotoImportPage.jsx'),
    'utf8'
  );
  const cssSource = await fs.readFile(
    path.resolve(process.cwd(), 'src/styles/main.css'),
    'utf8'
  );
  const mainSource = await fs.readFile(path.resolve(process.cwd(), 'electron/main.cjs'), 'utf8');
  const preloadSource = await fs.readFile(path.resolve(process.cwd(), 'electron/preload.cjs'), 'utf8');
  sourceContract(pageSource.includes('<strong>平台查询条件</strong>'), '页面必须明确平台查询条件区域');
  sourceContract(pageSource.includes('<strong>已加载结果筛选</strong>'), '页面必须明确已加载结果筛选区域');
  sourceContract(pageSource.includes('<span>水印模板</span>'), '已加载结果筛选必须包含动态水印模板');
  sourceContract(pageSource.includes('<span>导入状态</span>'), '已加载结果筛选必须包含导入状态');
  sourceContract(!pageSource.includes('全部有水印'), '页面不得保留虚构的全部有水印选项');
  sourceContract(!pageSource.includes('水印状态待确认'), '页面不得保留虚构的水印状态待确认文案');
  sourceContract(!pageSource.includes('只有已确认有水印的照片可以导入'), '页面不得以虚构水印状态阻断导入');
  sourceContract(pageSource.includes('全选当前筛选结果'), '查询工具栏必须使用当前筛选全选语义');
  sourceContract(pageSource.includes('rawQueryResults'), '页面必须保留原始查询结果');
  sourceContract(pageSource.includes('filteredQueryResults'), '页面必须派生当前筛选结果');
  sourceContract(!pageSource.includes('BUSY_SOURCE_STATUSES'), '页面不得继续引用旧模糊状态集合');
  sourceContract(cssSource.includes('grid-template-columns: repeat(4, minmax(150px, 1fr))'), '顶部查询卡片必须使用响应式四列布局');
  sourceContract(cssSource.includes('@media (max-width: 900px)'), '小窗口必须有单列响应式规则');
  sourceContract(mainSource.includes("marki:list-import-records"), '主进程必须提供导入记录 IPC');
  sourceContract(mainSource.includes("marki:undo-import-batch"), '主进程必须提供受控撤销 IPC');
  sourceContract(mainSource.includes("marki:cleanup-import-cache"), '主进程必须提供安全缓存清理 IPC');
  sourceContract(mainSource.includes('markMarkiImportLifecycleAppending'), '批次消费前必须标记 appending');
  sourceContract(preloadSource.includes('listImportRecords:'), 'preload 必须暴露导入记录查询');
  sourceContract(preloadSource.includes('recoverImportLifecycle:'), 'preload 必须暴露受控生命周期恢复');
  sourceContract(preloadSource.includes('undoImportBatch:'), 'preload 必须暴露受控撤销');
  sourceContract(preloadSource.includes('clearImportRecord:'), 'preload 必须暴露软清除记录');
  sourceContract(preloadSource.includes('cleanupImportCache:'), 'preload 必须暴露安全缓存清理');

  assert.equal(behaviorAssertionCount >= 70, true, '马克导入生命周期闭环至少应执行七十个行为断言');
  console.log(
    `马克查询筛选与导入生命周期自检通过：${behaviorAssertionCount} 个行为场景，`
    + `${behaviorAssertionCount} 个行为断言，${sourceContractCount} 个源码契约断言；`
    + '覆盖模板筛选、生命周期资格、崩溃恢复、撤销、重导和缓存清理。'
  );
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`核心流程自检失败：${error?.message || '未知错误'}`);
  process.exit(1);
});
