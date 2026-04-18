import type { FastifyInstance } from 'fastify';
import { noiseFilter } from '../llm/noise-filter.js';

export function noiseFilterRoutes(fastify: FastifyInstance) {
  // List all noise filter rules
  fastify.get('/api/noise-filters', async () => {
    return noiseFilter.list();
  });

  // Toggle a rule on/off
  fastify.patch('/api/noise-filters/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { enabled } = req.body as { enabled: boolean };
    return noiseFilter.toggle(id, enabled);
  });

  // Delete a rule
  fastify.delete('/api/noise-filters/:id', async (req) => {
    const { id } = req.params as { id: string };
    await noiseFilter.remove(id);
    return { deleted: true };
  });

  // Add a manual rule
  fastify.post('/api/noise-filters', async (req) => {
    const { host, method, shape } = req.body as { host: string; method: string; shape: string };
    return noiseFilter.addManual(host, method, shape);
  });

  // Clear all auto-detected rules
  fastify.delete('/api/noise-filters/auto', async () => {
    const count = await noiseFilter.clearAuto();
    return { deleted: count };
  });
}
