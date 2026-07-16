import { PAGE_TITLES, VERSION_SUMMARY } from '../constants/app.js';

export default function BottomStatusBar({ currentPage, archiveState }) {
  return (
    <footer className="bottom-status-bar">
      <span>当前页面：{PAGE_TITLES[currentPage] || '未选择'}</span>
      <span>归档目录：{archiveState.archiveRoot ? '已设置' : '未设置'}</span>
      <span>基础数据：{archiveState.configs ? '已加载' : '读取中'}</span>
      <span className={`bottom-status-text ${archiveState.status?.type || 'idle'}`}>{archiveState.status?.text || '未开始'}</span>
      <span>{VERSION_SUMMARY}</span>
    </footer>
  );
}
