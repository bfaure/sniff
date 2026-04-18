import React, { useState, useEffect } from 'react';
import { wsClient } from '../../api/ws';

interface Finding {
  exchangeId: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  method: string | null;
  url: string | null;
  timestamp: number;
  escalated?: boolean;
}

const SEVERITY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  critical: { bg: 'bg-red-950', text: 'text-red-300', border: 'border-red-800' },
  high: { bg: 'bg-orange-950', text: 'text-orange-300', border: 'border-orange-800' },
  medium: { bg: 'bg-amber-950', text: 'text-amber-300', border: 'border-amber-800' },
  low: { bg: 'bg-blue-950', text: 'text-blue-300', border: 'border-blue-800' },
  info: { bg: 'bg-gray-800', text: 'text-gray-300', border: 'border-gray-700' },
};

interface FindingsPanelProps {
  onSelectExchange?: (exchangeId: string) => void;
}

export function FindingsPanel({ onSelectExchange }: FindingsPanelProps) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const unsub = wsClient.on('finding:new' as any, (data: any) => {
      setFindings((prev) => [{
        exchangeId: data.exchangeId,
        severity: data.severity,
        title: data.title,
        detail: data.detail,
        method: data.method,
        url: data.url,
        escalated: data.escalated,
        timestamp: Date.now(),
      }, ...prev].slice(0, 50));
    });
    return unsub;
  }, []);

  const critCount = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;

  if (findings.length === 0) return null;

  return (
    <div className="border-t border-gray-800">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-left"
      >
        <span className="text-xs uppercase tracking-wider text-purple-400 font-medium">
          AI Findings
        </span>
        <span className={`text-xs px-1.5 rounded-full ${critCount > 0 ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
          {findings.length}
        </span>
        <span className="flex-1" />
        <span className="text-gray-600 text-xs">{expanded ? '\u25BE' : '\u25B8'}</span>
      </button>

      {/* Findings list */}
      {expanded && (
        <div className="max-h-48 overflow-auto">
          {findings.map((f, i) => {
            const colors = SEVERITY_COLORS[f.severity] || SEVERITY_COLORS.info;
            return (
              <div
                key={`${f.exchangeId || 'no-ex'}-${i}`}
                onClick={() => f.exchangeId && onSelectExchange?.(f.exchangeId)}
                className={`flex items-start gap-2 px-3 py-1.5 border-b ${colors.border} cursor-pointer hover:bg-gray-800/50`}
              >
                <span className={`text-[10px] px-1 py-0.5 rounded uppercase font-bold ${colors.bg} ${colors.text} shrink-0 mt-0.5`}>
                  {f.escalated ? '* ' : ''}{f.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-gray-200 font-medium truncate">{f.title}</div>
                  <div className="text-[10px] text-gray-500 truncate">{f.detail}</div>
                  <div className="text-[10px] text-gray-600 truncate mt-0.5">
                    {f.method && f.url ? `${f.method} ${(() => { try { return new URL(f.url).pathname; } catch { return f.url; } })()}` : ''}
                  </div>
                </div>
                <span className="text-[10px] text-gray-700 shrink-0">
                  {new Date(f.timestamp).toLocaleTimeString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
