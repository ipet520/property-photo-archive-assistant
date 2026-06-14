import { APP_VERSION, PAGE_TITLES } from '../constants/app.js';

export default function BottomStatusBar({ currentPage, archiveState }) {
  const successCount = archiveState.previewItems?.filter((item) => item.status === '归档成功').length || 0;
  const failedCount = archiveState.previewItems?.filter((item) => item.status === '归档失败').length || 0;

  return (
    <footer className="bottom-status-bar">
      <span>当前页面：{PAGE_TITLES[currentPage] || '未选择'}</span>
      <span>照片数：{archiveState.photos?.length || 0}</span>
      <span>预览数：{archiveState.previewItems?.length || 0}</span>
      <span>成功：{successCount}</span>
      <span>失败：{failedCount}</span>
      <span className={`bottom-status-text ${archiveState.status?.type || 'idle'}`}>{archiveState.status?.text || '未开始'}</span>
      <span>版本：{APP_VERSION}</span>
    </footer>
  );
}
