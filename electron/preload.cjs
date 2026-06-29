const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archiveAssistant', {
  selectPhotoFolder: () => ipcRenderer.invoke('dialog:selectPhotoFolder'),
  selectArchiveRoot: () => ipcRenderer.invoke('dialog:selectArchiveRoot'),
  scanImages: (folderPath) => ipcRenderer.invoke('photos:scanImages', folderPath),
  loadConfigs: () => ipcRenderer.invoke('configs:load'),
  loadUserConfigs: () => ipcRenderer.invoke('configs:loadUserConfigs'),
  saveUserConfig: (configName, data) => ipcRenderer.invoke('configs:saveUserConfig', configName, data),
  saveAllUserConfigs: (configs) => ipcRenderer.invoke('configs:saveAllUserConfigs', configs),
  resetConfigsToDefault: () => ipcRenderer.invoke('configs:resetToDefault'),
  exportConfigs: () => ipcRenderer.invoke('configs:export'),
  importConfigs: () => ipcRenderer.invoke('configs:import'),
  backupConfigs: () => ipcRenderer.invoke('configs:backup'),
  getConfigPaths: () => ipcRenderer.invoke('configs:getPaths'),
  validateConfig: (configName, data) => ipcRenderer.invoke('configs:validate', configName, data),
  onOpenConfigManager: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:openConfigManager', listener);
    return () => ipcRenderer.removeListener('app:openConfigManager', listener);
  },
  buildArchivePreview: (payload) => ipcRenderer.invoke('archive:buildPreview', payload),
  archivePhotos: (archivePlan) => ipcRenderer.invoke('archive:archivePhotos', archivePlan),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  updateLastPhotoFolder: (folderPath) => ipcRenderer.invoke('settings:updateLastPhotoFolder', folderPath),
  updateLastArchiveRoot: (folderPath) => ipcRenderer.invoke('settings:updateLastArchiveRoot', folderPath),
  setDefaultArchiveRoot: (folderPath) => ipcRenderer.invoke('settings:setDefaultArchiveRoot', folderPath),
  validatePathExists: (targetPath) => ipcRenderer.invoke('system:validatePathExists', targetPath),
  openPath: (targetPath) => ipcRenderer.invoke('system:openPath', targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('system:showItemInFolder', targetPath),
  copyText: (text) => ipcRenderer.invoke('system:copyText', text),
  openLedger: (archiveRoot) => ipcRenderer.invoke('ledger:open', archiveRoot),
  loadLedgerRecords: (archiveRoot) => ipcRenderer.invoke('ledger:loadRecords', archiveRoot),
  deleteLedgerRecords: (archiveRoot, selections, options) => ipcRenderer.invoke('ledger:deleteRecords', archiveRoot, selections, options),
  exportLedgerRecords: (records) => ipcRenderer.invoke('ledger:exportRecords', records),
  selectArchivePackageTargetRoot: () => ipcRenderer.invoke('archivePackage:selectTargetRoot'),
  buildArchivePackagePlan: (records, targetRoot, options) => ipcRenderer.invoke('archivePackage:buildPlan', records, targetRoot, options),
  generateArchivePackage: (records, options) => ipcRenderer.invoke('archivePackage:generate', records, options),
  exportServiceBriefPackage: (payload) => ipcRenderer.invoke('serviceBrief:exportPackage', payload),
  getDataMaintenanceReport: () => ipcRenderer.invoke('dataMaintenance:getReport'),
  loadTrialIssues: () => ipcRenderer.invoke('trialIssues:load'),
  saveTrialIssue: (item) => ipcRenderer.invoke('trialIssues:save', item),
  deleteTrialIssue: (id) => ipcRenderer.invoke('trialIssues:delete', id),
  clearHandledTrialIssues: () => ipcRenderer.invoke('trialIssues:clearHandled'),
  exportTrialIssues: (items, format) => ipcRenderer.invoke('trialIssues:export', items, format),
  loadDashboardData: () => ipcRenderer.invoke('dashboard:loadData'),
  loadRectificationItems: () => ipcRenderer.invoke('rectification:loadItems'),
  saveRectificationItem: (item) => ipcRenderer.invoke('rectification:saveItem', item),
  selectRectificationPhotos: () => ipcRenderer.invoke('rectification:selectPhotos'),
  exportRectificationItems: (items) => ipcRenderer.invoke('rectification:exportItems', items),
  loadSummaryData: (archiveRoot) => ipcRenderer.invoke('summary:loadData', archiveRoot),
  exportSummaryWorkbook: (payload) => ipcRenderer.invoke('summary:exportWorkbook', payload),
  onArchivePackageProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('archivePackage:progress', listener);
    return () => ipcRenderer.removeListener('archivePackage:progress', listener);
  },
  saveSortDraft: (draft) => ipcRenderer.invoke('sortDraft:save', draft),
  loadSortDraft: () => ipcRenderer.invoke('sortDraft:load'),
  getAppPaths: () => ipcRenderer.invoke('app:getPaths')
});
