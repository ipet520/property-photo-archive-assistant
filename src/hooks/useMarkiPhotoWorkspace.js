import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createMarkiReadyBatchRefresh,
  createDefaultMarkiImportFilters,
  destroyMarkiPhotoQuerySession,
  getMarkiConfigStatus,
  getMarkiPhotoQuerySession,
  importMarkiPhotoQuerySelection,
  cleanupMarkiImportCache,
  clearMarkiImportRecord,
  listMarkiMembers,
  listMarkiImportRecords,
  listMarkiTeams,
  loadNextMarkiPhotoQueryPage,
  parseMarkiImportBeijingDateTime,
  recoverMarkiWorkbenchCandidates,
  recoverMarkiImportLifecycle,
  scanMarkiWorkbenchRecoveryCandidates,
  startMarkiPhotoQuerySession,
  undoMarkiImportBatch
} from '../utils/markiClient.js';
import {
  MARKI_IMPORT_STATUS_FILTERS,
  buildMarkiTemplateFilterOptions,
  filterMarkiQueryPhotos,
  formatMarkiImportLifecycleStatus,
  isMarkiQueryPhotoSelectable,
  normalizeStoredTemplateFilter,
  pruneMarkiSelectionTokens,
  selectMarkiFilteredTokens,
  summarizeMarkiQueryResults
} from '../utils/markiImportLifecycle.js';
import { classifyPhotoProjectCompatibility } from '../utils/activeProjectContext.js';
import {
  buildMarkiRecoveryCompletionNotice,
  summarizeMarkiRecoveryCandidates
} from '../utils/markiRecoveryDialog.js';
import { runMarkiRecoveryWithWorkspaceSnapshot } from '../utils/markiRecoveryExecution.js';

