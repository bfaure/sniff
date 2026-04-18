import { useEffect } from 'react';
import { wsClient } from '../api/ws';

export function useWebSocket(): void {
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.disconnect();
  }, []);
}
