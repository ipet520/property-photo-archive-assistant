import { APP_NAME, VERSION_SUMMARY } from '../constants/app.js';
import appIconUrl from '../assets/app-icon.svg';

export default function HeaderBar({ archiveState }) {
  const photoSourceDirectory = archiveState.runtimeConfiguration?.photoSourceDirectory || '';
  const archiveRoot = archiveState.runtimeConfiguration?.archiveRootDirectory || '';

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
        <span>照片来源：<strong title={photoSourceDirectory}>{photoSourceDirectory || '未设置'}</strong></span>
        <span>归档根目录：<strong title={archiveRoot}>{archiveRoot || '未设置'}</strong></span>
      </div>
    </header>
  );
}
