import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-xml-doc';
import { js_beautify, html_beautify, css_beautify } from 'js-beautify';
import { api } from '../api/client';
import { wsClient } from '../api/ws';
import { StatusBadge } from '../components/shared/StatusBadge';
import { ContextMenu } from '../components/shared/ContextMenu';
import { appEvents } from '../events/appEvents';
import { useNavigate } from '../App';
import { buildScopeOptions, checkExistingCoverage, type ScopeRule } from '../utils/scopeOptions';
import type { ExchangeSummary } from '@sniff/shared';

type SortKey = 'method' | 'host' | 'path' | 'status' | 'size' | 'time' | 'timestamp';
type SortDir = 'asc' | 'desc';

// Persist filter state across tab switches (module-level, survives remounts)
const persistedFilters = {
  searchText: '',
  methodFilter: '',
  statusFilter: '',
  hostFilter: '',
  scopeFilter: 'all' as 'all' | 'in' | 'out',
  sortKey: 'timestamp' as SortKey,
  sortDir: 'desc' as SortDir,
  hidePatterns: [] as string[],
};
let filtersLoadedFromDb = false;
let filterSaveTimer: ReturnType<typeof setTimeout> | null = null;

function saveFiltersToDb() {
  if (filterSaveTimer) clearTimeout(filterSaveTimer);
  filterSaveTimer = setTimeout(() => {
    const { searchText: _s, ...toSave } = persistedFilters; // don't persist search text
    api.settings.set('ui_history_filters', JSON.stringify(toSave)).catch(() => {});
  }, 500);
}

interface ExchangeDetail {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode: number | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  requestBodyBase64: string | null;
  requestBodyTruncated?: boolean;
  requestBodyFullSize?: number;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  responseBodyBase64: string | null;
  responseBodyTruncated?: boolean;
  responseBodyFullSize?: number;
  duration: number | null;
  timestamp: string;
  notes: string | null;
  tags: string[];
}

interface SearchResult extends ExchangeSummary {
  matchField?: string;
}

let persistedSelected: ExchangeDetail | null = null;

const DEFAULT_COL_WIDTHS: Record<string, number> = {
  method: 72,
  host: 180,
  path: 260,
  status: 72,
  size: 80,
  time: 68,
  match: 110,
  timestamp: 120,
};

