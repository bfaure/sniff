import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { useNavigate } from '../App';
import { findingsStore, type StoredFinding } from '../stores/findingsStore';
import { useLLMStream } from '../hooks/useLLMStream';
import { api } from '../api/client';
import { appEvents } from '../events/appEvents';
import { LLMNotConfigured, isLLMNotConfigured } from '../components/shared/LLMNotConfigured';

// Map a finding's type/category/title to a guided-test vuln type label.
function inferVulnType(f: StoredFinding): string {
  const hay = `${f.type || ''} ${f.categoryName || ''} ${f.title || ''}`.toLowerCase();
  if (hay.includes('sql')) return 'SQL Injection';
  if (hay.includes('xss') || hay.includes('cross-site script')) return 'Cross-Site Scripting (XSS)';
  if (hay.includes('idor') || hay.includes('object-level') || hay.includes('object level')) return 'IDOR / Broken Object-Level Auth';
  if (hay.includes('ssrf')) return 'Server-Side Request Forgery (SSRF)';
  if (hay.includes('command inj') || hay.includes('cmdinj')) return 'Command Injection';
  if (hay.includes('path travers') || hay.includes('lfi') || hay.includes('rfi')) return 'Path Traversal / LFI';
  if (hay.includes('xxe') || hay.includes('xml external')) return 'XML External Entity (XXE)';
  if (hay.includes('ssti') || hay.includes('template inj')) return 'Server-Side Template Injection (SSTI)';
  if (hay.includes('open redirect')) return 'Open Redirect';
  if (hay.includes('jwt') || hay.includes('token')) return 'JWT / Token Tampering';
  if (hay.includes('race')) return 'Race Condition';
  if (hay.includes('csrf')) return 'CSRF';
  if (hay.includes('mass assignment')) return 'Mass Assignment';
  if (hay.includes('deserial')) return 'Insecure Deserialization';
  if (hay.includes('priv') && hay.includes('esc')) return 'Authorization / Privilege Escalation';
  if (hay.includes('auth')) return 'Authentication Bypass';
  return 'SQL Injection'; // default fallback
}

