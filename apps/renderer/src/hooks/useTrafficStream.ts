import { useState, useEffect, useCallback } from 'react';
import { wsClient } from '../api/ws';
import type { ExchangeSummary } from '@sniff/shared';

export function useTrafficStream(maxItems = 1000) {
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);

  useEffect(() => {
    const unsubNew = wsClient.on('traffic:new', (data) => {
      setExchanges((prev) => {
        // Deduplicate by id
        if (prev.some((e) => e.id === data.id)) return prev;
        const next = [data, ...prev];
        return next.length > maxItems ? next.slice(0, maxItems) : next;
      });
    });

    const unsubUpdate = wsClient.on('traffic:update', (data) => {
      setExchanges((prev) => {
        const idx = prev.findIndex((e) => e.id === data.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], statusCode: data.statusCode, responseSize: data.responseSize, duration: data.duration };
        return next;
      });
    });

    return () => {
      unsubNew();
      unsubUpdate();
    };
  }, [maxItems]);

  const clear = useCallback(() => setExchanges([]), []);

  return { exchanges, clear };
}