const SESSION_STORAGE_KEY = 'marki-photo-import-session-v1';
const MAX_MEMBER_PAGES = 100;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export default function useMarkiPhotoWorkspace({
  archiveState,
  onBatchReady,
  getCurrentWorkspace,
  saveWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
  onWorkspaceStatus,
  onWorkspaceSyncBlocked,
  workspaceReady = false,
  workspaceSyncBlocked = false,
  externalBusy = false,
  enabled = true
} = {}) {
  const activeProject = archiveState?.activeProject;
  const initialFilters = useMemo(() => createDefaultMarkiImportFilters(), []);
  const [configured, setConfigured] = useState(null);
  const [teams, setTeams] = useState([]);
  const [members, setMembers] = useState([]);
  const [filters, setFilters] = useState(initialFilters);
  const [session, setSession] = useState(null);
  const [selectedTokens, setSelectedTokens] = useState([]);
  const [readyBatches, setReadyBatches] = useState([]);
  const [importRecords, setImportRecords] = useState([]);
  const [isRefreshingReadyBatches, setIsRefreshingReadyBatches] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState({ type: 'idle', text: '' });
  const [retryLocked, setRetryLocked] = useState(false);
  const [recoveryCandidates, setRecoveryCandidates] = useState([]);
  const [selectedRecoveryTokens, setSelectedRecoveryTokens] = useState([]);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState({ type: 'idle', text: '' });
  const [recoveryRefreshNonce, setRecoveryRefreshNonce] = useState(0);
  const mountedRef = useRef(true);
  const executionGenerationRef = useRef(0);
  const projectStateRef = useRef(null);
  const recoveryContextRef = useRef({});
  const readyBatchRefreshRef = useRef(null);

  if (!readyBatchRefreshRef.current) {
    readyBatchRefreshRef.current = createMarkiReadyBatchRefresh();
  }

  projectStateRef.current = {
    busy: Boolean(busy || externalBusy || workspaceSyncBlocked),
    isRefreshingReadyBatches,
    recoveryBusy,
    workspaceReady: workspaceReady === true,
    workspaceSyncBlocked: workspaceSyncBlocked === true,
    sessionId: session?.sessionId || ''
  };
  recoveryContextRef.current = {
    getCurrentWorkspace,
    saveWorkspaceSnapshot,
    restoreWorkspaceSnapshot,
    onWorkspaceStatus,
    onWorkspaceSyncBlocked
  };

  const updateBusy = useCallback((value) => {
    if (projectStateRef.current) projectStateRef.current.busy = value;
    setBusy(value);
  }, []);

  const updateReadyBatchRefreshing = useCallback((value) => {
    if (projectStateRef.current) {
      projectStateRef.current.isRefreshingReadyBatches = Boolean(value);
    }
    setIsRefreshingReadyBatches(Boolean(value));
  }, []);

  const isCurrentExecution = useCallback(
    (token) => mountedRef.current && token === executionGenerationRef.current,
    []
  );

  const clearProjectState = useCallback(async () => {
    executionGenerationRef.current += 1;
    const sessionId = String(projectStateRef.current?.sessionId || '').trim();
    if (sessionId) await destroyMarkiPhotoQuerySession(sessionId);
    clearStoredSession();
    setSession(null);
    setSelectedTokens([]);
    setRetryLocked(false);
    setFilters(initialFilters);
    setMembers([]);
    setReadyBatches([]);
    setImportRecords([]);
    setNotice({ type: 'idle', text: '' });
    setRecoveryCandidates([]);
    setSelectedRecoveryTokens([]);
    setRecoveryNotice({ type: 'idle', text: '' });
    setRecoveryRefreshNonce(0);
    setRecoveryBusy(false);
    updateBusy('');
    updateReadyBatchRefreshing(false);
    return { success: true };
  }, [initialFilters, updateBusy, updateReadyBatchRefreshing]);

  const controller = useMemo(() => ({
    isBusy: () => Boolean(
      projectStateRef.current?.busy
      || projectStateRef.current?.isRefreshingReadyBatches
      || projectStateRef.current?.recoveryBusy
      || projectStateRef.current?.workspaceSyncBlocked
    ),
    flush: async () => ({ success: true }),
    clear: clearProjectState
  }), [clearProjectState]);

  const loadReadyBatches = useCallback(async ({ announce = false } = {}) => {
    const executionToken = executionGenerationRef.current;
    updateReadyBatchRefreshing(true);
    if (announce) setNotice({ type: 'info', text: '正在刷新待加入照片池的导入批次...' });
    try {
      const result = await readyBatchRefreshRef.current(activeProject);
      if (!isCurrentExecution(executionToken)) return result;
      if (result.success) setReadyBatches(result.items);
      if (announce) setNotice(result.notice);
      return result;
    } finally {
      if (isCurrentExecution(executionToken)) updateReadyBatchRefreshing(false);
    }
  }, [activeProject, isCurrentExecution, updateReadyBatchRefreshing]);

  const loadImportRecords = useCallback(async ({ announce = false } = {}) => {
    const executionToken = executionGenerationRef.current;
    const result = await listMarkiImportRecords(activeProject);
    if (!isCurrentExecution(executionToken)) return result;
    if (result?.success) {
      setImportRecords(Array.isArray(result.items) ? result.items : []);
      if (announce) {
        setNotice({
          type: 'success',
          text: `已刷新 ${Number(result.totalCount) || 0} 条导入记录。`
        });
      }
    } else if (announce) {
      setNotice({ type: 'error', text: result?.error?.message || '马克导入记录读取失败。' });
    }
    return result;
  }, [activeProject, isCurrentExecution]);

  const scanRecoveryCandidates = useCallback(async () => {
    if (projectStateRef.current?.recoveryBusy) return { success: false };
    const executionToken = executionGenerationRef.current;
    const currentWorkspace = recoveryContextRef.current.getCurrentWorkspace?.();
    if (
      projectStateRef.current?.workspaceReady !== true
      || projectStateRef.current?.workspaceSyncBlocked === true
      || !currentWorkspace
      || currentWorkspace.projectId !== activeProject?.projectId
    ) {
      const error = {
        code: 'marki_recovery_workspace_not_ready',
        message: '当前工作台尚未恢复完成，请稍后重试。'
      };
      setRecoveryNotice({ type: 'warning', text: error.message });
      return { success: false, error };
    }
    setRecoveryBusy(true);
    setRecoveryNotice({ type: 'idle', text: '正在核对本机已下载照片...' });
    recoveryContextRef.current.onWorkspaceStatus?.({
      type: 'idle',
      text: '正在核对已下载的马克照片...'
    });
    try {
      const saveSnapshot = recoveryContextRef.current.saveWorkspaceSnapshot;
      const snapshotResult = typeof saveSnapshot === 'function'
        ? await saveSnapshot(currentWorkspace)
        : { success: false };
      if (!isCurrentExecution(executionToken)) return { success: false };
      if (snapshotResult?.success !== true) {
        const notice = {
          type: 'error',
          text: '当前工作台快照保存失败，已停止核对以避免重复照片。'
        };
        setRecoveryNotice(notice);
        recoveryContextRef.current.onWorkspaceStatus?.(notice);
        return { success: false, error: { code: 'marki_recovery_snapshot_save_failed', message: notice.text } };
      }
      const result = await scanMarkiWorkbenchRecoveryCandidates(activeProject);
      if (!isCurrentExecution(executionToken)) return result;
      if (result?.success !== true) {
        const message = result?.error?.message || '已下载 Marki 照片核对失败，请重试。';
        setRecoveryCandidates([]);
        setSelectedRecoveryTokens([]);
        setRecoveryNotice({ type: 'error', text: message });
        recoveryContextRef.current.onWorkspaceStatus?.({ type: 'error', text: message });
        return result;
      }
      const items = Array.isArray(result.items) ? result.items : [];
      const summary = summarizeMarkiRecoveryCandidates(items);
      const recoverableCount = summary.recoverable;
      const repairableCount = summary.workspaceFileRepairable;
      const abnormalCount = summary.missingFile
        + summary.workspaceFileMissing
        + summary.workspaceFileCorrupted
        + summary.workspaceFileUnresolved
        + summary.abnormal;
      const recoveryText = recoverableCount > 0
        ? `发现 ${recoverableCount} 张可恢复照片${repairableCount > 0 ? `，${repairableCount} 张工作池文件可修复` : ''}${abnormalCount > 0 ? `，另有 ${abnormalCount} 项异常` : ''}。`
        : `当前没有可恢复照片${repairableCount > 0 ? `，发现 ${repairableCount} 张工作池文件可修复` : ''}${abnormalCount > 0 ? `，检测到 ${abnormalCount} 项异常` : ''}。`;
      const statusText = recoverableCount > 0
        ? `发现 ${recoverableCount} 张已下载但不在工作台的马克照片${repairableCount > 0 ? `，${repairableCount} 张工作池文件可修复` : ''}${abnormalCount > 0 ? `，另有 ${abnormalCount} 项异常需核对` : ''}。`
        : `没有发现可恢复的马克照片${repairableCount > 0 ? `；发现 ${repairableCount} 张工作池文件可修复` : ''}${abnormalCount > 0 ? `；检测到 ${abnormalCount} 项异常来源资料` : ''}。`;
      setRecoveryCandidates(items);
      setSelectedRecoveryTokens([]);
      setRecoveryNotice({ type: abnormalCount > 0 ? 'warning' : 'success', text: recoveryText });
      recoveryContextRef.current.onWorkspaceStatus?.({
        type: abnormalCount > 0 ? 'warning' : 'success',
        text: statusText
      });
      return result;
    } catch {
      const notice = { type: 'error', text: '已下载 Marki 照片核对失败，请重试。' };
      setRecoveryNotice(notice);
      recoveryContextRef.current.onWorkspaceStatus?.({ type: 'error', text: '已下载马克照片扫描失败，请重试。' });
      return { success: false, error: { code: 'marki_recovery_scan_failed', message: notice.text } };
    } finally {
      if (isCurrentExecution(executionToken)) setRecoveryBusy(false);
    }
  }, [activeProject, isCurrentExecution]);

  const toggleRecoverySelection = useCallback((recoveryToken) => {
    const token = String(recoveryToken || '').trim();
    if (!token || recoveryBusy) return;
    setSelectedRecoveryTokens((current) => (
      current.includes(token)
        ? current.filter((item) => item !== token)
        : [...current, token]
    ));
  }, [recoveryBusy]);

  const recoverCandidates = useCallback(async (recoveryTokens = selectedRecoveryTokens) => {
    const safeRecoveryTokens = Array.from(new Set(
      (Array.isArray(recoveryTokens) ? recoveryTokens : [])
        .map((token) => String(token || '').trim())
        .filter(Boolean)
    ));
    if (recoveryBusy || safeRecoveryTokens.length === 0) return { success: false };
    const currentWorkspace = recoveryContextRef.current.getCurrentWorkspace?.();
    if (
      projectStateRef.current?.workspaceReady !== true
      || projectStateRef.current?.workspaceSyncBlocked === true
      || !currentWorkspace
      || currentWorkspace.projectId !== activeProject?.projectId
    ) {
      const error = {
        code: 'marki_recovery_workspace_not_ready',
        message: '当前工作台尚未恢复完成，请稍后重试。'
      };
      setRecoveryNotice({ type: 'warning', text: error.message });
      recoveryContextRef.current.onWorkspaceStatus?.({ type: 'warning', text: error.message });
      return { success: false, error };
    }
    const executionToken = executionGenerationRef.current;
    if (projectStateRef.current) projectStateRef.current.recoveryBusy = true;
    setRecoveryBusy(true);
    setRecoveryNotice({ type: 'idle', text: '正在恢复选中的 Marki 照片...' });
    recoveryContextRef.current.onWorkspaceStatus?.({ type: 'idle', text: '正在恢复已下载的马克照片...' });
    try {
      const result = await runMarkiRecoveryWithWorkspaceSnapshot({
        workspaceReady: projectStateRef.current?.workspaceReady === true,
        workspaceSyncBlocked: projectStateRef.current?.workspaceSyncBlocked === true,
        currentWorkspace,
        activeProjectId: activeProject?.projectId,
        saveWorkspaceSnapshot: recoveryContextRef.current.saveWorkspaceSnapshot,
        recover: () => recoverMarkiWorkbenchCandidates({
          recoveryTokens: safeRecoveryTokens,
          activeProject
        })
      });
      if (!isCurrentExecution(executionToken)) return result;
      if (result?.success !== true) {
        const errorCode = result?.error?.code;
        const staleCandidate = ['marki_recovery_token_invalid', 'marki_recovery_record_changed'].includes(errorCode);
        const message = staleCandidate
          ? '恢复候选已变化，请刷新恢复列表后重试。'
          : result?.error?.message || '恢复已下载 Marki 照片失败，请重试。';
        if (staleCandidate) setSelectedRecoveryTokens([]);
        const notice = { type: staleCandidate ? 'warning' : 'error', text: message };
        setRecoveryNotice(notice);
        recoveryContextRef.current.onWorkspaceStatus?.(notice);
        return result;
      }
      const recoveredTokens = new Set(safeRecoveryTokens);
      if (result.status === 'nothing_to_recover') {
        setRecoveryCandidates((current) => current.map((item) => (
          recoveredTokens.has(item.recoveryToken)
            ? { ...item, status: 'already_in_workbench' }
            : item
        )));
        setSelectedRecoveryTokens([]);
        const notice = { type: 'success', text: '所选照片已在当前工作台中，未重复恢复。' };
        setRecoveryNotice(notice);
        recoveryContextRef.current.onWorkspaceStatus?.(notice);
        return result;
      }
      const snapshotResult = await window.archiveAssistant?.loadSortWorkspaceSnapshot?.(activeProject);
      const restoredWorkspace = snapshotResult?.snapshot?.workspace;
      if (
        !isCurrentExecution(executionToken)
        || snapshotResult?.success !== true
        || snapshotResult?.found !== true
        || !restoredWorkspace
        || restoredWorkspace.projectId !== activeProject?.projectId
      ) {
        const notice = {
          type: 'warning',
          text: '马克照片已写入自动快照，但界面刷新失败；重新进入工作台即可恢复。'
        };
        setRecoveryNotice(notice);
        recoveryContextRef.current.onWorkspaceStatus?.(notice);
        recoveryContextRef.current.onWorkspaceSyncBlocked?.(notice);
        return result;
      }
      const restoreResult = recoveryContextRef.current.restoreWorkspaceSnapshot?.(restoredWorkspace);
      if (restoreResult?.success === false) {
        const notice = {
          type: 'warning',
          text: '马克照片已写入自动快照，但当前界面未能同步，请重新进入照片分拣工作台。'
        };
        setRecoveryNotice(notice);
        recoveryContextRef.current.onWorkspaceStatus?.(notice);
        recoveryContextRef.current.onWorkspaceSyncBlocked?.(notice);
        return result;
      }
      setRecoveryCandidates((current) => current.map((item) => (
        recoveredTokens.has(item.recoveryToken)
          ? { ...item, status: 'already_in_workbench' }
          : item
      )));
      setSelectedRecoveryTokens([]);
      const completionNotice = buildMarkiRecoveryCompletionNotice(result);
      const notice = {
        type: Number(result.conflictCount) > 0 ? 'warning' : 'success',
        text: completionNotice
      };
      setRecoveryNotice(notice);
      recoveryContextRef.current.onWorkspaceStatus?.(notice);
      return result;
    } catch {
      const notice = { type: 'error', text: '恢复已下载 Marki 照片失败，请重试。' };
      setRecoveryNotice(notice);
      recoveryContextRef.current.onWorkspaceStatus?.({ type: 'error', text: '恢复已下载马克照片失败，请重试。' });
      return { success: false, error: { code: 'marki_recovery_failed', message: notice.text } };
    } finally {
      if (projectStateRef.current) projectStateRef.current.recoveryBusy = false;
      if (isCurrentExecution(executionToken)) setRecoveryBusy(false);
    }
  }, [activeProject, isCurrentExecution, recoveryBusy, selectedRecoveryTokens]);

  const loadAllMembers = useCallback(async (teamId, { manageBusy = true } = {}) => {
    const executionToken = executionGenerationRef.current;
    if (manageBusy) updateBusy('members');
    const allMembers = [];
    const seenMembers = new Set();
    const seenCursors = new Set();
    let next = '';
    let hasMore = true;
    try {
      for (let page = 0; page < MAX_MEMBER_PAGES && hasMore; page += 1) {
        const result = await listMarkiMembers({ teamId, ...(next ? { next } : {}) });
        if (!isCurrentExecution(executionToken)) return { success: false, stale: true };
        if (!result?.success) {
          setNotice({ type: 'error', text: result?.error?.message || '成员列表读取失败。' });
          return result;
        }
        for (const member of result.members || []) {
          const uid = String(member.uid || '');
          if (!uid || seenMembers.has(uid)) continue;
          seenMembers.add(uid);
          allMembers.push(member);
        }
        hasMore = result.hasMore === true;
        const cursor = String(result.next || '');
        if (hasMore && (!cursor || seenCursors.has(cursor))) {
          const error = { success: false, error: { code: 'marki_member_pagination_invalid', message: '成员分页信息异常，请重新选择团队。' } };
          setNotice({ type: 'error', text: error.error.message });
          return error;
        }
        if (cursor) seenCursors.add(cursor);
        next = cursor;
      }
      if (hasMore) {
        const error = { success: false, error: { code: 'marki_member_limit_reached', message: '成员数量超过当前页面读取上限，请缩小查询范围。' } };
        setNotice({ type: 'error', text: error.error.message });
        return error;
      }
      setMembers(allMembers);
      setNotice({ type: 'success', text: `已读取 ${allMembers.length} 名成员。` });
      return { success: true, members: allMembers };
    } finally {
      if (manageBusy && isCurrentExecution(executionToken)) updateBusy('');
    }
  }, [isCurrentExecution, updateBusy]);

  const abandonCurrentSession = useCallback(async () => {
    const sessionId = session?.sessionId;
    setSession(null);
    setSelectedTokens([]);
    setRetryLocked(false);
    clearStoredSession();
    if (sessionId) await destroyMarkiPhotoQuerySession(sessionId);
  }, [session?.sessionId]);

  useEffect(() => {
    if (!enabled) return undefined;
    mountedRef.current = true;
    void initializeWorkspace();
    return () => {
      mountedRef.current = false;
      executionGenerationRef.current += 1;
    };

    async function initializeWorkspace() {
      const executionToken = executionGenerationRef.current;
      updateBusy('initializing');
      const [statusResult, teamResult] = await Promise.all([
        getMarkiConfigStatus(),
        listMarkiTeams()
      ]);
      if (!isCurrentExecution(executionToken)) return;
      const isConfigured = statusResult?.configured === true;
      setConfigured(isConfigured);
      if (isConfigured && teamResult?.success) {
        setTeams(Array.isArray(teamResult.teams) ? teamResult.teams : []);
      }
      const recoveryResult = await recoverMarkiImportLifecycle(activeProject);
      if (!isCurrentExecution(executionToken)) return;
      if (recoveryResult?.success === false) {
        setNotice({
          type: 'error',
          text: recoveryResult?.error?.message || '马克导入任务恢复失败，请刷新后重试。'
        });
      }
      await Promise.all([loadReadyBatches(), loadImportRecords()]);
      if (!isCurrentExecution(executionToken)) return;
      const stored = readStoredSession();
      if (stored?.activeProjectId && stored.activeProjectId !== activeProject?.projectId) {
        if (stored.sessionId) await destroyMarkiPhotoQuerySession(stored.sessionId);
        if (!isCurrentExecution(executionToken)) return;
        clearStoredSession();
      }
      if (isConfigured && stored?.sessionId) {
        const restored = await getMarkiPhotoQuerySession(stored.sessionId);
        if (!isCurrentExecution(executionToken)) return;
        if (restored?.success) {
          const restoredFilters = normalizeStoredFilters(stored.filters, initialFilters);
          setSession(restored);
          setFilters(restoredFilters);
          const availableTokens = new Set((restored.photos || []).map((photo) => photo.selectionToken));
          setSelectedTokens((stored.selectedTokens || []).filter((token) => availableTokens.has(token)));
          setRetryLocked(stored.retryLocked === true);
          if (restoredFilters.teamId) await loadAllMembers(restoredFilters.teamId);
          if (!isCurrentExecution(executionToken)) return;
          setNotice({ type: 'success', text: `已恢复查询会话，共 ${(restored.photos || []).length} 张照片。` });
        } else {
          clearStoredSession();
        }
      }
      if (isCurrentExecution(executionToken)) updateBusy('');
    }
  }, [activeProject, enabled, initialFilters, isCurrentExecution, loadAllMembers, loadImportRecords, loadReadyBatches, updateBusy]);

  useEffect(() => {
    if (!session?.sessionId) return;
    writeStoredSession({
      sessionId: session.sessionId,
      filters,
      selectedTokens,
      retryLocked,
      activeProjectId: activeProject?.projectId || ''
    });
  }, [activeProject?.projectId, filters, retryLocked, selectedTokens, session]);

  async function changeFilter(key, value) {
    if (['templateFilter', 'importStatusFilter'].includes(key)) {
      setSelectedTokens([]);
      setRetryLocked(false);
      setFilters((current) => ({ ...current, [key]: value }));
      return;
    }
    const executionToken = executionGenerationRef.current;
    updateBusy('filter');
    await abandonCurrentSession();
    if (!isCurrentExecution(executionToken)) return;
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === 'teamId' ? { uid: '' } : {})
    }));
    if (key === 'teamId') {
      setMembers([]);
      if (value) await loadAllMembers(value);
      if (!isCurrentExecution(executionToken)) return;
    }
    updateBusy('');
  }

  async function startQuery() {
    const validation = validateFilters(filters);
    if (validation) {
      setNotice({ type: 'error', text: validation });
      return;
    }
    const executionToken = executionGenerationRef.current;
    updateBusy('query');
    await abandonCurrentSession();
    if (!isCurrentExecution(executionToken)) return;
    const result = await startMarkiPhotoQuerySession(buildQueryInput(filters));
    if (!isCurrentExecution(executionToken)) return;
    updateBusy('');
    if (!result?.success) {
      setNotice({ type: 'error', text: result?.error?.message || '马克照片查询失败。' });
      return;
    }
    setSession(result);
    setNotice({ type: 'success', text: `已读取 ${(result.photos || []).length} 张照片。` });
  }

  async function loadNextPage() {
    if (!session?.sessionId || !session.pagination?.hasMore) return;
    const executionToken = executionGenerationRef.current;
    updateBusy('next');
    const result = await loadNextMarkiPhotoQueryPage(session.sessionId);
    if (!isCurrentExecution(executionToken)) return;
    updateBusy('');
    if (!result?.success) {
      setNotice({ type: 'error', text: result?.error?.message || '下一页读取失败。' });
      return;
    }
    setSession(result);
    setNotice({ type: 'success', text: `当前已加载 ${(result.photos || []).length} 张照片。` });
  }

  function toggleSelection(selectionToken) {
    if (retryLocked) return;
    const photo = projectAwareQueryResults.find((item) => item.selectionToken === selectionToken);
    if (!photo || !isMarkiQueryPhotoSelectable(photo)) return;
    setSelectedTokens((current) => (
      current.includes(selectionToken)
        ? current.filter((token) => token !== selectionToken)
        : [...current, selectionToken]
    ));
  }

  function selectAllLoaded() {
    if (retryLocked) return;
    const selectable = selectMarkiFilteredTokens(filteredQueryResults);
    setSelectedTokens((current) => Array.from(new Set([...current, ...selectable])));
  }

  async function importSelection() {
    if (!session?.sessionId || selectedTokens.length === 0) return;
    const executionToken = executionGenerationRef.current;
    updateBusy('import');
    const result = await importMarkiPhotoQuerySelection({
      sessionId: session.sessionId,
      selectionTokens: selectedTokens,
      templateFilter: filters.templateFilter,
      importStatusFilter: filters.importStatusFilter,
      activeProjectId: activeProject?.projectId,
      activeProjectName: activeProject?.projectName
    });
    if (!isCurrentExecution(executionToken)) return;
    updateBusy('');
    if (result?.status === 'ready' && result.batchId) {
      setRetryLocked(false);
      const appendResult = typeof onBatchReady === 'function'
        ? await onBatchReady(result.batchId)
        : { success: false, error: { message: '工作台批次追加入口不可用。' } };
      if (!isCurrentExecution(executionToken)) return;
      await Promise.all([loadReadyBatches(), loadImportRecords()]);
      if (appendResult?.consumeFailed) {
        setNotice({ type: 'warning', text: '照片已加入当前照片池，但批次消费状态未更新；刷新后可按 sourceKey 安全重试。' });
        return;
      }
      if (appendResult?.success !== true) {
        setNotice({ type: 'error', text: appendResult?.error?.message || '批次已准备好，但尚未加入当前照片池，可重试。' });
        return;
      }
      setNotice({
        type: appendResult.addedCount === 0 && appendResult.duplicateCount > 0 ? 'info' : 'success',
        text: `已加入当前照片池：新增 ${appendResult.addedCount || 0} 张，跳过重复 ${appendResult.duplicateCount || 0} 张，失败 ${appendResult.failureCount || 0} 张。`
      });
      return;
    }
    if (result?.status === 'nothing_to_import') {
      setRetryLocked(false);
      setNotice({ type: 'success', text: '所选照片均已处理，无需重复导入。' });
      return;
    }
    if (['download_failed', 'metadata_failed', 'batch_persist_failed'].includes(result?.status)) {
      setRetryLocked(true);
      const failureSummary = buildSafeFailureSummary(result?.failures);
      setNotice({
        type: 'error',
        text: `${formatImportFailureStatus(result.status)}${failureSummary} 可使用当前照片集合重试。`
      });
      await loadReadyBatches();
      if (!isCurrentExecution(executionToken)) return;
      await loadImportRecords();
      return;
    }
    setNotice({ type: 'error', text: result?.error?.message || '马克照片导入失败，请重试。' });
  }

  async function enterReadyBatch(batchId) {
    if (!batchId || busy) return;
    updateBusy('append');
    const result = typeof onBatchReady === 'function'
      ? await onBatchReady(batchId)
      : { success: false, error: { message: '工作台批次追加入口不可用。' } };
    updateBusy('');
    await Promise.all([loadReadyBatches(), loadImportRecords()]);
    if (result?.consumeFailed) {
      setNotice({ type: 'warning', text: '照片已加入当前照片池，但批次消费状态未更新；刷新后可按 sourceKey 安全重试。' });
    } else if (result?.success === true) {
      setNotice({
        type: result.addedCount === 0 && result.duplicateCount > 0 ? 'info' : 'success',
        text: `已加入当前照片池：新增 ${result.addedCount || 0} 张，跳过重复 ${result.duplicateCount || 0} 张，失败 ${result.failureCount || 0} 张。`
      });
    } else {
      setNotice({ type: 'error', text: result?.error?.message || '导入批次加入当前照片池失败，可重试。' });
    }
  }

  async function runRecordAction(action, batchId, confirmMessage = '') {
    if (isBusy) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    const executionToken = executionGenerationRef.current;
    updateBusy('record');
    try {
      if (action === undoMarkiImportBatch && typeof saveWorkspaceSnapshot === 'function') {
        const preUndoSnapshot = await saveWorkspaceSnapshot(getCurrentWorkspace?.());
        if (!isCurrentExecution(executionToken)) return;
        if (preUndoSnapshot?.success !== true) {
          setNotice({ type: 'error', text: '当前工作台保存失败，已取消撤销以避免状态覆盖。' });
          return;
        }
      }
      const result = await action(batchId, activeProject);
      if (!isCurrentExecution(executionToken)) return;
      if (!result?.success) {
        setNotice({ type: 'error', text: result?.error?.message || '导入记录操作失败。' });
        return;
      }
      if (action === undoMarkiImportBatch) {
        const snapshotResult = await window.archiveAssistant?.loadSortWorkspaceSnapshot?.(activeProject);
        const workspace = snapshotResult?.snapshot?.workspace;
        if (
          !isCurrentExecution(executionToken)
          || snapshotResult?.success !== true
          || snapshotResult?.found !== true
          || !workspace
          || workspace.projectId !== activeProject?.projectId
        ) {
          const safeNotice = {
            type: 'error',
            text: '撤销已保存，但当前界面未能同步，请重新进入照片分拣工作台。'
          };
          setNotice(safeNotice);
          recoveryContextRef.current.onWorkspaceStatus?.(safeNotice);
          recoveryContextRef.current.onWorkspaceSyncBlocked?.(safeNotice);
          return;
        }
        const restoreResult = recoveryContextRef.current.restoreWorkspaceSnapshot?.(workspace);
        if (restoreResult?.success === false) {
          const safeNotice = {
            type: 'error',
            text: '撤销已保存，但当前界面未能同步，请重新进入照片分拣工作台。'
          };
          setNotice(safeNotice);
          recoveryContextRef.current.onWorkspaceStatus?.(safeNotice);
          recoveryContextRef.current.onWorkspaceSyncBlocked?.(safeNotice);
          return;
        }
        setRecoveryCandidates([]);
        setSelectedRecoveryTokens([]);
        setRecoveryNotice({ type: 'idle', text: '撤销已完成，恢复区待刷新。' });
        setRecoveryRefreshNonce((value) => value + 1);
      }
      await Promise.all([loadImportRecords(), loadReadyBatches()]);
      if (!isCurrentExecution(executionToken)) return;
      if (session?.sessionId) {
        const refreshed = await getMarkiPhotoQuerySession(session.sessionId);
        if (!isCurrentExecution(executionToken)) return;
        if (refreshed?.success) setSession(refreshed);
      }
      setSelectedTokens([]);
      setNotice({
        type: 'success',
        text: action === undoMarkiImportBatch
          ? `撤销完成：已从工作池移除 ${Number(result.removedCount) || 0} 张照片。`
          : action === cleanupMarkiImportCache
            ? `缓存清理完成：删除 ${Number(result.removedCount) || 0} 个安全缓存，跳过 ${Number(result.skippedCount) || 0} 个。`
            : '导入记录已清除；已进入工作池的照片保持不变。'
      });
    } catch {
      if (isCurrentExecution(executionToken)) {
        setNotice({ type: 'error', text: '导入记录操作失败，请重试。' });
      }
    } finally {
      if (isCurrentExecution(executionToken)) updateBusy('');
    }
  }

  async function retryImportRecord(record) {
    if (isBusy) return;
    const executionToken = executionGenerationRef.current;
    updateBusy('retry');
    try {
      const nextFilters = buildRecordRetryFilters(record, initialFilters);
      await abandonCurrentSession();
      if (!isCurrentExecution(executionToken)) return;
      setFilters(nextFilters);
      setMembers([]);
      if (nextFilters.teamId) {
        const membersResult = await loadAllMembers(nextFilters.teamId, { manageBusy: false });
        if (!isCurrentExecution(executionToken)) return;
        if (membersResult?.success !== true) return;
      }
      const result = await startMarkiPhotoQuerySession(buildQueryInput(nextFilters));
      if (!isCurrentExecution(executionToken)) {
        if (result?.sessionId) await destroyMarkiPhotoQuerySession(result.sessionId);
        return;
      }
      if (!result?.success) {
        setNotice({ type: 'error', text: result?.error?.message || '失败照片重新查询失败。' });
        return;
      }
      setSession(result);
      setNotice({ type: 'info', text: '已按原查询条件重新读取照片，并筛选为可重试项。请选择后点击“导入到照片池”。' });
    } catch {
      if (isCurrentExecution(executionToken)) {
        setNotice({ type: 'error', text: '失败照片重新查询失败，请重试。' });
      }
    } finally {
      if (isCurrentExecution(executionToken)) updateBusy('');
    }
  }

  const configuredReady = configured === true;
  const isBusy = Boolean(busy || externalBusy || workspaceSyncBlocked);
  const rawQueryResults = session?.photos || [];
  const projectAwareQueryResults = useMemo(() => rawQueryResults.map((photo) => ({
    ...photo,
    projectCompatibility: classifyPhotoProjectCompatibility({
      activeProject,
      projectOptions: archiveState?.projectOptions || [],
      sourceProjectText: photo.projectText,
      assignedProjectId: photo.assignedProjectId,
      assignedProjectName: photo.assignedProjectName
    })
  })), [activeProject, archiveState?.projectOptions, rawQueryResults]);

  useEffect(() => {
    setSelectedTokens((current) => {
      const next = pruneMarkiSelectionTokens(current, projectAwareQueryResults);
      return next.length === current.length ? current : next;
    });
  }, [projectAwareQueryResults]);

  const templateOptions = useMemo(() => buildMarkiTemplateFilterOptions(projectAwareQueryResults), [projectAwareQueryResults]);
  const filteredQueryResults = useMemo(() => filterMarkiQueryPhotos(projectAwareQueryResults, filters), [filters, projectAwareQueryResults]);
  const querySummary = useMemo(() => summarizeMarkiQueryResults(projectAwareQueryResults, filteredQueryResults, selectedTokens), [filteredQueryResults, projectAwareQueryResults, selectedTokens]);
  const teamNameById = useMemo(() => new Map(teams.map((team) => [String(team.teamId || ''), team.teamName || ''])), [teams]);
  const memberNameById = useMemo(() => new Map(members.map((member) => [String(member.uid || ''), member.nickname || ''])), [members]);

  return {
    activeProject,
    configured,
    configuredReady,
    teams,
    members,
    filters,
    session,
    selectedTokens,
    readyBatches,
    importRecords,
    notice,
    busy,
    isBusy,
    isRefreshingReadyBatches,
    retryLocked,
    projectAwareQueryResults,
    filteredQueryResults,
    templateOptions,
    querySummary,
    teamNameById,
    memberNameById,
    MARKI_IMPORT_STATUS_FILTERS,
    formatMarkiImportLifecycleStatus,
    controller,
    clearProjectState,
    loadReadyBatches,
    loadImportRecords,
    loadAllMembers,
    changeFilter,
    startQuery,
    loadNextPage,
    toggleSelection,
    selectAllLoaded,
    clearSelection: () => setSelectedTokens([]),
    importSelection,
    enterReadyBatch,
    runRecordAction,
    retryImportRecord,
    undoMarkiImportBatch,
    cleanupMarkiImportCache,
    clearMarkiImportRecord,
    recovery: {
      items: recoveryCandidates,
      selectedTokens: selectedRecoveryTokens,
      busy: recoveryBusy,
      notice: recoveryNotice,
      refreshNonce: recoveryRefreshNonce,
      onToggle: toggleRecoverySelection,
      onRefresh: scanRecoveryCandidates,
      onRecoverSelected: (tokens = selectedRecoveryTokens) => recoverCandidates(tokens.filter((token) => (
        recoveryCandidates.some((item) => item.recoveryToken === token && item.status === 'recoverable')
      ))),
      onRecoverAll: recoverCandidates,
      onRepairSelected: (tokens = selectedRecoveryTokens) => recoverCandidates(tokens.filter((token) => (
        recoveryCandidates.some((item) => item.recoveryToken === token && item.status === 'workspace_file_repairable')
      ))),
      onRepairAll: recoverCandidates
    }
  };
}

