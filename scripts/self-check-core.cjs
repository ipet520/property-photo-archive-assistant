const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildArchivePreview, archivePhotos } = require('../electron/services/archiveService.cjs');
const { buildPackagePlan, generateArchivePackage } = require('../electron/services/archivePackageService.cjs');
const { matchArchivedPhotos } = require('../electron/services/archiveFingerprintService.cjs');
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
const { saveRectificationItem } = require('../electron/services/rectificationService.cjs');
const { saveSettings } = require('../electron/services/settingsService.cjs');
const { generateSmartSortGroups } = require('../electron/services/smartSortService.cjs');
const { loadSummaryData } = require('../electron/services/summaryService.cjs');

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-archive-self-check-'));
  try {
    await checkRecognitionEngine(temporaryRoot);
    await checkMarkiFoundation(path.join(temporaryRoot, 'marki'));
    await checkMarkiSourceManifest(path.join(temporaryRoot, 'marki-source'));
    await checkMarkiPhotoDownload(path.join(temporaryRoot, 'marki-download'));
    await checkCurrentFormContract();
    await checkMaintenanceRecommendations(path.join(temporaryRoot, 'maintenance'));
    await checkSmartSortOutcomes(path.join(temporaryRoot, 'smart-sort'));
    await checkArchiveFlow(path.join(temporaryRoot, 'archive-flow'));
    await checkSourceContracts();
    console.log('核心流程自检通过：OCR、马克来源清单与下载、智拣、表单、预览、归档、台账、指纹和 IPC 契约均正常。');
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

async function checkRecognitionEngine(userDataDir) {
  const status = await getRecognitionStatus(userDataDir);
  const localProvider = (status.providers || []).find((provider) => provider.id === 'local_ocr' || provider.providerId === 'local_ocr');
  assert.equal(localProvider?.available, true, `本地 OCR 引擎不可用：${localProvider?.reason || status.reason || '未知原因'}`);
  assert.equal(localProvider?.engine, 'rapidocr', '本地 OCR 引擎应为 RapidOCR');
  assert.match(String(localProvider?.componentVersion || ''), /2026\.7\.2.*v3\.9\.1/i, 'OCR 组件版本号未统一');
}

async function checkCurrentFormContract() {
  const {
    buildArchiveSuggestion,
    parseWatermarkRecord,
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
    currentProject: '潇湘新区二期',
    defaultProject: '潇湘新区二期'
  });
  assert.equal(watermark.locationText, '', '只有项目名称时，位置/区域必须保持为空');
  assert.equal(suggestion.suggestedFields.location, '', '项目名称不得重复写入位置/区域');
  assert.deepEqual(validateSortForm({
    date: '2026-06-12',
    watermarkCategory: '机动车违规管理',
    workContent: '随意停放阻碍通行',
    location: '',
    keywords: '',
    remark: ''
  }), [], '当前表单只应要求日期、归档分类和工作内容');
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
