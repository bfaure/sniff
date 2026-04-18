import React, { useState, useEffect, useRef, useCallback } from 'react';
import { wsClient } from '../api/ws';
import { api } from '../api/client';
import { PillToggle } from '../components/shared/PillToggle';

interface ActivityEntry {
  event: string;
  exchangeId?: string;
  method?: string;
  url?: string;
  message: string;
  costUsd?: number;
  dailyCost?: number;
  queueLength?: number;
  observations?: string;
  timestamp: number;
}

interface QueueExchange {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode: number | null;
}

const EVENT_STYLES: Record<string, { color: string; icon: string }> = {
  analyzing: { color: 'text-blue-400', icon: '...' },
  done: { color: 'text-gray-500', icon: ' - ' },
  skipped: { color: 'text-gray-600', icon: ' ~ ' },
  finding: { color: 'text-amber-400', icon: ' ! ' },
  escalating: { color: 'text-purple-400', icon: ' ^ ' },
  'deep-start': { color: 'text-purple-300', icon: '>>>' },
  'deep-done': { color: 'text-purple-300', icon: '<<<' },
  error: { color: 'text-red-400', icon: 'ERR' },
  'cost-cap': { color: 'text-red-500', icon: ' $ ' },
};

const MAX_ENTRIES = 500;

function groupByHost(exchanges: QueueExchange[]): Record<string, QueueExchange[]> {
  const groups: Record<string, QueueExchange[]> = {};
  for (const ex of exchanges) {
    if (!groups[ex.host]) groups[ex.host] = [];
    groups[ex.host].push(ex);
  }
  return groups;
}

function MethodBadge({ method }: { method: string }) {
  const color = method === 'GET' ? 'text-emerald-400' :
    method === 'POST' ? 'text-blue-400' :
    method === 'DELETE' ? 'text-red-400' :
    'text-amber-400';
  return <span className={`font-bold text-[10px] ${color}`}>{method}</span>;
}

