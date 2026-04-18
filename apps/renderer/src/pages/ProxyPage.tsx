import React, { useState } from 'react';
import { useTrafficStream } from '../hooks/useTrafficStream';
import { useIntercept } from '../hooks/useIntercept';
import { api } from '../api/client';
import { PillToggle } from '../components/shared/PillToggle';
import { StatusBadge } from '../components/shared/StatusBadge';
import { RequestView } from '../components/shared/RequestView';
import { ContextMenu, type MenuItem } from '../components/shared/ContextMenu';
import { AnalysisPanel } from '../components/shared/AnalysisPanel';
import { FindingsPanel } from '../components/shared/FindingsPanel';
import { appEvents } from '../events/appEvents';
import { useNavigate } from '../App';
import type { ExchangeSummary, InterceptedItem } from '@sniff/shared';

interface ExchangeDetail {
  id: string;
  method: string;
  url: string;
  statusCode: number | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  duration: number | null;
}

export function ProxyPage() {
  const { exchanges, clear } = useTrafficStream();
  const { queue, enabled, toggle, forward, drop, forwardAll } = useIntercept();
  const navigate = useNavigate();
  const [selectedExchange, setSelectedExchange] = useState<ExchangeSummary | null>(null);
  const [selectedIntercept, setSelectedIntercept] = useState<InterceptedItem | null>(null);
  const [exchangeDetail, setExchangeDetail] = useState<ExchangeDetail | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; exchangeId: string } | null>(null);
  const [detailTab, setDetailTab] = useState<'request' | 'ai'>('request');
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [scopeOnly, setScopeOnly] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');

  const toggleAutoAnalyze = async (value: boolean) => {
    await api.llm.toggleAutoAnalyze(value);
    setAutoAnalyze(value);
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

  const loadExchangeDetail = async (exchange: ExchangeSummary) => {
    setSelectedExchange(exchange);
    setSelectedIntercept(null);
    const detail = await api.history.get(exchange.id);
    setExchangeDetail(detail as ExchangeDetail);
  };

  const filteredExchanges = exchanges.filter((ex) => {
    if (scopeOnly && !ex.inScope) return false;
    if (quickFilter) {
      const q = quickFilter.toLowerCase();
      if (!ex.host.toLowerCase().includes(q) && !ex.path.toLowerCase().includes(q) && !ex.method.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <span className="flex items-center gap-1.5 text-xs text-emerald-400">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Proxy :8080
        </span>

        <PillToggle
          enabled={enabled}
          onChange={toggle}
          label="Hold"
        />

        <PillToggle
          enabled={autoAnalyze}
          onChange={toggleAutoAnalyze}
          label="Auto-Analyze"
        />

        {queue.length > 0 && (
          <button
            onClick={forwardAll}
            className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
          >
            Forward All ({queue.length})
          </button>
        )}

        <PillToggle
          enabled={scopeOnly}
          onChange={setScopeOnly}
          label="Scope Only"
        />

        <input
          type="text"
          value={quickFilter}
          onChange={(e) => setQuickFilter(e.target.value)}
          placeholder="Filter..."
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 w-36 focus:outline-none focus:border-emerald-600"
        />

        <div className="flex-1" />

        <button
          onClick={clear}
          className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: Hold queue + traffic list */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Hold queue (shown when hold is on and items exist) */}
          {enabled && queue.length > 0 && (
            <div className="border-b border-gray-800 max-h-48 overflow-auto">
              <div className="px-3 py-1 text-xs text-amber-400 bg-amber-950 border-b border-amber-900">
                Held ({queue.length})
              </div>
              {queue.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    setSelectedIntercept(item);
                    setSelectedExchange(null);
                    setExchangeDetail(null);
                  }}
                  className={`flex items-center gap-3 px-3 py-1.5 text-sm cursor-pointer border-b border-gray-800/50 ${
                    selectedIntercept?.id === item.id
                      ? 'bg-amber-950/50'
                      : 'hover:bg-gray-800/50'
                  }`}
                >
                  <span className="text-amber-400 text-xs">{item.type === 'request' ? 'REQ' : 'RES'}</span>
                  <span className="text-blue-400 font-bold text-xs">{item.method}</span>
                  <span className="text-gray-300 truncate">{item.url}</span>
                  <div className="flex-1" />
                  <button
                    onClick={(e) => { e.stopPropagation(); forward(item.id); }}
                    className="px-2 py-0.5 text-xs rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                  >
                    Forward
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); drop(item.id); }}
                    className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white"
                  >
                    Drop
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Traffic table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-900 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-1.5 w-8">#</th>
                  <th className="text-left px-3 py-1.5 w-16">Method</th>
                  <th className="text-left px-3 py-1.5">Host</th>
                  <th className="text-left px-3 py-1.5">Path</th>
                  <th className="text-left px-3 py-1.5 w-16">Status</th>
                  <th className="text-right px-3 py-1.5 w-20">Size</th>
                  <th className="text-right px-3 py-1.5 w-16">Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredExchanges.map((ex, i) => (
                  <tr
                    key={ex.id}
                    onClick={() => loadExchangeDetail(ex)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, exchangeId: ex.id });
                    }}
                    className={`border-b border-gray-800/30 cursor-pointer ${
                      selectedExchange?.id === ex.id
                        ? 'bg-gray-800'
                        : 'hover:bg-gray-800/50'
                    } ${!ex.inScope ? 'opacity-50' : ''}`}
                  >
                    <td className="px-3 py-1 text-gray-600">{filteredExchanges.length - i}</td>
                    <td className="px-3 py-1">
                      <span className={`font-bold text-xs ${
                        ex.method === 'GET' ? 'text-emerald-400' :
                        ex.method === 'POST' ? 'text-blue-400' :
                        ex.method === 'DELETE' ? 'text-red-400' :
                        'text-amber-400'
                      }`}>{ex.method}</span>
                    </td>
                    <td className="px-3 py-1 text-gray-300">{ex.host}</td>
                    <td className="px-3 py-1 text-gray-400 truncate max-w-xs">{ex.path}</td>
                    <td className="px-3 py-1"><StatusBadge statusCode={ex.statusCode} /></td>
                    <td className="px-3 py-1 text-right text-gray-500 text-xs">
                      {ex.responseSize != null ? formatBytes(ex.responseSize) : '-'}
                    </td>
                    <td className="px-3 py-1 text-right text-gray-500 text-xs">
                      {ex.duration != null ? `${ex.duration}ms` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredExchanges.length === 0 && (
              <div className="flex items-center justify-center h-48 text-gray-600 text-sm">
                {enabled
                  ? 'Hold is on — requests will be paused here for review.'
                  : 'Enable hold to pause and modify requests. Live traffic is shown below.'
                }
              </div>
            )}
          </div>

          {/* AI Findings panel */}
          <FindingsPanel
            onSelectExchange={(id) => {
              const ex = exchanges.find((e) => e.id === id);
              if (ex) loadExchangeDetail(ex);
            }}
          />
        </div>

        {/* Right panel: Detail view */}
        {(exchangeDetail || selectedIntercept) && (
          <div className="w-[450px] border-l border-gray-800 flex flex-col">
            {/* Detail tab bar */}
            {exchangeDetail && (
              <div className="flex border-b border-gray-800 shrink-0">
                <button
                  onClick={() => setDetailTab('request')}
                  className={`px-3 py-1.5 text-xs uppercase tracking-wider ${
                    detailTab === 'request' ? 'text-emerald-400 border-b-2 border-emerald-400' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Request/Response
                </button>
                <button
                  onClick={() => setDetailTab('ai')}
                  className={`px-3 py-1.5 text-xs uppercase tracking-wider ${
                    detailTab === 'ai' ? 'text-purple-400 border-b-2 border-purple-400' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  AI Analysis
                </button>
              </div>
            )}

            <div className="flex-1 overflow-auto">
              {selectedIntercept && (
                <div className="p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900 text-amber-300">
                      {selectedIntercept.type === 'request' ? 'REQUEST' : 'RESPONSE'}
                    </span>
                    <span className="text-xs text-gray-500">intercepted</span>
                  </div>
                  <RequestView
                    method={selectedIntercept.method}
                    url={selectedIntercept.url}
                    headers={selectedIntercept.headers}
                    body={selectedIntercept.body}
                  />
                </div>
              )}

              {exchangeDetail && detailTab === 'request' && (
                <div className="p-4 space-y-4">
                  <RequestView
                    method={exchangeDetail.method}
                    url={exchangeDetail.url}
                    headers={exchangeDetail.requestHeaders}
                    body={exchangeDetail.requestBody}
                  />
                  {exchangeDetail.statusCode && (
                    <div>
                      <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Response</h3>
                      <div className="flex items-center gap-2 mb-2">
                        <StatusBadge statusCode={exchangeDetail.statusCode} />
                        <span className="text-xs text-gray-500">
                          {exchangeDetail.duration}ms
                        </span>
                      </div>
                      {exchangeDetail.responseHeaders && (
                        <div className="bg-gray-900 rounded p-2 text-sm space-y-0.5 mb-2">
                          {Object.entries(exchangeDetail.responseHeaders).map(([k, v]) => (
                            <div key={k} className="flex">
                              <span className="text-cyan-400 min-w-[150px] shrink-0">{k}:</span>
                              <span className="text-gray-300 break-all">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {exchangeDetail.responseBody && (
                        <pre className="bg-gray-900 rounded p-2 text-xs text-gray-300 whitespace-pre-wrap break-all max-h-64 overflow-auto">
                          {formatBody(exchangeDetail.responseBody)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}

              {exchangeDetail && detailTab === 'ai' && (
                <AnalysisPanel exchangeId={exchangeDetail.id} />
              )}
            </div>
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { label: 'Send to Replay', onClick: () => sendToReplay(contextMenu.exchangeId) },
          ]}
        />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
