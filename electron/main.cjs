const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { scanImages } = require('./services/fileService.cjs');
const { buildArchivePreview, archivePhotos } = require('./services/archiveService.cjs');
const { loadConfigs } = require('./services/configService.cjs');
const { getLedgerPath } = require('./services/excelService.cjs');
const {
  loadSettings,
  saveSettings,
  updateLastPhotoFolder,
  updateLastArchiveRoot,
  setDefaultArchiveRoot,
  validatePathExists
} = require('./services/settingsService.cjs');

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = electron;
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const runtimeDir = isDev
  ? path.join(__dirname, '..', '.runtime')
  : path.join(app.getPath('documents'), '物业工作照片归档助手', '.runtime');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
fs.mkdirSync(runtimeDir, { recursive: true });
app.commandLine.appendSwitch('user-data-dir', path.join(runtimeDir, 'userData'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(runtimeDir, 'cache'));
app.setPath('userData', path.join(runtimeDir, 'userData'));
app.setPath('sessionData', path.join(runtimeDir, 'sessionData'));
app.setPath('logs', path.join(runtimeDir, 'logs'));
app.setPath('crashDumps', path.join(runtimeDir, 'crashDumps'));

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
            detail: '本地照片归档整理工具。'
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
ipcMain.handle('configs:load', async () => loadConfigs());
ipcMain.handle('archive:buildPreview', async (_event, payload) => buildArchivePreview(payload));
ipcMain.handle('archive:archivePhotos', async (_event, archivePlan) => archivePhotos(archivePlan));

ipcMain.handle('system:openPath', async (_event, targetPath) => {
  if (!targetPath) return { success: false, message: '路径为空' };
  const error = await shell.openPath(targetPath);
  return error ? { success: false, message: error } : { success: true };
});

ipcMain.handle('settings:load', async () => loadSettings(app.getPath('documents')));
ipcMain.handle('settings:save', async (_event, settings) => saveSettings(app.getPath('documents'), settings));
ipcMain.handle('settings:updateLastPhotoFolder', async (_event, folderPath) => updateLastPhotoFolder(app.getPath('documents'), folderPath));
ipcMain.handle('settings:updateLastArchiveRoot', async (_event, folderPath) => updateLastArchiveRoot(app.getPath('documents'), folderPath));
ipcMain.handle('settings:setDefaultArchiveRoot', async (_event, folderPath) => setDefaultArchiveRoot(app.getPath('documents'), folderPath));
ipcMain.handle('system:validatePathExists', async (_event, targetPath) => validatePathExists(targetPath));

ipcMain.handle('ledger:open', async (_event, archiveRoot) => {
  const ledgerPath = getLedgerPath(archiveRoot);
  const error = await shell.openPath(ledgerPath);
  return error ? { success: false, message: error, ledgerPath } : { success: true, ledgerPath };
});

ipcMain.handle('app:getPaths', async () => ({
  userData: app.getPath('userData'),
  documents: app.getPath('documents')
}));
