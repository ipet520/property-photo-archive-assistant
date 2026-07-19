import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAGE_KEYS } from '../constants/app.js';
import {
  createMarkiReadyBatchRefresh,
  createDefaultMarkiImportFilters,
  destroyMarkiPhotoQuerySession,
  getMarkiConfigStatus,
  getMarkiPhotoQuerySession,
  importMarkiPhotoQuerySelection,
  listMarkiMembers,
  listMarkiTeams,
  listReadyMarkiImportBatches,
  loadNextMarkiPhotoQueryPage,
  parseMarkiImportBeijingDateTime,
  startMarkiPhotoQuerySession
} from '../utils/markiClient.js';

const SESSION_STORAGE_KEY = 'marki-photo-import-session-v1';
const MAX_MEMBER_PAGES = 100;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const BUSY_SOURCE_STATUSES = new Set(['downloading', 'imported']);

export default function MarkiPhotoImportPage({ onNavigate }) {
  const initialFilters = useMemo(() => createDefaultMarkiImportFilters(), []);
  const [configured, setConfigured] = useState(null);
  const [teams, setTeams] = useState([]);
  const [members, setMembers] = useState([]);
  const [filters, setFilters] = useState(initialFilters);
  const [session, setSession] = useState(null);
  const [selectedTokens, setSelectedTokens] = useState([]);
  const [readyBatches, setReadyBatches] = useState([]);
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
      await loadReadyBatches();
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
    const selectable = session?.photos
      ?.filter((photo) => !BUSY_SOURCE_STATUSES.has(photo.selectedSourceStatus))
      .map((photo) => photo.selectionToken) || [];
    setSelectedTokens((current) => Array.from(new Set([...current, ...selectable])));
  }

  async function importSelection() {
    if (!session?.sessionId || selectedTokens.length === 0) return;
    setBusy('import');
    const result = await importMarkiPhotoQuerySelection({
      sessionId: session.sessionId,
      selectionTokens: selectedTokens
    });
    setBusy('');
    if (result?.status === 'ready' && result.batchId) {
      setRetryLocked(false);
      await loadReadyBatches();
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
      setNotice({
        type: 'error',
        text: `${formatImportFailureStatus(result.status)} 可使用当前照片集合重试。`
      });
      await loadReadyBatches();
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

  const configuredReady = configured === true;
  const isBusy = Boolean(busy);
  const photos = session?.photos || [];
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

      <section className="marki-import-toolbar">
        <div>
          <strong>查询结果</strong>
          <span>已加载 {photos.length} 张，已选择 {selectedTokens.length} 张</span>
        </div>
        <div className="marki-import-toolbar-actions">
          <button type="button" onClick={selectAllLoaded} disabled={!photos.length || isBusy || retryLocked}>全选当前已加载照片</button>
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
        {photos.length > 0 ? (
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
                {photos.map((photo) => {
                  const disabled = BUSY_SOURCE_STATUSES.has(photo.selectedSourceStatus);
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
                      <td>{photo.markName || '-'}</td>
                      <td>{photo.projectText || '-'}</td>
                      <td>{photo.workContentText || '-'}</td>
                      <td>{photo.locationText || '-'}</td>
                      <td><span className={`marki-import-source-status ${photo.selectedSourceStatus}`}>{formatSourceStatus(photo.selectedSourceStatus)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="marki-import-empty">设置查询条件后读取照片。本版仅显示结构化摘要，不加载远程缩略图。</div>
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
    start: String(value.start || ''),
    end: String(value.end || '')
  };
  return validateFilters(candidate) ? fallback : candidate;
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

function formatSourceStatus(status) {
  return {
    new: '未导入',
    discovered: '已发现',
    downloading: '下载中',
    download_failed: '下载失败',
    imported: '已导入'
  }[status] || '未知';
}

function formatImportFailureStatus(status) {
  return {
    download_failed: '部分照片下载失败。',
    metadata_failed: '部分来源明细保存失败。',
    batch_persist_failed: '导入批次状态保存失败。'
  }[status] || '马克照片导入失败。';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { hour12: false });
}
