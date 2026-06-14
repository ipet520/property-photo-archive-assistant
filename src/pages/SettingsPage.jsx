import { APP_VERSION } from '../constants/app.js';

export default function SettingsPage({ archiveState }) {
  const settings = archiveState.settings || {};
  const appPaths = archiveState.appPaths || {};
  const configPaths = archiveState.configPaths || {};

  async function openDirectory(pathValue) {
    if (!pathValue) return;
    await window.archiveAssistant.openPath(pathValue);
  }

  return (
    <div className="page-stack">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">系统设置</p>
          <h1>路径记忆、配置目录和运行环境</h1>
          <p>当前版本 {APP_VERSION}。这里集中查看本地设置，不上传云端。</p>
        </div>
      </section>

      <section className="settings-grid">
        <SettingsCard title="当前照片文件夹" value={settings.lastPhotoFolder || '未设置'} />
        <SettingsCard title="当前归档根目录" value={settings.lastArchiveRoot || '未设置'} />
        <SettingsCard title="默认归档根目录" value={settings.defaultArchiveRoot || '未设置'} />
        <SettingsCard title="settings.json" value={settings.settingsPath || '加载中'} action="打开所在目录" onClick={() => openDirectory(parentDir(settings.settingsPath))} />
        <SettingsCard title="用户配置目录" value={configPaths.userConfigDir || '加载中'} action="打开目录" onClick={() => openDirectory(configPaths.userConfigDir)} />
        <SettingsCard title="配置备份目录" value={configPaths.backupDir || '加载中'} action="打开目录" onClick={() => openDirectory(configPaths.backupDir)} />
        <SettingsCard title="runtime / userData" value={appPaths.userData || '加载中'} action="打开目录" onClick={() => openDirectory(appPaths.userData)} />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">最近目录</p>
            <h2>路径记忆记录</h2>
          </div>
        </div>
        <div className="recent-path-grid">
          <RecentPathList title="最近照片文件夹" items={settings.recentPhotoFolders || []} onClear={archiveState.clearRecentPhotoFolders} />
          <RecentPathList title="最近归档根目录" items={settings.recentArchiveRoots || []} onClear={archiveState.clearRecentArchiveRoots} />
        </div>
      </section>
    </div>
  );
}

function SettingsCard({ title, value, action, onClick }) {
  return (
    <article className="settings-card">
      <span>{title}</span>
      <strong title={value}>{value}</strong>
      {action && <button className="ghost" onClick={onClick}>{action}</button>}
    </article>
  );
}

function RecentPathList({ title, items, onClear }) {
  return (
    <div className="recent-path-card">
      <div className="config-row-actions">
        <h3>{title}</h3>
        <button className="mini-button" onClick={onClear}>清空</button>
      </div>
      {items.length === 0 ? <p className="muted">暂无记录。</p> : items.map((item) => <small key={item} title={item}>{item}</small>)}
    </div>
  );
}

function parentDir(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/[\\/][^\\/]*$/, '');
}
