export default function PlaceholderPage({ eyebrow, title, description, sections }) {
  return (
    <div className="page-stack">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">{eyebrow || '即将开放'}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </section>
      <section className="placeholder-card-grid">
        {sections.map((section) => (
          <article className="placeholder-card panel" key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.text}</p>
          </article>
        ))}
      </section>
      <div className="warning-box">该模块为功能入口和布局预留，本次版本不执行真实业务操作。</div>
    </div>
  );
}
