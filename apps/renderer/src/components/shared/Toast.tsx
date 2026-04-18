import React, { useState, useEffect, useCallback } from 'react';
import { wsClient } from '../../api/ws';

interface ToastItem {
  id: number;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  escalated?: boolean;
  dismissing: boolean;
}

const SEVERITY_STYLES: Record<string, { border: string; bg: string; badge: string; text: string }> = {
  critical: { border: 'border-red-600', bg: 'bg-red-950/95', badge: 'bg-red-600 text-white', text: 'text-red-200' },
  high: { border: 'border-orange-600', bg: 'bg-orange-950/95', badge: 'bg-orange-600 text-white', text: 'text-orange-200' },
  medium: { border: 'border-amber-600', bg: 'bg-amber-950/95', badge: 'bg-amber-600 text-white', text: 'text-amber-200' },
  low: { border: 'border-blue-600', bg: 'bg-blue-950/95', badge: 'bg-blue-700 text-white', text: 'text-blue-200' },
  info: { border: 'border-gray-600', bg: 'bg-gray-800/95', badge: 'bg-gray-600 text-gray-200', text: 'text-gray-300' },
};

// Auto-dismiss durations by severity (ms)
const DISMISS_DELAYS: Record<string, number> = {
  critical: 8000,
  high: 6000,
  medium: 5000,
  low: 4000,
  info: 3000,
};

let nextId = 0;

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, dismissing: true } : t));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 300);
  }, []);

  useEffect(() => {
    const unsub = wsClient.on('llm:finding', (data) => {
      // Only toast for medium+ severity
      if (data.severity === 'info' || data.severity === 'low') return;

      const id = nextId++;
      const toast: ToastItem = {
        id,
        severity: data.severity,
        title: data.title,
        detail: data.detail,
        escalated: data.escalated,
        dismissing: false,
      };

      setToasts((prev) => [...prev, toast].slice(-5)); // Max 5 visible

      // Auto-dismiss
      const delay = DISMISS_DELAYS[data.severity] || 5000;
      setTimeout(() => dismiss(id), delay);
    });
    return unsub;
  }, [dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-3 right-3 z-50 flex flex-col gap-2 w-80 pointer-events-none">
      {toasts.map((toast) => {
        const s = SEVERITY_STYLES[toast.severity] || SEVERITY_STYLES.info;
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto border-l-4 ${s.border} ${s.bg} rounded-r shadow-lg backdrop-blur-sm px-3 py-2 cursor-pointer transition-all duration-300 ${
              toast.dismissing ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'
            }`}
            onClick={() => dismiss(toast.id)}
          >
            <div className="flex items-center gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold ${s.badge} shrink-0`}>
                {toast.escalated ? 'DEEP ' : ''}{toast.severity}
              </span>
              <span className={`text-xs font-medium ${s.text} truncate`}>{toast.title}</span>
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">{toast.detail}</div>
          </div>
        );
      })}
    </div>
  );
}