function buildQueryInput(filters) {
  return {
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...(filters.uid ? { uid: filters.uid } : {}),
    start: `${filters.start.replace('T', ' ')}:00`,
    end: `${filters.end.replace('T', ' ')}:00`
  };
}

function validateFilters(filters) {
  if (!filters.start || !filters.end) return '请选择完整的开始和结束时间。';
  if (filters.uid && !filters.teamId) return '成员筛选必须先选择具体团队。';
  const start = parseMarkiImportBeijingDateTime(filters.start);
  const end = parseMarkiImportBeijingDateTime(filters.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '查询时间格式无效。';
  if (start > end) return '开始时间不能晚于结束时间。';
  if (end - start > MAX_RANGE_MS) return '单次查询时间范围不能超过 31 天。';
  return '';
}

function normalizeStoredFilters(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = {
    teamId: String(value.teamId || ''),
    uid: String(value.uid || ''),
    templateFilter: normalizeStoredTemplateFilter(value.templateFilter ?? value.watermarkFilter ?? fallback.templateFilter),
    importStatusFilter: String(value.importStatusFilter || fallback.importStatusFilter),
    start: String(value.start || ''),
    end: String(value.end || '')
  };
  return validateFilters(candidate) ? fallback : candidate;
}

function buildRecordRetryFilters(record, fallback) {
  const querySummary = record?.querySummary;
  const importStatusFilter = Number(record?.failedCount) > 0 ? 'failed_retryable' : 'removed_reimportable';
  return {
    ...normalizeStoredFilters({
      teamId: querySummary?.teamId,
      uid: querySummary?.uid,
      templateFilter: normalizeStoredTemplateFilter(querySummary?.templateFilter ?? querySummary?.watermarkFilter ?? fallback.templateFilter),
      importStatusFilter,
      start: normalizeStoredDateTime(querySummary?.start),
      end: normalizeStoredDateTime(querySummary?.end)
    }, fallback),
    importStatusFilter
  };
}

function normalizeStoredDateTime(value) {
  return String(value || '').trim().replace(' ', 'T').slice(0, 16);
}

function readStoredSession() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      sessionId: String(parsed.sessionId || ''),
      filters: parsed.filters,
      selectedTokens: Array.isArray(parsed.selectedTokens) ? parsed.selectedTokens.map(String) : [],
      retryLocked: parsed.retryLocked === true,
      activeProjectId: String(parsed.activeProjectId || '')
    };
  } catch {
    clearStoredSession();
    return null;
  }
}

function writeStoredSession(value) {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
}

function clearStoredSession() {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function formatImportFailureStatus(status) {
  return {
    download_failed: '部分照片下载失败。',
    metadata_failed: '部分来源明细保存失败。',
    batch_persist_failed: '导入批次状态保存失败。'
  }[status] || '马克照片导入失败。';
}

function buildSafeFailureSummary(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  const text = failures.slice(0, 3)
    .map((failure) => `${String(failure?.displayId || '未知')} 号：${String(failure?.message || '处理失败。')}`)
    .join('；');
  return text ? ` ${text}` : '';
}
