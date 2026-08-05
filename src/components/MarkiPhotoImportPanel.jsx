import { createPortal } from 'react-dom';
import { formatMarkiImportLifecycleStatus } from '../utils/markiImportLifecycle.js';
import MarkiPhotoRecoverySection from './MarkiPhotoRecoverySection.jsx';

export default function MarkiPhotoImportPanel({
  open,
  activeTab = 'query',
  onTabChange,
  onClose,
  workspace,
  recovery,
  onOpenSettings
}) {
  if (!open || typeof document === 'undefined') return null;

  const configured = workspace.configured === true;
  const tabs = [
    ['query', '查询并导入'],
    ['ready', '待加入照片池'],
    ['records', '导入记录'],
    ['recovery', '异常与恢复']
  ];

  return createPortal(
    <div className="marki-import-panel-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !workspace.isBusy && !recovery?.busy) onClose();
    }}>
      <section className="marki-import-panel" role="dialog" aria-modal="true" aria-labelledby="marki-import-panel-title">
        <header className="marki-import-panel-header">
          <div>
            <p className="eyebrow">照片分拣工作台 · 当前项目</p>
            <h2 id="marki-import-panel-title">马克照片导入与管理</h2>
            <p>查询并选择当前项目的马克照片，导入后直接加入当前照片池。</p>
            <strong>{workspace.activeProject?.projectName || '未选择项目'}</strong>
          </div>
          <div className="marki-import-panel-header-actions">
            <button type="button" onClick={onClose} disabled={workspace.isBusy || recovery?.busy}>查看照片池</button>
            <button type="button" onClick={onClose} disabled={workspace.isBusy || recovery?.busy} aria-label="关闭马克照片面板">关闭</button>
          </div>
        </header>

        <nav className="marki-import-panel-tabs" aria-label="马克照片功能区">
          {tabs.map(([key, label]) => (
            <button type="button" key={key} className={activeTab === key ? 'active' : ''} onClick={() => onTabChange(key)} disabled={workspace.isBusy || recovery?.busy && key !== 'recovery'}>{label}</button>
          ))}
        </nav>

        <div className="marki-import-panel-content">
          {workspace.notice?.text && <div className={`marki-import-notice ${workspace.notice.type}`} role="status">{workspace.notice.text}</div>}
          {!configured && (
            <section className="marki-import-config-warning">
              <div>
                <strong>尚未配置马克平台</strong>
                <span>请先在系统设置中保存组织 ID 和组织 KEY。</span>
              </div>
              <button type="button" className="primary" onClick={onOpenSettings}>前往马克平台设置</button>
            </section>
          )}

          {activeTab === 'query' && <QuerySection workspace={workspace} />}
          {activeTab === 'ready' && <ReadyBatchSection workspace={workspace} />}
          {activeTab === 'records' && <ImportRecordsSection workspace={workspace} />}
          {activeTab === 'recovery' && <MarkiPhotoRecoverySection recovery={recovery} />}
        </div>
      </section>
    </div>,
    document.body
  );
}

