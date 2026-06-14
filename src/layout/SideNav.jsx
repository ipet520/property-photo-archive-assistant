import { NAV_GROUPS } from '../constants/app.js';

export default function SideNav({ currentPage, onNavigate, collapsed, onToggleCollapsed }) {
  return (
    <aside className={`side-nav ${collapsed ? 'collapsed' : ''}`}>
      <button
        type="button"
        className="nav-collapse-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        {collapsed ? '>' : '<'}
      </button>
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
            >
              <span>{item.marker}</span>
              <strong>{item.label}</strong>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
}
