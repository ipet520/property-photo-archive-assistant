import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  getRecoverableMarkiRecoveryTokens,
  summarizeMarkiRecoveryCandidates
} from '../utils/markiRecoveryDialog.js';

const statusLabels = {
  recoverable: '可恢复',
  already_in_workbench: '已在工作台',
  already_archived: '已归档',
  missing_file: '文件缺失',
  corrupted_file: '文件异常',
  missing_metadata: '元数据缺失',
  invalid_record: '数据异常'
};

export default function MarkiRehydrateDialog({
  open,
  items,
  selectedTokens,
  busy,
  notice,
  onToggle,
  onRefresh,
  onRecoverSelected,
  onRecoverAll,
  onClose
}) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [busy, onClose, open]);

  if (!open || typeof document === 'undefined') return null;

  const safeItems = Array.isArray(items) ? items : [];
  const selected = new Set(Array.isArray(selectedTokens) ? selectedTokens : []);
  const recoverableTokens = getRecoverableMarkiRecoveryTokens(safeItems);
  const summary = summarizeMarkiRecoveryCandidates(safeItems);

  return createPortal(
    <div
      className="marki-rehydrate-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="marki-rehydrate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="marki-rehydrate-title"
        aria-describedby="marki-rehydrate-description"
      >
        <header className="marki-rehydrate-header">
          <div>
            <h2 id="marki-rehydrate-title">恢复已下载的 Marki 照片</h2>
            <p id="marki-rehydrate-description">
              从本机已下载的 Marki 照片中，选择需要重新加入工作台的照片。
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭恢复弹窗">关闭</button>
        </header>

        <div className="marki-rehydrate-summary" aria-label="恢复状态摘要">
          <span>可恢复 <strong>{summary.recoverable}</strong></span>
          <span>已在工作台 <strong>{summary.alreadyInWorkbench}</strong></span>
          <span>已归档 <strong>{summary.alreadyArchived}</strong></span>
          <span>文件缺失 <strong>{summary.missingFile}</strong></span>
          <span>数据异常 <strong>{summary.abnormal}</strong></span>
        </div>

        <div className="marki-rehydrate-content">
          {notice?.text && (
            <p className={`marki-rehydrate-notice ${notice.type || 'idle'}`} role="status">
              {notice.text}
            </p>
          )}
          {busy && safeItems.length === 0 ? (
            <div className="marki-rehydrate-empty">正在核对本机已下载照片...</div>
          ) : safeItems.length === 0 ? (
            <div className="marki-rehydrate-empty">当前没有可恢复的 Marki 照片。</div>
          ) : (
            <div className="marki-rehydrate-table-wrap">
              <table className="marki-rehydrate-table">
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>编号</th>
                    <th>拍摄时间</th>
                    <th>拍照人员</th>
                    <th>项目</th>
                    <th>工作内容摘要</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {safeItems.map((item) => (
                    <tr key={item.recoveryToken}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择恢复 ${item.displayId}`}
                          checked={selected.has(item.recoveryToken)}
                          disabled={busy || item.status !== 'recoverable'}
                          onChange={() => onToggle(item.recoveryToken)}
                        />
                      </td>
                      <td>{item.displayId || '-'}</td>
                      <td>{item.capturedAt || '-'}</td>
                      <td>{item.photographerName || '-'}</td>
                      <td>{item.projectName || '-'}</td>
                      <td>{item.workContentText || '暂无摘要'}</td>
                      <td>{statusLabels[item.status] || '数据异常'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="marki-rehydrate-actions">
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" onClick={onRefresh} disabled={busy}>
            {busy ? '处理中...' : '刷新'}
          </button>
          <button
            type="button"
            className="primary orange"
            onClick={onRecoverSelected}
            disabled={busy || selected.size === 0}
          >
            恢复选中（{selected.size}）
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onRecoverAll(recoverableTokens)}
            disabled={busy || recoverableTokens.length === 0}
          >
            恢复全部可恢复项
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
