import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { findingsStore } from './stores/findingsStore';
import { AppShell } from './components/layout/AppShell';
import { CommandPalette } from './components/layout/CommandPalette';
import { ToastContainer } from './components/shared/Toast';
import { ProxyPage } from './pages/ProxyPage';
import { HistoryPage } from './pages/HistoryPage';
import { FailedPage } from './pages/FailedPage';
import { ReplayPage } from './pages/ReplayPage';
import { FuzzerPage } from './pages/FuzzerPage';
import { DecoderPage } from './pages/DecoderPage';
import { ComparerPage } from './pages/ComparerPage';
import { SiteMapPage } from './pages/SiteMapPage';
import { FindingsPage } from './pages/FindingsPage';
import { AIActivityPage } from './pages/AIActivityPage';
import { ScopePage } from './pages/ScopePage';
import { SettingsPage } from './pages/SettingsPage';
import { ChatPage } from './pages/ChatPage';

const NavigateContext = createContext<(page: string) => void>(() => {});
export const useNavigate = () => useContext(NavigateContext);

const PAGE_KEYS = ['history', 'proxy', 'replay', 'fuzzer', 'decoder', 'comparer', 'sitemap', 'scope', 'findings', 'ai-activity', 'chat', 'settings'] as const;

const PAGES: Record<string, React.FC> = {
  proxy: ProxyPage,
  history: HistoryPage,
  failed: FailedPage,
  replay: ReplayPage,
  fuzzer: FuzzerPage,
  decoder: DecoderPage,
  comparer: ComparerPage,
  sitemap: SiteMapPage,
  scope: ScopePage,
  findings: FindingsPage,
  'ai-activity': AIActivityPage,
  chat: ChatPage,
  settings: SettingsPage,
};

export function App() {
  const [activePage, setActivePage] = useState('history');
  const [paletteOpen, setPaletteOpen] = useState(false);

  useWebSocket();

  // Initialize global findings store (collects findings from all WS events regardless of active page)
  useEffect(() => { findingsStore.init(); }, []);

  const navigate = useCallback((page: string) => setActivePage(page), []);

  // Keyboard shortcuts: Ctrl/Cmd + 1-9 to switch pages, Cmd+Shift+P for palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Command palette: Cmd+Shift+P or Ctrl+Shift+P
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      if (e.metaKey || e.ctrlKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= PAGE_KEYS.length) {
          e.preventDefault();
          setActivePage(PAGE_KEYS[num - 1]);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const PageComponent = PAGES[activePage] || ProxyPage;

  return (
    <NavigateContext.Provider value={navigate}>
      <AppShell activePage={activePage} onNavigate={setActivePage}>
        <PageComponent />
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(page) => { setActivePage(page); setPaletteOpen(false); }}
      />
      <ToastContainer />
    </NavigateContext.Provider>
  );
}
