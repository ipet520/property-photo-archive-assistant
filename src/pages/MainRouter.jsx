import { PAGE_KEYS } from '../constants/app.js';
import ArchiveRecordsPage from './ArchiveRecordsPage.jsx';
import DashboardPage from './DashboardPage.jsx';
import DataMaintenancePage from './DataMaintenancePage.jsx';
import RectificationCenterPage from './RectificationCenterPage.jsx';
import SettingsPage from './SettingsPage.jsx';
import ServiceBriefPage from './ServiceBriefPage.jsx';
import SortWorkspacePage from './SortWorkspacePage.jsx';
import SummaryCenterPage from './SummaryCenterPage.jsx';

export default function MainRouter({ currentPage, onNavigate, navigationRequest, archiveState }) {
  if (currentPage === PAGE_KEYS.dashboard) {
    return <DashboardPage archiveState={archiveState} onNavigate={onNavigate} />;
  }
  if (currentPage === PAGE_KEYS.quickArchive) {
    // 旧的独立快归入口已取消；历史导航请求统一回到照片分拣工作台。
    return <SortWorkspacePage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.sortWorkspace) {
    return <SortWorkspacePage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.searchCenter) {
      return <ArchiveRecordsPage archiveState={archiveState} navigationRequest={navigationRequest} />;
  }
  if (currentPage === PAGE_KEYS.rectificationCenter) {
      return <RectificationCenterPage archiveState={archiveState} navigationRequest={navigationRequest} />;
  }
  if (currentPage === PAGE_KEYS.reportCenter) {
      return <SummaryCenterPage archiveState={archiveState} navigationRequest={navigationRequest} />;
  }
  if (currentPage === PAGE_KEYS.serviceBrief) {
      return <ServiceBriefPage archiveState={archiveState} onNavigate={onNavigate} />;
  }
  if (currentPage === PAGE_KEYS.dataMaintenance) {
    return <DataMaintenancePage onNavigate={onNavigate} />;
  }
  if (currentPage === PAGE_KEYS.configCenter || currentPage === PAGE_KEYS.settings) {
      return <SettingsPage archiveState={archiveState} navigationRequest={navigationRequest} />;
  }

  return <DashboardPage archiveState={archiveState} onNavigate={onNavigate} />;
}
