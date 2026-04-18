// Lightweight cross-page event bus with buffering for cross-page navigation
type ReplayRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

type FuzzerConfig = {
  name: string;
  attackType: string;
  templateReq: { method: string; url: string; headers: Record<string, string>; body: string | null };
  payloadPositions: string[];
  payloads: string[][];
};

type TestInReplay = {
  request: ReplayRequest;
  vulnType: string;
};

type EventMap = {
  'send-to-replay': ReplayRequest;
  'send-to-fuzzer': FuzzerConfig;
  'test-in-replay': TestInReplay;
};

type Listener<T> = (data: T) => void;

const listeners = new Map<string, Set<Listener<unknown>>>();
const pending = new Map<string, unknown[]>();

export const appEvents = {
  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    if (!listeners.has(event)) listeners.set(event, new Set());
    const set = listeners.get(event)!;
    set.add(listener as Listener<unknown>);

    // Deliver any buffered events
    const queued = pending.get(event);
    if (queued) {
      pending.delete(event);
      queued.forEach((data) => listener(data as EventMap[K]));
    }

    return () => set.delete(listener as Listener<unknown>);
  },

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const set = listeners.get(event);
    if (set && set.size > 0) {
      set.forEach((fn) => fn(data));
    } else {
      // Buffer for late subscribers (e.g., page not yet mounted)
      if (!pending.has(event)) pending.set(event, []);
      pending.get(event)!.push(data);
    }
  },
};
