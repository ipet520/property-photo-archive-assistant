import { PAGE_KEYS } from '../constants/app.js';
import ArchiveRecordsPage from './ArchiveRecordsPage.jsx';
import DashboardPage from './DashboardPage.jsx';
import DataMaintenancePage from './DataMaintenancePage.jsx';
import PlaceholderPage from './PlaceholderPage.jsx';
import QuickArchivePage from './QuickArchivePage.jsx';
import RectificationCenterPage from './RectificationCenterPage.jsx';
import SettingsPage from './SettingsPage.jsx';
import SortWorkspacePage from './SortWorkspacePage.jsx';

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
    return (
      <PlaceholderPage
        title="资料汇总中心"
        description="后续用于生成迎检资料包、月度汇总和 Word/PDF 汇报材料。"
        sections={[
          { title: '汇总条件区域', text: '预留项目、日期、部门、工作内容等汇总条件。' },
          { title: '资料包类型', text: '预留迎检资料包、专项汇总、月度/季度汇总。' },
          { title: '导出操作', text: '预留照片台账、Word、PDF 和资料包导出按钮。' }
        ]}
      />
    );
  }
  if (currentPage === PAGE_KEYS.dataMaintenance) {
    return <DataMaintenancePage onNavigate={onNavigate} />;
  }
  if (currentPage === PAGE_KEYS.configCenter || currentPage === PAGE_KEYS.settings) {
    return <SettingsPage archiveState={archiveState} />;
  }

  return <DashboardPage archiveState={archiveState} onNavigate={onNavigate} />;
}
