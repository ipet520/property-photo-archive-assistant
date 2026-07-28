const crypto = require('node:crypto');
const path = require('node:path');
const { MarkiApiError } = require('./markiApiService.cjs');
const {
  beginMarkiPhotoSelectionImport,
  settleMarkiPhotoSelectionImport
} = require('./markiPhotoQuerySessionService.cjs');
const {
  resolveMarkiImportSourceStatuses,
  beginMarkiImportLifecycleBatch,
  markMarkiImportLifecycleDownloading,
  markMarkiImportLifecycleFailed,
  markMarkiImportLifecycleReady,
  settleMarkiImportLifecycleDownloads
} = require('./markiImportLifecycleService.cjs');
const {
  downloadMarkiPhoto
} = require('./markiPhotoDownloadService.cjs');
const {
  prepareMarkiStructuredImport
} = require('./markiImportOrchestratorService.cjs');
const { parseMarkiContent } = require('./markiStructuredImportService.cjs');
const {
  beginMarkiImportBatch,
  getMarkiImportBatch,
  markMarkiImportBatchFailed,
  markMarkiImportBatchReady
} = require('./markiImportBatchService.cjs');

const MAX_CONCURRENT_DOWNLOADS = 3;
const REQUEST_KEYS = new Set([
  'sessionId',
  'selectionTokens',
  'templateFilter',
  'importStatusFilter',
  'activeProjectId',
  'activeProjectName'
]);
const LEGACY_REQUEST_KEYS = new Set([
  'sessionId',
  'selectionTokens',
  'watermarkFilter',
  'importStatusFilter',
  'activeProjectId',
  'activeProjectName'
]);
const INPUT_KEYS = new Set([
  'credentials',
  'documentsPath',
  'userDataPath',
  'projectOptions',
  'request'
]);
const sourceReservations = new Map();

class MarkiTrustedImportError extends MarkiApiError {
  constructor(code, message) {
    super(code, message);
    this.name = 'MarkiTrustedImportError';
  }
}

