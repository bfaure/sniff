import type { FastifyInstance } from 'fastify';
import type { ProxyEngine } from '../proxy/engine.js';

export function proxyRoutes(fastify: FastifyInstance, engine: ProxyEngine): void {
  fastify.post('/api/proxy/start', async (_req, reply) => {
    if (engine.running) {
      return reply.code(200).send({ status: 'already_running', ...engine.getStatus() });
    }
    await engine.start();
    return reply.send({ status: 'started', ...engine.getStatus() });
  });

  fastify.post('/api/proxy/stop', async (_req, reply) => {
    if (!engine.running) {
      return reply.code(200).send({ status: 'already_stopped', ...engine.getStatus() });
    }
    await engine.stop();
    return reply.send({ status: 'stopped', ...engine.getStatus() });
  });

  fastify.get('/api/proxy/status', async (_req, reply) => {
    return reply.send(engine.getStatus());
  });

  fastify.post('/api/proxy/intercept/toggle', async (req, reply) => {
    const { enabled } = req.body as { enabled: boolean };
    engine.intercept.enabled = enabled;
    return reply.send({ interceptEnabled: engine.intercept.enabled });
  });

  fastify.get('/api/proxy/intercept/queue', async (_req, reply) => {
    return reply.send(engine.intercept.getQueue());
  });

  fastify.post('/api/proxy/intercept/:id/forward', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { headers, body } = (req.body || {}) as {
      headers?: Record<string, string | string[]>;
      body?: string | null;
    };
    engine.intercept.forward(id, headers || body !== undefined ? { headers, body } : undefined);
    return reply.send({ status: 'forwarded' });
  });

  fastify.post('/api/proxy/intercept/:id/drop', async (req, reply) => {
    const { id } = req.params as { id: string };
    engine.intercept.drop(id);
    return reply.send({ status: 'dropped' });
  });

  fastify.post('/api/proxy/intercept/forward-all', async (_req, reply) => {
    engine.intercept.forwardAll();
    return reply.send({ status: 'all_forwarded' });
  });
}
