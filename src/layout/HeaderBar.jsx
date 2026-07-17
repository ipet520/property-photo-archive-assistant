import { APP_NAME, VERSION_SUMMARY } from '../constants/app.js';
import appIconUrl from '../assets/app-icon.svg';

export default function HeaderBar({ archiveState }) {
  const archiveRoot = archiveState.archiveRoot
    || archiveState.settings?.defaultArchiveRoot
    || archiveState.settings?.lastArchiveRoot
    || '';

  return (
    <header className="header-bar">
      <div className="brand-block">
        <img className="brand-mark" src={appIconUrl} alt="" aria-hidden="true" />
        <div>
          <strong>{APP_NAME}</strong>
          <small>{VERSION_SUMMARY}</small>
        </div>
      </div>
      <div className="header-current-path">
        <span>当前归档根目录</span>
        <strong title={archiveRoot}>{archiveRoot || '未设置归档根目录'}</strong>
      </div>
    </header>
  );
}