async function importMarkiPhotoQuerySelection(input = {}, options = {}) {
  const normalized = normalizeInput(input);
  const dependencies = resolveDependencies(options);
  const task = await dependencies.beginSelectionImport(
    normalized.request.sessionId,
    normalized.request.selectionTokens,
    options.sessionOptions || {}
  );
  let effectiveItems = [];
  let reservedSourceKeys = [];
  let batchId = task.batchId || '';

  try {
    if (task.orgId !== normalized.credentials.orgId) {
      throw new MarkiTrustedImportError(
        'marki_photo_query_organization_changed',
        '马克组织配置已变化，请重新查询照片。'
      );
    }
    effectiveItems = await resolveEffectiveItems(task, normalized, dependencies);
    if (effectiveItems.length === 0) {
      await settleTask(dependencies, task, 'completed', '', []);
      return buildSafeResult('nothing_to_import', {
        selectedCount: task.selectionTokens.length,
        skippedImportedCount: task.selectionTokens.length
      });
    }

    reservedSourceKeys = effectiveItems.map((item) => item.sourceKey);
    reserveSourceKeys(task.taskId, reservedSourceKeys);

    batchId = batchId || `marki-import-${dependencies.randomUUID()}`;
    await dependencies.beginLifecycleBatch(
      normalized.userDataPath,
      {
        batchId,
        querySummary: {
          ...task.querySummary,
          templateFilter: normalized.request.templateFilter,
          importStatusFilter: normalized.request.importStatusFilter,
          duplicateCount: task.selectionTokens.length - effectiveItems.length
        },
        projectId: normalized.activeProject.projectId,
        projectName: normalized.activeProject.projectName,
        items: effectiveItems.map((item) => ({
          sourceKey: item.sourceKey,
          displayId: resolveSafeDisplayId(item, task.items),
          markName: item.templateName || item.moment?.markName || '',
          assignedProjectId: normalized.activeProject.projectId,
          assignedProjectName: normalized.activeProject.projectName,
          projectAssignmentSource: item.projectAssignmentSource
        }))
      },
      options.lifecycleOptions || {}
    );
    await dependencies.markLifecycleDownloading(
      normalized.userDataPath,
      batchId,
      options.lifecycleOptions || {}
    );

    const downloadAttempts = await mapWithConcurrency(
      effectiveItems,
      MAX_CONCURRENT_DOWNLOADS,
      async (item) => {
        try {
          const download = await dependencies.downloadMarkiPhoto(
            normalized.documentsPath,
            {
              ...item.moment,
              orgId: task.orgId,
              momentId: item.moment.id
            },
            {
              ...(options.downloadOptions || {}),
              allowImportedRedownload: [
                'removed_reimportable',
                'failed_retryable',
                'workspace_file_repairable'
              ]
                .includes(item.selectedSourceStatus)
            }
          );
          await dependencies.settleLifecycleDownloads(
            normalized.userDataPath,
            {
              batchId,
              items: [{
                sourceKey: item.sourceKey,
                success: true,
                code: '',
                message: ''
              }]
            },
            options.lifecycleOptions || {}
          );
          return { success: true, item, download };
        } catch (error) {
          const safeFailure = toSafeFailure(
            error,
            'marki_photo_download_failed',
            '马克照片下载失败，请重试。'
          );
          await dependencies.settleLifecycleDownloads(
            normalized.userDataPath,
            {
              batchId,
              items: [{
                sourceKey: item.sourceKey,
                success: false,
                code: safeFailure.code,
                message: safeFailure.message
              }]
            },
            options.lifecycleOptions || {}
          );
          return {
            success: false,
            item,
            error: safeFailure
          };
        }
      }
    );
    const downloadFailures = downloadAttempts.filter((item) => !item.success);
    if (downloadFailures.length > 0) {
      await settleTask(
        dependencies,
        task,
        'failed',
        batchId,
        effectiveItems.map((item) => item.selectionToken)
      );
      return buildSafeResult('download_failed', {
        batchId,
        selectedCount: task.selectionTokens.length,
        skippedImportedCount: task.selectionTokens.length - effectiveItems.length,
        downloadedCount: downloadAttempts.filter(
          (item) => item.success && !item.download.reusedExisting
        ).length,
        reusedCount: downloadAttempts.filter(
          (item) => item.success && item.download.reusedExisting
        ).length,
        failedCount: downloadFailures.length,
        failures: downloadFailures.map(({ item, error }) => ({
          selectionToken: item.selectionToken,
          displayId: resolveSafeDisplayId(item, task.items),
          code: error.code,
          message: error.message
        }))
      });
    }

    const importItems = downloadAttempts.map(({ item, download }) => ({
      moment: item.moment,
      download,
      projectAssignmentSource: item.projectAssignmentSource
    }));
    const deduplication = buildDeduplication(importItems.length);

    let existingBatch = await getExistingBatch(
      dependencies,
      normalized.userDataPath,
      batchId,
      options.batchOptions || {}
    );
    if (existingBatch?.status === 'ready') {
      await dependencies.markLifecycleReady(
        normalized.userDataPath,
        {
          batchId,
          photos: existingBatch.workbenchImportPackage.photos.map((photo) => ({
            sourceKey: photo.sourceKey,
            photoId: photo.id
          }))
        },
        options.lifecycleOptions || {}
      );
      await settleTask(
        dependencies,
        task,
        'completed',
        batchId,
        effectiveItems.map((item) => item.selectionToken)
      );
      return buildReadyResult(task, effectiveItems, downloadAttempts, existingBatch);
    }
    if (existingBatch?.status === 'consumed') {
      await settleTask(
        dependencies,
        task,
        'completed',
        batchId,
        effectiveItems.map((item) => item.selectionToken)
      );
      return buildSafeResult('nothing_to_import', {
        batchId,
        selectedCount: task.selectionTokens.length,
        skippedImportedCount: task.selectionTokens.length
      });
    }

    try {
      if (!existingBatch || existingBatch.status === 'failed') {
        await dependencies.beginImportBatch(
          normalized.userDataPath,
          {
            batchId,
            inputCount: importItems.length,
            deduplication,
            projectId: normalized.activeProject.projectId,
            projectName: normalized.activeProject.projectName
          },
          options.batchOptions || {}
        );
      } else if (existingBatch.status !== 'preparing') {
        throw new MarkiTrustedImportError(
          'marki_import_batch_state_invalid',
          '马克导入批次状态无法继续，请重新发起导入。'
        );
      }
    } catch {
      await recordLifecycleFailure(
        dependencies,
        normalized.userDataPath,
        batchId,
        effectiveItems,
        'marki_import_batch_save_failed',
        '马克导入批次保存失败，请重试。',
        options
      );
      await settleTask(
        dependencies,
        task,
        'failed',
        batchId,
        effectiveItems.map((item) => item.selectionToken)
      );
      return buildSafeResult('batch_persist_failed', {
        batchId,
        selectedCount: task.selectionTokens.length,
        skippedImportedCount: task.selectionTokens.length - effectiveItems.length,
        downloadedCount: countDownloaded(downloadAttempts),
        reusedCount: countReused(downloadAttempts),
        failedCount: 1,
        failures: [buildGeneralFailure(
          'marki_import_batch_save_failed',
          '马克导入批次保存失败，请重试。',
          effectiveItems[0],
          task.items
        )]
      });
    }

    let prepared;
    try {
      prepared = await dependencies.prepareStructuredImport(
        {
          documentsPath: normalized.documentsPath,
          orgId: task.orgId,
          items: importItems
        },
        {
          ...(options.orchestratorOptions || {}),
          batchId,
          activeProject: normalized.activeProject
        }
      );
    } catch (error) {
      const safeFailure = toSafeFailure(
        error,
        'marki_import_metadata_failed',
        '马克照片结构化数据处理失败，请重试。'
      );
      prepared = buildFailedPreparation(batchId, importItems, deduplication, safeFailure);
    }

    if (!prepared.success) {
      try {
        await dependencies.markBatchFailed(
          normalized.userDataPath,
          prepared,
          options.batchOptions || {}
        );
      } catch {
        await settleTask(
          dependencies,
          task,
          'failed',
          batchId,
          effectiveItems.map((item) => item.selectionToken)
        );
        return buildSafeResult('batch_persist_failed', {
          batchId,
          selectedCount: task.selectionTokens.length,
          skippedImportedCount: task.selectionTokens.length - effectiveItems.length,
          downloadedCount: countDownloaded(downloadAttempts),
          reusedCount: countReused(downloadAttempts),
          metadataSavedCount: prepared.metadataSavedCount,
          failedCount: 1,
          failures: [buildGeneralFailure(
            'marki_import_batch_save_failed',
            '马克导入批次保存失败，请重试。',
            effectiveItems[0],
            task.items
          )]
        });
      }
      await dependencies.markLifecycleFailed(
        normalized.userDataPath,
        {
          batchId,
          failures: prepared.failures.map((failure) => ({
            sourceKey: failure.sourceKey,
            code: normalizeSafeCode(failure.code, 'marki_import_metadata_failed'),
            message: '马克来源元数据保存失败，请重试。'
          }))
        },
        options.lifecycleOptions || {}
      );
      await settleTask(
        dependencies,
        task,
        'failed',
        batchId,
        effectiveItems.map((item) => item.selectionToken)
      );
      return buildSafeResult('metadata_failed', {
        batchId,
        selectedCount: task.selectionTokens.length,
        skippedImportedCount: task.selectionTokens.length - effectiveItems.length,
        downloadedCount: countDownloaded(downloadAttempts),
        reusedCount: countReused(downloadAttempts),
        metadataSavedCount: prepared.metadataSavedCount,
        failedCount: prepared.failedCount,
        failures: mapMetadataFailures(prepared.failures, effectiveItems)
      });
    }

    let readyBatch;
    try {
      readyBatch = await dependencies.markBatchReady(
        normalized.userDataPath,
        prepared,
        options.batchOptions || {}
      );
    } catch {
      await recordLifecycleFailure(
        dependencies,
        normalized.userDataPath,
        batchId,
        effectiveItems,
        'marki_import_batch_save_failed',
        '马克导入批次保存失败，请重试。',
        options
      );
      await settleTask(
        dependencies,
        task,
        'failed',
        batchId,
        effectiveItems.map((item) => item.selectionToken)
      );
      return buildSafeResult('batch_persist_failed', {
        batchId,
        selectedCount: task.selectionTokens.length,
        skippedImportedCount: task.selectionTokens.length - effectiveItems.length,
        downloadedCount: countDownloaded(downloadAttempts),
        reusedCount: countReused(downloadAttempts),
        metadataSavedCount: prepared.metadataSavedCount,
        failedCount: 1,
        failures: [buildGeneralFailure(
          'marki_import_batch_save_failed',
          '马克导入批次保存失败，请重试。',
          effectiveItems[0],
          task.items
        )]
      });
    }

    await dependencies.markLifecycleReady(
      normalized.userDataPath,
      {
        batchId,
        photos: readyBatch.workbenchImportPackage.photos.map((photo) => ({
          sourceKey: photo.sourceKey,
          photoId: photo.id
        }))
      },
      options.lifecycleOptions || {}
    );
    await settleTask(
      dependencies,
      task,
      'completed',
      batchId,
      effectiveItems.map((item) => item.selectionToken)
    );
    return buildReadyResult(task, effectiveItems, downloadAttempts, readyBatch);
  } catch (error) {
    await settleTask(
      dependencies,
      task,
      'failed',
      batchId,
      effectiveItems.map((item) => item.selectionToken)
    ).catch(() => {});
    if (error instanceof MarkiTrustedImportError) throw error;
    throw new MarkiTrustedImportError(
      'marki_photo_import_failed',
      '马克照片导入失败，请重试。'
    );
  } finally {
    releaseSourceKeys(task.taskId, reservedSourceKeys);
  }
}

