import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAGE_KEYS } from '../constants/app.js';
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
  listReadyMarkiImportBatches,
  loadNextMarkiPhotoQueryPage,
  parseMarkiImportBeijingDateTime,
  recoverMarkiImportLifecycle,
  startMarkiPhotoQuerySession,
  undoMarkiImportBatch
} from '../utils/markiClient.js';
import {
  MARKI_IMPORT_STATUS_FILTERS,
  buildMarkiWatermarkFilterOptions,
  filterMarkiQueryPhotos,
  formatMarkiImportLifecycleStatus,
  isMarkiQueryPhotoSelectable,
  selectMarkiFilteredTokens,
  summarizeMarkiQueryResults
} from '../utils/markiImportLifecycle.js';

const SESSION_STORAGE_KEY = 'marki-photo-import-session-v1';
const MAX_MEMBER_PAGES = 100;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export default function MarkiPhotoImportPage({ onNavigate }) {
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
  const mountedRef = useRef(true);
  const readyBatchRefreshRef = useRef(null);
  if (!readyBatchRefreshRef.current) {
    readyBatchRefreshRef.current = createMarkiReadyBatchRefresh();
  }

  const loadReadyBatches = useCallback(async ({ announce = false } = {}) => {
    setIsRefreshingReadyBatches(true);
    if (announce) {
      setNotice({ type: 'info', text: '正在刷新待处理批次...' });
    }
    try {
      const result = await readyBatchRefreshRef.current();
      if (!mountedRef.current) return;
      if (result.success) {
        setReadyBatches(result.items);
      }
      if (announce) {
        setNotice(result.notice);
      }
    } finally {
      if (mountedRef.current) {
        setIsRefreshingReadyBatches(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void initializePage();
    return () => {
      mountedRef.current = false;
    };

    async function initializePage() {
      setBusy('initializing');
      const [statusResult, teamResult] = await Promise.all([
        getMarkiConfigStatus(),
        listMarkiTeams()
      ]);
      if (!mountedRef.current) return;
      const isConfigured = statusResult?.configured === true;
      setConfigured(isConfigured);
      if (isConfigured && teamResult?.success) {
        setTeams(Array.isArray(teamResult.teams) ? teamResult.teams : []);
      }
      const recoveryResult = await recoverMarkiImportLifecycle();
      if (recoveryResult?.success === false) {
        setNotice({
          type: 'error',
          text: recoveryResult?.error?.message || '马克导入任务恢复失败，请刷新后重试。'
        });
      }
      await Promise.all([loadReadyBatches(), loadImportRecords()]);
      const stored = readStoredSession();
      if (isConfigured && stored?.sessionId) {
        const restored = await getMarkiPhotoQuerySession(stored.sessionId);
        if (!mountedRef.current) return;
        if (restored?.success) {
          const restoredFilters = normalizeStoredFilters(stored.filters, initialFilters);
          setSession(restored);
          setFilters(restoredFilters);
          const availableTokens = new Set(restored.photos.map((photo) => photo.selectionToken));
          setSelectedTokens(
            (stored.selectedTokens || []).filter((token) => availableTokens.has(token))
          );
          setRetryLocked(stored.retryLocked === true);
          if (restoredFilters.teamId) await loadAllMembers(restoredFilters.teamId);
          setNotice({ type: 'success', text: `已恢复查询会话，共 ${restored.photos.length} 张照片。` });
        } else {
          clearStoredSession();
        }
      }
      setBusy('');
    }
  }, [initialFilters, loadReadyBatches]);

  useEffect(() => {
    if (!session?.sessionId) return;
    writeStoredSession({
      sessionId: session.sessionId,
      filters,
      selectedTokens,
      retryLocked
    });
  }, [filters, retryLocked, selectedTokens, session]);

  async function changeFilter(key, value) {
    if (['watermarkFilter', 'importStatusFilter'].includes(key)) {
      setSelectedTokens([]);
      setRetryLocked(false);
      setFilters((current) => ({ ...current, [key]: value }));
      return;
    }
    await abandonCurrentSession();
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === 'teamId' ? { uid: '' } : {})
    }));
    if (key === 'teamId') {
      setMembers([]);
      if (value) await loadAllMembers(value);
    }
  }

  async function abandonCurrentSession() {
    const sessionId = session?.sessionId;
    setSession(null);
    setSelectedTokens([]);
    setRetryLocked(false);
    clearStoredSession();
    if (sessionId) await destroyMarkiPhotoQuerySession(sessionId);
  }

  async function loadAllMembers(teamId) {
    setBusy('members');
    const allMembers = [];
    const seenMembers = new Set();
    const seenCursors = new Set();
    let next = '';
    let hasMore = true;
    for (let page = 0; page < MAX_MEMBER_PAGES && hasMore; page += 1) {
      const result = await listMarkiMembers({ teamId, ...(next ? { next } : {}) });
      if (!result?.success) {
        setBusy('');
        setNotice({ type: 'error', text: result?.error?.message || '成员列表读取失败。' });
        return;
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
        setBusy('');
        setNotice({ type: 'error', text: '成员分页信息异常，请重新选择团队。' });
        return;
      }
      if (cursor) seenCursors.add(cursor);
      next = cursor;
    }
    if (hasMore) {
      setNotice({ type: 'error', text: '成员数量超过当前页面读取上限，请缩小查询范围。' });
    } else {
      setMembers(allMembers);
      setNotice({ type: 'success', text: `已读取 ${allMembers.length} 名成员。` });
    }
    setBusy('');
  }

  async function startQuery() {
    const validation = validateFilters(filters);
    if (validation) {
      setNotice({ type: 'error', text: validation });
      return;
    }
    await abandonCurrentSession();
    setBusy('query');
    const result = await startMarkiPhotoQuerySession(buildQueryInput(filters));
    setBusy('');
    if (!result?.success) {
      setNotice({ type: 'error', text: result?.error?.message || '马克照片查询失败。' });
      return;
    }
    setSession(result);
    setNotice({ type: 'success', text: `已读取 ${result.photos.length} 张照片。` });
  }

  async function loadNextPage() {
    if (!session?.sessionId || !session.pagination?.hasMore) return;
    setBusy('next');
    const result = await loadNextMarkiPhotoQueryPage(session.sessionId);
    setBusy('');
    if (!result?.success) {
      setNotice({ type: 'error', text: result?.error?.message || '下一页读取失败。' });
      return;
    }
    setSession(result);
    setNotice({ type: 'success', text: `当前已加载 ${result.photos.length} 张照片。` });
  }

  function toggleSelection(selectionToken) {
    if (retryLocked) return;
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
    setBusy('import');
    const result = await importMarkiPhotoQuerySelection({
      sessionId: session.sessionId,
      selectionTokens: selectedTokens,
      watermarkFilter: filters.watermarkFilter,
      importStatusFilter: filters.importStatusFilter
    });
    setBusy('');
    if (result?.status === 'ready' && result.batchId) {
      setRetryLocked(false);
      await Promise.all([loadReadyBatches(), loadImportRecords()]);
      onNavigate({
        page: PAGE_KEYS.sortWorkspace,
        action: 'appendMarkiImportBatch',
        payload: { batchId: result.batchId }
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
      await loadImportRecords();
      return;
    }
    setNotice({ type: 'error', text: result?.error?.message || '马克照片导入失败，请重试。' });
  }

  function enterReadyBatch(batchId) {
    onNavigate({
      page: PAGE_KEYS.sortWorkspace,
      action: 'appendMarkiImportBatch',
      payload: { batchId }
    });
  }

  async function loadImportRecords({ announce = false } = {}) {
    const result = await listMarkiImportRecords();
    if (!mountedRef.current) return;
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
  }

  async function runRecordAction(action, batchId, confirmMessage = '') {
    if (isBusy) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusy('record');
    const result = await action(batchId);
    setBusy('');
    if (!result?.success) {
      setNotice({ type: 'error', text: result?.error?.message || '导入记录操作失败。' });
      return;
    }
    await Promise.all([loadImportRecords(), loadReadyBatches()]);
    if (session?.sessionId) {
      const refreshed = await getMarkiPhotoQuerySession(session.sessionId);
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
  }

  async function retryImportRecord(record) {
    if (isBusy) return;
    const nextFilters = buildRecordRetryFilters(record, initialFilters);
    await abandonCurrentSession();
    setFilters(nextFilters);
    setMembers([]);
    if (nextFilters.teamId) {
      await loadAllMembers(nextFilters.teamId);
    }
    setBusy('query');
    const result = await startMarkiPhotoQuerySession(buildQueryInput(nextFilters));
    setBusy('');
    if (!result?.success) {
      setNotice({ type: 'error', text: result?.error?.message || '失败照片重新查询失败。' });
      return;
    }
    setSession(result);
    setNotice({
      type: 'info',
      text: '已按原查询条件重新读取照片，并筛选为可重试项。请选择后点击“开始导入”。'
    });
  }

  const configuredReady = configured === true;
  const isBusy = Boolean(busy);
  const rawQueryResults = session?.photos || [];
  const watermarkOptions = useMemo(
    () => buildMarkiWatermarkFilterOptions(rawQueryResults),
    [rawQueryResults]
  );
  const filteredQueryResults = useMemo(
    () => filterMarkiQueryPhotos(rawQueryResults, filters),
    [filters, rawQueryResults]
  );
  const querySummary = useMemo(
    () => summarizeMarkiQueryResults(rawQueryResults, filteredQueryResults, selectedTokens),
    [filteredQueryResults, rawQueryResults, selectedTokens]
  );
  const teamNameById = useMemo(
    () => new Map(teams.map((team) => [String(team.teamId || ''), team.teamName || ''])),
    [teams]
  );
  const memberNameById = useMemo(
    () => new Map(members.map((member) => [String(member.uid || ''), member.nickname || ''])),
    [members]
  );

  return (
    <div className="marki-import-page">
      <header className="marki-import-header">
        <div>
          <p className="eyebrow">马克开放平台</p>
          <h1>马克照片导入</h1>
          <p>查询并选择马克水印照片，下载后追加到现有照片分拣工作台。</p>
        </div>
        <button
          type="button"
          onClick={() => void loadReadyBatches({ announce: true })}
          disabled={isBusy || isRefreshingReadyBatches}
        >
          {isRefreshingReadyBatches ? '刷新中...' : '刷新待处理批次'}
        </button>
      </header>

      {configured === false && (
        <section className="marki-import-config-warning">
          <div>
            <strong>尚未配置马克平台</strong>
            <span>请先保存组织 ID 和组织 KEY，再返回此页查询照片。</span>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => onNavigate({ page: PAGE_KEYS.settings, action: 'settings-marki' })}
          >
            前往马克平台设置
          </button>
        </section>
      )}

      <section className="marki-import-filter-band">
        <div className="marki-import-filter-heading">
          <strong>平台查询条件</strong>
          <span>团队、成员和时间范围会重新创建主进程查询会话。</span>
        </div>
        <label>
          <span>团队</span>
          <select
            value={filters.teamId}
            onChange={(event) => void changeFilter('teamId', event.target.value)}
            disabled={!configuredReady || isBusy}
          >
            <option value="">全部团队</option>
            {teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.teamName || `团队 ${team.teamId}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>成员</span>
          <select
            value={filters.uid}
            onChange={(event) => void changeFilter('uid', event.target.value)}
            disabled={!filters.teamId || isBusy}
          >
            <option value="">全部成员</option>
            {members.map((member) => (
              <option key={member.uid} value={member.uid}>
                {member.nickname || `成员 ${member.uid}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>开始时间</span>
          <input
            type="datetime-local"
            value={filters.start}
            onChange={(event) => void changeFilter('start', event.target.value)}
            disabled={!configuredReady || isBusy}
          />
        </label>
        <label>
          <span>结束时间</span>
          <input
            type="datetime-local"
            value={filters.end}
            onChange={(event) => void changeFilter('end', event.target.value)}
            disabled={!configuredReady || isBusy}
          />
        </label>
        <button type="button" className="primary" onClick={startQuery} disabled={!configuredReady || isBusy}>
          {busy === 'query' ? '正在查询...' : '查询照片'}
        </button>
      </section>

      {notice.text && <div className={`marki-import-notice ${notice.type}`}>{notice.text}</div>}

      <section className="marki-import-filter-band marki-import-result-filter-band">
        <div className="marki-import-filter-heading">
          <strong>已加载结果筛选</strong>
          <span>这里只筛选当前会话内已加载的安全摘要，不改变平台查询条件。</span>
        </div>
        <label>
          <span>水印状态 / 模板</span>
          <select
            value={filters.watermarkFilter}
            onChange={(event) => void changeFilter('watermarkFilter', event.target.value)}
            disabled={!session || isBusy}
          >
            {watermarkOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>导入状态</span>
          <select
            value={filters.importStatusFilter}
            onChange={(event) => void changeFilter('importStatusFilter', event.target.value)}
            disabled={!session || isBusy}
          >
            {MARKI_IMPORT_STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="marki-import-toolbar">
        <div>
          <strong>查询结果</strong>
          <span>
            已加载 {querySummary.loadedCount} 张，当前筛选 {querySummary.filteredCount} 张，
            已选择 {querySummary.selectedCount} 张
          </span>
        </div>
        <div className="marki-import-toolbar-actions">
          <button type="button" onClick={selectAllLoaded} disabled={!querySummary.selectableCount || isBusy || retryLocked}>全选当前筛选结果</button>
          <button type="button" onClick={() => setSelectedTokens([])} disabled={!selectedTokens.length || isBusy || retryLocked}>清空选择</button>
          <button
            type="button"
            onClick={loadNextPage}
            disabled={!session?.pagination?.hasMore || isBusy || retryLocked}
          >
            {busy === 'next' ? '正在加载...' : '加载下一页'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={importSelection}
            disabled={!selectedTokens.length || isBusy}
          >
            {busy === 'import' ? '正在导入...' : (retryLocked ? '重试导入' : '开始导入')}
          </button>
        </div>
      </section>

      <section className="marki-import-results">
        {filteredQueryResults.length > 0 ? (
          <div className="marki-import-table-wrap">
            <table className="marki-import-table">
              <thead>
                <tr>
                  <th>选择</th>
                  <th>编号</th>
                  <th>上传时间</th>
                  <th>团队 / 人员</th>
                  <th>水印</th>
                  <th>项目</th>
                  <th>工作内容</th>
                  <th>地点</th>
                  <th>来源状态</th>
                </tr>
              </thead>
              <tbody>
                {filteredQueryResults.map((photo) => {
                  const disabled = !isMarkiQueryPhotoSelectable(photo);
                  return (
                    <tr key={photo.selectionToken} className={selectedTokens.includes(photo.selectionToken) ? 'selected' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedTokens.includes(photo.selectionToken)}
                          disabled={disabled || isBusy || retryLocked}
                          onChange={() => toggleSelection(photo.selectionToken)}
                          aria-label={`选择照片 ${photo.displayId}`}
                        />
                      </td>
                      <td>{photo.displayId}</td>
                      <td>{photo.displayDate || '-'}</td>
                      <td>
                        <strong>{teamNameById.get(String(photo.teamId)) || `团队 ${photo.teamId || '-'}`}</strong>
                        <span>{memberNameById.get(String(photo.uid)) || photo.photographerName || `UID ${photo.uid || '-'}`}</span>
                      </td>
                      <td>{formatWatermarkStatus(photo)}</td>
                      <td>{photo.projectText || '-'}</td>
                      <td>{photo.workContentText || '-'}</td>
                      <td>{photo.locationText || '-'}</td>
                      <td><span className={`marki-import-source-status ${photo.selectedSourceStatus}`}>{formatMarkiImportLifecycleStatus(photo.selectedSourceStatus)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="marki-import-empty">
            {session
              ? '当前筛选条件下没有已加载的照片。可调整筛选条件或继续加载下一页。'
              : '设置查询条件后读取照片。本版仅显示结构化摘要，不加载远程缩略图。'}
          </div>
        )}
      </section>

      <section className="marki-import-records-section">
        <header>
          <div>
            <h2>导入记录</h2>
            <p>清除记录不会删除已进入工作池的照片；撤销导入会先保存新的工作台快照。</p>
          </div>
          <button type="button" onClick={() => void loadImportRecords({ announce: true })} disabled={isBusy}>
            刷新导入记录
          </button>
        </header>
        {importRecords.length > 0 ? (
          <div className="marki-import-record-list">
            {importRecords.map((record) => (
              <article key={record.batchId}>
                <div className="marki-import-record-main">
                  <strong>{formatDateTime(record.updatedAt)}</strong>
                  <span>
                    查询已加载 {record.querySummary?.loadedCount || 0} 张，
                    选择 {record.querySummary?.selectedCount || record.totalCount} 张，
                    进入工作池 {record.appendedCount} 张，
                    过滤 {record.filteredCount} 张，重复 {record.duplicateCount} 张，
                    失败 {record.failedCount} 张，已撤销 {record.removedCount} 张
                  </span>
                  <small>{formatRecordQuerySummary(record.querySummary)}</small>
                  <small>{formatBatchStatus(record.status)}</small>
                  {record.items
                    .filter((item) => item.status === 'failed_retryable')
                    .slice(0, 3)
                    .map((item) => (
                      <small key={`${record.batchId}-${item.displayId}`}>
                        {item.displayId} 号：{item.message || '导入失败，可重新查询后重试。'}
                      </small>
                    ))}
                </div>
                <div className="marki-import-record-actions">
                  {record.hasActivePhotos && (
                    <button
                      type="button"
                      onClick={() => void runRecordAction(
                        undoMarkiImportBatch,
                        record.batchId,
                        '撤销会把本批次中尚未归档的照片从工作池移除，并允许以后重新导入。确定继续吗？'
                      )}
                      disabled={isBusy}
                    >
                      撤销导入
                    </button>
                  )}
                  {record.retryableCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void retryImportRecord(record)}
                      disabled={isBusy}
                    >
                      重新查询可重试项
                    </button>
                  )}
                  {record.retryableCount > 0 && (
                    <button
                      type="button"
                      onClick={() => void runRecordAction(
                        cleanupMarkiImportCache,
                        record.batchId,
                        '只会清理未被工作池和未完成事务引用的下载缓存。确定继续吗？'
                      )}
                      disabled={isBusy}
                    >
                      清理安全缓存
                    </button>
                  )}
                  {!record.hasRetryableItems && (
                    <button
                      type="button"
                      onClick={() => void runRecordAction(
                        clearMarkiImportRecord,
                        record.batchId,
                        '清除导入记录不会删除已进入工作池的照片。确定清除吗？'
                      )}
                      disabled={isBusy}
                    >
                      清除记录
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="marki-import-empty compact">当前没有导入记录。</div>
        )}
      </section>

      <section className="marki-import-ready-section">
        <header>
          <div>
            <h2>待进入工作台的导入批次</h2>
            <p>批次已经完成下载和结构化转换，可继续进入现有分拣工作台。</p>
          </div>
          <span>{readyBatches.length} 个</span>
        </header>
        {readyBatches.length > 0 ? (
          <div className="marki-import-ready-list">
            {readyBatches.map((batch) => (
              <article key={batch.batchId}>
                <div>
                  <strong>{formatDateTime(batch.updatedAt)}</strong>
                  <span>{batch.inputCount} 张照片，{batch.metadataSavedCount} 条来源明细</span>
                </div>
                <button type="button" onClick={() => enterReadyBatch(batch.batchId)} disabled={isBusy}>进入工作台</button>
              </article>
            ))}
          </div>
        ) : (
          <div className="marki-import-empty compact">当前没有待进入工作台的导入批次。</div>
        )}
      </section>
    </div>
  );
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
    watermarkFilter: String(value.watermarkFilter || fallback.watermarkFilter),
    importStatusFilter: String(value.importStatusFilter || fallback.importStatusFilter),
    start: String(value.start || ''),
    end: String(value.end || '')
  };
  return validateFilters(candidate) ? fallback : candidate;
}

function buildRecordRetryFilters(record, fallback) {
  const querySummary = record?.querySummary;
  const importStatusFilter = Number(record?.failedCount) > 0
    ? 'failed_retryable'
    : 'removed_reimportable';
  const normalized = normalizeStoredFilters({
    teamId: querySummary?.teamId,
    uid: querySummary?.uid,
    watermarkFilter: querySummary?.watermarkFilter || fallback.watermarkFilter,
    importStatusFilter,
    start: normalizeStoredDateTime(querySummary?.start),
    end: normalizeStoredDateTime(querySummary?.end)
  }, fallback);
  return {
    ...normalized,
    importStatusFilter
  };
}

function normalizeStoredDateTime(value) {
  return String(value || '').trim().replace(' ', 'T').slice(0, 16);
}

function formatWatermarkStatus(photo) {
  if (photo?.watermarkStatus === 'watermarked') return photo.markName || '有水印';
  if (photo?.watermarkStatus === 'unwatermarked') return '无水印';
  return '水印状态待确认';
}

function readStoredSession() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      sessionId: String(parsed.sessionId || ''),
      filters: parsed.filters,
      selectedTokens: Array.isArray(parsed.selectedTokens) ? parsed.selectedTokens.map(String) : [],
      retryLocked: parsed.retryLocked === true
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
  const text = failures
    .slice(0, 3)
    .map((failure) => `${String(failure?.displayId || '未知')} 号：${String(failure?.message || '处理失败。')}`)
    .join('；');
  return text ? ` ${text}` : '';
}

function formatBatchStatus(status) {
  return {
    created: '已创建',
    downloading: '正在下载',
    ready_to_append: '待进入工作池',
    appending: '正在追加',
    completed: '已完成',
    partial_failed: '部分失败',
    failed: '失败，可重试',
    cancelled: '已撤销',
    cleared: '已清除'
  }[status] || '状态未知';
}

function formatRecordQuerySummary(summary = {}) {
  const team = summary.teamId ? `团队 ${summary.teamId}` : '全部团队';
  const member = summary.uid ? `成员 ${summary.uid}` : '全部成员';
  const range = summary.start && summary.end
    ? `${summary.start} 至 ${summary.end}`
    : '时间范围未知';
  return `${team}，${member}，${range}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { hour12: false });
}
