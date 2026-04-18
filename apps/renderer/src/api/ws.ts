import type { WSEvent, WSEventType, WSEventData } from '@sniff/shared';

type EventHandler<T extends WSEventType> = (data: WSEventData<T>) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Function>>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private url: string;
  private shouldReconnect = true;

  constructor(url?: string) {
    // In dev mode, connect directly to the backend to avoid Vite HMR WS conflicts
    const backendPort = 47120;
    const defaultUrl = window.location.port === '5173'
      ? `ws://${window.location.hostname}:${backendPort}/ws`
      : `ws://${window.location.hostname}:${window.location.port}/ws`;
    this.url = url || defaultUrl;
  }

  connect(): void {
    // Prevent duplicate connections (React StrictMode double-mount)
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this.shouldReconnect = true;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[ws] connected');
      this.reconnectDelay = 1000;
      // Notify any listeners that care about reconnection (so they can resync state)
      const reconnectHandlers = this.handlers.get('__reconnect__');
      if (reconnectHandlers) for (const h of reconnectHandlers) (h as Function)(null);
    };

    this.ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as WSEvent;
        const handlers = this.handlers.get(parsed.type);
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed.data);
          }
        }
      } catch (err) {
        console.error('[ws] failed to parse message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[ws] disconnected');
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[ws] error:', err);
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }

  on<T extends WSEventType>(type: T, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }
}

// Singleton
export const wsClient = new WebSocketClient();