async function resolveEffectiveItems(task, input, dependencies) {
  if (task.retry) {
    const retryTokens = new Set(task.effectiveSelectionTokens);
    return task.items
      .filter((item) => retryTokens.has(item.selectionToken))
      .map((item) => ({
        ...item,
        ...resolveTrustedItemProject(item, input)
      }));
  }
  const statusResult = await dependencies.resolveSourceStatuses({
    documentsPath: input.documentsPath,
    userDataPath: input.userDataPath,
    orgId: task.orgId,
    sourceKeys: task.items.map((item) => item.sourceKey),
    activeProject: input.activeProject
  });
  const statusBySourceKey = statusResult?.bySourceKey || {};
  const assignedProjectBySourceKey = statusResult?.assignedProjectBySourceKey || {};
  return task.items.flatMap((item) => {
    const selectedSourceStatus = statusBySourceKey[item.sourceKey] || 'discovered';
    const currentItem = { ...item, selectedSourceStatus };
    if (!matchesTrustedImportFilters(currentItem, input.request)) return [];
    const assignedProject = assignedProjectBySourceKey[item.sourceKey];
    if (
      assignedProject
      && (
        (
          assignedProject.projectId
          && assignedProject.projectId !== input.activeProject.projectId
        )
        || (
          assignedProject.projectName
          && normalizeProjectText(assignedProject.projectName)
            !== normalizeProjectText(input.activeProject.projectName)
        )
      )
    ) {
      throw new MarkiTrustedImportError(
        'source_project_locked',
        `该照片已归属“${assignedProject.projectName || '其他项目'}”，不能加入当前项目“${input.activeProject.projectName}”。`
      );
    }
    const projectAssignment = resolveTrustedItemProject(currentItem, input);
    return ['discovered', 'removed_reimportable', 'failed_retryable', 'workspace_file_repairable']
      .includes(selectedSourceStatus)
      ? [{ ...currentItem, ...projectAssignment }]
      : [];
  });
}

