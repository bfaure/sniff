import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { wsClient } from '../api/ws';

interface FailedEntry {
  id: string;
  method: string;
  host: string;
  path: string;
  url: string;
  errorMessage: string;
  duration: number | null;
  timestamp: string;
  inScope: boolean;
}

export function FailedPage() {
  const [entries, setEntries] = useState<FailedEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');

  const searchRef = useRef(search);
  searchRef.current = search;

  // Monotonic sequence ensures only the latest response wins, preventing
  // stale overwrites when rapid-fire `traffic:new` events trigger overlapping loads.
  const seqRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const mySeq = ++seqRef.current;
    try {
      const params: Record<string, string> = { limit: '200' };
      if (searchRef.current) params.search = searchRef.current;
      const result = await api.history.listFailed(params);
      if (mySeq !== seqRef.current) return; // newer load started; discard
      setEntries(result.data);
      setTotal(result.total);
      setLoaded(true);
    } catch {
      if (mySeq === seqRef.current) setLoaded(true);
    }
  }, []);

  // Debounced refresh — coalesces bursts of ws events into a single load
  const scheduleLoad = useCallback(() => {
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(load, 300);
  }, [load]);

  useEffect(() => {
    load();
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    };
  }, [load]);

  useEffect(() => {
    scheduleLoad();
  }, [search, scheduleLoad]);

  useEffect(() => {
    const unsub = wsClient.on('traffic:new', scheduleLoad);
    return unsub;
  }, [scheduleLoad]);

  const handleClear = async () => {
    if (!confirm(`Clear all ${total} failed request entries?`)) return;
    await api.history.clearFailed();
    load();
  };

  const groupedByError = entries.reduce<Record<string, number>>((acc, e) => {
    const key = e.errorMessage.split(':')[0].trim() || 'error';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-gray-800 p-4 flex items-center gap-3">
        <h2 className="text-sm font-bold text-gray-300">Failed Requests</h2>
        <span className="text-xs text-gray-500">{total} total</span>
        <input
          type="text"
          placeholder="Filter by URL..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-emerald-500 w-64"
        />
        <button
          onClick={load}
          className="px-3 py-1 text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded hover:bg-gray-700"
        >
          Refresh
        </button>
        {total > 0 && (
          <button
            onClick={handleClear}
            className="px-3 py-1 text-xs bg-red-900/50 text-red-300 border border-red-800 rounded hover:bg-red-900"
          >
            Clear All
          </button>
        )}
      </div>

      {Object.keys(groupedByError).length > 0 && (
        <div className="px-4 py-2 border-b border-gray-800 flex gap-3 flex-wrap">
          {Object.entries(groupedByError).map(([key, count]) => (
            <span key={key} className="text-[11px] text-gray-400">
              <span className="text-red-400 font-mono">{key}</span>: {count}
            </span>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!loaded ? (
          <div className="p-8 text-center text-gray-500 text-sm">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            No failed requests. Connection errors (DNS, TLS, etc.) will appear here.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-900 sticky top-0">
              <tr className="text-left text-gray-500">
                <th className="px-3 py-2 font-medium w-16">Method</th>
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium">Error</th>
                <th className="px-3 py-2 font-medium w-20">Time</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-gray-800/50 hover:bg-gray-900/50">
                  <td className="px-3 py-1.5 font-mono text-gray-300">{e.method}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-200">{e.host}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-400 truncate max-w-xs" title={e.path}>{e.path}</td>
                  <td className="px-3 py-1.5 text-red-400 font-mono truncate max-w-md" title={e.errorMessage}>{e.errorMessage}</td>
                  <td className="px-3 py-1.5 text-gray-500">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
