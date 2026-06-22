import { NAV_GROUPS } from '../constants/app.js';
import AppNavIcon from '../components/AppNavIcon.jsx';

export default function SideNav({ currentPage, onNavigate, collapsed, onToggleCollapsed }) {
  return (
    <aside className={`side-nav ${collapsed ? 'collapsed' : ''}`}>
      <div className="side-nav-header">
        <button
          type="button"
          className="nav-collapse-toggle"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
          <strong>功能导航</strong>
        </button>
      </div>
      <div className="side-nav-sections">
        {NAV_GROUPS.map((group) => (
          <section className="nav-group" key={group.title}>
            <h2>{group.title}</h2>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.key}
                className={currentPage === item.key ? 'active' : ''}
                onClick={() => onNavigate(item.key)}
                title={item.label}
                aria-current={currentPage === item.key ? 'page' : undefined}
              >
                <span aria-hidden="true"><AppNavIcon name={item.icon} /></span>
                <strong>{item.label}</strong>
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