function resolveTrustedItemProject(item, input) {
  const sourceProjectText = getMomentProjectText(item?.moment);
  if (!sourceProjectText) {
    return {
      projectId: input.activeProject.projectId,
      projectName: input.activeProject.projectName,
      projectAssignmentSource: 'active_project_context',
      projectOriginalText: ''
    };
  }
  const match = input.projectOptions.find((project) => project.name === normalizeProjectText(sourceProjectText));
  if (!match) {
    throw new MarkiTrustedImportError(
      'photo_project_unresolved',
      '照片项目无法确认，请检查项目配置或切换到正确项目。'
    );
  }
  if (match.id !== input.activeProject.projectId) {
    throw new MarkiTrustedImportError(
      'photo_project_mismatch',
      `项目不匹配：照片属于“${match.name}”，当前项目为“${input.activeProject.projectName}”。`
    );
  }
  return {
    projectId: input.activeProject.projectId,
    projectName: input.activeProject.projectName,
    projectAssignmentSource: 'marki_structured_confirmed',
    projectOriginalText: sourceProjectText
  };
}

function getMomentProjectText(moment = {}) {
  const parsed = parseMarkiContent(moment.content);
  return parsed?.success
    ? normalizeProjectText(parsed.fields?.['小区名称'])
    : '';
}

