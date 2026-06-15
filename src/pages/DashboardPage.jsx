import { APP_NAME, APP_VERSION, PAGE_KEYS } from '../constants/app.js';

export default function DashboardPage({ archiveState, onNavigate }) {
  const settings = archiveState.settings || {};

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <p className="eyebrow">首页总览</p>
          <h1>{APP_NAME}</h1>
          <p>当前版本 {APP_VERSION}。这里用于查看当前目录、配置路径和常用功能入口。</p>
        </div>
      </section>

      <section className="overview-grid">
        <InfoCard title="当前照片文件夹" value={settings.lastPhotoFolder || '未设置'} />
        <InfoCard title="当前归档根目录" value={settings.lastArchiveRoot || '未设置'} />
        <InfoCard title="默认归档根目录" value={settings.defaultArchiveRoot || '未设置'} />
        <InfoCard title="最近照片文件夹数量" value={`${settings.recentPhotoFolders?.length || 0} 个`} />
        <InfoCard title="最近归档根目录数量" value={`${settings.recentArchiveRoots?.length || 0} 个`} />
        <InfoCard title="当前配置目录" value={archiveState.configPaths?.userConfigDir || '加载中'} />
        <InfoCard title="配置备份目录" value={archiveState.configPaths?.backupDir || '加载中'} />
      </section>

      <section className="quick-entry-grid">
        <EntryCard title="开始快速批量归档" text="一批照片使用同一套归档信息时，从这里开始。" onClick={() => onNavigate(PAGE_KEYS.quickArchive)} />
        <EntryCard title="进入照片分拣工作台" text="处理混合事项照片，逐批分拣后再归档。" onClick={() => onNavigate(PAGE_KEYS.sortWorkspace)} />
        <EntryCard title="打开归档记录" text="读取照片归档台账，查询、筛选、核对历史归档照片。" onClick={() => onNavigate(PAGE_KEYS.searchCenter)} />
        <EntryCard title="打开系统设置" text="维护基础数据、默认目录、资料包设置、备份恢复和系统信息。" onClick={() => onNavigate(PAGE_KEYS.settings)} />
      </section>
    </div>
  );
}

function InfoCard({ title, value }) {
  return (
    <article className="info-card">
      <span>{title}</span>
      <strong title={value}>{value}</strong>
    </article>
  );
}

function EntryCard({ title, text, onClick }) {
  return (
    <button className="entry-card" onClick={onClick}>
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  );
}
