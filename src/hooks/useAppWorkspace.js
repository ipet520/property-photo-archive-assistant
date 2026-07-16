import { useCallback, useEffect, useState } from 'react';
import { getUsableArchiveRoot, withRuntimeConfigFallback } from '../utils/runtimeConfig.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

export function useAppWorkspace() {
  const [configs, setConfigs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [appPaths, setAppPaths] = useState(null);
  const [configPaths, setConfigPaths] = useState(null);
  const [archiveRoot, setArchiveRoot] = useState('');
  const [status, setStatus] = useState({ type: 'idle', text: '正在读取基础配置。' });

  useEffect(() => {
    Promise.all([
      window.archiveAssistant.loadConfigs(),
      window.archiveAssistant.loadSettings(),
      window.archiveAssistant.getAppPaths(),
      window.archiveAssistant.getConfigPaths()
    ])
      .then(([loadedConfigs, loadedSettings, loadedAppPaths, loadedConfigPaths]) => {
        setConfigs(withRuntimeConfigFallback(loadedConfigs));
        setSettings(loadedSettings);
        setAppPaths(loadedAppPaths);
        setConfigPaths(loadedConfigPaths);
        setArchiveRoot(getUsableArchiveRoot(loadedSettings) || '');
        setStatus({ type: 'success', text: '基础配置已加载。' });
      })
      .catch((error) => {
        recordRuntimeLog({ page: '应用框架', operation: '读取基础配置', errorType: '配置读取失败', summary: error.message, error });
        setStatus({ type: 'error', text: `基础配置读取失败：${error.message}` });
      });
  }, []);

  async function handleConfigsSaved(runtimeConfigs) {
    setConfigs(withRuntimeConfigFallback(runtimeConfigs));
    setStatus({ type: 'success', text: '基础数据已更新。' });
  }

  const setCurrentArchiveRoot = useCallback((nextArchiveRoot, nextSettings = null) => {
    setArchiveRoot(String(nextArchiveRoot || '').trim());
    if (nextSettings) setSettings(nextSettings);
  }, []);

  const applySavedSettings = useCallback((nextSettings) => {
    if (!nextSettings) return;
    setSettings(nextSettings);
    setArchiveRoot(getUsableArchiveRoot(nextSettings) || '');
  }, []);

  return {
    configs,
    settings,
    appPaths,
    configPaths,
    archiveRoot,
    setCurrentArchiveRoot,
    applySavedSettings,
    status,
    handleConfigsSaved
  };
}