function matchesTrustedImportFilters(item, request) {
  const templateFilter = request.templateFilter;
  const templateKey = resolveItemTemplateKey(item);
  if (
    templateFilter !== 'all'
    && templateFilter !== templateKey
  ) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_filter_mismatch',
      '所选照片不符合当前水印模板筛选条件。'
    );
  }
  const status = String(item.selectedSourceStatus || '');
  const importStatusFilter = request.importStatusFilter;
  if (
    importStatusFilter !== 'all'
    && !(
      (importStatusFilter === 'not_imported' && status === 'discovered')
      || importStatusFilter === status
    )
  ) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_filter_mismatch',
      '所选照片不符合当前导入状态筛选条件。'
    );
  }
  return true;
}

async function settleTask(dependencies, task, status, batchId, effectiveSelectionTokens) {
  return dependencies.settleSelectionImport(task.sessionId, {
    taskId: task.taskId,
    status,
    batchId,
    effectiveSelectionTokens
  });
}

async function getExistingBatch(dependencies, userDataPath, batchId, batchOptions) {
  try {
    return await dependencies.getImportBatch(userDataPath, batchId, batchOptions);
  } catch (error) {
    if (error?.code === 'marki_import_batch_not_found') return null;
    throw error;
  }
}

function buildReadyResult(task, effectiveItems, downloadAttempts, readyBatch) {
  return buildSafeResult('ready', {
    batchId: readyBatch.batchId,
    selectedCount: task.selectionTokens.length,
    skippedImportedCount: task.selectionTokens.length - effectiveItems.length,
    downloadedCount: countDownloaded(downloadAttempts),
    reusedCount: countReused(downloadAttempts),
    metadataSavedCount: readyBatch.metadataSavedCount
  });
}

function buildSafeResult(status, overrides = {}) {
  return {
    success: ['ready', 'nothing_to_import'].includes(status),
    status,
    batchId: '',
    selectedCount: 0,
    skippedImportedCount: 0,
    downloadedCount: 0,
    reusedCount: 0,
    metadataSavedCount: 0,
    failedCount: 0,
    failures: [],
    ...overrides
  };
}

