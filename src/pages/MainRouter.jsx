import { PAGE_KEYS } from '../constants/app.js';
import ArchiveRecordsPage from './ArchiveRecordsPage.jsx';
import ConfigCenterPage from './ConfigCenterPage.jsx';
import DashboardPage from './DashboardPage.jsx';
import PlaceholderPage from './PlaceholderPage.jsx';
import QuickArchivePage from './QuickArchivePage.jsx';
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
  if (currentPage === PAGE_KEYS.configCenter) {
    return <ConfigCenterPage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.settings) {
    return <SettingsPage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.searchCenter) {
    return <ArchiveRecordsPage archiveState={archiveState} />;
  }
  if (currentPage === PAGE_KEYS.rectificationCenter) {
    return (
      <PlaceholderPage
        title="整改闭环中心"
        description="未来将管理发现问题、处理过程、处理结果和复查照片。"
        sections={[
          { title: '整改事项列表', text: '预留问题事项台账和负责人、期限、状态字段。' },
          { title: '整改阶段看板', text: '预留发现、处理中、已完成、复查通过等阶段。' },
          { title: '整改前后对比', text: '预留前后照片对照和复查记录导出。' }
        ]}
      />
    );
  }
  if (currentPage === PAGE_KEYS.reportCenter) {
    return (
      <PlaceholderPage
        title="资料汇总中心"
        description="未来将生成迎检资料包、月度汇总和 Word/PDF 汇报材料。"
        sections={[
          { title: '汇总条件区域', text: '预留项目、日期、部门、工作内容等汇总条件。' },
          { title: '资料包类型', text: '预留迎检资料包、专项汇总、月度/季度汇总。' },
          { title: '导出操作', text: '预留照片台账、Word、PDF 和资料包导出按钮。' }
        ]}
      />
    );
  }
  if (currentPage === PAGE_KEYS.dataMaintenance) {
    return (
      <PlaceholderPage
        title="数据维护中心"
        description="未来将管理配置备份、台账备份、缓存、日志和旧版本数据迁移。"
        sections={[
          { title: '数据备份', text: '预留台账备份、数据导入导出和旧版本迁移。' },
          { title: '配置备份', text: '预留配置备份浏览、恢复和清理旧备份。' },
          { title: '日志与缓存', text: '预留运行日志、缓存清理和照片索引重建。' }
        ]}
      />
    );
  }

  return <DashboardPage archiveState={archiveState} onNavigate={onNavigate} />;
}
