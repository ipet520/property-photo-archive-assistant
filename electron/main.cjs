const electron = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { scanImages } = require('./services/fileService.cjs');
const { buildArchivePreview, archivePhotos } = require('./services/archiveService.cjs');
const { loadConfigs } = require('./services/configService.cjs');
const { getLedgerPath } = require('./services/excelService.cjs');

const { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } = electron;
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const runtimeDir = isDev
  ? path.join(__dirname, '..', '.runtime')
  : path.join(app.getPath('documents'), '物业工作照片归档助手', '.runtime');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('user-data-dir', path.join(runtimeDir, 'userData'));
app.setPath('userData', path.join(runtimeDir, 'userData'));
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

app.whenReady().then(() => {
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

ipcMain.handle('ledger:open', async (_event, archiveRoot) => {
  const ledgerPath = getLedgerPath(archiveRoot);
  const error = await shell.openPath(ledgerPath);
  return error ? { success: false, message: error, ledgerPath } : { success: true, ledgerPath };
});

ipcMain.handle('app:getPaths', async () => ({
  userData: app.getPath('userData'),
  documents: app.getPath('documents')
}));