function buildFailedPreparation(batchId, items, deduplication, safeFailure) {
  return {
    success: false,
    batchId,
    inputCount: items.length,
    metadataSavedCount: 0,
    failedCount: items.length,
    failures: items.map((item) => ({
      sourceMetadataRef: buildSourceMetadataRef(item.moment, item.download),
      sourceKey: item.download.sourceKey,
      code: safeFailure.code,
      message: safeFailure.message
    })),
    deduplication,
    workbenchImportPackage: null
  };
}

function buildSourceMetadataRef(moment, download) {
  const sourceKey = String(download.sourceKey || '');
  const match = /^marki_api:(\d+):(.+)$/.exec(sourceKey);
  if (!match || String(moment.id || '') !== match[2]) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_source_invalid',
      '马克照片来源标识不一致。'
    );
  }
  return `marki_source_metadata:${match[1]}:${match[2]}`;
}

function mapMetadataFailures(failures, items) {
  const itemBySourceKey = new Map(items.map((item) => [item.sourceKey, item]));
  return (Array.isArray(failures) ? failures : []).map((failure) => ({
    selectionToken: itemBySourceKey.get(failure.sourceKey)?.selectionToken || '',
    displayId: resolveSafeDisplayId(itemBySourceKey.get(failure.sourceKey), items),
    code: normalizeSafeCode(failure.code, 'marki_import_metadata_failed'),
    message: '马克来源元数据保存失败，请重试。'
  }));
}

function buildGeneralFailure(code, message, item, items) {
  return {
    selectionToken: String(item?.selectionToken || ''),
    displayId: resolveSafeDisplayId(item, items),
    code,
    message
  };
}

function resolveSafeDisplayId(item, items = []) {
  const displayId = String(item?.displayId || '').trim();
  if (/^\d{1,6}$/.test(displayId)) return displayId;
  const selectionToken = String(item?.selectionToken || '');
  const index = Array.isArray(items)
    ? items.findIndex((candidate) => String(candidate?.selectionToken || '') === selectionToken)
    : -1;
  return String(index >= 0 ? index + 1 : 1);
}

function buildDeduplication(inputCount) {
  return {
    inputCount,
    uniqueCount: inputCount,
    duplicateCount: 0,
    skippedItems: []
  };
}

function countDownloaded(attempts) {
  return attempts.filter((item) => item.success && !item.download.reusedExisting).length;
}

function countReused(attempts) {
  return attempts.filter((item) => item.success && item.download.reusedExisting).length;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function reserveSourceKeys(taskId, sourceKeys) {
  const conflict = sourceKeys.some((sourceKey) => sourceReservations.has(sourceKey));
  if (conflict) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_source_busy',
      '所选照片正在其他导入任务中处理，请稍后重试。'
    );
  }
  for (const sourceKey of sourceKeys) sourceReservations.set(sourceKey, taskId);
}

function releaseSourceKeys(taskId, sourceKeys) {
  for (const sourceKey of sourceKeys) {
    if (sourceReservations.get(sourceKey) === taskId) sourceReservations.delete(sourceKey);
  }
}

function normalizeInput(input) {
  assertExactObject(input, INPUT_KEYS, 'marki_photo_import_invalid_request');
  const credentials = normalizeCredentials(input.credentials);
  const documentsPath = normalizeAbsolutePath(input.documentsPath);
  const userDataPath = normalizeAbsolutePath(input.userDataPath);
  const projectOptions = normalizeProjectOptions(input.projectOptions);
  const legacyRequest = isExactObject(input.request, LEGACY_REQUEST_KEYS);
  if (!legacyRequest) {
    assertExactObject(input.request, REQUEST_KEYS, 'marki_photo_import_invalid_request');
  }
  return {
    credentials,
    documentsPath,
    userDataPath,
    request: {
      sessionId: normalizeUuid(input.request.sessionId),
      selectionTokens: normalizeSelectionTokens(input.request.selectionTokens),
      templateFilter: legacyRequest
        ? migrateLegacyWatermarkFilter(input.request.watermarkFilter)
        : normalizeTemplateFilter(input.request.templateFilter),
      importStatusFilter: normalizeImportStatusFilter(input.request.importStatusFilter)
    },
    projectOptions,
    activeProject: normalizeActiveProject(
      input.request.activeProjectId,
      input.request.activeProjectName,
      projectOptions
    )
  };
}

