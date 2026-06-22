import ConfigManager from '../components/ConfigManager.jsx';

export default function ConfigCenterPage({ archiveState }) {
  return (
    <div className="page-stack">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">系统设置</p>
          <h1>维护基础配置和水印分类父子关系</h1>
          <p>项目、部门、照片来源、水印分类与工作内容、关键词、常见场景都在这里维护。</p>
        </div>
      </section>
      <ConfigManager open embedded onClose={() => {}} onSaved={archiveState.handleConfigsSaved} />
    </div>
  );
}
