import BottomStatusBar from './BottomStatusBar.jsx';
import HeaderBar from './HeaderBar.jsx';
import MainContent from './MainContent.jsx';
import SideNav from './SideNav.jsx';

export default function AppLayout({ currentPage, onNavigate, archiveState, children }) {
  return (
    <div className="app-frame">
      <HeaderBar currentPage={currentPage} onNavigate={onNavigate} archiveState={archiveState} />
      <div className="app-body">
        <SideNav currentPage={currentPage} onNavigate={onNavigate} />
        <MainContent>{children}</MainContent>
      </div>
      <BottomStatusBar currentPage={currentPage} archiveState={archiveState} />
    </div>
  );
}