export function AIActivityPage() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [dailyCost, setDailyCost] = useState(0);
  const [scopeMode, setScopeMode] = useState<'all' | 'in-scope'>('in-scope');
  const [observations, setObservations] = useState('');
  const [showSkipped, setShowSkipped] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Queue state
  const [currentItem, setCurrentItem] = useState<QueueExchange | null>(null);
  const [activeQueue, setActiveQueue] = useState<QueueExchange[]>([]);
  const [activeQueueExpanded, setActiveQueueExpanded] = useState<Set<string>>(new Set());
  const [showActiveQueue, setShowActiveQueue] = useState(true);

  // Load auto-analyze status on mount (also reload after WS reconnect)
  useEffect(() => {
    const load = () => {
      api.llm.getAutoAnalyzeStatus().then((status: any) => {
        setAutoAnalyze(status.enabled);
        setDailyCost(status.dailyCost);
        setScopeMode(status.scopeMode);
        if (typeof status.observations === 'string') setObservations(status.observations);
      }).catch(() => {});
    };
    load();
    const unsub = wsClient.on('__reconnect__' as any, load);
    return unsub;
  }, []);

  // Subscribe to activity events
  useEffect(() => {
    const unsub = wsClient.on('analyzer:activity', (data) => {
      const entry = data as ActivityEntry;
      setEntries((prev) => [...prev, entry].slice(-MAX_ENTRIES));
      if (entry.dailyCost != null) setDailyCost(entry.dailyCost);
      if (entry.observations) setObservations(entry.observations);
    });
    return unsub;
  }, []);

  // Poll the active queue periodically while auto-analyze is on
  const refreshQueue = useCallback(() => {
    api.llm.getAnalyzeQueue().then((state) => {
      setCurrentItem(state.current);
      setActiveQueue(state.queued);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!autoAnalyze) {
      setCurrentItem(null);
      setActiveQueue([]);
      return;
    }
    refreshQueue();
    const interval = setInterval(refreshQueue, 2000);
    return () => clearInterval(interval);
  }, [autoAnalyze, refreshQueue]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const toggleAutoAnalyze = async (value: boolean) => {
    await api.llm.toggleAutoAnalyze(value);
    setAutoAnalyze(value);

    // When turning on, automatically enqueue any unanalyzed in-scope traffic
    if (value) {
      try {
        const result = await api.scope.analyzePendingCount();
        if (result.count > 0) {
          await api.scope.analyzePending();
          setTimeout(refreshQueue, 500);
        }
      } catch { /* ignore */ }
    }
  };

  const handleScopeMode = async (mode: 'all' | 'in-scope') => {
    setScopeMode(mode);
    await api.llm.setAIScopeMode(mode);
  };

  const toggleHost = (host: string) => {
    setActiveQueueExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host); else next.add(host);
      return next;
    });
  };

  const filtered = showSkipped ? entries : entries.filter((e) => e.event !== 'skipped');

  const activeByHost = groupByHost(activeQueue);
  const totalQueued = activeQueue.length + (currentItem ? 1 : 0);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <h2 className="text-lg font-bold text-gray-300">AI Activity</h2>

        <PillToggle
          enabled={autoAnalyze}
          onChange={toggleAutoAnalyze}
          label="Auto-Analyze"
        />

        <div className="flex items-center gap-1 border border-gray-700 rounded overflow-hidden">
          <button
            onClick={() => handleScopeMode('all')}
            className={`px-2.5 py-1 text-[11px] ${scopeMode === 'all' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
          >
            All Traffic
          </button>
          <button
            onClick={() => handleScopeMode('in-scope')}
            className={`px-2.5 py-1 text-[11px] ${scopeMode === 'in-scope' ? 'bg-emerald-900 text-emerald-300' : 'text-gray-500 hover:text-gray-300'}`}
          >
            In-Scope Only
          </button>
        </div>

        <span className="text-xs text-gray-500">
          Cost today: <span className="text-amber-400 font-mono">${dailyCost.toFixed(4)}</span>
        </span>

        <div className="flex-1" />

        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={showSkipped}
            onChange={(e) => setShowSkipped(e.target.checked)}
            className="rounded"
          />
          Show skipped
        </label>

        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded"
          />
          Auto-scroll
        </label>

        <button
          onClick={() => setEntries([])}
          className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Activity log */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-xs">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-gray-600 text-sm font-sans">
                {autoAnalyze
                  ? 'Waiting for traffic to analyze...'
                  : 'Enable Auto-Analyze to see AI activity here.'}
              </div>
            ) : (
              <table className="w-full">
                <tbody>
                  {filtered.map((entry, i) => {
                    const style = EVENT_STYLES[entry.event] || { color: 'text-gray-400', icon: '   ' };
                    return (
                      <tr
                        key={i}
                        className={`border-b border-gray-800/20 hover:bg-gray-800/30 ${
                          entry.event === 'skipped' ? 'opacity-40' : ''
                        }`}
                      >
                        <td className="px-2 py-1 text-gray-700 whitespace-nowrap w-20">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </td>
                        <td className={`px-1 py-1 whitespace-nowrap w-8 text-center ${style.color}`}>
                          {style.icon}
                        </td>
                        <td className={`px-2 py-1 ${style.color}`}>
                          {entry.message}
                        </td>
                        <td className="px-2 py-1 text-gray-700 text-right whitespace-nowrap w-20">
                          {entry.costUsd != null && entry.costUsd > 0
                            ? `$${entry.costUsd.toFixed(4)}`
                            : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right sidebar: Queue + Observations */}
        <div className="w-72 border-l border-gray-800 flex flex-col shrink-0">
          {/* Active queue panel */}
          <div className="border-b border-gray-800">
            <button
              onClick={() => setShowActiveQueue((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900 hover:bg-gray-800/50"
            >
              <span className="text-[10px] text-gray-600">{showActiveQueue ? '\u25BC' : '\u25B6'}</span>
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Analysis Queue</h3>
              {totalQueued > 0 && (
                <span className="ml-auto px-1.5 py-0.5 rounded-full bg-blue-900 text-blue-300 text-[10px] font-mono font-bold">
                  {totalQueued}
                </span>
              )}
              {totalQueued === 0 && !currentItem && (
                <span className="ml-auto text-[10px] text-gray-600">idle</span>
              )}
            </button>

            {showActiveQueue && (
              <div className="max-h-64 overflow-auto">
                {/* Currently analyzing */}
                {currentItem && (
                  <div className="px-3 py-1.5 bg-blue-950/30 border-b border-blue-900/30">
                    <div className="flex items-center gap-1.5 text-[10px] text-blue-400 mb-0.5">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                      Analyzing now
                    </div>
                    <div className="flex items-center gap-1.5 text-xs">
                      <MethodBadge method={currentItem.method} />
                      <span className="text-gray-400 truncate">{currentItem.host}</span>
                      <span className="text-gray-600 truncate">{currentItem.path}</span>
                    </div>
                  </div>
                )}

                {/* Queued items grouped by host */}
                {activeQueue.length > 0 ? (
                  Object.entries(activeByHost)
                    .sort(([, a], [, b]) => b.length - a.length)
                    .map(([host, items]) => (
                      <div key={host}>
                        <button
                          onClick={() => toggleHost(host)}
                          className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-gray-800/50 text-xs"
                        >
                          <span className="text-[10px] text-gray-600">{activeQueueExpanded.has(host) ? '\u25BC' : '\u25B6'}</span>
                          <span className="text-gray-300">{host}</span>
                          <span className="text-gray-600 ml-auto">{items.length}</span>
                        </button>
                        {activeQueueExpanded.has(host) && (
                          <div className="pl-6 pb-1">
                            {items.slice(0, 50).map((ex) => (
                              <div key={ex.id} className="flex items-center gap-1.5 py-0.5 text-[11px] text-gray-500">
                                <MethodBadge method={ex.method} />
                                <span className="truncate">{ex.path}</span>
                              </div>
                            ))}
                            {items.length > 50 && (
                              <div className="text-[10px] text-gray-600 py-0.5">
                                +{items.length - 50} more
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))
                ) : !currentItem ? (
                  <div className="px-3 py-3 text-[11px] text-gray-600 italic">
                    {autoAnalyze ? 'Queue empty -- waiting for traffic' : 'Auto-Analyze is off'}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Observations */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 bg-gray-900">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Session Observations</h3>
              <p className="text-[10px] text-gray-600 mt-0.5">
                Patterns the AI has noticed across requests
              </p>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {observations ? (
                <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words">
                  {observations}
                </pre>
              ) : (
                <p className="text-xs text-gray-600 italic">
                  No observations yet. The AI builds context as it analyzes traffic.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
