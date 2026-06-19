import { PAGE_KEYS } from '../constants/app.js';
import ArchiveRecordsPage from './ArchiveRecordsPage.jsx';
import DashboardPage from './DashboardPage.jsx';
import DataMaintenancePage from './DataMaintenancePage.jsx';
import QuickArchivePage from './QuickArchivePage.jsx';
import RectificationCenterPage from './RectificationCenterPage.jsx';
import SettingsPage from './SettingsPage.jsx';
import SortWorkspacePage from './SortWorkspacePage.jsx';
import SummaryCenterPage from './SummaryCenterPage.jsx';

export default function MainRouter({ currentPage, onNavigate, archiveState }) {
  if (currentPage === PAGE_KEYS.dashboard) {
    return <DashboardPage archiveState={archiveState} onNavigate={onNavigate} />;
  }
  if (currentPage === PAGE_KEYS.quickArchive) {
    return <QuickArchivePage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.sortWorkspace) {
    return <SortWorkspacePage />;
  }
  if (currentPage === PAGE_KEYS.searchCenter) {
    return <ArchiveRecordsPage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.rectificationCenter) {
    return <RectificationCenterPage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.reportCenter) {
    return <SummaryCenterPage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.dataMaintenance) {
    return <DataMaintenancePage onNavigate={onNavigate} />;
  }
  if (currentPage === PAGE_KEYS.configCenter || currentPage === PAGE_KEYS.settings) {
    return <SettingsPage archiveState={archiveState} />;
  }

  return <DashboardPage archiveState={archiveState} onNavigate={onNavigate} />;
}
