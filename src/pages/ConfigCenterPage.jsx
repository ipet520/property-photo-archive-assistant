import ConfigManager from '../components/ConfigManager.jsx';

export default function ConfigCenterPage({ archiveState }) {
  return (
    <div className="page-stack">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">系统设置</p>
          <h1>维护当前归档表单和默认项</h1>
          <p>归档分类、工作内容、关键词以及底层归档默认项在这里统一维护。</p>
        </div>
      </section>
      <ConfigManager open embedded onClose={() => {}} onSaved={archiveState.handleConfigsSaved} />
    </div>
  );
}
