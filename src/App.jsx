import { useEffect, useState } from 'react';
import { PAGE_KEYS } from './constants/app.js';
import AppLayout from './layout/AppLayout.jsx';
import { useArchiveWorkspace } from './hooks/useArchiveWorkspace.js';
import MainRouter from './pages/MainRouter.jsx';

export default function App() {
  const archiveState = useArchiveWorkspace();
  const [currentPage, setCurrentPage] = useState(PAGE_KEYS.dashboard);

  useEffect(() => {
    const unsubscribe = window.archiveAssistant.onOpenConfigManager?.(() => setCurrentPage(PAGE_KEYS.configCenter));
    return () => unsubscribe?.();
  }, []);

  return (
    <AppLayout currentPage={currentPage} onNavigate={setCurrentPage} archiveState={archiveState}>
      <MainRouter currentPage={currentPage} onNavigate={setCurrentPage} archiveState={archiveState} />
    </AppLayout>
  );
}