function QuerySection({ workspace }) {
  const {
    configuredReady,
    teams,
    members,
    filters,
    session,
    selectedTokens,
    retryLocked,
    busy,
    isBusy,
    isRefreshingReadyBatches,
    templateOptions,
    filteredQueryResults,
    querySummary,
    teamNameById,
    memberNameById,
    MARKI_IMPORT_STATUS_FILTERS,
    changeFilter,
    startQuery,
    loadNextPage,
    toggleSelection,
    selectAllLoaded,
    clearSelection,
    importSelection,
    loadReadyBatches,
    loadImportRecords
  } = workspace;

  return (
    <section className="marki-import-query-section">
      <div className="marki-import-section-heading">
        <div>
          <h3>查询并导入</h3>
          <p>平台查询只返回安全摘要；模板筛选只使用可信 markName，不判断图片画面水印版本。</p>
        </div>
        <button type="button" onClick={() => void Promise.all([loadReadyBatches({ announce: true }), loadImportRecords({ announce: false })])} disabled={isBusy || isRefreshingReadyBatches}>
          {isRefreshingReadyBatches ? '刷新中...' : '刷新状态'}
        </button>
      </div>

      <div className="marki-import-filter-band">
        <label><span>团队</span><select value={filters.teamId} onChange={(event) => void changeFilter('teamId', event.target.value)} disabled={!configuredReady || isBusy}>
          <option value="">全部团队</option>
          {teams.map((team) => <option key={team.teamId} value={team.teamId}>{team.teamName || `团队 ${team.teamId}`}</option>)}
        </select></label>
        <label><span>成员</span><select value={filters.uid} onChange={(event) => void changeFilter('uid', event.target.value)} disabled={!filters.teamId || isBusy}>
          <option value="">全部成员</option>
          {members.map((member) => <option key={member.uid} value={member.uid}>{member.nickname || `成员 ${member.uid}`}</option>)}
        </select></label>
        <label><span>开始时间</span><input type="datetime-local" value={filters.start} onChange={(event) => void changeFilter('start', event.target.value)} disabled={!configuredReady || isBusy} /></label>
        <label><span>结束时间</span><input type="datetime-local" value={filters.end} onChange={(event) => void changeFilter('end', event.target.value)} disabled={!configuredReady || isBusy} /></label>
        <button type="button" className="primary" onClick={startQuery} disabled={!configuredReady || isBusy}>{busy === 'query' ? '正在查询...' : '查询照片'}</button>
      </div>

      <div className="marki-import-filter-band marki-import-result-filter-band">
        <label><span>水印模板</span><select value={filters.templateFilter} onChange={(event) => void changeFilter('templateFilter', event.target.value)} disabled={!session || isBusy}>
          {templateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label><span>导入状态</span><select value={filters.importStatusFilter} onChange={(event) => void changeFilter('importStatusFilter', event.target.value)} disabled={!session || isBusy}>
          {MARKI_IMPORT_STATUS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <span className="marki-import-filter-hint">模板未知仍可按生命周期选择，不因 markName 为空阻断导入。</span>
      </div>

      <div className="marki-import-toolbar">
        <div>
          <strong>已加载结果</strong>
          <span>已加载 {querySummary.loadedCount} 张，当前筛选 {querySummary.filteredCount} 张，已选择 {querySummary.selectedCount} 张</span>
          <small>当前项目可导入 {querySummary.currentProjectCount} 张；来源项目为空可归属 {querySummary.assignToCurrentCount} 张；不匹配 {querySummary.projectMismatchCount} 张；无法确认 {querySummary.projectUnresolvedCount} 张；已锁定其他项目 {querySummary.sourceProjectLockedCount} 张</small>
        </div>
        <div className="marki-import-toolbar-actions">
          <button type="button" onClick={selectAllLoaded} disabled={!querySummary.selectableCount || isBusy || retryLocked}>全选当前筛选结果</button>
          <button type="button" onClick={clearSelection} disabled={!selectedTokens.length || isBusy || retryLocked}>清空选择</button>
          <button type="button" onClick={loadNextPage} disabled={!session?.pagination?.hasMore || isBusy || retryLocked}>{busy === 'next' ? '正在加载...' : '加载下一页'}</button>
          <button type="button" className="primary" onClick={importSelection} disabled={!selectedTokens.length || isBusy}>{busy === 'import' ? '正在导入...' : (retryLocked ? '重试导入' : '导入到照片池')}</button>
        </div>
      </div>

      {filteredQueryResults.length > 0 ? (
        <div className="marki-import-table-wrap">
          <table className="marki-import-table">
            <thead><tr><th>选择</th><th>编号</th><th>上传时间</th><th>团队 / 人员</th><th>水印模板</th><th>项目</th><th>项目兼容状态</th><th>工作内容</th><th>地点</th><th>来源状态</th></tr></thead>
            <tbody>{filteredQueryResults.map((photo) => {
              const disabled = !isMarkiQueryPhotoSelectableForPanel(photo);
              return <tr key={photo.selectionToken} className={selectedTokens.includes(photo.selectionToken) ? 'selected' : ''}>
                <td><input type="checkbox" checked={selectedTokens.includes(photo.selectionToken)} disabled={disabled || isBusy || retryLocked} onChange={() => toggleSelection(photo.selectionToken)} aria-label={`选择照片 ${photo.displayId}`} /></td>
                <td>{photo.displayId}</td>
                <td>{photo.displayDate || '-'}</td>
                <td><strong>{teamNameById.get(String(photo.teamId)) || `团队 ${photo.teamId || '-'}`}</strong><span>{memberNameById.get(String(photo.uid)) || photo.photographerName || `UID ${photo.uid || '-'}`}</span></td>
                <td>{formatTemplateName(photo)}</td>
                <td>{photo.projectText || '-'}</td>
                <td>{formatProjectCompatibility(photo.projectCompatibility, workspace.activeProject)}</td>
                <td>{photo.workContentText || '-'}</td>
                <td>{photo.locationText || '-'}</td>
                <td><span className={`marki-import-source-status ${photo.selectedSourceStatus}`}>{formatMarkiImportLifecycleStatus(photo.selectedSourceStatus)}</span></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      ) : <div className="marki-import-empty">{session ? '当前筛选条件下没有已加载的照片。可调整筛选条件或继续加载下一页。' : '设置查询条件后读取照片。本版仅显示结构化摘要，不加载远程缩略图。'}</div>}
    </section>
  );
}

function ReadyBatchSection({ workspace }) {
  return (
    <section className="marki-import-ready-section">
      <header><div><h3>待加入照片池的导入批次</h3><p>批次已经完成下载和结构化转换，可直接加入当前项目照片池。</p></div><span>{workspace.readyBatches.length} 个</span></header>
      {workspace.readyBatches.length > 0 ? <div className="marki-import-ready-list">{workspace.readyBatches.map((batch) => <article key={batch.batchId}>
        <div><strong>{formatDateTime(batch.updatedAt)}</strong><span>{batch.inputCount} 张照片，{batch.metadataSavedCount} 条来源明细，{formatBatchStatus(batch.status)}</span></div>
        <button type="button" onClick={() => void workspace.enterReadyBatch(batch.batchId)} disabled={workspace.isBusy}>加入照片池</button>
      </article>)}</div> : <div className="marki-import-empty compact">当前没有待加入照片池的导入批次。</div>}
    </section>
  );
}

function ImportRecordsSection({ workspace }) {
  return (
    <section className="marki-import-records-section">
      <header><div><h3>导入记录</h3><p>清除记录不会删除已进入照片池的照片；撤销导入会先保存新的工作台快照。</p></div><button type="button" onClick={() => void workspace.loadImportRecords({ announce: true })} disabled={workspace.isBusy}>刷新导入记录</button></header>
      {workspace.importRecords.length > 0 ? <div className="marki-import-record-list">{workspace.importRecords.map((record) => <article key={record.batchId}>
        <div className="marki-import-record-main"><strong>{formatDateTime(record.updatedAt)}</strong><span>查询已加载 {record.querySummary?.loadedCount || 0} 张，选择 {record.querySummary?.selectedCount || record.totalCount} 张，进入照片池 {record.appendedCount} 张，重复 {record.duplicateCount} 张，失败 {record.failedCount} 张，已撤销 {record.removedCount} 张</span><small>{formatRecordQuerySummary(record.querySummary)}</small><small>{formatBatchStatus(record.status)}</small>
          {record.items?.filter((item) => item.status === 'failed_retryable').slice(0, 3).map((item) => <small key={`${record.batchId}-${item.displayId}`}>{item.displayId} 号：{item.message || '导入失败，可重新查询后重试。'}</small>)}
        </div>
        <div className="marki-import-record-actions">
          {record.hasActivePhotos && <button type="button" onClick={() => void workspace.runRecordAction(workspace.undoMarkiImportBatch, record.batchId, '撤销会把本批次中尚未归档的照片从工作池移除，并允许以后重新导入。确定继续吗？')} disabled={workspace.isBusy}>撤销导入</button>}
          {record.retryableCount > 0 && <button type="button" onClick={() => void workspace.retryImportRecord(record)} disabled={workspace.isBusy}>重新查询可重试项</button>}
          {record.retryableCount > 0 && <button type="button" onClick={() => void workspace.runRecordAction(workspace.cleanupMarkiImportCache, record.batchId, '只会清理未被工作池和未完成事务引用的下载缓存。确定继续吗？')} disabled={workspace.isBusy}>清理安全缓存</button>}
          {!record.hasRetryableItems && <button type="button" onClick={() => void workspace.runRecordAction(workspace.clearMarkiImportRecord, record.batchId, '清除导入记录不会删除已进入照片池的照片。确定清除吗？')} disabled={workspace.isBusy}>清除记录</button>}
        </div>
      </article>)}</div> : <div className="marki-import-empty compact">当前没有导入记录。</div>}
    </section>
  );
}

function isMarkiQueryPhotoSelectableForPanel(photo) {
  if (photo?.projectCompatibility && photo.projectCompatibility.selectable !== true) return false;
  return ['discovered', 'workspace_file_repairable', 'removed_reimportable', 'failed_retryable'].includes(String(photo?.selectedSourceStatus || ''));
}

function formatTemplateName(photo) {
  return String(photo?.templateName || photo?.markName || '').trim() || '模板未知';
}

function formatProjectCompatibility(compatibility, activeProject) {
  const currentProjectName = String(activeProject?.projectName || '当前项目');
  if (compatibility?.status === 'current_project') return '当前项目，可导入';
  if (compatibility?.status === 'assign_current_project') return `来源项目为空，将归属${currentProjectName}`;
  if (compatibility?.status === 'project_mismatch') return `其他项目，不可导入（${compatibility.sourceProjectName || '项目不匹配'}）`;
  if (compatibility?.status === 'source_project_locked') return `已归属其他项目，不可导入（${compatibility.sourceProjectName || '项目已锁定'}）`;
  return '项目无法确认，不可导入';
}

function formatBatchStatus(status) {
  return {
    created: '已创建',
    downloading: '正在下载',
    ready_to_append: '待加入照片池',
    appending: '正在加入照片池',
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
  const range = summary.start && summary.end ? `${summary.start} 至 ${summary.end}` : '时间范围未知';
  return `${team}，${member}，${range}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
}
