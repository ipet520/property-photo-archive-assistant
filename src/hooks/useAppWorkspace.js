import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeRuntimeConfiguration } from '../utils/runtimeConfig.js';
import {
  getEnabledProjectOptions,
  resolveActiveProject,
  runProjectWorkspaceTransition,
  validateActiveProject
} from '../utils/activeProjectContext.js';
import { recordRuntimeLog } from '../utils/runtimeLogger.js';

export function useAppWorkspace() {
  const [configs, setConfigs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [appPaths, setAppPaths] = useState(null);
  const [configPaths, setConfigPaths] = useState(null);
  const [archiveRoot, setArchiveRoot] = useState('');
  const [runtimeConfiguration, setRuntimeConfiguration] = useState(null);
  const [activeProject, setActiveProject] = useState(null);
  const [status, setStatus] = useState({ type: 'idle', text: '正在读取基础配置。' });
  const projectWorkspaceControllerRef = useRef(null);

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

  useEffect(() => {
    if (!activeProject || !runtimeConfiguration) return;
    const resolved = resolveActiveProject(activeProject.projectId, runtimeConfiguration);
    if (resolved) {
      if (resolved.projectName !== activeProject.projectName) setActiveProject(resolved);
      return;
    }
    void (async () => {
      const controller = projectWorkspaceControllerRef.current;
      const saveResult = await controller?.flush?.(activeProject);
      if (saveResult && saveResult.success !== true) {
        setStatus({ type: 'error', text: '当前项目已停用，但工作台保存失败，暂未退出项目。' });
        return;
      }
      controller?.clear?.();
      setActiveProject(null);
      setStatus({ type: 'warning', text: '当前项目已删除或停用，请重新选择项目。' });
    })();
  }, [activeProject, runtimeConfiguration]);

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

  const selectActiveProject = useCallback((projectId) => {
    const resolved = resolveActiveProject(projectId, runtimeConfiguration);
    if (!resolved) {
      setStatus({ type: 'error', text: '所选项目不可用，请刷新基础配置后重试。' });
      return { success: false, code: 'active_project_invalid' };
    }
    setActiveProject(resolved);
    setStatus({ type: 'success', text: `当前项目已切换为“${resolved.projectName}”。` });
    return { success: true, activeProject: resolved };
  }, [runtimeConfiguration]);

  const switchActiveProject = useCallback(async (projectId) => {
    const resolved = resolveActiveProject(projectId, runtimeConfiguration);
    if (!resolved) {
      return { success: false, code: 'active_project_invalid', message: '所选项目不可用。' };
    }
    if (!activeProject) return selectActiveProject(projectId);
    if (resolved.projectId === activeProject.projectId) {
      return { success: true, activeProject: resolved, unchanged: true };
    }
    const transition = await runProjectWorkspaceTransition(
      projectWorkspaceControllerRef.current,
      activeProject
    );
    if (transition.success !== true) return transition;
    setActiveProject(resolved);
    setStatus({ type: 'success', text: `已切换到项目“${resolved.projectName}”。` });
    return { success: true, activeProject: resolved };
  }, [activeProject, runtimeConfiguration, selectActiveProject]);

  const clearActiveProject = useCallback(() => {
    projectWorkspaceControllerRef.current?.clear?.();
    setActiveProject(null);
  }, []);

  const registerProjectWorkspaceController = useCallback((controller) => {
    projectWorkspaceControllerRef.current = controller || null;
    return () => {
      if (projectWorkspaceControllerRef.current === controller) {
        projectWorkspaceControllerRef.current = null;
      }
    };
  }, []);

  const projectOptions = getEnabledProjectOptions(runtimeConfiguration || {});
  const activeProjectValidation = validateActiveProject(activeProject, runtimeConfiguration || {});

  return {
    configs,
    settings,
    appPaths,
    configPaths,
    runtimeConfiguration,
    activeProject,
    hasActiveProject: activeProjectValidation.valid,
    activeProjectValidation,
    projectOptions,
    archiveRoot,
    setCurrentArchiveRoot,
    applySavedSettings,
    status,
    handleConfigsSaved,
    selectActiveProject,
    switchActiveProject,
    clearActiveProject,
    validateActiveProject: () => validateActiveProject(activeProject, runtimeConfiguration || {}),
    registerProjectWorkspaceController
  };
}
