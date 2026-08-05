import {
  getRecoverableMarkiRecoveryTokens,
  summarizeMarkiRecoveryCandidates
} from '../utils/markiRecoveryDialog.js';

const RECOVERY_STATUS_LABELS = {
  recoverable: '可恢复',
  already_in_workbench: '已在工作台',
  already_archived: '已归档',
  missing_file: '文件缺失',
  corrupted_file: '文件异常',
  missing_metadata: '元数据缺失',
  invalid_record: '数据异常'
};

export default function MarkiPhotoRecoverySection({ recovery }) {
  if (!recovery) return <div className="marki-import-empty">恢复服务暂不可用。</div>;
  const items = Array.isArray(recovery.items) ? recovery.items : [];
  const selected = new Set(recovery.selectedTokens || []);
  const summary = summarizeMarkiRecoveryCandidates(items);
  const recoverableTokens = getRecoverableMarkiRecoveryTokens(items);
  return (
    <section className="marki-import-recovery-section">
      <header><div><h3>异常与恢复</h3><p>检查当前项目本机已下载的 Marki 照片，只修复文件状态，不重新查询平台。</p></div><button type="button" onClick={recovery.onRefresh} disabled={recovery.busy}>{recovery.busy ? '处理中...' : '刷新健康状态'}</button></header>
      <div className="marki-rehydrate-summary" aria-label="恢复状态摘要"><span>可恢复 <strong>{summary.recoverable}</strong></span><span>已在工作台 <strong>{summary.alreadyInWorkbench}</strong></span><span>已归档 <strong>{summary.alreadyArchived}</strong></span><span>文件缺失 <strong>{summary.missingFile}</strong></span><span>数据异常 <strong>{summary.abnormal}</strong></span></div>
      {recovery.notice?.text && <p className={`marki-rehydrate-notice ${recovery.notice.type || 'idle'}`} role="status">{recovery.notice.text}</p>}
      {recovery.busy && items.length === 0 ? <div className="marki-import-empty">正在核对本机已下载照片...</div> : items.length === 0 ? <div className="marki-import-empty">当前没有可恢复的 Marki 照片。</div> : <div className="marki-rehydrate-table-wrap"><table className="marki-rehydrate-table"><thead><tr><th>选择</th><th>编号</th><th>拍摄时间</th><th>拍照人员</th><th>项目</th><th>工作内容摘要</th><th>状态</th></tr></thead><tbody>{items.map((item) => <tr key={item.recoveryToken}><td><input type="checkbox" checked={selected.has(item.recoveryToken)} disabled={recovery.busy || item.status !== 'recoverable'} onChange={() => recovery.onToggle(item.recoveryToken)} /></td><td>{item.displayId || '-'}</td><td>{item.capturedAt || '-'}</td><td>{item.photographerName || '-'}</td><td>{item.projectName || '-'}</td><td>{item.workContentText || '暂无摘要'}</td><td>{RECOVERY_STATUS_LABELS[item.status] || '数据异常'}</td></tr>)}</tbody></table></div>}
      <footer className="marki-rehydrate-actions"><button type="button" onClick={() => recovery.onClose?.()} disabled={recovery.busy}>关闭</button><button type="button" onClick={recovery.onRefresh} disabled={recovery.busy}>刷新</button><button type="button" className="primary orange" onClick={() => recovery.onRecoverSelected?.()} disabled={recovery.busy || selected.size === 0}>恢复选中（{selected.size}）</button><button type="button" className="primary" onClick={() => recovery.onRecoverAll?.(recoverableTokens)} disabled={recovery.busy || recoverableTokens.length === 0}>恢复全部可恢复项</button></footer>
    </section>
  );
}
