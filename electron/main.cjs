const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { scanImages, scanImagesWithHealth } = require('./services/fileService.cjs');
const { buildArchivePreview, archivePhotos, recoverPendingArchiveTransactions } = require('./services/archiveService.cjs');
const { matchArchivedPhotos } = require('./services/archiveFingerprintService.cjs');
const { buildPackagePlan, generateArchivePackage } = require('./services/archivePackageService.cjs');
const { exportServiceBriefImages } = require('./services/serviceBriefService.cjs');
const { getDataMaintenanceReport } = require('./services/dataMaintenanceService.cjs');
const { clearHandledTrialIssues, deleteTrialIssue, exportTrialIssues, loadTrialIssues, saveTrialIssue } = require('./services/trialIssueService.cjs');
const { loadDashboardData } = require('./services/dashboardService.cjs');
const { deleteLedgerRecords, exportLedgerRecords, loadLedgerRecords } = require('./services/ledgerQueryService.cjs');
const {
  getRecognitionConfig,
  getRecognitionProviders,
  getRecognitionStatus,
  getSafeRecognitionConfig,
  updateRecognitionConfig,
  diagnoseRecognitionConfig,
  parseRecognitionText,
  recognizePhoto,
  recognizePhotos,
  getRecognitionFieldMappingRules,
  getRecognitionFieldMappingRule,
  buildCandidateFieldSetFromStagedResult,
  getCandidateFieldSet,
  getCandidateFieldSetByStagedResult,
  getCandidateFieldSetByPhoto,
  listCandidateFieldSets,
  clearCandidateFieldSet,
  clearCandidateFieldSetsByPhoto,
  clearAllCandidateFieldSets,
  createReviewDraftFromStagedResult,
  getReviewDraft,
  getReviewDraftByStagedResultId,
  getReviewDraftByPhoto,
  listReviewDrafts,
  updateReviewDraftStatus,
  clearReviewDraft,
  clearReviewDraftsByPhoto,
  clearAllReviewDrafts,
  createReviewDecision,
  getReviewDecision,
  getReviewDecisionByReviewDraftId,
  getReviewDecisionByPhoto,
  listReviewDecisions,
  clearReviewDecision,
  clearReviewDecisionsByPhoto,
  clearAllReviewDecisions,
  buildFormPatchDraftFromReviewDecision,
  validateFormPatchDraft,
  getFormPatchDraft,
  getFormPatchDraftByReviewDecisionId,
  getFormPatchDraftByPhoto,
  listFormPatchDrafts,
  updateFormPatchDraftStatus,
  clearFormPatchDraft,
  clearFormPatchDraftsByPhoto,
  clearAllFormPatchDrafts,
  getStagedRecognitionResult,
  getStagedRecognitionResultByTaskId,
  getStagedRecognitionResultByPhoto,
  listStagedRecognitionResults,
  updateStagedRecognitionStatus,
  clearStagedRecognitionResult,
  clearStagedRecognitionResultsByPhoto,
  clearAllStagedRecognitionResults
} = require('./services/recognitionService.cjs');
const { exportSummaryWorkbook, loadSummaryData } = require('./services/summaryService.cjs');
const {
  exportRectificationItems,
  loadRectificationItems,
  saveRectificationItem
} = require('./services/rectificationService.cjs');
const {
  saveUserConfig,
  saveAllUserConfigs,
  resetConfigsToDefault,
  exportConfigs,
  importConfigs,
  backupConfigs,
  validateConfig
} = require('./services/configService.cjs');
const { getLedgerPath } = require('./services/excelService.cjs');
const {
  loadSettings,
  validatePathExists
} = require('./services/settingsService.cjs');
const {
  getRuntimeConfigurationPaths,
  loadRuntimeConfiguration,
  loadRuntimeEditableConfigs,
  saveRuntimeDirectory,
  saveRuntimeSettings
} = require('./services/runtimeConfigurationService.cjs');
const { inspectDirectoryHealth } = require('./services/directoryHealthService.cjs');
const { inspectPhotoSourceFile } = require('./services/photoFileHealthService.cjs');
const {
  clearMarkiCredentials,
  getMarkiCredentialStatus,
  loadMarkiCredentials,
  saveMarkiCredentials
} = require('./services/markiCredentialService.cjs');
const {
  listMarkiMembers,
  listMarkiTeams,
  testMarkiConnection,
  toSafeMarkiError
} = require('./services/markiApiService.cjs');
const {
  consumeMarkiImportBatch,
  getMarkiImportBatch,
  listReadyMarkiImportBatches
} = require('./services/markiImportBatchService.cjs');
const {
  createMarkiPhotoQuerySession,
  destroyMarkiPhotoQuerySession,
  getMarkiPhotoQuerySession,
  loadNextMarkiPhotoQueryPage
} = require('./services/markiPhotoQuerySessionService.cjs');
const {
  importMarkiPhotoQuerySelection
} = require('./services/markiTrustedImportService.cjs');
const {
  cleanupMarkiImportLifecycleCache,
  clearMarkiImportLifecycleRecord,
  completeMarkiImportLifecycleBatch,
  listMarkiImportLifecycleRecords,
  markMarkiImportLifecycleAppending,
  recoverMarkiImportLifecycle,
  undoMarkiImportLifecycleBatch
} = require('./services/markiImportLifecycleService.cjs');
const {
  loadSortWorkspaceSnapshot,
  saveSortWorkspaceSnapshot
} = require('./services/sortWorkspaceSnapshotService.cjs');
const {
  recoverMarkiWorkbenchCandidates,
  scanMarkiWorkbenchRecoveryCandidates
} = require('./services/markiWorkbenchRehydrateService.cjs');

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, protocol, safeStorage, shell, screen } = electron;
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const appDataFolderName = '物业工作照片归档助手';
const appIconPath = path.join(__dirname, 'assets', 'app-icon.png');
const runtimeDir = resolveRuntimeDir();
const WINDOW_STATE_FILE = 'window-state.json';
const MIN_WINDOW_WIDTH = 1280;
const MIN_WINDOW_HEIGHT = 800;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('user-data-dir', path.join(runtimeDir, 'userData'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(runtimeDir, 'cache'));
app.setPath('userData', path.join(runtimeDir, 'userData'));
app.setPath('sessionData', path.join(runtimeDir, 'sessionData'));
app.setPath('logs', path.join(runtimeDir, 'logs'));
app.setPath('crashDumps', path.join(runtimeDir, 'crashDumps'));

function resolveRuntimeDir() {
  const preferredRuntimeDir = isDev
    ? path.join(__dirname, '..', '.runtime')
    : path.join(app.getPath('documents'), appDataFolderName, '.runtime');
  try {
    fs.mkdirSync(preferredRuntimeDir, { recursive: true });
    return preferredRuntimeDir;
  } catch {
    const fallbackRuntimeDir = path.join(app.getPath('temp'), appDataFolderName, '.runtime');
    fs.mkdirSync(fallbackRuntimeDir, { recursive: true });
    return fallbackRuntimeDir;
  }
}

function createWindow() {
  const windowState = loadWindowState();
  const safeBounds = normalizeWindowBounds(windowState.bounds);
  const mainWindow = new BrowserWindow({
    ...safeBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: '物业工作照片归档助手',
    icon: appIconPath,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenuBarVisibility(false);

  if (!windowState.hasSavedState || windowState.isMaximized) {
    mainWindow.maximize();
  }
  installWindowStatePersistence(mainWindow);

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function getWindowStatePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function loadWindowState() {
  try {
    const statePath = getWindowStatePath();
    if (!fs.existsSync(statePath)) {
      return { hasSavedState: false, isMaximized: true, bounds: defaultWindowBounds() };
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      hasSavedState: true,
      isMaximized: Boolean(parsed.isMaximized),
      bounds: normalizeWindowBounds(parsed.bounds)
    };
  } catch {
    return { hasSavedState: false, isMaximized: true, bounds: defaultWindowBounds() };
  }
}

function defaultWindowBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(1400, workArea.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(900, workArea.height));
  return {
    width,
    height,
    x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2))
  };
}

function normalizeWindowBounds(bounds = {}) {
  const fallback = defaultWindowBounds();
  const width = Math.max(MIN_WINDOW_WIDTH, Number(bounds.width) || fallback.width);
  const height = Math.max(MIN_WINDOW_HEIGHT, Number(bounds.height) || fallback.height);
  let x = Number.isFinite(Number(bounds.x)) ? Number(bounds.x) : fallback.x;
  let y = Number.isFinite(Number(bounds.y)) ? Number(bounds.y) : fallback.y;
  const candidate = { x, y, width, height };
  const visible = screen.getAllDisplays().some((display) => intersects(candidate, display.workArea));
  if (!visible) {
    x = fallback.x;
    y = fallback.y;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function intersects(rect, area) {
  return rect.x < area.x + area.width
    && rect.x + rect.width > area.x
    && rect.y < area.y + area.height
    && rect.y + rect.height > area.y;
}

function installWindowStatePersistence(mainWindow) {
  let lastNormalBounds = normalizeWindowBounds(mainWindow.getBounds());
  const rememberBounds = () => {
    if (mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    if (!mainWindow.isMaximized()) lastNormalBounds = normalizeWindowBounds(mainWindow.getBounds());
  };
  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);
  mainWindow.on('maximize', rememberBounds);
  mainWindow.on('unmaximize', rememberBounds);
  mainWindow.on('close', () => {
    if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
    const state = {
      isMaximized: mainWindow.isMaximized(),
      bounds: normalizeWindowBounds(mainWindow.isMaximized() ? lastNormalBounds : mainWindow.getBounds())
    };
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Window state is convenience data. Failing to save it must not block exit.
    }
  });
}

function getWritableDocumentsPath() {
  const preferredDocumentsPath = app.getPath('documents');
  const preferredAppDataDir = path.join(preferredDocumentsPath, appDataFolderName);
  const projectRoot = path.resolve(__dirname, '..');
  if (path.resolve(preferredAppDataDir) === projectRoot) {
    return app.getPath('userData');
  }
  try {
    fs.mkdirSync(preferredAppDataDir, { recursive: true });
    return preferredDocumentsPath;
  } catch {
    return app.getPath('userData');
  }
}

function getRuntimeConfigurationStorageRoots() {
  return {
    userDataPath: app.getPath('userData'),
    documentsPath: app.getPath('documents')
  };
}

async function loadCurrentRuntimeConfiguration() {
  return loadRuntimeConfiguration(getRuntimeConfigurationStorageRoots());
}

async function publishRuntimeConfiguration() {
  const runtimeConfiguration = await loadCurrentRuntimeConfiguration();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
    }
  }
  return runtimeConfiguration;
}

