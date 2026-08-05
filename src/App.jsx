import { useEffect, useState } from 'react';
import { PAGE_KEYS } from './constants/app.js';
import RuntimeErrorBoundary from './components/RuntimeErrorBoundary.jsx';
import AppLayout from './layout/AppLayout.jsx';
import { useAppWorkspace } from './hooks/useAppWorkspace.js';
import MainRouter from './pages/MainRouter.jsx';
import { installGlobalRuntimeLoggers } from './utils/runtimeLogger.js';

export default function App() {
  const archiveState = useAppWorkspace();
  const [currentPage, setCurrentPage] = useState(PAGE_KEYS.dashboard);
  const [navigationRequest, setNavigationRequest] = useState({ page: PAGE_KEYS.dashboard, action: '', payload: null, nonce: 0 });

  function handleNavigate(target) {
    const rawRequest = typeof target === 'string' ? { page: target } : target;
    const request = normalizeNavigationRequest(rawRequest);
    if (!request?.page) return;
    setCurrentPage(request.page);
    setNavigationRequest({ page: request.page, action: request.action || '', payload: request.payload || null, nonce: Date.now() });
  }

  useEffect(() => {
    const unsubscribe = window.archiveAssistant.onOpenConfigManager?.(() => handleNavigate(PAGE_KEYS.configCenter));
    return () => unsubscribe?.();
  }, []);

  useEffect(() => installGlobalRuntimeLoggers(), []);

  useEffect(() => {
    window.requestAnimationFrame(() => document.querySelector('.main-content')?.scrollTo({ top: 0, left: 0 }));
  }, [currentPage]);

  return (
    <RuntimeErrorBoundary>
      <AppLayout currentPage={currentPage} onNavigate={handleNavigate} archiveState={archiveState}>
        <MainRouter currentPage={currentPage} onNavigate={handleNavigate} navigationRequest={navigationRequest} archiveState={archiveState} />
      </AppLayout>
    </RuntimeErrorBoundary>
  );
}

function normalizeNavigationRequest(request) {
  if (!request || typeof request !== 'object') return request;
  if (request.page === PAGE_KEYS.markiImport) {
    return {
      ...request,
      page: PAGE_KEYS.sortWorkspace,
      action: 'openMarkiPanel',
      payload: { tab: 'query' }
    };
  }
  if (request.action === 'openMarkiRecovery' || request.action === 'showMarkiRecovery') {
    return {
      ...request,
      page: PAGE_KEYS.sortWorkspace,
      action: 'openMarkiPanel',
      payload: { ...(request.payload || {}), tab: 'recovery' }
    };
  }
  return request;
}
