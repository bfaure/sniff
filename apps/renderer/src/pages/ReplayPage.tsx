import React, { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';
import Prism from 'prismjs';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-css';
import { js_beautify, html_beautify, css_beautify } from 'js-beautify';
import { api } from '../api/client';
import { ContextMenu } from '../components/shared/ContextMenu';
import { StatusBadge } from '../components/shared/StatusBadge';
import { LLMNotConfigured, isLLMNotConfigured } from '../components/shared/LLMNotConfigured';
import { appEvents } from '../events/appEvents';
import { useLLMStream } from '../hooks/useLLMStream';
import { buildScopeOptions, checkExistingCoverage, type ScopeOption, type ScopeRule } from '../utils/scopeOptions';

const VULN_TYPES = [
  'SQL Injection',
  'Cross-Site Scripting (XSS)',
  'IDOR / Broken Object-Level Auth',
  'Authentication Bypass',
  'Authorization / Privilege Escalation',
  'Server-Side Request Forgery (SSRF)',
  'Command Injection',
  'Path Traversal / LFI',
  'XML External Entity (XXE)',
  'Server-Side Template Injection (SSTI)',
  'Open Redirect',
  'JWT / Token Tampering',
  'Race Condition',
  'Business Logic Flaw',
  'CSRF',
  'Mass Assignment',
  'Insecure Deserialization',
];

interface GuidedTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ReplayResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  bodyBase64?: string;
  duration: number;
}

interface HistoryEntry {
  method: string;
  url: string;
  headers: string;
  body: string;
  response: ReplayResponse | null;
}

interface ReplayTab {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  response: ReplayResponse | null;
  loading: boolean;
  history: HistoryEntry[];
  historyIndex: number; // -1 means "current" (not viewing history)
}

interface ScopeWizardState {
  url: string;
  tabId: string;
}

let tabCounter = 1;

function genId(): string {
  return `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTab(): ReplayTab {
  return {
    id: genId(),
    name: `Tab ${tabCounter++}`,
    method: 'GET',
    url: 'https://',
    headers: 'User-Agent: Sniff/1.0\nAccept: */*',
    body: '',
    response: null,
    loading: false,
    history: [],
    historyIndex: -1,
  };
}

// Module-level state to persist across remounts
let persistedTabs: ReplayTab[] | null = null;
let persistedActiveTabId: string | null = null;
let persistedGuidedHistory: Record<string, GuidedTurn[]> = {};
let persistedGuidedOpen = false;
let persistedGuidedVulnType = VULN_TYPES[0];
let persistedGuidedMode: 'guided' | 'auto' = 'guided';
let persistedPanelHeight = 320;
let guidedStateLoadedFromDb = false;
let guidedSaveTimer: ReturnType<typeof setTimeout> | null = null;

function saveGuidedStateToDb() {
  if (guidedSaveTimer) clearTimeout(guidedSaveTimer);
  guidedSaveTimer = setTimeout(() => {
    const payload = {
      history: persistedGuidedHistory,
      open: persistedGuidedOpen,
      vulnType: persistedGuidedVulnType,
      mode: persistedGuidedMode,
      panelHeight: persistedPanelHeight,
    };
    api.settings.set('ui_replay_guided', JSON.stringify(payload)).catch(() => {});
  }, 800);
}

interface ProposedTest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function parseProposedTest(content: string): ProposedTest | null {
  const match = content.match(/```proposed-test\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.method && typeof parsed.path === 'string' && parsed.headers) return parsed;
  } catch { /* ignore */ }
  return null;
}

/** Strip the proposed-test block from markdown so it doesn't render as visible text */
function stripProposedTest(content: string): string {
  return content.replace(/```proposed-test\s*\n[\s\S]*?\n```/g, '').trimEnd();
}

/**
 * Chat input sidebar for the AI Test panel. Holds its own draft text in local
 * state so keystrokes do NOT bubble a re-render up to ReplayPage, which
 * re-renders the full conversation and is expensive (markdown per turn).
 *
 * The parent seeds a prefill value (e.g., after "Apply Test") via the
 * `prefill` prop. We key off `prefill.seq` so repeated prefills of the same
 * text still overwrite the draft.
 */
const GuidedChatInput = React.memo(function GuidedChatInput(props: {
  disabled: boolean;
  prefill: { seq: number; text: string };
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState(props.prefill.text);
  const lastSeq = useRef(props.prefill.seq);
  useEffect(() => {
    if (props.prefill.seq !== lastSeq.current) {
      lastSeq.current = props.prefill.seq;
      setValue(props.prefill.text);
    }
  }, [props.prefill]);
  const canSend = !props.disabled && value.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    props.onSend(value);
    setValue('');
  };
  return (
    <div className="w-64 border-l border-gray-800 flex flex-col p-2 shrink-0">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Report results or ask a follow-up... (⌘+Enter)"
        disabled={props.disabled}
        className="flex-1 bg-gray-900 border border-gray-800 rounded p-2 text-sm text-gray-200 resize-none focus:outline-none focus:border-purple-600 disabled:opacity-50"
      />
      <button
        onClick={send}
        disabled={!canSend}
        className="mt-1.5 w-full px-3 py-1 rounded bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-medium"
      >
        Send
      </button>
    </div>
  );
});

