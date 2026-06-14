import { NAV_GROUPS } from '../constants/app.js';

export default function SideNav({ currentPage, onNavigate }) {
  return (
    <aside className="side-nav">
      {NAV_GROUPS.map((group) => (
        <section className="nav-group" key={group.title}>
          <h2>{group.title}</h2>
          {group.items.map((item) => (
            <button
              type="button"
              key={item.key}
              className={currentPage === item.key ? 'active' : ''}
              onClick={() => onNavigate(item.key)}
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