function normalizeProjectOptions(value) {
  if (!Array.isArray(value)) {
    throw new MarkiTrustedImportError('active_project_invalid', '当前项目配置无效。');
  }
  return value.map((item) => ({
    id: String(item?.id || '').trim(),
    name: normalizeProjectText(item?.name)
  })).filter((item) => item.id && item.name);
}

function normalizeActiveProject(projectIdValue, projectNameValue, projectOptions) {
  const projectId = String(projectIdValue || '').trim();
  const projectName = normalizeProjectText(projectNameValue);
  if (!projectId || !projectName) {
    throw new MarkiTrustedImportError('active_project_required', '请选择当前工作项目。');
  }
  const match = projectOptions.find((item) => item.id === projectId);
  if (!match || match.name !== projectName) {
    throw new MarkiTrustedImportError('active_project_invalid', '当前项目已失效，请重新选择。');
  }
  return { projectId, projectName };
}

function normalizeProjectText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTemplateFilter(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (text === 'all' || text === 'template_unknown') return text;
  if (text.startsWith('name:')) {
    const name = normalizeTemplateName(text.slice(5));
    if (name && text === `name:${name}`) return text;
  }
  throw new MarkiTrustedImportError(
    'marki_photo_import_invalid_request',
    '马克水印模板筛选条件无效。'
  );
}

function migrateLegacyWatermarkFilter(value) {
  const text = String(value || '').normalize('NFKC').trim();
  return text.startsWith('name:')
    ? normalizeTemplateFilter(text)
    : 'all';
}

function resolveItemTemplateKey(item) {
  const explicit = String(item?.templateKey || '').normalize('NFKC').trim();
  if (explicit === 'template_unknown' || explicit.startsWith('name:')) {
    return normalizeTemplateFilter(explicit);
  }
  const legacy = String(item?.watermarkKey || '').normalize('NFKC').trim();
  if (legacy.startsWith('name:')) return normalizeTemplateFilter(legacy);
  const name = normalizeTemplateName(
    item?.templateName
    || item?.markName
    || item?.moment?.markName
  );
  return name ? `name:${name}` : 'template_unknown';
}

function normalizeTemplateName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function normalizeImportStatusFilter(value) {
  const text = String(value || '').trim();
  if ([
    'all',
    'not_imported',
    'imported_active',
    'removed_reimportable',
    'failed_retryable',
    'filtered'
  ].includes(text)) {
    return text;
  }
  throw new MarkiTrustedImportError(
    'marki_photo_import_invalid_request',
    '马克导入状态筛选条件无效。'
  );
}

function normalizeCredentials(value) {
  const orgId = String(value?.orgId || '').trim();
  const key = String(value?.key || '').trim();
  if (!/^\d+$/.test(orgId) || !key) {
    throw new MarkiTrustedImportError('marki_not_configured', '马克平台组织配置不完整。');
  }
  return { orgId, key };
}

function normalizeAbsolutePath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text) || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_storage_invalid',
      '马克照片导入存储目录不可用。'
    );
  }
  return text;
}

function normalizeSelectionTokens(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_selection_invalid',
      '请选择需要导入的马克照片。'
    );
  }
  const tokens = value.map(normalizeUuid);
  if (new Set(tokens).size !== tokens.length) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_selection_invalid',
      '所选马克照片包含重复项。'
    );
  }
  return tokens;
}

function normalizeUuid(value) {
  const text = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_selection_invalid',
      '马克照片选择凭据无效。'
    );
  }
  return text;
}

function assertExactObject(value, allowedKeys, code) {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== allowedKeys.size
    || Object.keys(value).some((key) => !allowedKeys.has(key))
  ) {
    throw new MarkiTrustedImportError(code, '马克照片导入请求格式不正确。');
  }
}

