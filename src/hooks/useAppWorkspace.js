import { useCallback, useEffect, useState } from 'react';
import { normalizeRuntimeConfiguration } from '../utils/runtimeConfig.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

export function useAppWorkspace() {
  const [configs, setConfigs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [appPaths, setAppPaths] = useState(null);
  const [configPaths, setConfigPaths] = useState(null);
  const [archiveRoot, setArchiveRoot] = useState('');
  const [runtimeConfiguration, setRuntimeConfiguration] = useState(null);
  const [status, setStatus] = useState({ type: 'idle', text: '正在读取基础配置。' });

  useEffect(() => {
    let disposed = false;
    const applyRuntimeConfiguration = (value) => {
      if (disposed || !value) return;
      const normalized = normalizeRuntimeConfiguration(value);
      setRuntimeConfiguration(normalized);
      setConfigs(normalized.configs);
      setSettings(normalized.settings);
      setArchiveRoot(normalized.archiveRootDirectory);
    };
    Promise.all([
      window.archiveAssistant.loadRuntimeConfiguration(),
      window.archiveAssistant.getAppPaths(),
      window.archiveAssistant.getConfigPaths()
    ])
      .then(([loadedRuntimeConfiguration, loadedAppPaths, loadedConfigPaths]) => {
        applyRuntimeConfiguration(loadedRuntimeConfiguration);
        setAppPaths(loadedAppPaths);
        setConfigPaths(loadedConfigPaths);
        setStatus({ type: 'success', text: '基础配置已加载。' });
      })
      .catch((error) => {
        recordRuntimeLog({ page: '应用框架', operation: '读取基础配置', errorType: '配置读取失败', summary: error.message, error });
        setStatus({ type: 'error', text: `基础配置读取失败：${error.message}` });
      });
    const unsubscribe = window.archiveAssistant.onRuntimeConfigurationChanged?.((value) => {
      applyRuntimeConfiguration(value);
      setStatus({ type: 'success', text: '运行配置已更新。' });
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  async function handleConfigsSaved(savedResult) {
    const runtime = savedResult?.runtimeConfiguration
      || await window.archiveAssistant.loadRuntimeConfiguration();
    const normalized = normalizeRuntimeConfiguration(runtime);
    setRuntimeConfiguration(normalized);
    setConfigs(normalized.configs);
    setSettings(normalized.settings);
    setArchiveRoot(normalized.archiveRootDirectory);
    setStatus({ type: 'success', text: '基础数据已更新。' });
  }

  const setCurrentArchiveRoot = useCallback((nextArchiveRoot, nextSettings = null) => {
    setArchiveRoot(String(nextArchiveRoot || '').trim());
    if (nextSettings) setSettings(nextSettings);
  }, []);

  const applySavedSettings = useCallback((nextSettings) => {
    if (!nextSettings) return;
    if (nextSettings.revision && nextSettings.configs) {
      const normalized = normalizeRuntimeConfiguration(nextSettings);
      setRuntimeConfiguration(normalized);
      setConfigs(normalized.configs);
      setSettings(normalized.settings);
      setArchiveRoot(normalized.archiveRootDirectory);
      return;
    }
    setSettings(nextSettings);
  }, []);

  return {
    configs,
    settings,
    appPaths,
    configPaths,
    runtimeConfiguration,
    archiveRoot,
    setCurrentArchiveRoot,
    applySavedSettings,
    status,
    handleConfigsSaved
  };
}
