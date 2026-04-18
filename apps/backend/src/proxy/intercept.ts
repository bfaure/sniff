import { randomUUID } from 'crypto';
import type { InterceptedItem } from '@sniff/shared';

interface QueuedItem {
  item: InterceptedItem;
  resolve: (modified: { headers: Record<string, string | string[]>; body: string | null }) => void;
  reject: (reason: string) => void;
}

type InterceptListener = (event: 'new' | 'resolved', item: InterceptedItem) => void;

export class InterceptQueue {
  private queue = new Map<string, QueuedItem>();
  private listeners: InterceptListener[] = [];
  private _enabled = false;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
    if (!value) {
      this.forwardAll();
    }
  }

  onEvent(listener: InterceptListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: 'new' | 'resolved', item: InterceptedItem): void {
    for (const listener of this.listeners) {
      listener(event, item);
    }
  }

  enqueue(
    type: 'request' | 'response',
    method: string,
    url: string,
    headers: Record<string, string | string[]>,
    body: string | null,
  ): { id: string; promise: Promise<{ headers: Record<string, string | string[]>; body: string | null }> } {
    const id = randomUUID();
    const item: InterceptedItem = {
      id,
      type,
      method,
      url,
      headers,
      body,
      timestamp: Date.now(),
    };

    let resolve!: QueuedItem['resolve'];
    let reject!: QueuedItem['reject'];
    const promise = new Promise<{ headers: Record<string, string | string[]>; body: string | null }>(
      (res, rej) => {
        resolve = res;
        reject = rej;
      },
    );

    this.queue.set(id, { item, resolve, reject });
    this.emit('new', item);

    return { id, promise };
  }

  forward(
    id: string,
    modified?: { headers?: Record<string, string | string[]>; body?: string | null },
  ): void {
    const queued = this.queue.get(id);
    if (!queued) return;

    this.queue.delete(id);
    queued.resolve({
      headers: modified?.headers ?? queued.item.headers,
      body: modified?.body !== undefined ? modified.body : queued.item.body,
    });
    this.emit('resolved', queued.item);
  }

  drop(id: string): void {
    const queued = this.queue.get(id);
    if (!queued) return;

    this.queue.delete(id);
    queued.reject('dropped');
    this.emit('resolved', queued.item);
  }

  forwardAll(): void {
    for (const [id] of this.queue) {
      this.forward(id);
    }
  }

  getQueue(): InterceptedItem[] {
    return Array.from(this.queue.values()).map((q) => q.item);
  }

  get size(): number {
    return this.queue.size;
  }
}
