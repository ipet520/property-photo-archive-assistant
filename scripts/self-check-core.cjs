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
  recoverLedgerSwapArtifacts
} = require('../electron/services/excelService.cjs');
const { loadDashboardData } = require('../electron/services/dashboardService.cjs');
const { getDataMaintenanceReport } = require('../electron/services/dataMaintenanceService.cjs');
const { loadLedgerRecords } = require('../electron/services/ledgerQueryService.cjs');
const { getRecognitionStatus } = require('../electron/services/recognitionService.cjs');
const {
  buildMarkiPostSignature,
  listMarkiMembers,
  listMarkiTeams
} = require('../electron/services/markiApiService.cjs');
const {
  getMarkiCredentialStatus,
  loadMarkiCredentials,
  saveMarkiCredentials
} = require('../electron/services/markiCredentialService.cjs');
const {
  downloadMarkiPhoto,
  retryMarkiPhotoDownload
} = require('../electron/services/markiPhotoDownloadService.cjs');
const {
  buildMarkiSourceKey,
  checkMarkiSourceKeys,
  getMarkiSourceManifestPath,
  getMarkiSourceRecordByKey,
  hasMarkiSourceKey,
  loadMarkiSourceManifest,
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
const { saveRectificationItem } = require('../electron/services/rectificationService.cjs');
const { saveSettings } = require('../electron/services/settingsService.cjs');
const { generateSmartSortGroups } = require('../electron/services/smartSortService.cjs');
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
    await checkMarkiFoundation(path.join(temporaryRoot, 'marki'));
    await checkMarkiSourceManifest(path.join(temporaryRoot, 'marki-source'));
    await checkMarkiPhotoDownload(path.join(temporaryRoot, 'marki-download'));
    await checkMarkiSourceMetadata(path.join(temporaryRoot, 'marki-source-metadata'));
    await checkMarkiStructuredImport(path.join(temporaryRoot, 'marki-structured'));
    await checkMarkiImportOrchestrator(path.join(temporaryRoot, 'marki-orchestrator'));
    await checkCurrentFormContract();
    await checkMaintenanceRecommendations(path.join(temporaryRoot, 'maintenance'));
    await checkSmartSortOutcomes(path.join(temporaryRoot, 'smart-sort'));
    await checkArchiveFlow(path.join(temporaryRoot, 'archive-flow'));
    await checkArchiveTransactionRecovery(path.join(temporaryRoot, 'archive-transaction'));
    await checkSourceContracts();
    console.log('核心流程自检通过：RapidOCR 运行时、OCR、马克来源清单、来源元数据、下载、结构化导入与主进程编排、智拣、表单、预览、归档、台账、指纹和 IPC 契约均正常。');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  await assert.rejects(
    () => fs.access(temporaryRoot),
    (error) => error?.code === 'ENOENT',
    '核心自检结束后应清理系统临时目录'
  );
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
  assert.equal(successfulFetchCount, 1, '同一 sourceKey 不得重复下载');

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
      '工程类专用': { items: ['水电设施设备维修'] },
      '机动车违规管理': { items: ['占用消防通道'] },
      '时间地点水印': { items: ['标题/内容自定义'] }
    }
  });
  const baseMoment = deepFreeze({
    id: 'moment-structured-001',
    uid: 20001,
    teamId: 10001,
    momentType: 1,
    markName: '工程类专用',
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
  assert.equal(mapped.suggestedFields.watermarkCategory, '工程类专用', '水印名称应匹配现有分类');
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
  assert.equal(
    fallbackCategory.suggestedFields.watermarkCategory,
    '时间地点水印',
    '时间地点兜底水印应通过明确映射匹配现有分类'
  );

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
    '占用消防通道｜云D12345',
    '机动车水印应组合违停类型和车牌号'
  );

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

async function checkCurrentFormContract() {
  const {
    buildArchiveSuggestion,
    buildCurrentPhotoArchiveServiceForm,
    confirmArchiveSuggestion,
    parseWatermarkRecord,
    validateRequiredArchiveFields,
    validateSortForm
  } = await import('../src/utils/sortRightPanelState.js');
  const configs = {
    projects: ['潇湘新区二期'],
    watermarkCategories: {
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
    project: '潇湘新区二期',
    date: '2026-06-12',
    watermarkCategory: '机动车违规管理',
    workContent: '随意停放阻碍通行',
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
}

async function checkSmartSortOutcomes(userDataDir) {
  const photos = [
    {
      id: 'no-watermark',
      path: path.join(userDataDir, 'no-watermark.jpg'),
      recognition: { status: 'success', rawText: '消防车辆正在场地开展演练' },
      archiveSuggestion: { suggestedFields: {}, missingRequiredFields: ['归档分类', '工作内容'] }
    },
    {
      id: 'recognition-failed',
      path: path.join(userDataDir, 'recognition-failed.jpg'),
      recognition: { status: 'failed', rawText: '' },
      archiveSuggestion: { suggestedFields: {}, missingRequiredFields: ['归档分类', '工作内容'] }
    },
    {
      id: 'archive-failed',
      path: path.join(userDataDir, 'archive-failed.jpg'),
      sortStatus: 'failed',
      archiveResult: { status: '归档失败', error: '测试失败' }
    }
  ];
  const result = await generateSmartSortGroups(userDataDir, { photos });
  const titles = new Set((result.groups || []).map((group) => group.title));
  assert.equal(titles.has('未检测到水印'), true, '无有效水印文字应进入“未检测到水印”');
  assert.equal(titles.has('无法判断工作内容'), false, '无水印场景文字不应进入“无法判断工作内容”');
  assert.equal(titles.has('识别失败'), true, 'OCR 执行失败应进入“识别失败”');
  assert.equal(titles.has('归档失败'), true, '归档失败状态应进入“归档失败”');
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
    remark: '核心流程自检'
  };
  const photo = {
    id: 'archive-photo',
    path: sourcePath,
    name: 'original.jpg',
    extension: '.jpg'
  };

  const initialPreview = await buildArchivePreview({ form, photos: [photo], archiveRoot });
  await fs.mkdir(initialPreview[0].targetDirectory, { recursive: true });
  await fs.writeFile(initialPreview[0].targetPath, Buffer.from('existing-target'));
  const preview = await buildArchivePreview({ form, photos: [photo], archiveRoot });
  assert.match(preview[0].newFileName, /_01\.jpg$/i, '预览应提前显示重名后的最终文件名');
  assert.equal(preview[0].location, '现场', '空位置应在归档服务中统一归一为“现场”');

  const archiveResult = await archivePhotos({ archiveRoot, items: preview });
  assert.equal(archiveResult.success, true, '归档复制应成功');
  assert.equal(archiveResult.items[0].targetPath, preview[0].targetPath, '无并发冲突时，预览文件名与最终文件名必须一致');
  assert.deepEqual(await fs.readFile(sourcePath), originalContent, '归档不得移动、删除或修改原始照片');

  const ledger = await loadLedgerRecords(archiveRoot);
  assert.equal(ledger.records.length, 1, '归档成功应追加一条台账记录');
  assert.equal(ledger.records[0].watermarkCategory, form.watermarkCategory, '台账归档分类字段应正确');
  assert.equal(ledger.records[0].workContent, form.workContent, '台账工作内容字段应正确');
  assert.equal(ledger.records[0].location, '现场', '台账位置字段应正确');
  assert.equal(ledger.records[0].fileExists, true, '台账归档文件应能被后续页面找到');

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
  const failedPreview = await buildArchivePreview({
    form,
    photos: [{ ...photo, id: 'missing-source', path: path.join(sourceDirectory, 'missing.jpg') }],
    archiveRoot: failedArchiveRoot
  });
  const failedResult = await archivePhotos({ archiveRoot: failedArchiveRoot, items: failedPreview });
  assert.equal(failedResult.failedCount, 1, '原图缺失时应明确归档失败');
  const failedLedger = await loadLedgerRecords(failedArchiveRoot);
  assert.equal(failedLedger.records.length, 0, '归档失败不得写入台账');

  await checkDownstreamPages({ root, archiveRoot, ledgerRecord: ledger.records[0] });
}

async function checkArchiveTransactionRecovery(root) {
  assert.equal(
    path.relative(os.tmpdir(), root).startsWith('..'),
    false,
    '归档事务自检必须使用系统临时目录'
  );

  const single = await createArchiveTransactionTestPlan(path.join(root, 'single'), { count: 1, tag: 'single' });
  const singleResult = await archivePhotos({ archiveRoot: single.archiveRoot, items: single.preview });
  assert.equal(singleResult.status, 'committed', '单张照片应完整提交');
  assert.equal(singleResult.committedCount, 1, '单张照片应提交一条台账');
  const singleTransaction = JSON.parse(await fs.readFile(
    path.join(getArchiveTransactionDirectory(single.archiveRoot), `${singleResult.transactionId}.json`),
    'utf8'
  ));
  assert.equal(path.isAbsolute(singleTransaction.items[0].targetRelativePath), false, '事务日志不得保存绝对目标路径');
  assert.equal(Object.prototype.hasOwnProperty.call(singleTransaction.items[0], 'targetPath'), false, '事务日志不得持久化 targetPath');

  const multiple = await createArchiveTransactionTestPlan(path.join(root, 'multiple'), { count: 3, tag: 'multiple' });
  const multipleResult = await archivePhotos({ archiveRoot: multiple.archiveRoot, items: multiple.preview });
  assert.equal(multipleResult.committedCount, 3, '多张照片应全部提交');
  assert.equal((await loadLedgerRecords(multiple.archiveRoot)).records.length, 3, '多张归档应写入三条台账');

  const firstFailure = await createArchiveTransactionTestPlan(path.join(root, 'first-failure'), { count: 2, tag: 'first-failure' });
  const firstFailureResult = await archivePhotos(
    { archiveRoot: firstFailure.archiveRoot, items: firstFailure.preview },
    { copyFile: createSelectiveCopyFailure('source-1.jpg') }
  );
  assert.equal(firstFailureResult.status, 'partial', '首张复制失败时其余照片应正常提交');
  assert.equal(firstFailureResult.items[0].stage, 'copy_failed', '首张复制失败应返回逐项失败');
  assert.equal(firstFailureResult.committedCount, 1, '首张失败时第二张应正常提交');

  const middleFailure = await createArchiveTransactionTestPlan(path.join(root, 'middle-failure'), { count: 3, tag: 'middle-failure' });
  const middleFailureResult = await archivePhotos(
    { archiveRoot: middleFailure.archiveRoot, items: middleFailure.preview },
    { copyFile: createSelectiveCopyFailure('source-2.jpg') }
  );
  assert.equal(middleFailureResult.items[1].stage, 'copy_failed', '中间照片复制失败应准确定位');
  assert.equal(middleFailureResult.committedCount, 2, '中间照片失败不应阻止其他成功项写入台账');
  assert.equal((await loadLedgerRecords(middleFailure.archiveRoot)).records.length, 2, '中间失败时台账只写成功项');

  const ledgerRetry = await createArchiveTransactionTestPlan(path.join(root, 'ledger-retry'), { count: 1, tag: 'ledger-retry' });
  const ledgerPendingResult = await archivePhotos(
    { archiveRoot: ledgerRetry.archiveRoot, items: ledgerRetry.preview },
    { excelOptions: { hooks: { writeWorkbook: async () => { throw createInjectedError('EPERM'); } } } }
  );
  assert.equal(ledgerPendingResult.status, 'ledger_pending', 'Excel 首次失败时应保留 ledger_pending');
  assert.equal(ledgerPendingResult.pendingLedgerCount, 1, 'Excel 失败应逐项返回待补记');
  assert.equal((await listArchiveTestImages(ledgerRetry.archiveRoot)).length, 1, 'Excel 失败后归档照片必须保留');
  const frozenName = path.basename(ledgerPendingResult.items[0].targetPath);
  const ledgerRetryResult = await archivePhotos({
    archiveRoot: ledgerRetry.archiveRoot,
    transactionId: ledgerPendingResult.transactionId,
    items: ledgerRetry.preview
  });
  assert.equal(ledgerRetryResult.status, 'committed', 'Excel 恢复后应补记同一事务');
  assert.equal(path.basename(ledgerRetryResult.items[0].targetPath), frozenName, '重试必须复用冻结目标路径');
  assert.equal((await listArchiveTestImages(ledgerRetry.archiveRoot)).some((name) => /_01\./i.test(name)), false, '重试不得生成 _01');

  const restart = await createArchiveTransactionTestPlan(path.join(root, 'restart'), { count: 1, tag: 'restart' });
  const restartPending = await archivePhotos(
    { archiveRoot: restart.archiveRoot, items: restart.preview },
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
  const conflictResult = await archivePhotos(
    { archiveRoot: conflict.archiveRoot, items: conflict.preview },
    {
      copyFile: async (_sourcePath, targetPath) => {
        await fs.writeFile(targetPath, unknownContent);
        throw createInjectedError('EEXIST');
      }
    }
  );
  assert.equal(conflictResult.conflictCount, 1, '冻结目标存在不同内容时应返回 target_conflict');
  assert.equal(conflictResult.items[0].stage, 'target_conflict', '冲突项状态必须明确');
  assert.deepEqual(await fs.readFile(conflictResult.items[0].targetPath), unknownContent, '未知目标文件不得覆盖或删除');
  assert.equal(firstFailureResult.failedCount, 1, 'partial 返回的失败数量应准确');
  assert.equal(firstFailureResult.committedCount, 1, 'partial 返回的成功数量应准确');

  const occupied = await createArchiveTransactionTestPlan(path.join(root, 'occupied'), { count: 1, tag: 'occupied-base' });
  await archivePhotos({ archiveRoot: occupied.archiveRoot, items: occupied.preview });
  const ledgerBeforeOccupied = await fs.readFile(getLedgerPath(occupied.archiveRoot));
  const occupiedNext = await createArchiveTransactionTestPlan(path.join(root, 'occupied-next'), {
    archiveRoot: occupied.archiveRoot,
    count: 1,
    tag: 'occupied-next',
    formPatch: { workContent: '第二项工作' }
  });
  const occupiedResult = await archivePhotos(
    { archiveRoot: occupied.archiveRoot, items: occupiedNext.preview },
    { excelOptions: { hooks: { afterBackup: async () => { throw createInjectedError('EPERM'); } } } }
  );
  assert.equal(occupiedResult.pendingLedgerCount, 1, 'Excel 被占用时应保留 ledger_pending');
  assert.deepEqual(await fs.readFile(getLedgerPath(occupied.archiveRoot)), ledgerBeforeOccupied, 'Excel 写入失败时旧台账必须保持完整');

  const corruptLedger = await createArchiveTransactionTestPlan(path.join(root, 'corrupt-ledger'), { count: 1, tag: 'corrupt-ledger' });
  await fs.mkdir(corruptLedger.archiveRoot, { recursive: true });
  const corruptLedgerBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
  await fs.writeFile(getLedgerPath(corruptLedger.archiveRoot), corruptLedgerBytes);
  const corruptLedgerResult = await archivePhotos({ archiveRoot: corruptLedger.archiveRoot, items: corruptLedger.preview });
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
    archivePhotos({ archiveRoot: concurrent.archiveRoot, items: concurrent.preview }),
    archivePhotos({ archiveRoot: concurrent.archiveRoot, items: concurrent.preview })
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

  for (const testPlan of [single, multiple, firstFailure, middleFailure, ledgerRetry, restart, conflict, occupied, occupiedNext, corruptLedger, concurrent]) {
    for (const source of testPlan.sources) {
      assert.deepEqual(await fs.readFile(source.path), source.content, '归档事务不得移动、删除或修改原图');
    }
  }

  const ledgerAlreadyWritten = await createArchiveTransactionTestPlan(path.join(root, 'ledger-already-written'), {
    count: 1,
    tag: 'ledger-already-written'
  });
  const ledgerAlreadyPending = await archivePhotos(
    { archiveRoot: ledgerAlreadyWritten.archiveRoot, items: ledgerAlreadyWritten.preview },
    { hooks: { afterLedgerAppend: async () => { throw createInjectedError('SIMULATED_EXIT'); } } }
  );
  assert.equal(ledgerAlreadyPending.pendingLedgerCount, 1, 'Excel 已写而事务未更新时应保持 ledger_pending');
  assert.equal((await loadLedgerRecords(ledgerAlreadyWritten.archiveRoot)).records.length, 1, '模拟退出前 Excel 行应已经写入');
  const ledgerAlreadyRecovered = await archivePhotos({
    archiveRoot: ledgerAlreadyWritten.archiveRoot,
    transactionId: ledgerAlreadyPending.transactionId,
    items: ledgerAlreadyWritten.preview
  });
  assert.equal(ledgerAlreadyRecovered.status, 'committed', '恢复时应通过归档路径发现已存在台账行');
  assert.equal((await loadLedgerRecords(ledgerAlreadyWritten.archiveRoot)).records.length, 1, '补记恢复不得重复追加 Excel 行');

  const committedRepeat = await archivePhotos({
    archiveRoot: ledgerAlreadyWritten.archiveRoot,
    transactionId: ledgerAlreadyRecovered.transactionId,
    items: ledgerAlreadyWritten.preview
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
  await archivePhotos({ archiveRoot: swapRecovery.archiveRoot, items: swapRecovery.preview });
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
  const preview = await buildArchivePreview({ form, photos, archiveRoot });
  return { root, archiveRoot, form, photos, preview, sources };
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
  const [mainSource, preloadSource, workspaceSource, settingsSource, serviceBriefSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SortWorkspacePage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/SettingsPage.jsx'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src/pages/ServiceBriefPage.jsx'), 'utf8')
  ]);
  const invokedChannels = new Set([...preloadSource.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const handledChannels = new Set([...mainSource.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const missingHandlers = [...invokedChannels].filter((channel) => !handledChannels.has(channel));
  assert.deepEqual(missingHandlers, [], `preload 中存在无主进程处理器的 IPC：${missingHandlers.join(', ')}`);
  assert.equal(invokedChannels.has('archive:recoverPendingTransactions'), true, 'preload 应暴露最小归档事务恢复接口');
  assert.equal(workspaceSource.includes('recoverPendingArchiveTransactions'), true, '工作台应在归档根目录可用时恢复待补记事务');
  assert.equal(workspaceSource.includes("return selectedSessionFolder || defaultPhotoFolder;"), true, '手工选择的照片目录应优先于默认目录');
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

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`核心流程自检失败：${error.message}`);
  process.exit(1);
});
