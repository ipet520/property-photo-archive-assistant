import { PAGE_KEYS } from '../constants/app.js';

export default function ActiveProjectGate({
  projectOptions = [],
  onSelectProject,
  onNavigate
}) {
  const hasProjects = projectOptions.length > 0;
  return (
    <section className="settings-section">
      <div className="settings-card">
        <h1>请选择当前工作项目</h1>
        {hasProjects ? (
          <>
            <p>照片导入、工作台、智拣、预览和归档都只在选定项目内进行。</p>
            <div className="settings-grid">
              {projectOptions.map((project) => (
                <button
                  type="button"
                  className="primary"
                  key={project.id}
                  onClick={() => onSelectProject(project.id)}
                >
                  {project.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p>当前没有可用项目，请先前往基础数据配置中维护项目。</p>
            <button
              type="button"
              className="primary"
              onClick={() => onNavigate(PAGE_KEYS.configCenter)}
            >
              进入配置中心
            </button>
          </>
        )}
      </div>
    </section>
  );
}