export function ReplayPage() {
  const [tabs, _setTabs] = useState<ReplayTab[]>(() => persistedTabs || []);
  const [activeTabId, _setActiveTabId] = useState(() => persistedActiveTabId || '');

  const setTabs = (v: ReplayTab[] | ((prev: ReplayTab[]) => ReplayTab[])) => {
    _setTabs((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      persistedTabs = next;
      return next;
    });
  };
  const setActiveTabId = (v: string | ((prev: string) => string)) => {
    _setActiveTabId((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      persistedActiveTabId = next;
      return next;
    });
  };

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
  const [dbLoaded, setDbLoaded] = useState(!!persistedTabs);

  // Load tabs from DB on first mount
  useEffect(() => {
    if (persistedTabs) return; // already loaded in this session
    api.replay.getTabs().then(async (dbTabs) => {
      if (dbTabs.length > 0) {
        const loaded: ReplayTab[] = await Promise.all(dbTabs.map(async (t) => {
          let history: HistoryEntry[] = [];
          try {
            const dbHistory = await api.replay.getHistory(t.id);
            history = dbHistory.map((h) => ({
              method: h.method,
              url: h.url,
              headers: h.headers,
              body: h.body,
              response: h.statusCode != null ? {
                statusCode: h.statusCode,
                headers: h.responseHeaders ? JSON.parse(h.responseHeaders) : {},
                body: h.responseBody || '',
                duration: h.duration || 0,
              } : null,
            }));
          } catch { /* ignore */ }
          return {
            id: t.id,
            name: t.name,
            method: t.method,
            url: t.url,
            headers: t.headers,
            body: t.body,
            response: null,
            loading: false,
            history,
            historyIndex: -1,
          };
        }));
        tabCounter = dbTabs.length + 1;
        setTabs(loaded);
        if (!persistedActiveTabId) setActiveTabId(loaded[0].id);
      }
      setDbLoaded(true);
    }).catch(() => setDbLoaded(true));
  }, []);

  // Load guided test state from DB on first mount
  useEffect(() => {
    if (guidedStateLoadedFromDb) return;
    guidedStateLoadedFromDb = true;
    api.settings.getAll().then((all) => {
      const raw = all['ui_replay_guided'];
      if (!raw) return;
      try {
        const saved = JSON.parse(raw);
        if (saved.history) { persistedGuidedHistory = saved.history; _setGuidedHistory(saved.history); }
        if (saved.open != null) { persistedGuidedOpen = saved.open; _setGuidedOpen(saved.open); }
        if (saved.vulnType) { persistedGuidedVulnType = saved.vulnType; _setGuidedVulnType(saved.vulnType); }
        if (saved.mode) { persistedGuidedMode = saved.mode; _setGuidedMode(saved.mode); }
        if (saved.panelHeight) { persistedPanelHeight = saved.panelHeight; setPanelHeight(saved.panelHeight); }
      } catch { /* ignore */ }
    }).catch(() => {});
  }, []);

  // Debounced save to DB when a tab's editable fields change
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveTabToDb = useCallback((tab: ReplayTab) => {
    if (saveTimersRef.current[tab.id]) clearTimeout(saveTimersRef.current[tab.id]);
    saveTimersRef.current[tab.id] = setTimeout(() => {
      api.replay.updateTab(tab.id, {
        name: tab.name,
        method: tab.method,
        url: tab.url,
        headers: tab.headers,
        body: tab.body,
      }).catch(() => {});
      delete saveTimersRef.current[tab.id];
    }, 500);
  }, []);

  // Right-click context menu + scope wizard
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [scopeWizard, setScopeWizard] = useState<ScopeWizardState | null>(null);
  const [scopeAdded, setScopeAdded] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [existingScopeRules, setExistingScopeRules] = useState<ScopeRule[]>([]);
  const [pendingAnalysis, setPendingAnalysis] = useState<{ count: number; label: string } | null>(null);

  // Guided test state (per-tab keyed by tab id)
  const [guidedOpen, _setGuidedOpen] = useState(persistedGuidedOpen);
  const [guidedVulnType, _setGuidedVulnType] = useState(persistedGuidedVulnType);
  const [guidedHistory, _setGuidedHistory] = useState<Record<string, GuidedTurn[]>>(persistedGuidedHistory);

  const setGuidedOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    _setGuidedOpen((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      persistedGuidedOpen = next;
      saveGuidedStateToDb();
      return next;
    });
  };
  const setGuidedVulnType = (v: string) => {
    _setGuidedVulnType(v);
    persistedGuidedVulnType = v;
    saveGuidedStateToDb();
  };
  const setGuidedHistory = (v: Record<string, GuidedTurn[]> | ((prev: Record<string, GuidedTurn[]>) => Record<string, GuidedTurn[]>)) => {
    _setGuidedHistory((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      persistedGuidedHistory = next;
      saveGuidedStateToDb();
      return next;
    });
  };
  const [guidedMode, _setGuidedMode] = useState<'guided' | 'auto'>(persistedGuidedMode);
  const setGuidedMode = (v: 'guided' | 'auto') => {
    _setGuidedMode(v);
    persistedGuidedMode = v;
    saveGuidedStateToDb();
  };
  const [panelHeight, setPanelHeight] = useState(persistedPanelHeight);
  const resizingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startY = e.clientY;
    const startH = panelHeight;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const newH = Math.max(120, Math.min(window.innerHeight - 200, startH + (startY - ev.clientY)));
      setPanelHeight(newH);
      persistedPanelHeight = newH;
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveGuidedStateToDb();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelHeight]);

  const [splitPercent, setSplitPercent] = useState(50);
  const splitDraggingRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const onSplitStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDraggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!splitDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(Math.max(20, Math.min(80, pct)));
    };
    const onUp = () => {
      splitDraggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const [appliedFlash, setAppliedFlash] = useState<{ url?: boolean; headers?: boolean; body?: boolean; method?: boolean } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preApplySnapshot, setPreApplySnapshot] = useState<{ tabId: string; method: string; url: string; headers: string; body: string } | null>(null);

  const applyProposedTest = useCallback((test: ProposedTest) => {
    if (!activeTab) return;

    // Save snapshot for undo
    setPreApplySnapshot({
      tabId: activeTab.id,
      method: activeTab.method,
      url: activeTab.url,
      headers: activeTab.headers,
      body: activeTab.body,
    });

    const headersStr = Object.entries(test.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const changed: { url?: boolean; headers?: boolean; body?: boolean; method?: boolean } = {};

    let newUrl = activeTab.url;
    try {
      const u = new URL(activeTab.url);
      newUrl = `${u.protocol}//${u.host}${test.path.startsWith('/') ? test.path : '/' + test.path}`;
    } catch { /* keep existing url */ }

    if (newUrl !== activeTab.url) changed.url = true;
    if (headersStr !== activeTab.headers) changed.headers = true;
    if ((test.body || '') !== activeTab.body) changed.body = true;
    if (test.method !== activeTab.method) changed.method = true;

    updateTab(activeTab.id, {
      method: test.method,
      url: newUrl,
      headers: headersStr,
      body: test.body || '',
    });

    setAppliedFlash(changed);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setAppliedFlash(null), 3000);

    // Prefill chat with follow-up prompt so user can quickly ask AI to re-analyze
    setGuidedInput('I applied the test and sent the request. Analyze the new response — did it work?');
  }, [activeTab]);

  const undoApply = useCallback(() => {
    if (!preApplySnapshot) return;
    updateTab(preApplySnapshot.tabId, {
      method: preApplySnapshot.method,
      url: preApplySnapshot.url,
      headers: preApplySnapshot.headers,
      body: preApplySnapshot.body,
    });
    setPreApplySnapshot(null);
    setAppliedFlash(null);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, [preApplySnapshot]);

  // Prefill seed the chat input can read on change (e.g., after Apply Test).
  // The actual input value lives inside GuidedChatInput so keystrokes don't
  // re-render this whole page (Markdown in each past turn is expensive).
  const [guidedInputPrefill, setGuidedInputPrefill] = useState({ seq: 0, text: '' });
  const setGuidedInput = (text: string) => setGuidedInputPrefill((p) => ({ seq: p.seq + 1, text }));
  const llm = useLLMStream();
  const lastStreamTabRef = useRef<string | null>(null);
  const turns = activeTab ? (guidedHistory[activeTab.id] || []) : [];
  // Auto-scroll the conversation to the bottom as new content streams/commits.
  const convoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = convoRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, llm.streaming, llm.text]);

  // When a stream finishes, append the assistant turn to this tab's history
  useEffect(() => {
    if (!llm.streaming && llm.text && lastStreamTabRef.current) {
      const tabId = lastStreamTabRef.current;
      setGuidedHistory((prev) => {
        const existing = prev[tabId] || [];
        // Avoid double-append if effect re-runs
        if (existing.length > 0 && existing[existing.length - 1].role === 'assistant' && existing[existing.length - 1].content === llm.text) {
          return prev;
        }
        return { ...prev, [tabId]: [...existing, { role: 'assistant', content: llm.text }] };
      });
      lastStreamTabRef.current = null;
      llm.reset();
    }
  }, [llm.streaming, llm.text]);

  const buildExchangeForGuided = () => {
    const headers: Record<string, string> = {};
    activeTab.headers.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    const respHeaders: Record<string, string> | null = activeTab.response
      ? Object.fromEntries(Object.entries(activeTab.response.headers).map(([k, v]) => [k, String(v)]))
      : null;
    // Truncate large bodies to avoid exceeding server body limits
    const MAX_BODY = 100_000;
    const reqBody = activeTab.body || null;
    let resBody = activeTab.response?.body ?? null;
    if (resBody && resBody.length > MAX_BODY) {
      resBody = resBody.slice(0, MAX_BODY) + `\n... [truncated, ${(resBody.length / 1024).toFixed(0)}KB total]`;
    }
    return {
      method: activeTab.method,
      url: activeTab.url,
      requestHeaders: headers,
      requestBody: reqBody && reqBody.length > MAX_BODY ? reqBody.slice(0, MAX_BODY) + '\n... [truncated]' : reqBody,
      statusCode: activeTab.response?.statusCode ?? null,
      responseHeaders: respHeaders,
      responseBody: resBody,
    };
  };

  const startGuidedTest = async () => {
    const ex = buildExchangeForGuided();
    setGuidedHistory((prev) => ({ ...prev, [activeTab.id]: [] }));
    lastStreamTabRef.current = activeTab.id;
    const vt = guidedMode === 'guided' ? guidedVulnType : undefined;
    await llm.guidedTest(vt, ex);
  };

  const sendGuidedFollowup = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || llm.streaming) return;
    const newHistory: GuidedTurn[] = [...turns, { role: 'user', content: trimmed }];
    setGuidedHistory((prev) => ({ ...prev, [activeTab.id]: newHistory }));
    const ex = buildExchangeForGuided();
    lastStreamTabRef.current = activeTab.id;
    const vt = guidedMode === 'guided' ? guidedVulnType : undefined;
    await llm.guidedTest(vt, ex, trimmed, newHistory.slice(0, -1));
  };

  // Listen for "Send to Replay" events from other pages
  useEffect(() => {
    return appEvents.on('send-to-replay', (req) => {
      const headersStr = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      const tab = createTab();
      tab.name = new URL(req.url).pathname.slice(0, 20) || 'Request';
      tab.method = req.method;
      tab.url = req.url;
      tab.headers = headersStr;
      tab.body = req.body || '';
      setTabs((prev) => {
        api.replay.createTab({
          id: tab.id, name: tab.name, method: tab.method,
          url: tab.url, headers: tab.headers, body: tab.body, sortOrder: prev.length,
        }).catch(() => {});
        return [...prev, tab];
      });
      setActiveTabId(tab.id);
    });
  }, []);

  // Pending guided test to auto-start once tab is created from event
  const pendingGuidedRef = useRef<{ tabId: string; vulnType: string } | null>(null);

  // Listen for "Test in Replay" — combined load + open guided test
  useEffect(() => {
    return appEvents.on('test-in-replay', ({ request, vulnType }) => {
      const headersStr = Object.entries(request.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      const tab = createTab();
      try { tab.name = new URL(request.url).pathname.slice(0, 20) || 'Request'; } catch { /* ignore */ }
      tab.method = request.method;
      tab.url = request.url;
      tab.headers = headersStr;
      tab.body = request.body || '';
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
      setGuidedOpen(true);
      setGuidedVulnType(VULN_TYPES.includes(vulnType) ? vulnType : VULN_TYPES[0]);
      pendingGuidedRef.current = { tabId: tab.id, vulnType };
    });
  }, []);

  // Once the pending tab is mounted and active, fire the guided test
  useEffect(() => {
    const pending = pendingGuidedRef.current;
    if (pending && activeTab && pending.tabId === activeTab.id && !llm.streaming) {
      pendingGuidedRef.current = null;
      // Defer to next tick so state has settled
      setTimeout(() => { startGuidedTest(); }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id]);

  const updateTab = (id: string, updates: Partial<ReplayTab>) => {
    setTabs((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...updates } : t));
      // Persist to DB if editable fields changed
      const persistKeys = ['name', 'method', 'url', 'headers', 'body'] as const;
      if (persistKeys.some((k) => k in updates)) {
        const updated = next.find((t) => t.id === id);
        if (updated) saveTabToDb(updated);
      }
      return next;
    });
  };

  const addTab = () => {
    const tab = createTab();
    setTabs((prev) => {
      const sortOrder = prev.length;
      api.replay.createTab({
        id: tab.id, name: tab.name, method: tab.method,
        url: tab.url, headers: tab.headers, body: tab.body, sortOrder,
      }).catch(() => {});
      return [...prev, tab];
    });
    setActiveTabId(tab.id);
  };

  const removeTab = (id: string) => {
    api.replay.deleteTab(id).catch(() => {});
    const closedIdx = tabs.findIndex((t) => t.id === id);
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      if (remaining.length > 0) {
        const newIdx = Math.min(closedIdx, remaining.length - 1);
        setActiveTabId(remaining[newIdx].id);
      } else {
        setActiveTabId('');
      }
    }
  };

  const sendRequest = async () => {
    const headers: Record<string, string> = {};
    activeTab.headers.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });

    updateTab(activeTab.id, { loading: true });

    try {
      const result = await api.replay.send({
        method: activeTab.method,
        url: activeTab.url,
        headers,
        body: activeTab.body || null,
      }) as ReplayResponse;

      // Snapshot this exchange into history
      const entry: HistoryEntry = {
        method: activeTab.method,
        url: activeTab.url,
        headers: activeTab.headers,
        body: activeTab.body,
        response: result,
      };
      const newHistory = [...activeTab.history, entry];
      updateTab(activeTab.id, { response: result, loading: false, history: newHistory, historyIndex: -1 });

      // Persist to DB
      api.replay.createHistory(activeTab.id, {
        sortOrder: newHistory.length - 1,
        method: entry.method,
        url: entry.url,
        headers: entry.headers,
        body: entry.body,
        statusCode: result.statusCode,
        responseHeaders: JSON.stringify(result.headers),
        responseBody: result.body,
        duration: result.duration,
      }).catch(() => {});
    } catch (err) {
      const errResponse: ReplayResponse = {
        statusCode: 0,
        headers: {},
        body: `Error: ${(err as Error).message}`,
        duration: 0,
      };
      const entry: HistoryEntry = {
        method: activeTab.method,
        url: activeTab.url,
        headers: activeTab.headers,
        body: activeTab.body,
        response: errResponse,
      };
      const newHistory = [...activeTab.history, entry];
      updateTab(activeTab.id, { response: errResponse, loading: false, history: newHistory, historyIndex: -1 });

      // Persist error entries too
      api.replay.createHistory(activeTab.id, {
        sortOrder: newHistory.length - 1,
        method: entry.method,
        url: entry.url,
        headers: entry.headers,
        body: entry.body,
        statusCode: 0,
        responseBody: errResponse.body,
        duration: 0,
      }).catch(() => {});
    }
  };

  const followRedirect = async () => {
    if (!activeTab?.response) return;
    const status = activeTab.response.statusCode;
    if (status < 300 || status >= 400) return;
    const headers = activeTab.response.headers;
    const locationRaw = (headers['location'] || headers['Location']) as string | string[] | undefined;
    if (!locationRaw) return;
    const location = Array.isArray(locationRaw) ? locationRaw[0] : locationRaw;

    let targetUrl: string;
    try {
      targetUrl = new URL(location, activeTab.url).toString();
    } catch {
      targetUrl = location;
    }

    // 303 forces GET; 301/302 traditionally become GET; 307/308 preserve method + body
    const preserveMethod = status === 307 || status === 308;
    const newMethod = preserveMethod ? activeTab.method : 'GET';
    const newBody = preserveMethod ? activeTab.body : '';

    // Carry Set-Cookie forward into the Cookie request header so sessions survive
    const setCookieRaw = (headers['set-cookie'] || headers['Set-Cookie']) as string | string[] | undefined;
    let newHeaders = activeTab.headers;
    if (setCookieRaw) {
      const setCookies = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw];
      const newCookies = setCookies
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean);
      if (newCookies.length > 0) {
        const lines = activeTab.headers.split('\n');
        const cookieIdx = lines.findIndex((l) => l.toLowerCase().startsWith('cookie:'));
        const existing = cookieIdx >= 0
          ? lines[cookieIdx].slice(lines[cookieIdx].indexOf(':') + 1).trim().split(';').map((c) => c.trim()).filter(Boolean)
          : [];
        // Merge: new cookies override existing ones with the same name
        const byName = new Map<string, string>();
        for (const c of existing) {
          const eq = c.indexOf('=');
          if (eq > 0) byName.set(c.slice(0, eq), c);
        }
        for (const c of newCookies) {
          const eq = c.indexOf('=');
          if (eq > 0) byName.set(c.slice(0, eq), c);
        }
        const merged = 'Cookie: ' + Array.from(byName.values()).join('; ');
        newHeaders = cookieIdx >= 0
          ? [...lines.slice(0, cookieIdx), merged, ...lines.slice(cookieIdx + 1)].join('\n')
          : [merged, ...lines].join('\n');
      }
    }

    updateTab(activeTab.id, {
      url: targetUrl,
      method: newMethod,
      body: newBody,
      headers: newHeaders,
    });
    // Defer send by a tick so the state update is applied before sendRequest reads it
    setTimeout(() => sendRequestRef.current(), 0);
  };

  const goBack = () => {
    if (!activeTab || activeTab.history.length === 0) return;
    const currentIdx = activeTab.historyIndex;
    let targetIdx: number;
    if (currentIdx === -1) {
      // Going back from current state — save current as a snapshot first if it differs from last history entry
      targetIdx = activeTab.history.length - 1;
    } else if (currentIdx > 0) {
      targetIdx = currentIdx - 1;
    } else {
      return; // already at oldest
    }
    const entry = activeTab.history[targetIdx];
    updateTab(activeTab.id, {
      method: entry.method,
      url: entry.url,
      headers: entry.headers,
      body: entry.body,
      response: entry.response,
      historyIndex: targetIdx,
    });
  };

  const goForward = () => {
    if (!activeTab || activeTab.historyIndex === -1) return;
    const nextIdx = activeTab.historyIndex + 1;
    if (nextIdx >= activeTab.history.length) {
      // Return to current (latest) state — historyIndex = -1
      // The latest entry is already the last in history
      const latest = activeTab.history[activeTab.history.length - 1];
      updateTab(activeTab.id, {
        method: latest.method,
        url: latest.url,
        headers: latest.headers,
        body: latest.body,
        response: latest.response,
        historyIndex: -1,
      });
      return;
    }
    const entry = activeTab.history[nextIdx];
    updateTab(activeTab.id, {
      method: entry.method,
      url: entry.url,
      headers: entry.headers,
      body: entry.body,
      response: entry.response,
      historyIndex: nextIdx,
    });
  };

  // Keyboard shortcut: Cmd+Shift+Enter (Mac) / Ctrl+Shift+Enter to send
  const sendRequestRef = useRef(sendRequest);
  sendRequestRef.current = sendRequest;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendRequestRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRename = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    setRenamingTabId(tabId);
    setRenameValue(tab.name);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (renamingTabId && renameValue.trim()) {
      updateTab(renamingTabId, { name: renameValue.trim() });
    }
    setRenamingTabId(null);
  };

  return (
    <div className="h-full flex flex-col relative">
      {/* Tab bar */}
      <div className="flex items-center bg-gray-900 border-b border-gray-800">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            onDoubleClick={() => startRename(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            className={`flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer border-r border-gray-800 ${
              tab.id === activeTabId ? 'bg-gray-800 text-gray-200' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {renamingTabId === tab.id ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingTabId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="bg-gray-700 border border-gray-600 rounded px-1 py-0 text-sm text-gray-200 w-24 focus:outline-none focus:border-emerald-600"
                autoFocus
              />
            ) : (
              <span>{tab.name}</span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); removeTab(tab.id); }}
              className="ml-1 text-gray-600 hover:text-gray-400 text-xs"
            >
              x
            </button>
          </div>
        ))}
        <button onClick={addTab} className="px-3 py-1.5 text-gray-600 hover:text-gray-400 text-sm">
          +
        </button>
      </div>

      {/* Request / Response split */}
      {!activeTab ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          <div className="text-center">
            <p className="mb-2">No tabs open</p>
            <button
              onClick={addTab}
              className="px-4 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm border border-gray-700"
            >
              + New Tab
            </button>
          </div>
        </div>
      ) : (
      <div ref={splitContainerRef} className="flex-1 flex overflow-auto" style={guidedOpen ? { paddingBottom: panelHeight } : undefined}>
        {/* Request editor */}
        <div className="flex flex-col overflow-hidden" style={{ width: `${splitPercent}%` }}>
          <div className="bg-gray-900/50 border-b border-gray-800 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <select
                value={activeTab.method}
                onChange={(e) => updateTab(activeTab.id, { method: e.target.value })}
                className={`bg-gray-800 border rounded px-2 py-1 text-sm text-gray-300 shrink-0 transition-colors ${appliedFlash?.method ? 'border-emerald-500 bg-emerald-950' : 'border-gray-700'}`}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <button
                onClick={() => {
                  const isHttps = activeTab.url.startsWith('https://');
                  const newUrl = isHttps
                    ? activeTab.url.replace(/^https:\/\//, 'http://')
                    : activeTab.url.replace(/^http:\/\//, 'https://');
                  updateTab(activeTab.id, { url: newUrl });
                }}
                className="px-2 py-1 rounded text-[10px] font-mono font-bold border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 shrink-0"
                title="Toggle HTTP/HTTPS"
              >
                {activeTab.url.startsWith('https://') ? 'HTTPS' : 'HTTP'}
              </button>
              <input
                type="text"
                value={(() => { try { return new URL(activeTab.url).hostname; } catch { return activeTab.url.replace(/^https?:\/\//, ''); } })()}
                onChange={(e) => {
                  try {
                    const u = new URL(activeTab.url);
                    updateTab(activeTab.id, { url: `${u.protocol}//${e.target.value}${u.port ? ':' + u.port : ''}${u.pathname}${u.search}${u.hash}` });
                  } catch {
                    const scheme = activeTab.url.startsWith('https://') ? 'https://' : 'http://';
                    updateTab(activeTab.id, { url: `${scheme}${e.target.value}` });
                  }
                }}
                className={`bg-gray-800 border rounded px-2 py-1 text-sm text-gray-300 font-mono focus:outline-none focus:border-emerald-600 flex-1 transition-colors ${appliedFlash?.url ? 'border-emerald-500 bg-emerald-950' : 'border-gray-700'}`}
                placeholder="hostname"
                title="Host"
              />
              <span className="text-gray-600 text-sm select-none shrink-0">:</span>
              <input
                type="text"
                value={(() => { try { const u = new URL(activeTab.url); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch { return ''; } })()}
                onChange={(e) => {
                  try {
                    const u = new URL(activeTab.url);
                    const port = e.target.value;
                    const defaultPort = u.protocol === 'https:' ? '443' : '80';
                    const portStr = port && port !== defaultPort ? ':' + port : '';
                    updateTab(activeTab.id, { url: `${u.protocol}//${u.hostname}${portStr}${u.pathname}${u.search}${u.hash}` });
                  } catch { /* ignore */ }
                }}
                className={`bg-gray-800 border rounded px-2 py-1 text-sm text-gray-300 font-mono focus:outline-none focus:border-emerald-600 shrink-0 w-14 transition-colors ${appliedFlash?.url ? 'border-emerald-500 bg-emerald-950' : 'border-gray-700'}`}
                placeholder="443"
                title="Port"
              />
              <button
                onClick={goBack}
                disabled={activeTab.history.length === 0 || activeTab.historyIndex === 0}
                className="px-1.5 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:hover:text-gray-400 text-sm shrink-0"
                title={`Back (${activeTab.history.length} entries)`}
              >
                &#9664;
              </button>
              <button
                onClick={goForward}
                disabled={activeTab.historyIndex === -1}
                className="px-1.5 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:hover:text-gray-400 text-sm shrink-0"
                title="Forward"
              >
                &#9654;
              </button>
              <span className="relative inline-block group shrink-0">
                <button
                  onClick={sendRequest}
                  disabled={activeTab.loading}
                  className="px-4 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
                >
                  Send
                </button>
                <span className="absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-0.5 rounded bg-gray-800 text-gray-200 text-[11px] whitespace-nowrap hidden group-hover:block border border-gray-700 shadow-lg" style={{ zIndex: 9999 }}>
                  {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+Enter
                </span>
              </span>
              {activeTab.historyIndex !== -1 && (
                <span className="text-[10px] text-amber-400 shrink-0">
                  {activeTab.historyIndex + 1}/{activeTab.history.length}
                </span>
              )}
            </div>
            <textarea
              value={(() => { try { const u = new URL(activeTab.url); return `${u.pathname}${u.search}${u.hash}`; } catch { return '/'; } })()}
              onChange={(e) => {
                try {
                  const u = new URL(activeTab.url);
                  updateTab(activeTab.id, { url: `${u.protocol}//${u.host}${e.target.value}` });
                } catch { /* ignore */ }
              }}
              rows={1}
              className={`w-full min-w-0 bg-gray-800 border rounded px-2 py-1 text-sm text-gray-300 font-mono focus:outline-none focus:border-emerald-600 resize-none overflow-hidden transition-colors ${appliedFlash?.url ? 'border-emerald-500 bg-emerald-950' : 'border-gray-700'}`}
              style={{ fieldSizing: 'content' as any }}
              placeholder="/path?query=value"
              title="Path + query (clear to send without path)"
            />
          </div>

          <div className="flex-1 flex flex-col p-3 overflow-auto">
            <label className={`text-xs uppercase tracking-wider shrink-0 mb-1 transition-colors ${appliedFlash?.headers ? 'text-emerald-400' : 'text-gray-500'}`}>Headers {appliedFlash?.headers && '(updated)'}</label>
            <textarea
              value={activeTab.headers}
              onChange={(e) => updateTab(activeTab.id, { headers: e.target.value })}
              style={{ fieldSizing: 'content' as any, minHeight: '3em' }}
              className={`w-full bg-gray-900 border rounded p-2 text-sm font-mono text-gray-300 resize-none focus:outline-none focus:border-emerald-600 shrink-0 overflow-hidden transition-colors ${appliedFlash?.headers ? 'border-emerald-500 bg-emerald-950/50' : 'border-gray-800'}`}
              placeholder="Header-Name: value"
            />
            <label className={`text-xs uppercase tracking-wider shrink-0 mt-3 mb-1 transition-colors ${appliedFlash?.body ? 'text-emerald-400' : 'text-gray-500'}`}>Body {appliedFlash?.body && '(updated)'}</label>
            <textarea
              value={activeTab.body}
              onChange={(e) => updateTab(activeTab.id, { body: e.target.value })}
              style={{ fieldSizing: 'content' as any, minHeight: '4em' }}
              className={`w-full bg-gray-900 border rounded p-2 text-sm font-mono text-gray-300 resize-none focus:outline-none focus:border-emerald-600 shrink-0 overflow-hidden transition-colors ${appliedFlash?.body ? 'border-emerald-500 bg-emerald-950/50' : 'border-gray-800'}`}
              placeholder="Request body..."
            />
          </div>
        </div>

        {/* Splitter handle */}
        <div
          onMouseDown={onSplitStart}
          className="w-1 cursor-col-resize bg-gray-800 hover:bg-emerald-600/40 transition-colors shrink-0"
        />

        {/* Response viewer */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {activeTab.response ? (
            <>
              <div className="flex items-center gap-3 px-3 py-2 bg-gray-900/50 border-b border-gray-800 shrink-0">
                <StatusBadge statusCode={activeTab.response.statusCode} />
                <span className="text-xs text-gray-500">{activeTab.response.duration}ms</span>
                <span className="text-xs text-gray-600">
                  {activeTab.response.body.length} bytes
                </span>
                {(() => {
                  const s = activeTab.response.statusCode;
                  const loc = activeTab.response.headers['location'] || activeTab.response.headers['Location'];
                  const locStr = Array.isArray(loc) ? loc[0] : loc;
                  if (s < 300 || s >= 400 || !locStr) return null;
                  let display = String(locStr);
                  try { display = new URL(String(locStr), activeTab.url).toString(); } catch { /* keep raw */ }
                  return (
                    <button
                      onClick={followRedirect}
                      disabled={activeTab.loading}
                      className="ml-auto px-2 py-1 text-[11px] rounded bg-amber-900/40 hover:bg-amber-900 text-amber-300 border border-amber-800 flex items-center gap-1.5 disabled:opacity-50"
                      title={`Follow redirect to ${display}`}
                    >
                      <span>Follow redirect \u2192</span>
                      <span className="text-amber-500/80 font-mono truncate max-w-[260px]">{display}</span>
                    </button>
                  );
                })()}
              </div>
              <div className="flex-1 flex flex-col p-3 overflow-auto">
                <label className="text-xs text-gray-500 uppercase tracking-wider shrink-0 mb-1">Response Headers</label>
                <div className="bg-gray-900 rounded p-2 text-sm space-y-0.5 shrink-0">
                  {Object.entries(activeTab.response.headers).map(([k, v]) => (
                    <div key={k} className="flex">
                      <span className="text-cyan-400 min-w-[150px] shrink-0">{k}:</span>
                      <span className="text-gray-300 break-all">{String(v)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col shrink-0 mt-3">
                  <ResponseBody
                    body={activeTab.response.body}
                    bodyBase64={activeTab.response.bodyBase64}
                    contentType={String(activeTab.response.headers['content-type'] || activeTab.response.headers['Content-Type'] || '')}
                    contentEncoding={String(activeTab.response.headers['content-encoding'] || activeTab.response.headers['Content-Encoding'] || '')}
                    url={activeTab.url}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              Send a request to see the response
            </div>
          )}
        </div>

      </div>
      )}

      {/* AI Test floating bubble */}
      {activeTab && !guidedOpen && (
        <button
          onClick={() => setGuidedOpen(true)}
          className="absolute bottom-4 right-4 z-30 w-12 h-12 rounded-full bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/40 flex items-center justify-center transition-colors"
          title="AI Test"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="M12 2a4 4 0 0 1 4 4v1a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2V6a4 4 0 0 1 4-4z" />
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 14v4" />
          </svg>
        </button>
      )}

      {/* Floating AI Test panel */}
      {guidedOpen && activeTab && (
        <div
          ref={panelRef}
          className="absolute bottom-0 left-0 right-0 flex flex-col bg-gray-950 border-t border-purple-800/60 shadow-[0_-4px_24px_rgba(0,0,0,0.5)] z-20"
          style={{ height: panelHeight }}
        >
          {/* Resize handle */}
          <div
            onMouseDown={onResizeStart}
            className="h-1.5 cursor-ns-resize bg-gray-900 hover:bg-purple-800/40 transition-colors shrink-0"
          />

          {/* Header bar */}
          <div className="flex items-center gap-3 px-4 py-1.5 bg-gray-900/80 border-b border-gray-800 shrink-0">
            <span className="text-xs uppercase tracking-wider text-purple-400 font-semibold">AI Test</span>
            <div className="flex rounded overflow-hidden border border-gray-700">
              <button
                onClick={() => setGuidedMode('guided')}
                className={`px-2.5 py-0.5 text-[11px] font-medium ${guidedMode === 'guided' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-300'}`}
              >
                Guided
              </button>
              <button
                onClick={() => setGuidedMode('auto')}
                className={`px-2.5 py-0.5 text-[11px] font-medium ${guidedMode === 'auto' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-300'}`}
              >
                Auto-Analyze
              </button>
            </div>
            {guidedMode === 'guided' && (
              <select
                value={guidedVulnType}
                onChange={(e) => setGuidedVulnType(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-300"
              >
                {VULN_TYPES.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            )}
            <button
              onClick={startGuidedTest}
              disabled={llm.streaming}
              className="px-3 py-0.5 rounded bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-medium"
            >
              {turns.length === 0
                ? (guidedMode === 'guided' ? 'Start Test' : 'Analyze')
                : 'Restart'}
            </button>
            {!activeTab.response && (
              <span className="text-[10px] text-amber-500">Send request first for best results</span>
            )}
            <button
              onClick={() => setGuidedOpen(false)}
              className="ml-auto text-gray-500 hover:text-gray-300 text-sm"
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 flex overflow-hidden">
            {/* Conversation */}
            <div ref={convoRef} className="flex-1 overflow-auto px-4 py-3 space-y-4 text-sm">
              {turns.length === 0 && !llm.streaming && (
                <div className="text-gray-500 text-xs">
                  {guidedMode === 'guided'
                    ? 'Pick a vulnerability type and click Start. The AI will walk you through testing this request step by step.'
                    : 'Click Analyze to let the AI examine this exchange and suggest what to test.'}
                </div>
              )}
              {turns.map((t, i) => {
                const proposed = t.role === 'assistant' ? parseProposedTest(t.content) : null;
                const displayContent = t.role === 'assistant' ? stripProposedTest(t.content) : t.content;
                return (
                  <div key={i}>
                    <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">
                      {t.role === 'user' ? 'You' : 'AI'}
                    </div>
                    {t.role === 'assistant' ? (
                      <>
                        <div className="ai-prose">
                          <Markdown>{displayContent}</Markdown>
                        </div>
                        {proposed && (
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => applyProposedTest(proposed)}
                              className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium inline-flex items-center gap-1.5"
                            >
                              Apply Test
                              <span className="text-emerald-300 font-mono text-[10px]">{proposed.method} {proposed.path.length > 50 ? proposed.path.slice(0, 50) + '...' : proposed.path}</span>
                            </button>
                            {preApplySnapshot?.tabId === activeTab?.id && (
                              <button
                                onClick={undoApply}
                                className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium"
                              >
                                Undo
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words font-sans text-cyan-300">{displayContent}</pre>
                    )}
                  </div>
                );
              })}
              {llm.streaming && (() => {
                const streamProposed = parseProposedTest(llm.text);
                const streamDisplay = stripProposedTest(llm.text);
                return (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">AI</div>
                    <div className="ai-prose">
                      <Markdown>{streamDisplay}</Markdown>
                      <span className="animate-pulse">▍</span>
                    </div>
                    {streamProposed && (
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => applyProposedTest(streamProposed)}
                          className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium inline-flex items-center gap-1.5"
                        >
                          Apply Test
                          <span className="text-emerald-300 font-mono text-[10px]">{streamProposed.method} {streamProposed.path.length > 50 ? streamProposed.path.slice(0, 50) + '...' : streamProposed.path}</span>
                        </button>
                        {preApplySnapshot?.tabId === activeTab?.id && (
                          <button
                            onClick={undoApply}
                            className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium"
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
              {llm.error && (
                isLLMNotConfigured(llm.error, llm.errorCode)
                  ? <LLMNotConfigured inline />
                  : <div className="text-red-400 text-xs">Error: {llm.error}</div>
              )}
            </div>

            {/* Input sidebar — extracted so keystrokes don't rerender the
                conversation list (which re-renders markdown on each message). */}
            <GuidedChatInput
              disabled={llm.streaming || turns.length === 0}
              prefill={guidedInputPrefill}
              onSend={sendGuidedFollowup}
            />
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (() => {
        const ctxTab = tabs.find((t) => t.id === ctxMenu.tabId);
        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            items={[
              {
                label: 'Rename',
                onClick: () => startRename(ctxMenu.tabId),
              },
              {
                label: 'Add to Scope...',
                onClick: () => {
                  if (ctxTab) {
                    setScopeWizard({ url: ctxTab.url, tabId: ctxTab.id });
                    api.scope.list().then((rules) => setExistingScopeRules(rules as ScopeRule[])).catch(() => {});
                  }
                },
              },
              {
                label: 'Duplicate Tab',
                onClick: () => {
                  if (ctxTab) {
                    const dup = createTab();
                    dup.name = ctxTab.name + ' (copy)';
                    dup.method = ctxTab.method;
                    dup.url = ctxTab.url;
                    dup.headers = ctxTab.headers;
                    dup.body = ctxTab.body;
                    setTabs((prev) => [...prev, dup]);
                    setActiveTabId(dup.id);
                  }
                },
              },
              {
                label: 'Close Tab',
                onClick: () => removeTab(ctxMenu.tabId),
              },
            ]}
          />
        );
      })()}

      {/* Scope wizard modal */}
      {scopeWizard && (() => {
        const options = buildScopeOptions(scopeWizard.url);
        const coverage = checkExistingCoverage(options, existingScopeRules);
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => { setScopeWizard(null); setScopeAdded(null); }}>
            <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[480px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                <h3 className="text-sm font-semibold text-gray-200">Add to Scope</h3>
                <button onClick={() => { setScopeWizard(null); setScopeAdded(null); }} className="text-gray-500 hover:text-gray-300">×</button>
              </div>
              <div className="px-4 py-2 border-b border-gray-800">
                <span className="text-xs text-gray-500">URL: </span>
                <span className="text-xs text-gray-300 font-mono break-all">{scopeWizard.url}</span>
              </div>
              <div className="flex-1 overflow-auto p-2">
                {options.length === 0 ? (
                  <div className="p-4 text-sm text-gray-500 text-center">Invalid URL — cannot build scope rules</div>
                ) : (
                  <div className="space-y-1">
                    {options.map((opt, i) => {
                      const coveredBy = coverage.get(i);
                      return (
                        <button
                          key={i}
                          disabled={scopeLoading || !!coveredBy}
                          onClick={async () => {
                            setScopeLoading(true);
                            try {
                              const result = await api.scope.create(opt.rule);
                              setExistingScopeRules((prev) => [...prev, opt.rule as ScopeRule]);
                              if (result.pendingAnalysisCount > 0) {
                                setPendingAnalysis({ count: result.pendingAnalysisCount, label: opt.label });
                              } else {
                                setScopeAdded(opt.label);
                                setTimeout(() => { setScopeWizard(null); setScopeAdded(null); }, 1200);
                              }
                            } finally {
                              setScopeLoading(false);
                            }
                          }}
                          className={`w-full text-left px-3 py-2 rounded transition-colors group ${
                            coveredBy
                              ? 'opacity-40 cursor-not-allowed'
                              : scopeLoading
                                ? 'opacity-50 pointer-events-none'
                                : 'hover:bg-gray-800'
                          }`}
                        >
                          <div className={`text-sm font-mono ${coveredBy ? 'text-gray-500' : 'text-emerald-400'}`}>{opt.label}</div>
                          <div className="text-xs text-gray-500 group-hover:text-gray-400">
                            {coveredBy || opt.description}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {scopeLoading && (
                <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-400 flex items-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-gray-600 border-t-emerald-400 rounded-full animate-spin" />
                  Adding scope rule and re-evaluating traffic...
                </div>
              )}
              {scopeAdded && !pendingAnalysis && (
                <div className="px-4 py-2 border-t border-gray-800 text-xs text-emerald-400">
                  Added: {scopeAdded}
                </div>
              )}
              {pendingAnalysis && (
                <div className="border-t border-gray-800 px-4 py-3 space-y-2">
                  <div className="text-sm text-gray-200">
                    Scope rule added. <span className="text-amber-400 font-semibold">{pendingAnalysis.count}</span> existing request{pendingAnalysis.count !== 1 ? 's' : ''} {pendingAnalysis.count !== 1 ? 'are' : 'is'} now in scope but {pendingAnalysis.count !== 1 ? 'have' : 'has'} not been analyzed by the AI.
                  </div>
                  <div className="text-xs text-gray-500">
                    Would you like to queue them for LLM analysis? This will use your daily AI budget.
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        await api.scope.analyzePending();
                        setPendingAnalysis(null);
                        setScopeAdded(pendingAnalysis.label + ' (+ queued analysis)');
                        setTimeout(() => { setScopeWizard(null); setScopeAdded(null); }, 1500);
                      }}
                      className="flex-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
                    >
                      Analyze {pendingAnalysis.count} request{pendingAnalysis.count !== 1 ? 's' : ''}
                    </button>
                    <button
                      onClick={() => {
                        setPendingAnalysis(null);
                        setScopeAdded(pendingAnalysis!.label);
                        setTimeout(() => { setScopeWizard(null); setScopeAdded(null); }, 1200);
                      }}
                      className="flex-1 px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm border border-gray-700"
                    >
                      Skip
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

const MAX_FORMAT = 500_000;

function formatAndHighlight(body: string): { html: string | null; formatted: string } {
  const canFormat = body.length <= MAX_FORMAT;

  // JSON
  try {
    const parsed = JSON.parse(body);
    const fmt = JSON.stringify(parsed, null, 2);
    return { html: canFormat ? Prism.highlight(fmt, Prism.languages.json, 'json') : null, formatted: fmt };
  } catch { /* not JSON */ }

  const trimmed = body.trimStart();

  // HTML
  if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || (trimmed.startsWith('<') && trimmed.includes('</'))) {
    const fmt = canFormat ? html_beautify(body, { indent_size: 2, wrap_line_length: 120 }) : body;
    return { html: canFormat ? Prism.highlight(fmt, Prism.languages.markup, 'markup') : null, formatted: fmt };
  }

  // JavaScript
  if (/^(\s*(?:var |let |const |function |class |import |export |\/\/|\/\*|"use strict"|window\.|document\.))/m.test(trimmed) ||
      /\bfunction\s*\(/.test(trimmed)) {
    const fmt = canFormat ? js_beautify(body, { indent_size: 2 }) : body;
    return { html: canFormat ? Prism.highlight(fmt, Prism.languages.javascript, 'javascript') : null, formatted: fmt };
  }

  // CSS
  if (/^[.#@]?[\w-]+\s*\{/m.test(trimmed) || trimmed.startsWith('@media')) {
    const fmt = canFormat ? css_beautify(body, { indent_size: 2 }) : body;
    return { html: canFormat ? Prism.highlight(fmt, Prism.languages.css, 'css') : null, formatted: fmt };
  }

  return { html: null, formatted: body };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function guessExtensionFromContentType(ct: string): string {
  const lower = ct.toLowerCase();
  if (lower.includes('json')) return 'json';
  if (lower.includes('html')) return 'html';
  if (lower.includes('xml')) return 'xml';
  if (lower.includes('javascript')) return 'js';
  if (lower.includes('css')) return 'css';
  if (lower.startsWith('image/png')) return 'png';
  if (lower.startsWith('image/jpeg') || lower.startsWith('image/jpg')) return 'jpg';
  if (lower.startsWith('image/gif')) return 'gif';
  if (lower.startsWith('image/webp')) return 'webp';
  if (lower.startsWith('image/svg')) return 'svg';
  if (lower.startsWith('application/pdf')) return 'pdf';
  if (lower.startsWith('text/')) return 'txt';
  return 'bin';
}

function triggerDownload(bytes: Uint8Array, filename: string, mime: string) {
  // Copy into a fresh ArrayBuffer so TS is happy (Uint8Array<ArrayBufferLike> issue)
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ResponseBody({ body, bodyBase64, contentType, contentEncoding, url }: { body: string; bodyBase64?: string; contentType?: string; contentEncoding?: string; url?: string }) {
  const [renderMode, setRenderMode] = useState<'source' | 'rendered'>('source');

  if (!body && !bodyBase64) {
    return (
      <div>
        <label className="text-xs text-gray-500 uppercase tracking-wider">Response Body</label>
        <p className="text-xs text-gray-600 italic mt-2">Empty body</p>
      </div>
    );
  }

  const ct = (contentType || '').toLowerCase();
  const ce = (contentEncoding || '').toLowerCase().trim();
  const isImage = ct.startsWith('image/');
  const isHtml = ct.includes('text/html');
  const canRender = isImage || isHtml;
  const effectiveMode = isImage && !body ? 'rendered' : renderMode;
  const isGzip = ce === 'gzip' || ce === 'x-gzip';
  const isDeflate = ce === 'deflate';
  const compressionExt = isGzip ? 'gz' : isDeflate ? 'deflate' : ce === 'br' ? 'br' : '';

  const { html, formatted } = formatAndHighlight(body);

  const baseName = (() => {
    try {
      if (!url) return 'response';
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return (last || u.hostname || 'response').replace(/[^\w.\-]/g, '_').slice(0, 80) || 'response';
    } catch { return 'response'; }
  })();
  const ext = guessExtensionFromContentType(ct);
  const rawFilename = compressionExt
    ? `${baseName}.${ext}.${compressionExt}`
    : `${baseName}.${ext}`;

  const downloadRaw = () => {
    if (!bodyBase64) return;
    const bytes = base64ToBytes(bodyBase64);
    triggerDownload(bytes, rawFilename, contentType || 'application/octet-stream');
  };

  const downloadDecoded = async () => {
    if (!bodyBase64) return;
    const bytes = base64ToBytes(bodyBase64);
    try {
      const format = isGzip ? 'gzip' : 'deflate';
      // @ts-ignore — DecompressionStream exists in modern browsers but types may lag
      const ds = new DecompressionStream(format);
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
      const decompressed = await new Response(stream).arrayBuffer();
      triggerDownload(new Uint8Array(decompressed), `${baseName}.${ext}`, contentType || 'application/octet-stream');
    } catch (err) {
      console.error('[replay] decompression failed:', err);
      alert(`Decompression failed: ${(err as Error).message}. Downloading raw bytes instead.`);
      downloadRaw();
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <label className="text-xs text-gray-500 uppercase tracking-wider">Response Body</label>
        {ce && (
          <span className="text-[10px] font-mono text-amber-500 bg-amber-950/30 border border-amber-900/40 rounded px-1.5 py-0.5">
            {ce}
          </span>
        )}
        {canRender && (
          <div className="flex rounded border border-gray-700 overflow-hidden">
            <button
              onClick={() => setRenderMode('source')}
              className={`px-1.5 py-0.5 text-[10px] ${effectiveMode === 'source' ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-600 hover:text-gray-400'}`}
            >
              Source
            </button>
            <button
              onClick={() => setRenderMode('rendered')}
              className={`px-1.5 py-0.5 text-[10px] ${effectiveMode === 'rendered' ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-600 hover:text-gray-400'}`}
            >
              {isImage ? 'Image' : 'Rendered'}
            </button>
          </div>
        )}
        {bodyBase64 && (
          <div className="ml-auto flex items-center gap-1">
            {(isGzip || isDeflate) && (
              <button
                onClick={downloadDecoded}
                className="px-2 py-0.5 text-[10px] rounded bg-emerald-900/40 hover:bg-emerald-900 text-emerald-300 border border-emerald-800"
                title={`Decompress ${ce} and save`}
              >
                Download decoded
              </button>
            )}
            <button
              onClick={downloadRaw}
              className="px-2 py-0.5 text-[10px] rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
              title={`Save raw response bytes${compressionExt ? ` (${compressionExt})` : ''}`}
            >
              Download
            </button>
          </div>
        )}
      </div>
      {effectiveMode === 'rendered' && isImage && bodyBase64 ? (
        <div className="bg-gray-900 rounded p-2 flex items-center justify-center">
          <img src={`data:${contentType};base64,${bodyBase64}`} alt="Response" className="max-w-full max-h-80 object-contain" />
        </div>
      ) : effectiveMode === 'rendered' && isHtml ? (
        <iframe srcDoc={body} sandbox="" className="w-full h-80 bg-white rounded border border-gray-700" title="Rendered HTML" />
      ) : html ? (
        <pre className="bg-gray-900 rounded p-2 text-xs text-gray-300 whitespace-pre-wrap break-all mt-1">
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre className="bg-gray-900 rounded p-2 text-xs text-gray-300 whitespace-pre-wrap break-all mt-1">
          {formatted}
        </pre>
      )}
    </div>
  );
}
