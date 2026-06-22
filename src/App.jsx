import { useEffect, useState } from 'react';
import { PAGE_KEYS } from './constants/app.js';
import AppLayout from './layout/AppLayout.jsx';
import { useArchiveWorkspace } from './hooks/useArchiveWorkspace.js';
import MainRouter from './pages/MainRouter.jsx';

export default function App() {
  const archiveState = useArchiveWorkspace();
  const [currentPage, setCurrentPage] = useState(PAGE_KEYS.dashboard);
  const [navigationRequest, setNavigationRequest] = useState({ page: PAGE_KEYS.dashboard, action: '', payload: null, nonce: 0 });

  function handleNavigate(target) {
    const request = typeof target === 'string' ? { page: target } : target;
    if (!request?.page) return;
    setCurrentPage(request.page);
    setNavigationRequest({ page: request.page, action: request.action || '', payload: request.payload || null, nonce: Date.now() });
  }

  useEffect(() => {
    const unsubscribe = window.archiveAssistant.onOpenConfigManager?.(() => handleNavigate(PAGE_KEYS.configCenter));
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    window.requestAnimationFrame(() => document.querySelector('.main-content')?.scrollTo({ top: 0, left: 0 }));
  }, [currentPage]);

  return (
    <AppLayout currentPage={currentPage} onNavigate={handleNavigate} archiveState={archiveState}>
      <MainRouter currentPage={currentPage} onNavigate={handleNavigate} navigationRequest={navigationRequest} archiveState={archiveState} />
    </AppLayout>
  );
}