async function mutateRuntimeConfiguration(action) {
  await action();
  return publishRuntimeConfiguration();
}

function getConfiguredDirectory(runtimeConfiguration, directoryKind) {
  if (directoryKind === 'photoSource') {
    return {
      configuredPath: runtimeConfiguration.photoSourceDirectory,
      label: '照片来源目录',
      requirements: { readable: true, writable: false, allowCreate: false, checkOnly: true }
    };
  }
  if (directoryKind === 'archiveRoot') {
    return {
      configuredPath: runtimeConfiguration.archiveRootDirectory,
      label: '归档根目录',
      requirements: { readable: true, writable: false, allowCreate: false, checkOnly: true }
    };
  }
  if (directoryKind === 'archivePackage') {
    return {
      configuredPath: runtimeConfiguration.archivePackageDirectory,
      label: '归档资料包目录',
      requirements: { readable: true, writable: false, allowCreate: false, checkOnly: true }
    };
  }
  throw new TypeError('目录类型无效。');
}

function createDirectoryHealthMessage(directoryKind, health) {
  const label = directoryKind === 'photoSource' ? '照片来源目录' : '归档根目录';
  if (health.healthStatus === 'not_configured') return `尚未配置${label}。`;
  if (health.healthStatus === 'missing') return `${label}不存在：${health.normalizedPath}`;
  if (health.healthStatus === 'not_directory') return `配置路径不是目录：${health.normalizedPath}`;
  if (health.healthStatus === 'unreadable') {
    return `无法读取目录：${health.normalizedPath}，原因：${health.errorMessage}`;
  }
  if (health.healthStatus === 'unwritable') {
    return `${label}不可写：${health.normalizedPath}，原因：${health.errorMessage}`;
  }
  return `${label}当前不可用。`;
}

async function inspectConfiguredDirectory(directoryKind, overrides = {}) {
  const runtimeConfiguration = await loadCurrentRuntimeConfiguration();
  const configured = getConfiguredDirectory(runtimeConfiguration, directoryKind);
  const requirements = {
    ...configured.requirements,
    ...(overrides.writable === true ? { writable: true } : {})
  };
  const health = await inspectDirectoryHealth(configured.configuredPath, requirements);
  return {
    success: health.healthStatus === 'healthy',
    directoryKind,
    revision: runtimeConfiguration.revision,
    health,
    message: health.healthStatus === 'healthy'
      ? `${configured.label}可用。`
      : createDirectoryHealthMessage(directoryKind, health)
  };
}

