const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { scanImages } = require('./services/fileService.cjs');
const { buildArchivePreview, archivePhotos } = require('./services/archiveService.cjs');
const { buildPackagePlan, generateArchivePackage } = require('./services/archivePackageService.cjs');
const { getDataMaintenanceReport } = require('./services/dataMaintenanceService.cjs');
const { exportLedgerRecords, loadLedgerRecords } = require('./services/ledgerQueryService.cjs');
const { exportSummaryWorkbook, loadSummaryData } = require('./services/summaryService.cjs');
const {
  exportRectificationItems,
  loadRectificationItems,
  saveRectificationItem
} = require('./services/rectificationService.cjs');
const {
  loadConfigs,
  loadUserConfigs,
  saveUserConfig,
  saveAllUserConfigs,
  resetConfigsToDefault,
  exportConfigs,
  importConfigs,
  backupConfigs,
  getConfigPaths,
  validateConfig
} = require('./services/configService.cjs');
const { getLedgerPath } = require('./services/excelService.cjs');
const {
  loadSettings,
  saveSettings,
  updateLastPhotoFolder,
  updateLastArchiveRoot,
  setDefaultArchiveRoot,
  validatePathExists
} = require('./services/settingsService.cjs');

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, protocol, shell } = electron;
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const appDataFolderName = '物业工作照片归档助手';
const runtimeDir = resolveRuntimeDir();

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
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: '物业工作照片归档助手',
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
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

function createChineseMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '设置',
      submenu: [
        {
          label: '配置管理中心',
          click: () => {
            const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (targetWindow) {
              targetWindow.webContents.send('app:openConfigManager');
            }
          }
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于物业工作照片归档助手',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: '物业工作照片归档助手',
            detail: `本地照片归档整理工具。\n当前版本：${app.getVersion()}`
          })
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createChineseMenu();

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
ipcMain.handle('configs:load', async () => loadConfigs(getWritableDocumentsPath()));
ipcMain.handle('configs:loadUserConfigs', async () => loadUserConfigs(getWritableDocumentsPath()));
ipcMain.handle('configs:saveUserConfig', async (_event, configName, data) => saveUserConfig(getWritableDocumentsPath(), configName, data));
ipcMain.handle('configs:saveAllUserConfigs', async (_event, configs) => saveAllUserConfigs(getWritableDocumentsPath(), configs));
ipcMain.handle('configs:resetToDefault', async () => resetConfigsToDefault(getWritableDocumentsPath()));
ipcMain.handle('configs:backup', async () => backupConfigs(getWritableDocumentsPath()));
ipcMain.handle('configs:getPaths', async () => getConfigPaths(getWritableDocumentsPath()));
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
  return exportConfigs(getWritableDocumentsPath(), result.filePath);
});
ipcMain.handle('configs:import', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON 配置文件', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
  const imported = await importConfigs(getWritableDocumentsPath(), result.filePaths[0]);
  return { success: true, sourceFile: result.filePaths[0], ...imported };
});
ipcMain.handle('archive:buildPreview', async (_event, payload) => buildArchivePreview(payload));
ipcMain.handle('archive:archivePhotos', async (_event, archivePlan) => archivePhotos(archivePlan));

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

ipcMain.handle('system:openPath', async (_event, targetPath) => {
  if (!targetPath) return { success: false, message: '路径为空' };
  const error = await shell.openPath(targetPath);
  return error ? { success: false, message: error } : { success: true };
});

ipcMain.handle('settings:load', async () => loadSettings(getWritableDocumentsPath()));
ipcMain.handle('settings:save', async (_event, settings) => saveSettings(getWritableDocumentsPath(), settings));
ipcMain.handle('settings:updateLastPhotoFolder', async (_event, folderPath) => updateLastPhotoFolder(getWritableDocumentsPath(), folderPath));
ipcMain.handle('settings:updateLastArchiveRoot', async (_event, folderPath) => updateLastArchiveRoot(getWritableDocumentsPath(), folderPath));
ipcMain.handle('settings:setDefaultArchiveRoot', async (_event, folderPath) => setDefaultArchiveRoot(getWritableDocumentsPath(), folderPath));
ipcMain.handle('system:validatePathExists', async (_event, targetPath) => validatePathExists(targetPath));

ipcMain.handle('ledger:open', async (_event, archiveRoot) => {
  const ledgerPath = getLedgerPath(archiveRoot);
  const error = await shell.openPath(ledgerPath);
  return error ? { success: false, message: error, ledgerPath } : { success: true, ledgerPath };
});

ipcMain.handle('ledger:loadRecords', async (_event, archiveRoot) => loadLedgerRecords(archiveRoot));

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

ipcMain.handle('dataMaintenance:getReport', async () => getDataMaintenanceReport({
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
