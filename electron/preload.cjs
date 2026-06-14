const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archiveAssistant', {
  selectPhotoFolder: () => ipcRenderer.invoke('dialog:selectPhotoFolder'),
  selectArchiveRoot: () => ipcRenderer.invoke('dialog:selectArchiveRoot'),
  scanImages: (folderPath) => ipcRenderer.invoke('photos:scanImages', folderPath),
  loadConfigs: () => ipcRenderer.invoke('configs:load'),
  buildArchivePreview: (payload) => ipcRenderer.invoke('archive:buildPreview', payload),
  archivePhotos: (archivePlan) => ipcRenderer.invoke('archive:archivePhotos', archivePlan),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  updateLastPhotoFolder: (folderPath) => ipcRenderer.invoke('settings:updateLastPhotoFolder', folderPath),
  updateLastArchiveRoot: (folderPath) => ipcRenderer.invoke('settings:updateLastArchiveRoot', folderPath),
  setDefaultArchiveRoot: (folderPath) => ipcRenderer.invoke('settings:setDefaultArchiveRoot', folderPath),
  validatePathExists: (targetPath) => ipcRenderer.invoke('system:validatePathExists', targetPath),
  openPath: (targetPath) => ipcRenderer.invoke('system:openPath', targetPath),
  openLedger: (archiveRoot) => ipcRenderer.invoke('ledger:open', archiveRoot),
  getAppPaths: () => ipcRenderer.invoke('app:getPaths')
});