async function loadExchangeAsRequest(exchangeId: string): Promise<{ method: string; url: string; headers: Record<string, string>; body: string | null } | null> {
  try {
    const ex: any = await api.history.get(exchangeId);
    if (!ex) return null;
    let headers: Record<string, string> = {};
    try { headers = typeof ex.requestHeaders === 'string' ? JSON.parse(ex.requestHeaders) : (ex.requestHeaders || {}); } catch { /* ignore */ }
    let body: string | null = null;
    if (ex.requestBody) {
      // requestBody from API may be base64 or array — assume base64 string
      try {
        if (typeof ex.requestBody === 'string') {
          body = atob(ex.requestBody);
        } else if (Array.isArray(ex.requestBody)) {
          body = String.fromCharCode(...ex.requestBody);
        }
      } catch { /* ignore */ }
    }
    return { method: ex.method, url: ex.url, headers, body };
  } catch {
    return null;
  }
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-600 text-white',
  medium: 'bg-amber-600 text-black',
  low: 'bg-blue-600 text-white',
  info: 'bg-gray-600 text-white',
};
const SEVERITY_BORDER: Record<string, string> = {
  critical: 'border-l-red-600',
  high: 'border-l-orange-600',
  medium: 'border-l-amber-600',
  low: 'border-l-blue-600',
  info: 'border-l-gray-600',
};
const SOURCE_COLORS: Record<string, string> = {
  'auto-analyzer': 'text-purple-400 bg-purple-950 border-purple-800',
  'assessment': 'text-cyan-400 bg-cyan-950 border-cyan-800',
  'on-demand': 'text-amber-400 bg-amber-950 border-amber-800',
  'manual': 'text-emerald-400 bg-emerald-950 border-emerald-800',
};
const SOURCE_LABEL: Record<string, string> = {
  'auto-analyzer': 'Auto',
  'assessment': 'Manual',
  'on-demand': 'Manual',
  'manual': 'Manual',
};
function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const sec = Math.floor((now - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const STATUS_COLORS: Record<string, string> = {
  open: 'text-gray-400 bg-gray-800',
  confirmed: 'text-red-400 bg-red-950',
  'false-positive': 'text-gray-600 bg-gray-900 line-through',
  fixed: 'text-emerald-400 bg-emerald-950',
};

export function FindingsPage() {
  const findings = useSyncExternalStore(findingsStore.subscribe, findingsStore.getFindings);
  useEffect(() => { findingsStore.init(); }, []);
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [filterSeverity, setFilterSeverity] = useState<string | null>(null);
  const [filterSource, setFilterSource] = useState<string | null>(null);
  const [filterHost, setFilterHost] = useState<string | null>(null);
  const [filterNew, setFilterNew] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [chainOpen, setChainOpen] = useState(false);
  const chainLLM = useLLMStream();
  const navigate = useNavigate();

  // Capture the "last seen" timestamp when this page mounts, so new findings
  // that arrived before this visit get highlighted. Mark seen after a short delay.
  const [arrivalSeenTs] = useState(() => findingsStore.getLastSeenTimestamp());
  useEffect(() => {
    const timer = setTimeout(() => findingsStore.markSeen(), 500);
    return () => clearTimeout(timer);
  }, []);

  const isNewFinding = (f: StoredFinding) => arrivalSeenTs > 0 && f.timestamp > arrivalSeenTs;
  const newFindingsCount = findings.filter(isNewFinding).length;

  const toggleHost = (host: string) => {
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  };

  // Filtering
  const filtered = findings
    .filter((f) => !filterNew || isNewFinding(f))
    .filter((f) => !filterSeverity || f.severity === filterSeverity)
    .filter((f) => !filterSource || f.source === filterSource)
    .filter((f) => !filterHost || f.host === filterHost)
    .filter((f) => {
      if (!searchText) return true;
      const q = searchText.toLowerCase();
      return f.title.toLowerCase().includes(q) ||
        f.detail.toLowerCase().includes(q) ||
        (f.url?.toLowerCase().includes(q) ?? false) ||
        (f.categoryName?.toLowerCase().includes(q) ?? false);
    })
    .sort((a, b) => {
      // Sort by CVSS score descending first, fall back to severity enum, then timestamp
      const aCvss = a.cvss ?? -1;
      const bCvss = b.cvss ?? -1;
      if (aCvss !== bCvss) return bCvss - aCvss;
      const sevDiff = (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5);
      if (sevDiff !== 0) return sevDiff;
      return b.timestamp - a.timestamp;
    });

  // Group filtered findings by host
  const groupedByHost: { host: string; findings: typeof filtered; severityCounts: Record<string, number> }[] = [];
  const hostMap = new Map<string, typeof filtered>();
  for (const f of filtered) {
    const h = f.host || '(unknown)';
    if (!hostMap.has(h)) hostMap.set(h, []);
    hostMap.get(h)!.push(f);
  }
  // Sort hosts by highest severity finding, then by count
  for (const [host, hFindings] of hostMap) {
    const sevCounts = hFindings.reduce((acc, ff) => { acc[ff.severity] = (acc[ff.severity] || 0) + 1; return acc; }, {} as Record<string, number>);
    groupedByHost.push({ host, findings: hFindings, severityCounts: sevCounts });
  }
  groupedByHost.sort((a, b) => {
    const aMin = Math.min(...a.findings.map((f) => SEVERITY_ORDER[f.severity] ?? 5));
    const bMin = Math.min(...b.findings.map((f) => SEVERITY_ORDER[f.severity] ?? 5));
    if (aMin !== bMin) return aMin - bMin;
    return b.findings.length - a.findings.length;
  });

  // Aggregations (across all unfiltered findings)
  const severityCounts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const sourceCounts = findings.reduce((acc, f) => {
    acc[f.source] = (acc[f.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const hosts = [...new Set(findings.map((f) => f.host).filter(Boolean))] as string[];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <h2 className="text-lg font-bold text-gray-300">Findings</h2>
        <span className="text-xs text-gray-500">{findings.length} total</span>
        <div className="flex-1" />
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search findings..."
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 w-48 focus:outline-none focus:border-emerald-600"
        />
        {filterHost && (
          <button
            onClick={() => { setChainOpen(true); chainLLM.chainAnalysis(filterHost); }}
            disabled={chainLLM.streaming}
            className="px-2 py-1 rounded text-xs bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
            title={`Analyze attack chains across all findings on ${filterHost}`}
          >
            {chainLLM.streaming ? 'Analyzing...' : `Analyze Chains on ${filterHost}`}
          </button>
        )}
        {findings.length > 0 && (
          <button
            onClick={() => { findingsStore.clear(); setExpandedFinding(null); }}
            className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-400"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Chain analysis modal */}
      {chainOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/70" onClick={() => !chainLLM.streaming && setChainOpen(false)} />
          <div className="relative bg-gray-900 border border-purple-700 rounded-lg w-[800px] max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800">
              <span className="text-sm font-bold text-purple-300">Attack Chain Analysis</span>
              {filterHost && <span className="text-xs text-gray-500">{filterHost}</span>}
              <div className="flex-1" />
              {chainLLM.costUsd > 0 && (
                <span className="text-[10px] text-gray-500">${chainLLM.costUsd.toFixed(4)}</span>
              )}
              <button
                onClick={() => setChainOpen(false)}
                disabled={chainLLM.streaming}
                className="text-gray-500 hover:text-gray-300 disabled:opacity-30"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {chainLLM.error && (
                isLLMNotConfigured(chainLLM.error, chainLLM.errorCode)
                  ? <LLMNotConfigured />
                  : <div className="text-red-400 text-sm">{chainLLM.error}</div>
              )}
              <pre className="text-sm text-gray-200 whitespace-pre-wrap break-words font-sans">
                {chainLLM.text}
                {chainLLM.streaming && <span className="animate-pulse text-purple-400">▍</span>}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800/50 flex-wrap">
        {/* Severity filters */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-600 mr-1">Severity:</span>
          {['critical', 'high', 'medium', 'low', 'info'].map((sev) => {
            const count = severityCounts[sev] || 0;
            if (count === 0) return null;
            const isActive = filterSeverity === sev;
            return (
              <button
                key={sev}
                onClick={() => setFilterSeverity(isActive ? null : sev)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${SEVERITY_COLORS[sev]} ${isActive ? 'ring-2 ring-white/50' : 'opacity-70 hover:opacity-100'}`}
              >
                {count} {sev}
              </button>
            );
          })}
        </div>

        {/* New findings filter */}
        {newFindingsCount > 0 && (
          <button
            onClick={() => setFilterNew((v) => !v)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold ${filterNew ? 'bg-emerald-600 text-white ring-2 ring-emerald-400/50' : 'bg-emerald-900 text-emerald-300 hover:bg-emerald-800'}`}
          >
            {newFindingsCount} New
          </button>
        )}

        {/* Source filters */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-600 mr-1">Source:</span>
          {(['auto-analyzer', 'assessment', 'on-demand', 'manual'] as const).map((src) => {
            const count = sourceCounts[src] || 0;
            if (count === 0) return null;
            const isActive = filterSource === src;
            return (
              <button
                key={src}
                onClick={() => setFilterSource(isActive ? null : src)}
                className={`px-1.5 py-0.5 rounded text-[10px] border ${SOURCE_COLORS[src]} ${isActive ? 'ring-1 ring-white/50' : 'opacity-70 hover:opacity-100'}`}
              >
                {count} {SOURCE_LABEL[src]}
              </button>
            );
          })}
        </div>

        {/* Host filter */}
        {hosts.length > 1 && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-600 mr-1">Host:</span>
            <select
              value={filterHost || ''}
              onChange={(e) => setFilterHost(e.target.value || null)}
              className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-400"
            >
              <option value="">All</option>
              {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        )}

        {(filterSeverity || filterSource || filterHost) && (
          <button
            onClick={() => { setFilterSeverity(null); setFilterSource(null); setFilterHost(null); }}
            className="text-[10px] text-gray-500 hover:text-gray-300"
          >
            clear filters
          </button>
        )}

        <span className="text-[10px] text-gray-600 ml-auto">{filtered.length} shown</span>
      </div>

      {/* Findings list — grouped by host */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-48 text-gray-600 text-sm">
            {findings.length === 0
              ? 'No findings yet. Enable auto-analyze or run a target assessment to populate findings.'
              : 'No findings match the current filters.'}
          </div>
        )}

        {groupedByHost.map(({ host, findings: hostFindings, severityCounts: hostSev }) => {
          const isHostExpanded = expandedHosts.has(host);
          const highestSev = (['critical', 'high', 'medium', 'low', 'info'] as const).find((s) => hostSev[s]);
          return (
            <div key={host}>
              {/* Host header */}
              <button
                onClick={() => toggleHost(host)}
                className="w-full text-left px-4 py-2 bg-gray-900/70 border-b border-gray-800 hover:bg-gray-800/50 flex items-center gap-2 sticky top-0 z-10"
              >
                <span className="text-gray-500 w-4 text-center text-xs select-none">
                  {isHostExpanded ? '\u25BE' : '\u25B8'}
                </span>
                <span className="text-sm font-bold text-gray-300">{host}</span>
                <span className="text-xs text-gray-500">({hostFindings.length})</span>
                <div className="flex gap-1 ml-2">
                  {(['critical', 'high', 'medium', 'low', 'info'] as const).map((sev) => {
                    const count = hostSev[sev] || 0;
                    if (count === 0) return null;
                    return (
                      <span key={sev} className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${SEVERITY_COLORS[sev]}`}>
                        {count}
                      </span>
                    );
                  })}
                </div>
                <div className="flex-1" />
                <button
                  onClick={(e) => { e.stopPropagation(); setFilterHost(host); setChainOpen(true); chainLLM.chainAnalysis(host); }}
                  disabled={chainLLM.streaming}
                  className="px-2 py-0.5 rounded text-[10px] bg-purple-900/50 hover:bg-purple-900 text-purple-300 border border-purple-800 disabled:opacity-50 opacity-0 group-hover:opacity-100"
                  title={`Analyze attack chains on ${host}`}
                >
                  Chains
                </button>
              </button>

              {/* Host findings table */}
              {isHostExpanded && (
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-900/50 text-[10px] text-gray-500 uppercase tracking-wider">
                      <th className="text-left py-1.5 pl-10 pr-2 w-[70px]">Severity</th>
                      <th className="text-left py-1.5 px-2 w-[45px]">CVSS</th>
                      <th className="text-left py-1.5 px-2 w-[70px]">Source</th>
                      <th className="text-left py-1.5 px-2 w-[65px]">Status</th>
                      <th className="text-left py-1.5 px-2">Title</th>
                      <th className="text-left py-1.5 px-2 w-[70px]">OWASP</th>
                      <th className="text-right py-1.5 px-2 pr-4 w-[80px]">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hostFindings.map((f) => {
                      const isExpanded = expandedFinding === f.id;
                      const isNew = isNewFinding(f);
                      return (
                        <React.Fragment key={f.id}>
                          <tr
                            onClick={() => setExpandedFinding(isExpanded ? null : f.id)}
                            className={`cursor-pointer hover:bg-gray-800/40 border-l-2 ${SEVERITY_BORDER[f.severity]} ${isExpanded ? 'bg-gray-800/30' : ''} ${isNew ? 'bg-emerald-950/20' : ''}`}
                          >
                            <td className="py-1.5 pl-10 pr-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${SEVERITY_COLORS[f.severity]}`}>
                                {f.severity.toUpperCase()}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 font-mono text-gray-400" title={f.cvssVector || undefined}>
                              {f.cvss != null ? f.cvss.toFixed(1) : '-'}
                            </td>
                            <td className="py-1.5 px-2">
                              <span className={`px-1 py-0.5 rounded text-[10px] border ${SOURCE_COLORS[f.source]}`}>
                                {f.escalated ? 'Deep' : SOURCE_LABEL[f.source] || f.source}
                              </span>
                            </td>
                            <td className="py-1.5 px-2">
                              <span className={`px-1 py-0.5 rounded text-[10px] ${STATUS_COLORS[f.status]}`}>
                                {f.status}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-gray-300 truncate max-w-0">
                              <div className="flex items-center gap-1.5">
                                {isNew && <span className="text-[9px] px-1 py-0 rounded bg-emerald-600 text-white font-bold shrink-0">NEW</span>}
                                <span className="truncate">{f.title}</span>
                                {f.hits > 1 && <span className="text-[10px] text-gray-500 shrink-0">×{f.hits}</span>}
                              </div>
                            </td>
                            <td className="py-1.5 px-2 text-[10px] text-purple-500">{f.owaspId || ''}</td>
                            <td className="py-1.5 px-2 pr-4 text-right text-gray-600 whitespace-nowrap">
                              {timeAgo(f.createdAt)}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={7} className={`border-l-2 ${SEVERITY_BORDER[f.severity]} bg-gray-900/40`}>
                                <div className="px-4 pl-10 py-3 space-y-2">
                                  {f.cvss != null && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-gray-500 uppercase tracking-wider">CVSS</span>
                                      <span className="text-xs font-mono text-gray-300 font-bold">{f.cvss.toFixed(1)}</span>
                                      {f.cvssVector && (
                                        <span className="text-[10px] font-mono text-gray-500">{f.cvssVector}</span>
                                      )}
                                    </div>
                                  )}
                                  <div>
                                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Detail</div>
                                    <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words bg-gray-950 rounded p-2">
                                      {f.detail}
                                    </pre>
                                  </div>
                                  {f.evidence && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Evidence</div>
                                      <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words bg-gray-950 rounded p-2 font-mono">
                                        {f.evidence}
                                      </pre>
                                    </div>
                                  )}
                                  {f.url && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Request</div>
                                      <div className="text-xs text-gray-400 bg-gray-950 rounded p-2 font-mono">
                                        {f.method} {f.url}
                                      </div>
                                    </div>
                                  )}
                                  {f.suggestedTest && (
                                    <div>
                                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Suggested Test</div>
                                      <pre className="text-xs text-emerald-300 whitespace-pre-wrap break-words bg-gray-950 rounded p-2 font-mono">
                                        {f.suggestedTest}
                                      </pre>
                                    </div>
                                  )}
                                  {f.categoryName && (
                                    <div className="text-[10px] text-gray-600">
                                      Category: {f.categoryName}{f.owaspId ? ` (${f.owaspId})` : ''}
                                    </div>
                                  )}
                                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                                    {f.exchangeId && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); navigate('history'); }}
                                        className="text-[10px] text-emerald-400 hover:text-emerald-300"
                                      >
                                        View in History
                                      </button>
                                    )}
                                    {f.exchangeId && (
                                      <button
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          const req = await loadExchangeAsRequest(f.exchangeId!);
                                          if (!req) return;
                                          appEvents.emit('test-in-replay', { request: req, vulnType: inferVulnType(f) });
                                          navigate('replay');
                                        }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-purple-950 text-purple-300 hover:bg-purple-900"
                                        title="Open this exchange in Replay and start an AI guided test for this vulnerability"
                                      >
                                        Test in Replay
                                      </button>
                                    )}
                                    {f.exchangeId && (
                                      <button
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          const req = await loadExchangeAsRequest(f.exchangeId!);
                                          if (!req) return;
                                          appEvents.emit('send-to-fuzzer', {
                                            name: f.title.slice(0, 40),
                                            attackType: 'single',
                                            templateReq: req,
                                            payloadPositions: [],
                                            payloads: [[]],
                                          });
                                          navigate('fuzzer');
                                        }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 hover:bg-cyan-900"
                                        title="Send this exchange to Fuzzer as a fuzzing template"
                                      >
                                        Send to Fuzzer
                                      </button>
                                    )}
                                    {f.exchangeId && (
                                      <button
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          try {
                                            const r = await api.findings.retest(f.id);
                                            if (r.inconclusive) alert(`Re-test inconclusive (replay status ${r.replayStatus}) — model output not parseable.`);
                                            else if (r.stillPresent) alert(`Re-test: vulnerability STILL PRESENT (replay status ${r.replayStatus}).`);
                                            else alert(`Re-test: vulnerability NO LONGER REPRODUCED — marked as fixed (replay status ${r.replayStatus}).`);
                                            await findingsStore.init();
                                          } catch (err) {
                                            alert(`Re-test failed: ${(err as Error).message}`);
                                          }
                                        }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-purple-950 text-purple-300 hover:bg-purple-900"
                                        title="Replay this exchange and re-run vuln-scan to check if the issue is still present"
                                      >
                                        Re-test
                                      </button>
                                    )}
                                    {f.status !== 'confirmed' && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); findingsStore.updateStatus(f.id, 'confirmed'); }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-red-950 text-red-300 hover:bg-red-900"
                                      >
                                        Confirm
                                      </button>
                                    )}
                                    {f.status !== 'false-positive' && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); findingsStore.updateStatus(f.id, 'false-positive'); }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
                                        title="Mark as false positive — auto-analyzer will not re-report this"
                                      >
                                        False Positive
                                      </button>
                                    )}
                                    {f.status !== 'fixed' && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); findingsStore.updateStatus(f.id, 'fixed'); }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 hover:bg-emerald-900"
                                      >
                                        Mark Fixed
                                      </button>
                                    )}
                                    {f.status !== 'open' && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); findingsStore.updateStatus(f.id, 'open'); }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700"
                                      >
                                        Reopen
                                      </button>
                                    )}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); findingsStore.deleteFinding(f.id); }}
                                      className="text-[10px] px-2 py-0.5 rounded text-gray-600 hover:text-red-400 ml-auto"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
