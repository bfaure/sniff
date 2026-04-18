import { useState, useEffect } from 'react';
import { wsClient } from '../api/ws';
import { api } from '../api/client';
import type { InterceptedItem } from '@sniff/shared';

export function useIntercept() {
  const [queue, setQueue] = useState<InterceptedItem[]>([]);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const unsubNew = wsClient.on('intercept:new', (data) => {
      setQueue((prev) => [...prev, data]);
    });

    const unsubResolved = wsClient.on('intercept:resolved', (data) => {
      setQueue((prev) => prev.filter((item) => item.id !== data.id));
    });

    const unsubStatus = wsClient.on('proxy:status', (data) => {
      setEnabled(data.interceptEnabled);
    });

    return () => {
      unsubNew();
      unsubResolved();
      unsubStatus();
    };
  }, []);

  const toggle = async (value: boolean) => {
    await api.proxy.toggleIntercept(value);
    setEnabled(value);
  };

  const forward = async (id: string, modified?: { headers?: Record<string, string | string[]>; body?: string | null }) => {
    await api.proxy.forward(id, modified);
  };

  const drop = async (id: string) => {
    await api.proxy.drop(id);
  };

  const forwardAll = async () => {
    await api.proxy.forwardAll();
  };

  return { queue, enabled, toggle, forward, drop, forwardAll };
}
