const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archiveAssistant', {
  selectPhotoFolder: () => ipcRenderer.invoke('dialog:selectPhotoFolder'),
  selectArchiveRoot: () => ipcRenderer.invoke('dialog:selectArchiveRoot'),
  scanImages: (folderPath) => ipcRenderer.invoke('photos:scanImages', folderPath),
  loadConfigs: () => ipcRenderer.invoke('configs:load'),
  buildArchivePreview: (payload) => ipcRenderer.invoke('archive:buildPreview', payload),
  archivePhotos: (archivePlan) => ipcRenderer.invoke('archive:archivePhotos', archivePlan),
  openPath: (targetPath) => ipcRenderer.invoke('system:openPath', targetPath),
  openLedger: (archiveRoot) => ipcRenderer.invoke('ledger:open', archiveRoot),
  getAppPaths: () => ipcRenderer.invoke('app:getPaths')
});
