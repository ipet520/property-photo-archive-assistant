import { APP_NAME, APP_VERSION, PAGE_KEYS } from '../constants/app.js';

export default function HeaderBar({ onNavigate, archiveState }) {
  const archiveRoot = archiveState.archiveRoot || archiveState.settings?.lastArchiveRoot || '未设置';

  return (
    <header className="header-bar">
      <div className="brand-block">
        <span className="brand-mark">归</span>
        <div>
          <strong>{APP_NAME}</strong>
          <small>当前版本 {APP_VERSION}</small>
        </div>
      </div>
      <div className="header-current-path">
        <span>当前归档根目录</span>
        <strong title={archiveRoot}>{archiveRoot}</strong>
      </div>
      <div className="header-actions">
        <button onClick={() => onNavigate(PAGE_KEYS.quickArchive)}>快速归档</button>
        <button className="ghost" onClick={() => onNavigate(PAGE_KEYS.configCenter)}>配置管理</button>
        <button className="ghost" onClick={() => onNavigate(PAGE_KEYS.settings)}>系统设置</button>
      </div>
    </header>
  );
}
