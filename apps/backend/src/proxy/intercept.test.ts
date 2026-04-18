import { describe, it, expect } from 'vitest';
import { InterceptQueue } from './intercept.js';

describe('InterceptQueue', () => {
  it('starts disabled', () => {
    const queue = new InterceptQueue();
    expect(queue.enabled).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('enqueues and resolves items', async () => {
    const queue = new InterceptQueue();
    const { id, promise } = queue.enqueue(
      'request', 'GET', 'http://example.com', { host: 'example.com' }, null,
    );

    expect(queue.size).toBe(1);
    expect(queue.getQueue()).toHaveLength(1);
    expect(queue.getQueue()[0].method).toBe('GET');

    // Forward the item
    queue.forward(id);

    const result = await promise;
    expect(result.headers).toEqual({ host: 'example.com' });
    expect(queue.size).toBe(0);
  });

  it('resolves with modified data on forward', async () => {
    const queue = new InterceptQueue();
    const { id, promise } = queue.enqueue(
      'request', 'POST', 'http://example.com', { host: 'example.com' }, 'original',
    );

    queue.forward(id, {
      headers: { host: 'modified.com' },
      body: 'modified body',
    });

    const result = await promise;
    expect(result.headers).toEqual({ host: 'modified.com' });
    expect(result.body).toBe('modified body');
  });

  it('rejects on drop', async () => {
    const queue = new InterceptQueue();
    const { id, promise } = queue.enqueue(
      'request', 'GET', 'http://example.com', {}, null,
    );

    queue.drop(id);

    await expect(promise).rejects.toBe('dropped');
    expect(queue.size).toBe(0);
  });

  it('forwards all items when disabled', async () => {
    const queue = new InterceptQueue();
    queue.enabled = true;

    const { promise: p1 } = queue.enqueue('request', 'GET', 'http://a.com', {}, null);
    const { promise: p2 } = queue.enqueue('request', 'GET', 'http://b.com', {}, null);

    expect(queue.size).toBe(2);

    queue.enabled = false; // should forward all

    await p1;
    await p2;
    expect(queue.size).toBe(0);
  });

  it('emits events', () => {
    const queue = new InterceptQueue();
    const events: string[] = [];

    queue.onEvent((event) => events.push(event));

    const { id } = queue.enqueue('request', 'GET', 'http://example.com', {}, null);
    queue.forward(id);

    expect(events).toEqual(['new', 'resolved']);
  });

  it('unsubscribes listeners', () => {
    const queue = new InterceptQueue();
    const events: string[] = [];

    const unsub = queue.onEvent((event) => events.push(event));
    unsub();

    queue.enqueue('request', 'GET', 'http://example.com', {}, null);
    expect(events).toEqual([]);
  });
});