async function safeRecognitionCall(action, fallback) {
  try {
    return await action();
  } catch (error) {
    return fallback(error);
  }
}

async function safeArchiveCall(action, fallback) {
  try {
    return await action();
  } catch (error) {
    return fallback(error);
  }
}

function createArchiveIpcErrorResult(error = {}, inputCount = 0) {
  const safeCode = /^(archive|ledger)_/.test(String(error.code || ''))
    ? String(error.code)
    : 'archive_ipc_failed';
  const safeMessage = safeCode === 'archive_ipc_failed'
    ? '归档服务调用失败，请重试。'
    : String(error.message || '归档服务调用失败，请重试。');
  return {
    success: false,
    recoverable: false,
    transactionId: '',
    status: 'failed',
    inputCount,
    total: inputCount,
    copiedCount: 0,
    committedCount: 0,
    successCount: 0,
    pendingLedgerCount: 0,
    failedCount: inputCount,
    conflictCount: 0,
    fingerprintIndexWarning: '',
    errorCode: safeCode,
    message: safeMessage,
    items: []
  };
}

function createArchiveRecoveryIpcError(error = {}) {
  const safeCode = /^(archive|ledger)_/.test(String(error.code || ''))
    ? String(error.code)
    : 'archive_recovery_failed';
  return {
    success: false,
    recoveredTransactionCount: 0,
    transactionCount: 0,
    committedCount: 0,
    pendingLedgerCount: 0,
    retryRequiredCount: 0,
    conflictCount: 0,
    errors: [{
      errorCode: safeCode,
      message: safeCode === 'archive_recovery_failed'
        ? '归档恢复服务调用失败，请稍后重试。'
        : String(error.message || '归档恢复服务调用失败，请稍后重试。')
    }],
    transactions: []
  };
}

function createRecognitionErrorStatus(error = {}) {
  return {
    success: false,
    serviceStatus: 'unavailable',
    engineStatus: 'error',
    currentMode: 'disabled',
    status: 'error',
    reason: error.message || '识别服务调用失败。',
    message: '识别服务调用失败。',
    providers: [],
    errors: [{ code: 'recognition_ipc_error', message: error.message || '识别服务调用失败。' }],
    updatedAt: new Date().toISOString()
  };
}

function createRecognitionConfigError(error = {}) {
  return {
    success: false,
    config: {
      recognitionMode: 'disabled',
      activeProviderId: '',
      providers: {}
    },
    providers: {},
    warnings: ['识别配置服务调用失败，已返回安全兜底。'],
    errors: [{ code: 'recognition_config_ipc_error', message: error.message || '识别配置服务调用失败。' }],
    checkedAt: new Date().toISOString()
  };
}

function createRecognitionErrorResult(error = {}, options = {}) {
  const photo = options.photo || {};
  return {
    photoId: photo.id || options.photoId || '',
    filePath: photo.originalPath || photo.path || options.filePath || '',
    fileName: photo.fileName || photo.name || options.fileName || '',
    taskId: options.taskId || '',
    source: 'system',
    providerId: options.providerId || '',
    providerType: options.providerType || '',
    status: 'failed',
    confidence: null,
    rawText: '',
    parsedFields: {
      watermarkCategory: null,
      workContent: null,
      projectName: null,
      location: null,
      date: null,
      time: null,
      weekday: null,
      keywords: [],
      remark: null,
      stage: null,
      processStatus: null
    },
    warnings: ['识别服务调用失败，未修改照片或台账。'],
    errors: [{ code: 'recognition_ipc_error', message: error.message || '识别服务调用失败。' }],
    createdAt: new Date().toISOString()
  };
}

async function recordOcrRuntimeLog(photo = {}, result = {}) {
  try {
    const engine = result.engineResult || result.localResult?.engineResult || {};
    const fileName = result.fileName || photo.fileName || photo.name || path.basename(result.filePath || photo.originalPath || photo.path || '') || '未命名照片';
    const textLength = String(result.rawText || result.adoptedOcrText || '').length;
    const status = String(result.status || 'failed');
    const succeeded = status === 'success' && textLength > 0;
    const empty = status === 'empty' || (status === 'success' && textLength === 0);
    const level = succeeded ? 'info' : (empty ? 'warn' : 'error');
    const summary = succeeded
      ? `OCR 识别成功：${fileName}（${textLength} 字）`
      : `${empty ? 'OCR 未识别到有效文字' : 'OCR 识别失败'}：${fileName}`;
    const technicalDetail = JSON.stringify({
      fileName,
      status,
      providerId: result.providerId || '',
      ocrEngine: engine.ocrEngine || '',
      engineSource: engine.source || '',
      componentVersion: engine.componentVersion || '',
      durationMs: Number.isFinite(Number(engine.durationMs)) ? Number(engine.durationMs) : null,
      textLength,
      warnings: result.warnings || [],
      errors: result.errors || []
    }, null, 2);
    await saveTrialIssue(getWritableDocumentsPath(), {
      logType: 'auto',
      level,
      page: '照片分拣工作台',
      operation: 'OCR 识别',
      errorType: 'OCR 识别',
      summary,
      suggestion: succeeded ? '识别已完成，无需处理。' : '请在 OCR 识别记录中核对引擎、耗时与错误信息后重试。',
      technicalDetail,
      status: succeeded ? 'handled' : 'open',
      occurredAt: new Date().toISOString()
    });
  } catch (error) {
    console.warn('[OCR] runtime log write failed:', error.message || error);
  }
}

