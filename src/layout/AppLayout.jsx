import BottomStatusBar from './BottomStatusBar.jsx';
import HeaderBar from './HeaderBar.jsx';
import MainContent from './MainContent.jsx';
import SideNav from './SideNav.jsx';
import { useEffect, useState } from 'react';

export default function AppLayout({ currentPage, onNavigate, archiveState, children }) {
  const [isNavCollapsed, setIsNavCollapsed] = useState(() => localStorage.getItem('archiveAssistant.navCollapsed') === 'true');

  useEffect(() => {
    localStorage.setItem('archiveAssistant.navCollapsed', String(isNavCollapsed));
  }, [isNavCollapsed]);

  return (
    <div className={`app-frame ${isNavCollapsed ? 'nav-collapsed' : ''}`}>
      <HeaderBar currentPage={currentPage} onNavigate={onNavigate} archiveState={archiveState} />
      <div className="app-body">
        <SideNav
          currentPage={currentPage}
          onNavigate={onNavigate}
          collapsed={isNavCollapsed}
          onToggleCollapsed={() => setIsNavCollapsed((value) => !value)}
        />
        <MainContent>{children}</MainContent>
      </div>
      <BottomStatusBar currentPage={currentPage} archiveState={archiveState} />
    </div>
  );
}