function isExactObject(value, allowedKeys) {
  return isPlainObject(value)
    && Object.keys(value).length === allowedKeys.size
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

function resolveDependencies(options) {
  const dependencies = {
    beginSelectionImport: options.beginSelectionImport || beginMarkiPhotoSelectionImport,
    settleSelectionImport: options.settleSelectionImport || settleMarkiPhotoSelectionImport,
    resolveSourceStatuses: options.resolveSourceStatuses
      || (typeof options.checkSourceKeys === 'function'
        ? createLegacySourceStatusResolver(options.checkSourceKeys)
        : resolveMarkiImportSourceStatuses),
    downloadMarkiPhoto: options.downloadMarkiPhoto || downloadMarkiPhoto,
    prepareStructuredImport: options.prepareStructuredImport || prepareMarkiStructuredImport,
    beginImportBatch: options.beginImportBatch || beginMarkiImportBatch,
    getImportBatch: options.getImportBatch || getMarkiImportBatch,
    markBatchFailed: options.markBatchFailed || markMarkiImportBatchFailed,
    markBatchReady: options.markBatchReady || markMarkiImportBatchReady,
    beginLifecycleBatch: options.beginLifecycleBatch || beginMarkiImportLifecycleBatch,
    markLifecycleDownloading: options.markLifecycleDownloading || markMarkiImportLifecycleDownloading,
    settleLifecycleDownloads: options.settleLifecycleDownloads || settleMarkiImportLifecycleDownloads,
    markLifecycleFailed: options.markLifecycleFailed || markMarkiImportLifecycleFailed,
    markLifecycleReady: options.markLifecycleReady || markMarkiImportLifecycleReady,
    randomUUID: options.randomUUID || crypto.randomUUID
  };
  if (Object.values(dependencies).some((value) => typeof value !== 'function')) {
    throw new MarkiTrustedImportError(
      'marki_photo_import_dependency_invalid',
      '马克照片导入服务配置无效。'
    );
  }
  return dependencies;
}

function createLegacySourceStatusResolver(checkSourceKeys) {
  return async ({ documentsPath, orgId, sourceKeys }) => {
    const result = await checkSourceKeys(documentsPath, orgId, sourceKeys);
    return {
      success: true,
      bySourceKey: Object.fromEntries(sourceKeys.map((sourceKey) => {
        const item = result?.bySourceKey?.[sourceKey];
        const status = String(item?.importStatus || '');
        if (status === 'imported') return [sourceKey, 'imported_active'];
        if ([
          'download_failed',
          'repair_required',
          'repairing',
          'repair_failed'
        ].includes(status)) return [sourceKey, 'failed_retryable'];
        if (status === 'downloading') return [sourceKey, 'downloading'];
        return [sourceKey, 'discovered'];
      }))
    };
  };
}

async function recordLifecycleFailure(
  dependencies,
  userDataPath,
  batchId,
  items,
  code,
  message,
  options
) {
  await dependencies.markLifecycleFailed(
    userDataPath,
    {
      batchId,
      failures: items.map((item) => ({
        sourceKey: item.sourceKey,
        code,
        message
      }))
    },
    options.lifecycleOptions || {}
  ).catch(() => {});
}

function toSafeFailure(error, fallbackCode, fallbackMessage) {
  return {
    code: normalizeSafeCode(error?.code, fallbackCode),
    message: error instanceof MarkiTrustedImportError
      ? error.message
      : fallbackMessage
  };
}

function normalizeSafeCode(value, fallback) {
  const code = String(value || '').trim();
  return /^[a-z][a-z0-9_]{1,90}$/.test(code) ? code : fallback;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  MAX_CONCURRENT_DOWNLOADS,
  MarkiTrustedImportError,
  importMarkiPhotoQuerySelection,
  mapWithConcurrency
};