function disableNativeMenu() {
  Menu.setApplicationMenu(null);
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.property.photo.archive.assistant');
  disableNativeMenu();
  await recoverMarkiImportLifecycle(app.getPath('userData')).catch(() => {});

  protocol.handle('local-photo', (request) => {
    const url = new URL(request.url);
    const imagePath = decodeURIComponent(url.pathname.slice(1));
    return net.fetch(pathToFileURL(imagePath).toString());
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('dialog:selectPhotoFolder', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择照片文件夹',
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectArchiveRoot', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择归档根目录',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('photos:scanImages', async (_event, folderPath) => scanImages(folderPath));
ipcMain.handle('photos:scanConfigured', async () => {
  try {
    const inspection = await inspectConfiguredDirectory('photoSource');
    if (!inspection.success) return { ...inspection, photos: [], failures: [] };
    const result = await scanImagesWithHealth(inspection.health.normalizedPath);
    return {
      success: true,
      revision: inspection.revision,
      directory: inspection.health,
      photos: result.photos,
      failures: result.failures
    };
  } catch (error) {
    return {
      success: false,
      photos: [],
      failures: [],
      error: {
        code: 'configured_photo_scan_failed',
        message: `无法读取当前运行配置：${String(error?.message || '未知错误')}`
      }
    };
  }
});
ipcMain.handle('photos:inspectSourceFile', async (_event, input) => (
  inspectPhotoSourceFile(input?.path || input?.photo || input, input?.expectedSha256 || '')
));
ipcMain.handle('photos:matchArchived', async (_event, archiveRoot, photos) => matchArchivedPhotos(archiveRoot, photos));
ipcMain.handle('recognition:getStatus', async () => safeRecognitionCall(() => getRecognitionStatus(app.getPath('userData')), createRecognitionErrorStatus));
ipcMain.handle('recognition:getProviders', async () => safeRecognitionCall(() => getRecognitionProviders(app.getPath('userData')), () => []));
ipcMain.handle('recognition:getConfig', async () => safeRecognitionCall(() => getRecognitionConfig(app.getPath('userData')), createRecognitionConfigError));
ipcMain.handle('recognition:getSafeConfig', async () => safeRecognitionCall(() => getSafeRecognitionConfig(app.getPath('userData')), createRecognitionConfigError));
ipcMain.handle('recognition:updateConfig', async (_event, patch) => safeRecognitionCall(
  () => updateRecognitionConfig(app.getPath('userData'), patch),
  createRecognitionConfigError
));
ipcMain.handle('recognition:diagnoseConfig', async () => safeRecognitionCall(
  () => diagnoseRecognitionConfig(app.getPath('userData')),
  createRecognitionConfigError
));
ipcMain.handle('recognition:parseText', async (_event, rawText, options) => safeRecognitionCall(
  () => parseRecognitionText(rawText, options),
  (error) => createRecognitionErrorResult(error, options)
));
ipcMain.handle('recognition:recognizePhoto', async (_event, photo, options) => {
  const result = await safeRecognitionCall(
    () => recognizePhoto(photo, { ...options, userDataDir: app.getPath('userData') }),
    (error) => createRecognitionErrorResult(error, { ...options, photo })
  );
  await recordOcrRuntimeLog(photo, result);
  return result;
});
ipcMain.handle('recognition:recognizePhotos', async (_event, photos, options) => {
  const safePhotos = Array.isArray(photos) ? photos : [];
  const results = await safeRecognitionCall(
    () => recognizePhotos(safePhotos, { ...options, userDataDir: app.getPath('userData') }),
    (error) => safePhotos.map((photo) => createRecognitionErrorResult(error, { ...options, photo }))
  );
  for (let index = 0; index < results.length; index += 1) {
    await recordOcrRuntimeLog(safePhotos[index] || {}, results[index]);
  }
  return results;
});
ipcMain.handle('recognition:getStagedResult', async (_event, id) => safeRecognitionCall(
  () => getStagedRecognitionResult(app.getPath('userData'), id),
  () => null
));
ipcMain.handle('recognition:getStagedResultByTaskId', async (_event, taskId) => safeRecognitionCall(
  () => getStagedRecognitionResultByTaskId(app.getPath('userData'), taskId),
  () => null
));
ipcMain.handle('recognition:getStagedResultByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => getStagedRecognitionResultByPhoto(app.getPath('userData'), photoInput),
  () => null
));
ipcMain.handle('recognition:listStagedResults', async (_event, options) => safeRecognitionCall(
  () => listStagedRecognitionResults(app.getPath('userData'), options),
  () => []
));
ipcMain.handle('recognition:updateStagedResultStatus', async (_event, id, stageStatus) => safeRecognitionCall(
  () => updateStagedRecognitionStatus(app.getPath('userData'), id, stageStatus),
  () => null
));
ipcMain.handle('recognition:clearStagedResult', async (_event, id) => safeRecognitionCall(
  () => clearStagedRecognitionResult(app.getPath('userData'), id),
  () => false
));
ipcMain.handle('recognition:clearStagedResultsByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => clearStagedRecognitionResultsByPhoto(app.getPath('userData'), photoInput),
  () => 0
));
ipcMain.handle('recognition:clearAllStagedResults', async () => safeRecognitionCall(
  () => clearAllStagedRecognitionResults(app.getPath('userData')),
  () => 0
));
ipcMain.handle('recognition:getFieldMappingRules', async () => safeRecognitionCall(
  () => getRecognitionFieldMappingRules(),
  () => []
));
ipcMain.handle('recognition:getFieldMappingRule', async (_event, sourceFieldKey) => safeRecognitionCall(
  () => getRecognitionFieldMappingRule(sourceFieldKey),
  () => null
));
ipcMain.handle('recognition:buildCandidateFieldSet', async (_event, stagedResultId) => safeRecognitionCall(
  async () => {
    const stagedResult = await getStagedRecognitionResult(app.getPath('userData'), stagedResultId);
    return stagedResult ? buildCandidateFieldSetFromStagedResult(app.getPath('userData'), stagedResult) : null;
  },
  () => null
));
ipcMain.handle('recognition:getCandidateFieldSet', async (_event, id) => safeRecognitionCall(
  () => getCandidateFieldSet(app.getPath('userData'), id),
  () => null
));
ipcMain.handle('recognition:getCandidateFieldSetByStagedResult', async (_event, stagedResultId) => safeRecognitionCall(
  () => getCandidateFieldSetByStagedResult(app.getPath('userData'), stagedResultId),
  () => null
));
ipcMain.handle('recognition:getCandidateFieldSetByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => getCandidateFieldSetByPhoto(app.getPath('userData'), photoInput),
  () => null
));
ipcMain.handle('recognition:listCandidateFieldSets', async (_event, options) => safeRecognitionCall(
  () => listCandidateFieldSets(app.getPath('userData'), options),
  () => []
));
ipcMain.handle('recognition:clearCandidateFieldSet', async (_event, id) => safeRecognitionCall(
  () => clearCandidateFieldSet(app.getPath('userData'), id),
  () => false
));
ipcMain.handle('recognition:clearCandidateFieldSetsByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => clearCandidateFieldSetsByPhoto(app.getPath('userData'), photoInput),
  () => 0
));
ipcMain.handle('recognition:clearAllCandidateFieldSets', async () => safeRecognitionCall(
  () => clearAllCandidateFieldSets(app.getPath('userData')),
  () => 0
));
ipcMain.handle('recognition:createReviewDraft', async (_event, stagedResultId) => safeRecognitionCall(
  () => createReviewDraftFromStagedResult(app.getPath('userData'), stagedResultId),
  () => null
));
ipcMain.handle('recognition:getReviewDraft', async (_event, id) => safeRecognitionCall(
  () => getReviewDraft(app.getPath('userData'), id),
  () => null
));
ipcMain.handle('recognition:getReviewDraftByStagedResult', async (_event, stagedResultId) => safeRecognitionCall(
  () => getReviewDraftByStagedResultId(app.getPath('userData'), stagedResultId),
  () => null
));
ipcMain.handle('recognition:getReviewDraftByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => getReviewDraftByPhoto(app.getPath('userData'), photoInput),
  () => null
));
ipcMain.handle('recognition:listReviewDrafts', async (_event, options) => safeRecognitionCall(
  () => listReviewDrafts(app.getPath('userData'), options),
  () => []
));
ipcMain.handle('recognition:updateReviewDraftStatus', async (_event, id, status) => safeRecognitionCall(
  () => updateReviewDraftStatus(app.getPath('userData'), id, status),
  () => null
));
ipcMain.handle('recognition:clearReviewDraft', async (_event, id) => safeRecognitionCall(
  () => clearReviewDraft(app.getPath('userData'), id),
  () => false
));
ipcMain.handle('recognition:clearReviewDraftsByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => clearReviewDraftsByPhoto(app.getPath('userData'), photoInput),
  () => 0
));
ipcMain.handle('recognition:clearAllReviewDrafts', async () => safeRecognitionCall(
  () => clearAllReviewDrafts(app.getPath('userData')),
  () => 0
));
ipcMain.handle('recognition:createReviewDecision', async (_event, input) => safeRecognitionCall(
  () => createReviewDecision(app.getPath('userData'), input),
  () => null
));
ipcMain.handle('recognition:getReviewDecision', async (_event, id) => safeRecognitionCall(
  () => getReviewDecision(app.getPath('userData'), id),
  () => null
));
ipcMain.handle('recognition:getReviewDecisionByReviewDraft', async (_event, reviewDraftId) => safeRecognitionCall(
  () => getReviewDecisionByReviewDraftId(app.getPath('userData'), reviewDraftId),
  () => null
));
ipcMain.handle('recognition:getReviewDecisionByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => getReviewDecisionByPhoto(app.getPath('userData'), photoInput),
  () => null
));
ipcMain.handle('recognition:listReviewDecisions', async (_event, options) => safeRecognitionCall(
  () => listReviewDecisions(app.getPath('userData'), options),
  () => []
));
ipcMain.handle('recognition:clearReviewDecision', async (_event, id) => safeRecognitionCall(
  () => clearReviewDecision(app.getPath('userData'), id),
  () => false
));
ipcMain.handle('recognition:clearReviewDecisionsByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => clearReviewDecisionsByPhoto(app.getPath('userData'), photoInput),
  () => 0
));
ipcMain.handle('recognition:clearAllReviewDecisions', async () => safeRecognitionCall(
  () => clearAllReviewDecisions(app.getPath('userData')),
  () => 0
));
ipcMain.handle('recognition:buildFormPatchDraft', async (_event, input) => safeRecognitionCall(
  () => buildFormPatchDraftFromReviewDecision(app.getPath('userData'), input),
  () => null
));
ipcMain.handle('recognition:validateFormPatchDraft', async (_event, patchDraftId) => safeRecognitionCall(
  () => validateFormPatchDraft(app.getPath('userData'), patchDraftId),
  () => ({
    ok: false,
    patchDraftId: String(patchDraftId || ''),
    validPatches: [],
    invalidPatches: [],
    conflictPatches: [],
    warnings: [],
    errors: [{ code: 'patch_validation_unavailable', message: '表单补丁校验接口不可用。' }],
    checkedAt: new Date().toISOString(),
    schemaVersion: 1
  })
));
ipcMain.handle('recognition:getFormPatchDraft', async (_event, id) => safeRecognitionCall(
  () => getFormPatchDraft(app.getPath('userData'), id),
  () => null
));
ipcMain.handle('recognition:getFormPatchDraftByReviewDecision', async (_event, reviewDecisionId) => safeRecognitionCall(
  () => getFormPatchDraftByReviewDecisionId(app.getPath('userData'), reviewDecisionId),
  () => null
));
ipcMain.handle('recognition:getFormPatchDraftByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => getFormPatchDraftByPhoto(app.getPath('userData'), photoInput),
  () => null
));
ipcMain.handle('recognition:listFormPatchDrafts', async (_event, options) => safeRecognitionCall(
  () => listFormPatchDrafts(app.getPath('userData'), options),
  () => []
));
ipcMain.handle('recognition:updateFormPatchDraftStatus', async (_event, id, status) => safeRecognitionCall(
  () => updateFormPatchDraftStatus(app.getPath('userData'), id, status),
  () => null
));
ipcMain.handle('recognition:clearFormPatchDraft', async (_event, id) => safeRecognitionCall(
  () => clearFormPatchDraft(app.getPath('userData'), id),
  () => false
));
ipcMain.handle('recognition:clearFormPatchDraftsByPhoto', async (_event, photoInput) => safeRecognitionCall(
  () => clearFormPatchDraftsByPhoto(app.getPath('userData'), photoInput),
  () => 0
));
ipcMain.handle('recognition:clearAllFormPatchDrafts', async () => safeRecognitionCall(
  () => clearAllFormPatchDrafts(app.getPath('userData')),
  () => 0
));
ipcMain.handle('runtimeConfiguration:load', async () => loadCurrentRuntimeConfiguration());
ipcMain.handle('runtimeConfiguration:saveSettings', async (_event, settings) => {
  const runtimeConfiguration = await saveRuntimeSettings(getRuntimeConfigurationStorageRoots(), settings);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
  }
  return runtimeConfiguration;
});
ipcMain.handle('runtimeConfiguration:saveDirectory', async (_event, directoryKind, directoryPath) => {
  const runtimeConfiguration = await saveRuntimeDirectory(
    getRuntimeConfigurationStorageRoots(),
    directoryKind,
    directoryPath
  );
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
  }
  return runtimeConfiguration;
});
ipcMain.handle('runtimeConfiguration:inspectDirectory', async (_event, directoryKind, requirements = {}) => (
  inspectConfiguredDirectory(directoryKind, requirements)
));
ipcMain.handle('runtimeConfiguration:openDirectory', async (_event, directoryKind) => {
  try {
    const inspection = await inspectConfiguredDirectory(directoryKind);
    if (!inspection.success) return inspection;
    const error = await shell.openPath(inspection.health.normalizedPath);
    return error
      ? { ...inspection, success: false, message: `无法打开目录：${error}` }
      : { ...inspection, success: true, message: '目录已打开。' };
  } catch (error) {
    return {
      success: false,
      directoryKind,
      message: `无法读取当前运行配置：${String(error?.message || '未知错误')}`
    };
  }
});
ipcMain.handle('configs:load', async () => (await loadCurrentRuntimeConfiguration()).configs);
ipcMain.handle('configs:loadUserConfigs', async () => loadRuntimeEditableConfigs(getRuntimeConfigurationStorageRoots()));
ipcMain.handle('configs:saveUserConfig', async (_event, configName, data) => {
  const roots = getRuntimeConfigurationStorageRoots();
  await loadCurrentRuntimeConfiguration();
  const saved = await saveUserConfig(roots.userDataPath, configName, data);
  return { ...saved, runtimeConfiguration: await publishRuntimeConfiguration() };
});
ipcMain.handle('configs:saveAllUserConfigs', async (_event, configs) => {
  const roots = getRuntimeConfigurationStorageRoots();
  await loadCurrentRuntimeConfiguration();
  const saved = await saveAllUserConfigs(roots.userDataPath, configs);
  return { ...saved, runtimeConfiguration: await publishRuntimeConfiguration() };
});
ipcMain.handle('configs:resetToDefault', async () => {
  const roots = getRuntimeConfigurationStorageRoots();
  const saved = await resetConfigsToDefault(roots.userDataPath);
  return { ...saved, runtimeConfiguration: await publishRuntimeConfiguration() };
});
ipcMain.handle('configs:backup', async () => {
  const roots = getRuntimeConfigurationStorageRoots();
  await loadCurrentRuntimeConfiguration();
  return backupConfigs(roots.userDataPath);
});
ipcMain.handle('configs:getPaths', async () => getRuntimeConfigurationPaths(getRuntimeConfigurationStorageRoots()));
ipcMain.handle('configs:validate', async (_event, configName, data) => validateConfig(configName, data));
ipcMain.handle('configs:export', async () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const defaultPath = path.join(
    app.getPath('documents'),
    `物业工作照片归档助手配置备份_${timestamp}.json`
  );
  const result = await dialog.showSaveDialog({
    title: '导出配置',
    defaultPath,
    filters: [{ name: 'JSON 配置文件', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  const roots = getRuntimeConfigurationStorageRoots();
  await loadCurrentRuntimeConfiguration();
  return exportConfigs(roots.userDataPath, result.filePath);
});
ipcMain.handle('configs:import', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON 配置文件', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
  const roots = getRuntimeConfigurationStorageRoots();
  await loadCurrentRuntimeConfiguration();
  const imported = await importConfigs(roots.userDataPath, result.filePaths[0]);
  return {
    success: true,
    sourceFile: result.filePaths[0],
    ...imported,
    runtimeConfiguration: await publishRuntimeConfiguration()
  };
});
ipcMain.handle('archive:buildPreview', async (_event, payload) => {
  const runtimeConfiguration = await loadCurrentRuntimeConfiguration();
  return buildArchivePreview({
    ...payload,
    archiveRoot: runtimeConfiguration.archiveRootDirectory
  });
});
ipcMain.handle('archive:archivePhotos', async (_event, archivePlan) => safeArchiveCall(
  async () => {
    const runtimeConfiguration = await loadCurrentRuntimeConfiguration();
    return archivePhotos({
      ...archivePlan,
      archiveRoot: runtimeConfiguration.archiveRootDirectory,
      ...(archivePlan?.previewPlan
        ? {
            previewPlan: {
              ...archivePlan.previewPlan,
              archiveRoot: runtimeConfiguration.archiveRootDirectory
            }
          }
        : {})
    });
  },
  (error) => createArchiveIpcErrorResult(
    error,
    Array.isArray(archivePlan?.previewPlan?.items) ? archivePlan.previewPlan.items.length : 0
  )
));
ipcMain.handle('archive:recoverPendingTransactions', async () => safeArchiveCall(
  async () => {
    const runtimeConfiguration = await loadCurrentRuntimeConfiguration();
    return recoverPendingArchiveTransactions(runtimeConfiguration.archiveRootDirectory);
  },
  createArchiveRecoveryIpcError
));

ipcMain.handle('sortDraft:save', async (_event, draft) => {
  const draftsDir = path.join(getWritableDocumentsPath(), appDataFolderName, 'sort-drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const defaultPath = path.join(draftsDir, `照片分拣草稿_${timestamp}.json`);
  const result = await dialog.showSaveDialog({
    title: '保存分拣草稿',
    defaultPath,
    filters: [{ name: 'JSON 分拣草稿', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  fs.writeFileSync(result.filePath, JSON.stringify(draft, null, 2), 'utf-8');
  return { success: true, filePath: result.filePath };
});

ipcMain.handle('sortDraft:load', async () => {
  const draftsDir = path.join(getWritableDocumentsPath(), appDataFolderName, 'sort-drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const result = await dialog.showOpenDialog({
    title: '加载分拣草稿',
    defaultPath: draftsDir,
    properties: ['openFile'],
    filters: [{ name: 'JSON 分拣草稿', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
  const content = fs.readFileSync(result.filePaths[0], 'utf-8');
  return { success: true, filePath: result.filePaths[0], draft: JSON.parse(content) };
});

ipcMain.handle('sortWorkspaceSnapshot:save', async (_event, workspace) => safeSortWorkspaceSnapshotCall(
  () => saveSortWorkspaceSnapshot(app.getPath('userData'), workspace)
));
ipcMain.handle('sortWorkspaceSnapshot:load', async () => safeSortWorkspaceSnapshotCall(
  () => loadSortWorkspaceSnapshot(app.getPath('userData'))
));

ipcMain.handle('system:openPath', async (_event, targetPath) => {
  if (!targetPath) return { success: false, message: '路径为空' };
  const error = await shell.openPath(targetPath);
  return error ? { success: false, message: error } : { success: true };
});

ipcMain.handle('settings:load', async () => {
  const roots = getRuntimeConfigurationStorageRoots();
  await loadCurrentRuntimeConfiguration();
  return loadSettings(roots.userDataPath);
});
ipcMain.handle('settings:save', async (_event, settings) => {
  const runtimeConfiguration = await saveRuntimeSettings(getRuntimeConfigurationStorageRoots(), settings);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
  }
  return runtimeConfiguration.settings;
});
ipcMain.handle('settings:updateLastPhotoFolder', async (_event, folderPath) => {
  const runtimeConfiguration = await saveRuntimeDirectory(
    getRuntimeConfigurationStorageRoots(),
    'photoSource',
    folderPath
  );
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
  }
  return runtimeConfiguration.settings;
});
ipcMain.handle('settings:updateLastArchiveRoot', async (_event, folderPath) => {
  const runtimeConfiguration = await saveRuntimeDirectory(
    getRuntimeConfigurationStorageRoots(),
    'archiveRoot',
    folderPath
  );
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
  }
  return runtimeConfiguration.settings;
});
ipcMain.handle('settings:setDefaultArchiveRoot', async (_event, folderPath) => {
  const runtimeConfiguration = await saveRuntimeDirectory(
    getRuntimeConfigurationStorageRoots(),
    'archiveRoot',
    folderPath
  );
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('runtimeConfiguration:changed', runtimeConfiguration);
  }
  return runtimeConfiguration.settings;
});
ipcMain.handle('system:validatePathExists', async (_event, targetPath) => validatePathExists(targetPath));

ipcMain.handle('marki:getConfigStatus', async () => getMarkiCredentialStatus(app.getPath('userData'), safeStorage));
ipcMain.handle('marki:saveConfig', async (_event, input) => {
  try {
    return await saveMarkiCredentials(app.getPath('userData'), safeStorage, input);
  } catch (error) {
    return { success: false, error: toSafeMarkiError(error) };
  }
});
ipcMain.handle('marki:clearConfig', async () => {
  try {
    return await clearMarkiCredentials(app.getPath('userData'), safeStorage);
  } catch (error) {
    return { success: false, error: toSafeMarkiError(error) };
  }
});
ipcMain.handle('marki:testConnection', async () => safeMarkiCall((credentials) => testMarkiConnection(credentials)));
ipcMain.handle('marki:listTeams', async () => safeMarkiCall((credentials) => listMarkiTeams(credentials)));
ipcMain.handle('marki:listMembers', async (_event, input) => safeMarkiCall(
  (credentials) => listMarkiMembers(credentials, input)
));
ipcMain.handle('marki:start-photo-query-session', async (_event, input) => safeMarkiCall(
  (credentials) => createMarkiPhotoQuerySession({
    credentials,
    documentsPath: app.getPath('documents'),
    userDataPath: app.getPath('userData'),
    filters: input
  })
));
ipcMain.handle('marki:get-photo-query-session', async (_event, sessionId) => safeMarkiLocalCall(
  () => getMarkiPhotoQuerySession(sessionId)
));
ipcMain.handle('marki:load-next-photo-query-page', async (_event, sessionId) => safeMarkiCall(
  (credentials) => loadNextMarkiPhotoQueryPage(sessionId, { credentials })
));
ipcMain.handle('marki:destroy-photo-query-session', async (_event, sessionId) => safeMarkiLocalCall(
  () => destroyMarkiPhotoQuerySession(sessionId)
));
ipcMain.handle('marki:import-photo-query-selection', async (_event, input) => safeMarkiCall(
  (credentials) => importMarkiPhotoQuerySelection({
    credentials,
    documentsPath: app.getPath('documents'),
    userDataPath: app.getPath('userData'),
    request: input
  })
));
ipcMain.handle('marki:list-ready-import-batches', async () => safeMarkiLocalCall(
  () => listReadyMarkiImportBatches(app.getPath('userData'))
));
ipcMain.handle('marki:scan-workbench-recovery-candidates', async () => safeMarkiLocalCall(
  () => scanMarkiWorkbenchRecoveryCandidates({
    documentsPath: app.getPath('documents'),
    userDataPath: app.getPath('userData')
  })
));
ipcMain.handle('marki:recover-workbench-candidates', async (_event, input) => safeMarkiLocalCall(
  () => recoverMarkiWorkbenchCandidates({
    ...normalizeMarkiWorkbenchRecoveryRequest(input),
    documentsPath: app.getPath('documents'),
    userDataPath: app.getPath('userData')
  })
));
ipcMain.handle('marki:get-import-batch', async (_event, batchId) => safeMarkiLocalCall(
  () => getMarkiImportBatch(app.getPath('userData'), batchId)
));
ipcMain.handle('marki:consume-import-batch', async (_event, batchId) => safeMarkiLocalCall(
  async () => {
    let hasLifecycleRecord = true;
    try {
      await markMarkiImportLifecycleAppending(app.getPath('userData'), batchId);
    } catch (error) {
      if (error?.code !== 'marki_import_record_not_found') throw error;
      hasLifecycleRecord = false;
    }
    const result = await consumeMarkiImportBatch(app.getPath('userData'), batchId);
    if (hasLifecycleRecord) {
      await completeMarkiImportLifecycleBatch(app.getPath('userData'), batchId);
    }
    return result;
  }
));
ipcMain.handle('marki:list-import-records', async () => safeMarkiLocalCall(
  () => listMarkiImportLifecycleRecords(app.getPath('userData'))
));
ipcMain.handle('marki:recover-import-lifecycle', async () => safeMarkiLocalCall(
  () => recoverMarkiImportLifecycle(app.getPath('userData'))
));
ipcMain.handle('marki:undo-import-batch', async (_event, batchId) => safeMarkiLocalCall(
  () => undoMarkiImportLifecycleBatch(app.getPath('userData'), batchId)
));
ipcMain.handle('marki:clear-import-record', async (_event, batchId) => safeMarkiLocalCall(
  () => clearMarkiImportLifecycleRecord(app.getPath('userData'), batchId)
));
ipcMain.handle('marki:cleanup-import-cache', async (_event, batchId) => safeMarkiLocalCall(
  () => cleanupMarkiImportLifecycleCache(
    app.getPath('documents'),
    app.getPath('userData'),
    batchId
  )
));

ipcMain.handle('ledger:open', async (_event, archiveRoot) => {
  const ledgerPath = getLedgerPath(archiveRoot);
  const error = await shell.openPath(ledgerPath);
  return error ? { success: false, message: error, ledgerPath } : { success: true, ledgerPath };
});

ipcMain.handle('ledger:loadRecords', async (_event, archiveRoot) => loadLedgerRecords(archiveRoot));

ipcMain.handle('ledger:deleteRecords', async (_event, archiveRoot, selections, options) => deleteLedgerRecords(archiveRoot, selections, options));

ipcMain.handle('ledger:exportRecords', async (_event, records) => {
  if (!Array.isArray(records) || records.length === 0) {
    return { success: false, message: '当前没有可导出的记录' };
  }
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const result = await dialog.showSaveDialog({
    title: '导出当前筛选结果',
    defaultPath: path.join(app.getPath('documents'), `归档记录查询结果_${timestamp}.xlsx`),
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  return exportLedgerRecords(result.filePath, records);
});

ipcMain.handle('archivePackage:selectTargetRoot', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择资料包保存位置',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('archivePackage:buildPlan', async (_event, records, targetRoot, options) => buildPackagePlan(records, targetRoot, options));

ipcMain.handle('archivePackage:generate', async (event, records, options) => generateArchivePackage(records, {
  ...options,
  onProgress: (progress) => event.sender.send('archivePackage:progress', progress)
}));

ipcMain.handle('serviceBrief:exportImages', async (_event, payload) => {
  const result = await dialog.showOpenDialog({
    title: '选择每日服务简报导出目录',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
  return exportServiceBriefImages(result.filePaths[0], payload);
});

ipcMain.handle('dataMaintenance:getReport', async () => getDataMaintenanceReport({
  documentsPath: getWritableDocumentsPath(),
  projectRoot: path.resolve(__dirname, '..')
}));

ipcMain.handle('trialIssues:load', async () => loadTrialIssues(getWritableDocumentsPath()));
ipcMain.handle('trialIssues:save', async (_event, item) => saveTrialIssue(getWritableDocumentsPath(), item));
ipcMain.handle('trialIssues:delete', async (_event, id) => deleteTrialIssue(getWritableDocumentsPath(), id));
ipcMain.handle('trialIssues:clearHandled', async () => clearHandledTrialIssues(getWritableDocumentsPath()));
ipcMain.handle('trialIssues:export', async (_event, items, format = 'xlsx') => {
  if (!Array.isArray(items) || items.length === 0) return { success: false, message: '当前没有可导出的运行日志或问题反馈记录。' };
  const normalizedFormat = format === 'csv' ? 'csv' : 'xlsx';
  const timestamp = createFileTimestamp(new Date());
  const result = await dialog.showSaveDialog({
    title: '导出运行日志与问题反馈',
    defaultPath: path.join(app.getPath('documents'), `运行日志与问题反馈_${timestamp}.${normalizedFormat}`),
    filters: normalizedFormat === 'csv'
      ? [{ name: 'CSV 文件', extensions: ['csv'] }]
      : [{ name: 'Excel 文件', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  return exportTrialIssues(result.filePath, items, normalizedFormat);
});

ipcMain.handle('dashboard:loadData', async () => loadDashboardData({
  documentsPath: getWritableDocumentsPath(),
  projectRoot: path.resolve(__dirname, '..')
}));

ipcMain.handle('rectification:loadItems', async () => loadRectificationItems(getWritableDocumentsPath()));
ipcMain.handle('rectification:saveItem', async (_event, item) => saveRectificationItem(getWritableDocumentsPath(), item));
ipcMain.handle('rectification:selectPhotos', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择关联照片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  if (result.canceled) return [];
  return result.filePaths.map((filePath) => ({
    filePath,
    fileName: path.basename(filePath),
    sourceType: '手动添加',
    addedAt: new Date().toISOString(),
    fileExists: fs.existsSync(filePath)
  }));
});
ipcMain.handle('rectification:exportItems', async (_event, items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, message: '当前没有可导出的整改事项。' };
  }
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const result = await dialog.showSaveDialog({
    title: '导出整改台账',
    defaultPath: path.join(app.getPath('documents'), `整改闭环台账_${timestamp}.xlsx`),
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  return exportRectificationItems(result.filePath, items);
});

ipcMain.handle('summary:loadData', async (_event, archiveRoot) => loadSummaryData({
  archiveRoot,
  documentsPath: getWritableDocumentsPath(),
  projectRoot: path.resolve(__dirname, '..')
}));

ipcMain.handle('summary:exportWorkbook', async (_event, payload) => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const result = await dialog.showSaveDialog({
    title: '导出资料汇总台账',
    defaultPath: path.join(app.getPath('documents'), `资料汇总台账_${timestamp}.xlsx`),
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  return exportSummaryWorkbook(result.filePath, payload);
});

ipcMain.handle('system:showItemInFolder', async (_event, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) return { success: false, message: '文件不存在' };
  shell.showItemInFolder(targetPath);
  return { success: true };
});

ipcMain.handle('system:copyText', async (_event, text) => {
  clipboard.writeText(String(text || ''));
  return { success: true };
});

ipcMain.handle('app:getPaths', async () => ({
  userData: app.getPath('userData'),
  documents: app.getPath('documents'),
  writableDocuments: getWritableDocumentsPath()
}));

async function safeMarkiCall(callback) {
  try {
    const credentials = await loadMarkiCredentials(app.getPath('userData'), safeStorage);
    return await callback(credentials);
  } catch (error) {
    return {
      success: false,
      connectionStatus: 'error',
      error: toSafeMarkiError(error)
    };
  }
}

async function safeMarkiLocalCall(callback) {
  try {
    return await callback();
  } catch (error) {
    return {
      success: false,
      error: toSafeMarkiError(error)
    };
  }
}

function normalizeMarkiWorkbenchRecoveryRequest(input) {
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).length !== 1
    || !Object.hasOwn(input, 'recoveryTokens')
  ) {
    const error = new Error('恢复请求无效。');
    error.code = 'marki_recovery_input_invalid';
    throw error;
  }
  return {
    recoveryTokens: input.recoveryTokens
  };
}

async function safeSortWorkspaceSnapshotCall(callback) {
  try {
    return await callback();
  } catch {
    return {
      success: false,
      error: {
        code: 'sort_workspace_snapshot_unavailable',
        message: '工作台自动快照暂时不可用，请稍后重试。'
      }
    };
  }
}

function createFileTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