function highlightText(text: string, term: string | undefined): React.ReactNode {
  if (!term) return text;
  // Safety: skip highlighting on very large text to avoid creating thousands of React nodes
  if (text.length > 200_000) return text;
  const lower = text.toLowerCase();
  const tLower = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let pos = 0;
  let i = 0;
  const MAX_MARKS = 2000;
  while ((pos = lower.indexOf(tLower, last)) !== -1 && i < MAX_MARKS) {
    if (pos > last) parts.push(text.slice(last, pos));
    parts.push(<mark key={i++} className="bg-yellow-500/40 text-yellow-200 rounded-sm px-0">{text.slice(pos, pos + term.length)}</mark>);
    last = pos + term.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? <>{parts}</> : text;
}

function HeadersTable({ headers, title, highlight }: { headers: Record<string, string>; title?: string; highlight?: string }) {
  return (
    <div>
      {title && <h4 className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">{title}</h4>}
      <table className="w-full text-xs border-collapse">
        <tbody>
          {Object.entries(headers).map(([key, value]) => (
            <tr key={key} className="border-b border-gray-800/40">
              <td className="py-1 pr-3 text-emerald-400 font-mono whitespace-nowrap align-top select-all">{highlightText(key, highlight)}</td>
              <td className="py-1 text-gray-300 font-mono break-all select-all">{highlightText(value, highlight)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Max bytes for prettification (50KB) and syntax highlighting (100KB).
// Beyond these thresholds, show raw text to avoid freezing the UI.
const MAX_BEAUTIFY = 500_000;
const MAX_HIGHLIGHT = 500_000;

type DetectedBody = { formatted: string; grammar: Prism.Grammar | null; lang: string };

function detectAndFormat(body: string): DetectedBody {
  const canBeautify = body.length <= MAX_BEAUTIFY;

  // Try JSON
  try {
    const parsed = JSON.parse(body);
    return { formatted: JSON.stringify(parsed, null, 2), grammar: Prism.languages.json, lang: 'json' };
  } catch { /* not JSON */ }

  const trimmed = body.trimStart();

  // HTML/XML
  if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<div') || trimmed.startsWith('<?xml') || (trimmed.startsWith('<') && trimmed.includes('</'))) {
    const fmt = canBeautify ? html_beautify(body, { indent_size: 2, wrap_line_length: 120 }) : body;
    return { formatted: fmt, grammar: Prism.languages.markup, lang: 'markup' };
  }

  // JavaScript
  if (/^(\s*(?:var |let |const |function |class |import |export |\/\/|\/\*|"use strict"|window\.|document\.))/m.test(trimmed) ||
      /\bfunction\s*\(/.test(trimmed)) {
    const fmt = canBeautify ? js_beautify(body, { indent_size: 2 }) : body;
    return { formatted: fmt, grammar: Prism.languages.javascript, lang: 'javascript' };
  }

  // CSS
  if (/^[.#@]?[\w-]+\s*\{/m.test(trimmed) || trimmed.startsWith('@media') || trimmed.startsWith('@import')) {
    const fmt = canBeautify ? css_beautify(body, { indent_size: 2 }) : body;
    return { formatted: fmt, grammar: Prism.languages.css, lang: 'css' };
  }

  return { formatted: body, grammar: null, lang: 'text' };
}

function getContentTypeCategory(contentType: string | null | undefined): 'image' | 'html' | null {
  if (!contentType) return null;
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.includes('text/html')) return 'html';
  return null;
}

// Is this body URL-encoded form data? Checks content-type first, falls back to shape heuristic.
function isUrlEncoded(body: string, contentType: string | null | undefined): boolean {
  if (contentType && contentType.toLowerCase().includes('application/x-www-form-urlencoded')) return true;
  // Heuristic fallback for missing/wrong content-type: single line, has k=v pairs separated by &
  if (!body || body.length > 50_000) return false;
  if (/[\r\n]/.test(body.trim())) return false;
  if (!/=/.test(body)) return false;
  // Must not look like JSON/HTML/XML
  const t = body.trimStart();
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('<')) return false;
  const pairs = body.split('&');
  if (pairs.length < 1) return false;
  return pairs.every((p) => /^[A-Za-z0-9_\-.%+\[\]]+(=[^&]*)?$/.test(p));
}

function parseUrlEncoded(body: string): Array<{ key: string; value: string }> {
  return body.split('&').map((pair) => {
    const idx = pair.indexOf('=');
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawValue = idx === -1 ? '' : pair.slice(idx + 1);
    const safeDecode = (s: string) => {
      try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
    };
    return { key: safeDecode(rawKey), value: safeDecode(rawValue) };
  });
}

function BodyBlock({ body, bodyBase64, label, contentType, truncated, fullSize, onLoadFull, highlight }: {
  body: string | null;
  bodyBase64?: string | null;
  label?: string;
  contentType?: string | null;
  truncated?: boolean;
  fullSize?: number;
  onLoadFull?: () => void;
  highlight?: string;
}) {
  const category = getContentTypeCategory(contentType);
  const urlEncoded = body ? isUrlEncoded(body, contentType) : false;
  const [renderMode, setRenderMode] = useState<'source' | 'rendered' | 'form'>(urlEncoded ? 'form' : 'source');

  if (!body && !bodyBase64) {
    return <p className="text-xs text-gray-600 italic mt-2">{label ? `No ${label.toLowerCase()}` : 'No body'}</p>;
  }

  const canRender = category === 'image' || category === 'html';

  // For images with no text body, default to rendered
  const effectiveMode = category === 'image' && !body ? 'rendered' : renderMode;

  const { formatted, grammar, lang } = body ? detectAndFormat(body) : { formatted: '', grammar: null, lang: 'text' };
  const canHighlight = grammar && formatted.length <= MAX_HIGHLIGHT;

  // When search highlighting is active, skip Prism to use text-based highlighting instead
  const useSearchHighlight = highlight && formatted;
  const prismHighlighted = canHighlight && !useSearchHighlight ? Prism.highlight(formatted, grammar!, lang) : null;

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 mb-1">
        {label && <h4 className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</h4>}
        {canRender && (
          <div className="flex rounded border border-gray-700 overflow-hidden">
            <button
              onClick={() => setRenderMode('source')}
              className={`px-1.5 py-0.5 text-[10px] ${effectiveMode === 'source' ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-600 hover:text-gray-400'}`}
            >
              Source
            </button>
            <button
              onClick={() => {
                setRenderMode('rendered');
                if (truncated && onLoadFull) onLoadFull();
              }}
              className={`px-1.5 py-0.5 text-[10px] ${effectiveMode === 'rendered' ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-600 hover:text-gray-400'}`}
            >
              {category === 'image' ? 'Image' : 'Rendered'}
            </button>
          </div>
        )}
        {urlEncoded && (
          <div className="flex rounded border border-gray-700 overflow-hidden">
            <button
              onClick={() => setRenderMode('form')}
              className={`px-1.5 py-0.5 text-[10px] ${effectiveMode === 'form' ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-600 hover:text-gray-400'}`}
            >
              Form
            </button>
            <button
              onClick={() => setRenderMode('source')}
              className={`px-1.5 py-0.5 text-[10px] ${effectiveMode === 'source' ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-600 hover:text-gray-400'}`}
            >
              Raw
            </button>
          </div>
        )}
      </div>

      {effectiveMode === 'form' && body ? (
        <div className="bg-gray-950 rounded p-2 max-h-96 overflow-auto">
          <table className="w-full text-xs font-mono border-separate border-spacing-y-0.5">
            <tbody>
              {parseUrlEncoded(body).map((f, i) => (
                <tr key={i} className="align-top">
                  <td className="text-cyan-400 pr-3 whitespace-nowrap align-top w-1 break-all">{f.key}</td>
                  <td className="text-gray-300 break-all select-all">{f.value || <span className="text-gray-600 italic">(empty)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : effectiveMode === 'rendered' && category === 'image' && bodyBase64 ? (
        <div className="bg-gray-950 rounded p-2 max-h-96 overflow-auto flex items-center justify-center">
          <img
            src={`data:${contentType || 'image/png'};base64,${bodyBase64}`}
            alt="Response body"
            className="max-w-full max-h-80 object-contain"
          />
        </div>
      ) : effectiveMode === 'rendered' && category === 'html' && body ? (
        <iframe
          srcDoc={body}
          sandbox=""
          className="w-full h-80 bg-white rounded border border-gray-700"
          title="Rendered HTML"
        />
      ) : prismHighlighted ? (
        <pre className="bg-gray-950 rounded p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto select-all text-gray-300">
          <code dangerouslySetInnerHTML={{ __html: prismHighlighted }} />
        </pre>
      ) : (
        <pre className="bg-gray-950 rounded p-2 text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto select-all text-gray-300">
          {highlightText(formatted, highlight)}
        </pre>
      )}
      {truncated && (
        <div className="flex items-center gap-2 mt-1 px-2 py-1.5 bg-amber-950/30 border border-amber-900/40 rounded text-xs">
          <span className="text-amber-400">
            Showing first 50KB of {fullSize ? `${(fullSize / 1024).toFixed(0)}KB` : 'large body'}
          </span>
          {onLoadFull && (
            <button
              onClick={onLoadFull}
              className="px-2 py-0.5 rounded bg-amber-800 hover:bg-amber-700 text-amber-200 text-xs font-medium"
            >
              Load full
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Serialize the captured request back to an HTTP/1.1 request as it would
// have been sent on the wire: request line, headers, blank line, body.
function generateRawRequest(detail: ExchangeDetail): string {
  let pathAndQuery = '/';
  try {
    const u = new URL(detail.url);
    pathAndQuery = `${u.pathname}${u.search}` || '/';
  } catch {
    pathAndQuery = detail.url;
  }
  const lines = [`${detail.method} ${pathAndQuery} HTTP/1.1`];
  for (const [k, v] of Object.entries(detail.requestHeaders)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('');
  lines.push(detail.requestBody || '');
  return lines.join('\r\n');
}

function generateCurl(detail: ExchangeDetail): string {
  const parts = ['curl'];
  if (detail.method !== 'GET') {
    parts.push(`-X ${detail.method}`);
  }
  parts.push(`'${detail.url}'`);
  for (const [key, value] of Object.entries(detail.requestHeaders)) {
    parts.push(`-H '${key}: ${value}'`);
  }
  if (detail.requestBody) {
    parts.push(`--data-raw '${detail.requestBody.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n  ');
}

function HidePatternInput({ onAdd }: { onAdd: (pattern: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Hide pattern..."
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 placeholder-gray-600 w-28 focus:outline-none focus:border-red-600"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const val = value.trim();
          if (val) {
            onAdd(val);
            setValue('');
          }
        }
      }}
    />
  );
}

export function HistoryPage() {
  const navigate = useNavigate();
  const [exchanges, setExchanges] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, _setSelected] = useState<ExchangeDetail | null>(persistedSelected);
  const setSelected = (v: ExchangeDetail | null) => { persistedSelected = v; _setSelected(v); };
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  // Once the detail panel opens (or the selection changes), the table viewport
  // shrinks. Scroll the clicked row back into the visible portion so it isn't
  // hidden behind the panel. `block: 'nearest'` is a no-op when the row is
  // already fully visible, so it doesn't disrupt rows the user can already see.
  useEffect(() => {
    if (!selected) return;
    const container = tableScrollRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(`[data-row-id="${selected.id}"]`);
    if (!row) return;
    // Defer to next frame so the panel mount has settled and the container's
    // visible height reflects the new layout.
    requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [selected?.id]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; exchangeId: string } | null>(null);
  const [scopeWizardUrl, setScopeWizardUrl] = useState<string | null>(null);
  const [scopeAdded, setScopeAdded] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [existingScopeRules, setExistingScopeRules] = useState<ScopeRule[]>([]);
  const [pendingAnalysis, setPendingAnalysis] = useState<{ count: number; label: string } | null>(null);

  // Column widths for resizable columns
  const [colWidths, setColWidths] = useState<Record<string, number>>({ ...DEFAULT_COL_WIDTHS });
  const dragRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  // Resizable detail panel height (px)
  const [detailHeight, setDetailHeight] = useState(380);
  const detailDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onDetailResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    detailDragRef.current = { startY: e.clientY, startHeight: detailHeight };
    const onMove = (ev: MouseEvent) => {
      if (!detailDragRef.current) return;
      const delta = detailDragRef.current.startY - ev.clientY;
      const next = Math.max(120, Math.min(window.innerHeight - 200, detailDragRef.current.startHeight + delta));
      setDetailHeight(next);
    };
    const onUp = () => {
      detailDragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [detailHeight]);

  // Sorting (restored from persisted state)
  const [sortKey, setSortKeyRaw] = useState<SortKey>(persistedFilters.sortKey);
  const [sortDir, setSortDirRaw] = useState<SortDir>(persistedFilters.sortDir);

  // Filters (restored from persisted state)
  const [searchText, setSearchTextRaw] = useState(persistedFilters.searchText);

  const [methodFilter, setMethodFilterRaw] = useState(persistedFilters.methodFilter);
  const [statusFilter, setStatusFilterRaw] = useState(persistedFilters.statusFilter);
  const [hostFilter, setHostFilterRaw] = useState(persistedFilters.hostFilter);
  const [scopeFilter, setScopeFilterRaw] = useState<'all' | 'in' | 'out'>(persistedFilters.scopeFilter);

  // Load filters from DB on first mount
  useEffect(() => {
    if (filtersLoadedFromDb) return;
    filtersLoadedFromDb = true;
    api.settings.getAll().then((all) => {
      const raw = all['ui_history_filters'];
      if (!raw) return;
      try {
        const saved = JSON.parse(raw);
        if (saved.methodFilter) { persistedFilters.methodFilter = saved.methodFilter; setMethodFilterRaw(saved.methodFilter); }
        if (saved.statusFilter) { persistedFilters.statusFilter = saved.statusFilter; setStatusFilterRaw(saved.statusFilter); }
        if (saved.hostFilter) { persistedFilters.hostFilter = saved.hostFilter; setHostFilterRaw(saved.hostFilter); }
        if (saved.scopeFilter) { persistedFilters.scopeFilter = saved.scopeFilter; setScopeFilterRaw(saved.scopeFilter); }
        if (saved.sortKey) { persistedFilters.sortKey = saved.sortKey; setSortKeyRaw(saved.sortKey); }
        if (saved.sortDir) { persistedFilters.sortDir = saved.sortDir; setSortDirRaw(saved.sortDir); }
        if (saved.hidePatterns) { persistedFilters.hidePatterns = saved.hidePatterns; setHidePatternsRaw(saved.hidePatterns); }
      } catch { /* ignore */ }
    }).catch(() => {});
  }, []);

  // Wrap setters to persist across remounts + DB
  const setSearchText = (v: string) => { persistedFilters.searchText = v; setSearchTextRaw(v); };
  const setMethodFilter = (v: string) => { persistedFilters.methodFilter = v; setMethodFilterRaw(v); saveFiltersToDb(); };
  const setStatusFilter = (v: string) => { persistedFilters.statusFilter = v; setStatusFilterRaw(v); saveFiltersToDb(); };
  const setHostFilter = (v: string) => { persistedFilters.hostFilter = v; setHostFilterRaw(v); saveFiltersToDb(); };
  const setScopeFilter = (v: 'all' | 'in' | 'out') => { persistedFilters.scopeFilter = v; setScopeFilterRaw(v); saveFiltersToDb(); };
  const setSortKey = (v: SortKey) => { persistedFilters.sortKey = v; setSortKeyRaw(v); saveFiltersToDb(); };
  const setSortDir = (v: SortDir) => { persistedFilters.sortDir = v; setSortDirRaw(v); saveFiltersToDb(); };
  const [hidePatterns, setHidePatternsRaw] = useState<string[]>(persistedFilters.hidePatterns);
  const setHidePatterns = (v: string[] | ((prev: string[]) => string[])) => {
    setHidePatternsRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      persistedFilters.hidePatterns = next;
      saveFiltersToDb();
      return next;
    });
  };
  const addHidePattern = (pattern: string) => {
    if (!hidePatterns.includes(pattern)) setHidePatterns((prev) => [...prev, pattern]);
  };
  const removeHidePattern = (pattern: string) => {
    setHidePatterns((prev) => prev.filter((p) => p !== pattern));
  };

  const sendToReplay = async (id: string) => {
    const detail = await api.history.get(id) as ExchangeDetail;
    appEvents.emit('send-to-replay', {
      method: detail.method,
      url: detail.url,
      headers: detail.requestHeaders,
      body: detail.requestBody,
    });
    navigate('replay');
  };

  // Sequence counter so late-arriving responses (e.g. initial fetch before the
  // DB-persisted filter arrived) can't overwrite newer, correctly-filtered data.
  const loadSeqRef = useRef(0);
  const loadHistory = useCallback(async () => {
    const mySeq = ++loadSeqRef.current;
    if (searchText.trim()) {
      const params: Record<string, string> = { page: String(page), limit: '100' };
      if (scopeFilter === 'in') params.inScope = 'true';
      if (scopeFilter === 'out') params.inScope = 'false';
      if (hidePatterns.length > 0) params.hide = hidePatterns.join(',');

      const result = await api.history.search(searchText, params);
      if (mySeq !== loadSeqRef.current) return;
      setExchanges(result.data as SearchResult[]);
      setTotal(result.total);
    } else {
      const params: Record<string, string> = { page: String(page), limit: '100' };
      if (methodFilter) params.method = methodFilter;
      if (statusFilter) params.statusCode = statusFilter;
      if (hostFilter) params.host = hostFilter;
      if (scopeFilter === 'in') params.inScope = 'true';
      if (scopeFilter === 'out') params.inScope = 'false';
      if (hidePatterns.length > 0) params.hide = hidePatterns.join(',');

      const result = await api.history.list(params);
      if (mySeq !== loadSeqRef.current) return;
      setExchanges(result.data as SearchResult[]);
      setTotal(result.total);
    }
  }, [page, searchText, methodFilter, statusFilter, hostFilter, scopeFilter, hidePatterns]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Live updates: prepend new exchanges and patch updates as they stream in.
  // Disabled when paginated past page 1, or when an active search query is present
  // (results are server-side ranked and live insertion would be misleading).
  useEffect(() => {
    if (page !== 1 || searchText.trim()) return;

    const matchesFilters = (ex: ExchangeSummary): boolean => {
      if (methodFilter && ex.method !== methodFilter) return false;
      if (statusFilter && String(ex.statusCode) !== statusFilter) return false;
      if (hostFilter && !ex.host.toLowerCase().includes(hostFilter.toLowerCase())) return false;
      if (searchText && !ex.path.toLowerCase().includes(searchText.toLowerCase()) && !ex.host.toLowerCase().includes(searchText.toLowerCase())) return false;
      if (scopeFilter === 'in' && !ex.inScope) return false;
      if (scopeFilter === 'out' && ex.inScope) return false;
      // Apply hide patterns to live updates too
      if (hidePatterns.length > 0) {
        const haystack = `${ex.method} ${ex.host} ${ex.path}`.toLowerCase();
        for (const p of hidePatterns) {
          if (haystack.includes(p.toLowerCase())) return false;
        }
      }
      return true;
    };

    const unsubNew = wsClient.on('traffic:new', (data) => {
      if (!matchesFilters(data)) return;
      setExchanges((prev) => {
        if (prev.some((e) => e.id === data.id)) return prev;
        return [data as SearchResult, ...prev].slice(0, 100);
      });
      setTotal((t) => t + 1);
    });

    const unsubUpdate = wsClient.on('traffic:update', (data) => {
      setExchanges((prev) => {
        const idx = prev.findIndex((e) => e.id === data.id);
        if (idx === -1) return prev; // not in current list — skip re-render
        const updated = [...prev];
        updated[idx] = { ...updated[idx], statusCode: data.statusCode, responseSize: data.responseSize, duration: data.duration };
        return updated;
      });
    });

    return () => {
      unsubNew();
      unsubUpdate();
    };
  }, [page, methodFilter, statusFilter, hostFilter, searchText, scopeFilter, hidePatterns]);

  // Apply client-side sorting on top of whatever the server returned
  const sortedExchanges = useMemo(() => {
    const sorted = [...exchanges];
    const dir = sortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      const av: string | number = (() => {
        switch (sortKey) {
          case 'method': return a.method;
          case 'host': return a.host;
          case 'path': return a.path;
          case 'status': return a.statusCode ?? -1;
          case 'size': return a.responseSize ?? -1;
          case 'time': return a.duration ?? -1;
          case 'timestamp': return new Date(a.timestamp).getTime();
        }
      })();
      const bv: string | number = (() => {
        switch (sortKey) {
          case 'method': return b.method;
          case 'host': return b.host;
          case 'path': return b.path;
          case 'status': return b.statusCode ?? -1;
          case 'size': return b.responseSize ?? -1;
          case 'time': return b.duration ?? -1;
          case 'timestamp': return new Date(b.timestamp).getTime();
        }
      })();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return sorted;
  }, [exchanges, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      const next = sortDir === 'asc' ? 'desc' : 'asc';
      setSortDir(next);
    } else {
      setSortKey(key);
      setSortDir(key === 'timestamp' ? 'desc' : 'asc');
    }
  };

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [searchText, methodFilter, statusFilter, hostFilter, scopeFilter]);

  const loadDetail = async (id: string) => {
    const detail = await api.history.get(id, true) as ExchangeDetail;
    setSelected(detail);
  };

  const loadFullBody = async () => {
    if (!selected) return;
    const detail = await api.history.get(selected.id) as ExchangeDetail;
    setSelected(detail);
  };

  const clearHistory = async () => {
    await api.history.clear();
    setExchanges([]);
    setTotal(0);
    setSelected(null);
  };

  // Column resize handlers
  const onResizeStart = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { col, startX: e.clientX, startWidth: colWidths[col] ?? DEFAULT_COL_WIDTHS[col] ?? 100 };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      const newWidth = Math.max(40, dragRef.current.startWidth + delta);
      setColWidths((prev) => ({ ...prev, [dragRef.current!.col]: newWidth }));
    };

    const onMouseUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [colWidths]);

  const hasActiveFilters = searchText || methodFilter || statusFilter || hostFilter || scopeFilter !== 'all' || hidePatterns.length > 0;

  const colStyle = (col: string): React.CSSProperties => ({
    width: colWidths[col] ?? DEFAULT_COL_WIDTHS[col],
    minWidth: 40,
    maxWidth: 600,
  });

  const resizeHandle = (col: string) => (
    <div
      onMouseDown={(e) => onResizeStart(col, e)}
      style={{ cursor: 'col-resize', width: 4, position: 'absolute', right: 0, top: 0, bottom: 0, zIndex: 1 }}
      className="hover:bg-emerald-600/50"
    />
  );

  // Columns list for the header
  const columns: { key: SortKey; label: string; align: 'left' | 'right' | 'center' }[] = [
    { key: 'method', label: 'Method', align: 'left' },
    { key: 'host', label: 'Host', align: 'left' },
    { key: 'path', label: 'Path', align: 'left' },
    { key: 'status', label: 'Status', align: 'left' },
    { key: 'size', label: 'Size', align: 'right' },
    { key: 'time', label: 'Time', align: 'right' },
  ];

  const sortIndicator = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Bottom detail panel render — debounce highlighting to avoid freezing on large bodies
  const [reqSearch, setReqSearch] = useState('');
  const [resSearch, setResSearch] = useState('');
  const [reqHighlight, setReqHighlight] = useState('');
  const [resHighlight, setResHighlight] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setReqHighlight(reqSearch.trim()), 200);
    return () => clearTimeout(t);
  }, [reqSearch]);
  useEffect(() => {
    const t = setTimeout(() => setResHighlight(resSearch.trim()), 200);
    return () => clearTimeout(t);
  }, [resSearch]);

  const renderDetailPanel = () => {
    if (!selected) return null;

    return (
      <div style={{ height: detailHeight }} className="border-t border-gray-800 flex flex-col bg-gray-900/50 shrink-0 relative">
        {/* Resize handle */}
        <div
          onMouseDown={onDetailResizeStart}
          className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize hover:bg-emerald-600/40 z-10"
          title="Drag to resize"
        />
        {/* Close button */}
        <button
          onClick={() => { setSelected(null); setReqSearch(''); setResSearch(''); }}
          className="absolute top-1 right-2 z-20 text-gray-600 hover:text-gray-300 text-sm px-1"
          title="Close"
        >
          ×
        </button>
        {/* Content */}
        <div className="flex-1 overflow-hidden flex divide-x divide-gray-800">
          {/* Request side */}
          <div className="flex-1 overflow-auto p-3 min-w-0">
            <div className="flex items-center gap-2 mb-2 sticky top-0 bg-gray-900/90 py-1 z-[1]">
              <h3 className="text-[11px] text-blue-400 uppercase tracking-wider font-bold">
                Request
              </h3>
              <button
                onClick={() => copyToClipboard(generateRawRequest(selected))}
                className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500"
                title="Copy the raw HTTP request (method, headers, body)"
              >
                Copy request
              </button>
              <div className="flex-1" />
              <input
                type="text"
                value={reqSearch}
                onChange={(e) => setReqSearch(e.target.value)}
                placeholder="Search request..."
                className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-[11px] text-gray-300 placeholder-gray-600 w-40 focus:outline-none focus:border-blue-600"
              />
              {reqSearch && (
                <button onClick={() => setReqSearch('')} className="text-gray-600 hover:text-gray-400 text-xs">×</button>
              )}
            </div>
            <HeadersTable headers={selected.requestHeaders} highlight={reqHighlight} />
            <BodyBlock
              body={selected.requestBody}
              bodyBase64={selected.requestBodyBase64}
              label="Body"
              contentType={selected.requestHeaders['content-type'] || selected.requestHeaders['Content-Type']}
              truncated={selected.requestBodyTruncated}
              fullSize={selected.requestBodyFullSize}
              onLoadFull={loadFullBody}
              highlight={reqHighlight}
            />
          </div>

          {/* Response side */}
          <div className="flex-1 overflow-auto p-3 min-w-0">
            <div className="flex items-center gap-2 mb-2 sticky top-0 bg-gray-900/90 py-1 z-[1]">
              <h3 className="text-[11px] text-emerald-400 uppercase tracking-wider font-bold">
                Response
              </h3>
              {selected.statusCode && <StatusBadge statusCode={selected.statusCode} />}
              {selected.statusCode && selected.statusCode >= 300 && selected.statusCode < 400 && selected.responseHeaders && (
                <span className="text-[10px] text-amber-400 font-mono truncate max-w-[300px]" title={selected.responseHeaders['location'] || selected.responseHeaders['Location'] || ''}>
                  → {selected.responseHeaders['location'] || selected.responseHeaders['Location'] || '(no location)'}
                </span>
              )}
              {selected.duration != null && (
                <span className="text-[10px] text-gray-600">{selected.duration}ms</span>
              )}
              <div className="flex-1" />
              <input
                type="text"
                value={resSearch}
                onChange={(e) => setResSearch(e.target.value)}
                placeholder="Search response..."
                className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-[11px] text-gray-300 placeholder-gray-600 w-40 focus:outline-none focus:border-emerald-600"
              />
              {resSearch && (
                <button onClick={() => setResSearch('')} className="text-gray-600 hover:text-gray-400 text-xs">×</button>
              )}
            </div>
            {selected.responseHeaders && (
              <HeadersTable headers={selected.responseHeaders} highlight={resHighlight} />
            )}
            <BodyBlock
              body={selected.responseBody}
              bodyBase64={selected.responseBodyBase64}
              label="Body"
              contentType={selected.responseHeaders?.['content-type'] || selected.responseHeaders?.['Content-Type']}
              truncated={selected.responseBodyTruncated}
              fullSize={selected.responseBodyFullSize}
              onLoadFull={loadFullBody}
              highlight={resHighlight}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-900 border-b border-gray-800 flex-wrap">
        {/* Search */}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadHistory()}
            placeholder="Search all fields..."
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 placeholder-gray-600 w-72 focus:outline-none focus:border-emerald-600"
          />
        </div>

        {/* Method filter */}
        <select
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
        >
          <option value="">All Methods</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        {/* Status code filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
        >
          <option value="">All Status</option>
          <option value="200">200</option>
          <option value="201">201</option>
          <option value="301">301</option>
          <option value="302">302</option>
          <option value="400">400</option>
          <option value="401">401</option>
          <option value="403">403</option>
          <option value="404">404</option>
          <option value="500">500</option>
        </select>

        {/* Host filter */}
        <input
          type="text"
          value={hostFilter}
          onChange={(e) => setHostFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && loadHistory()}
          placeholder="Host..."
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 placeholder-gray-600 w-32 focus:outline-none focus:border-emerald-600"
        />

        {/* Scope filter */}
        <div className="flex rounded border border-gray-700 overflow-hidden">
          {(['all', 'in', 'out'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScopeFilter(s)}
              className={`px-2 py-1 text-[10px] ${
                scopeFilter === s
                  ? s === 'in' ? 'bg-emerald-900 text-emerald-300'
                    : s === 'out' ? 'bg-red-900 text-red-300'
                    : 'bg-gray-700 text-gray-300'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {s === 'all' ? 'All' : s === 'in' ? 'In Scope' : 'Out'}
            </button>
          ))}
        </div>

        {/* Hide filter */}
        <HidePatternInput onAdd={addHidePattern} />

        {/* Active hide patterns */}
        {hidePatterns.map((p) => (
          <span key={p} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-950/40 border border-red-900/40 text-[10px] text-red-400">
            <span className="text-red-500/60">hide:</span>{p}
            <button onClick={() => removeHidePattern(p)} className="text-red-600 hover:text-red-400 ml-0.5">×</button>
          </span>
        ))}

        {hasActiveFilters && (
          <button
            onClick={() => {
              setSearchText('');
              setMethodFilter('');
              setStatusFilter('');
              setHostFilter('');
              setScopeFilter('all');
              setHidePatterns([]);
            }}
            className="text-[10px] text-gray-500 hover:text-gray-300"
          >
            clear filters
          </button>
        )}

        <div className="flex-1" />
        <span className="text-xs text-gray-500">{total} results</span>
        <button onClick={clearHistory} className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300">
          Clear All
        </button>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Table */}
        <div ref={tableScrollRef} className={`overflow-auto ${selected ? 'flex-1' : 'flex-1'}`}>
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <thead className="sticky top-0 bg-gray-900 text-gray-500 text-xs uppercase">
              <tr>
                <th style={{ width: 36 }} className="px-0 py-1.5 text-center">
                </th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    style={{ ...colStyle(col.key), position: 'relative' }}
                    className={`${col.align === 'right' ? 'text-right' : 'text-left'} px-3 py-1.5`}
                  >
                    <button
                      onClick={() => toggleSort(col.key)}
                      className={`uppercase ${sortKey === col.key ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                      {col.label}{sortIndicator(col.key)}
                    </button>
                    {resizeHandle(col.key)}
                  </th>
                ))}
                {searchText.trim() && (
                  <th
                    style={{ ...colStyle('match'), position: 'relative' }}
                    className="text-left px-3 py-1.5"
                  >
                    Match
                    {resizeHandle('match')}
                  </th>
                )}
                <th
                  style={{ ...colStyle('timestamp'), position: 'relative' }}
                  className="text-right px-3 py-1.5"
                >
                  <button
                    onClick={() => toggleSort('timestamp')}
                    className={`uppercase ${sortKey === 'timestamp' ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    Timestamp{sortIndicator('timestamp')}
                  </button>
                  {resizeHandle('timestamp')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedExchanges.map((ex) => (
                <tr
                  key={ex.id}
                  data-row-id={ex.id}
                  onClick={() => loadDetail(ex.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, exchangeId: ex.id });
                  }}
                  className={`border-b border-gray-800/30 cursor-pointer ${
                    selected?.id === ex.id ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                  } ${!ex.inScope ? 'opacity-50' : ''} ${ex.highlighted ? 'bg-red-950/20' : ''}`}
                >
                  <td
                    style={{ width: 36 }}
                    className="px-0 py-0 text-center overflow-hidden"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const next = !ex.highlighted;
                      api.history.update(ex.id, { highlighted: next });
                      setExchanges((prev) => prev.map((r) => r.id === ex.id ? { ...r, highlighted: next } : r));
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div
                      className="flex items-center justify-center w-full h-full cursor-pointer py-2"
                      title={ex.highlighted ? 'Remove mark' : 'Mark'}
                    >
                      <span className={`inline-block w-3 h-3 rounded-full border-2 transition-colors ${
                        ex.highlighted
                          ? 'bg-red-500 border-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
                          : 'border-gray-600 hover:border-gray-400'
                      }`} />
                    </div>
                  </td>
                  <td style={colStyle('method')} className="px-3 py-1 overflow-hidden">
                    <span className="font-bold text-xs text-blue-400">{ex.method}</span>
                  </td>
                  <td style={colStyle('host')} className="px-3 py-1 text-gray-300 truncate overflow-hidden">{ex.host}</td>
                  <td style={colStyle('path')} className="px-3 py-1 text-gray-400 truncate overflow-hidden">{ex.path}</td>
                  <td style={colStyle('status')} className="px-3 py-1 overflow-hidden"><StatusBadge statusCode={ex.statusCode} /></td>
                  <td style={colStyle('size')} className="px-3 py-1 text-right text-gray-500 text-xs overflow-hidden">
                    {ex.responseSize != null ? formatBytes(ex.responseSize) : '-'}
                  </td>
                  <td style={colStyle('time')} className="px-3 py-1 text-right text-gray-500 text-xs overflow-hidden">
                    {ex.duration != null ? `${ex.duration}ms` : '-'}
                  </td>
                  {searchText.trim() && (
                    <td style={colStyle('match')} className="px-3 py-1 overflow-hidden">
                      {ex.matchField && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800">
                          {ex.matchField}
                        </span>
                      )}
                    </td>
                  )}
                  <td style={colStyle('timestamp')} className="px-3 py-1 text-right text-gray-600 text-xs overflow-hidden">
                    {new Date(ex.timestamp).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Bottom detail panel */}
        {renderDetailPanel()}
      </div>

      {/* Pagination */}
      {total > 100 && (
        <div className="flex items-center justify-center gap-2 py-2 bg-gray-900 border-t border-gray-800">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-2 py-1 text-xs text-gray-400 disabled:text-gray-700"
          >
            Prev
          </button>
          <span className="text-xs text-gray-500">Page {page} of {Math.ceil(total / 100)}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= Math.ceil(total / 100)}
            className="px-2 py-1 text-xs text-gray-400 disabled:text-gray-700"
          >
            Next
          </button>
        </div>
      )}

      {contextMenu && (() => {
        const ctxEx = exchanges.find((e) => e.id === contextMenu.exchangeId);
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={[
              { label: 'Copy as cURL', onClick: async () => {
                const detail = await api.history.get(contextMenu.exchangeId) as ExchangeDetail;
                copyToClipboard(generateCurl(detail));
              }},
              { label: 'Send to Replay', onClick: () => sendToReplay(contextMenu.exchangeId) },
              ...(ctxEx ? [
                {
                  label: `Hide path: ${ctxEx.path.length > 30 ? ctxEx.path.slice(0, 30) + '...' : ctxEx.path}`,
                  onClick: () => addHidePattern(ctxEx.path),
                },
                {
                  label: `Hide host: ${ctxEx.host}`,
                  onClick: () => addHidePattern(ctxEx.host),
                },
              ] : []),
              {
                label: 'Add to Scope...',
                onClick: () => {
                  if (ctxEx) {
                    setScopeWizardUrl(`https://${ctxEx.host}${ctxEx.path}`);
                    api.scope.list().then((rules) => setExistingScopeRules(rules as ScopeRule[])).catch(() => {});
                  }
                },
              },
            ]}
          />
        );
      })()}

      {/* Scope wizard modal */}
      {scopeWizardUrl && (() => {
        const options = buildScopeOptions(scopeWizardUrl);
        const coverage = checkExistingCoverage(options, existingScopeRules);
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => { setScopeWizardUrl(null); setScopeAdded(null); setPendingAnalysis(null); }}>
            <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-[480px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                <h3 className="text-sm font-semibold text-gray-200">Add to Scope</h3>
                <button onClick={() => { setScopeWizardUrl(null); setScopeAdded(null); setPendingAnalysis(null); }} className="text-gray-500 hover:text-gray-300">×</button>
              </div>
              <div className="px-4 py-2 border-b border-gray-800">
                <span className="text-xs text-gray-500">URL: </span>
                <span className="text-xs text-gray-300 font-mono break-all">{scopeWizardUrl}</span>
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
                                setTimeout(() => { setScopeWizardUrl(null); setScopeAdded(null); }, 1200);
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
                        setTimeout(() => { setScopeWizardUrl(null); setScopeAdded(null); }, 1500);
                      }}
                      className="flex-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
                    >
                      Analyze {pendingAnalysis.count} request{pendingAnalysis.count !== 1 ? 's' : ''}
                    </button>
                    <button
                      onClick={() => {
                        const label = pendingAnalysis.label;
                        setPendingAnalysis(null);
                        setScopeAdded(label);
                        setTimeout(() => { setScopeWizardUrl(null); setScopeAdded(null); }, 1200);
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

