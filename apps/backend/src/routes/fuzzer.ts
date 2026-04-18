import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { fuzzerEngine } from '../fuzzer/engine.js';

export function fuzzerRoutes(fastify: FastifyInstance) {
  // Create a new fuzzer job
  fastify.post('/api/fuzzer/jobs', async (req) => {
    const body = req.body as {
      name: string;
      attackType: string;
      templateReq: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body: string | null;
      };
      payloadPositions: string[];
      payloads: string[][];
      concurrency?: number;
      throttleMs?: number;
    };

    const { job, totalCombinations } = await fuzzerEngine.createJob(body);
    return { id: job.id, total: totalCombinations, status: 'pending' };
  });

  // Start a job
  fastify.post('/api/fuzzer/jobs/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    return fuzzerEngine.startJob(id);
  });

  // Pause a job
  fastify.post('/api/fuzzer/jobs/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    await fuzzerEngine.pauseJob(id);
    return { status: 'paused' };
  });

  // Resume a job
  fastify.post('/api/fuzzer/jobs/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    await fuzzerEngine.resumeJob(id);
    return { status: 'running' };
  });

  // Cancel a job
  fastify.post('/api/fuzzer/jobs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    await fuzzerEngine.cancelJob(id);
    return { status: 'cancelled' };
  });

  // List all jobs
  fastify.get('/api/fuzzer/jobs', async () => {
    return db.fuzzerJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  // Get a job with results
  fastify.get('/api/fuzzer/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = await db.fuzzerJob.findUnique({
      where: { id },
      include: { results: { orderBy: { id: 'asc' } } },
    });
    if (!job) throw new Error('Job not found');
    return job;
  });

  // Get results for a job (with optional interesting filter)
  fastify.get('/api/fuzzer/jobs/:id/results', async (req) => {
    const { id } = req.params as { id: string };
    const { interesting } = req.query as { interesting?: string };

    const where: Record<string, unknown> = { jobId: id };
    if (interesting === 'true') where.interesting = true;

    return db.fuzzerResult.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        payloads: true,
        statusCode: true,
        responseSize: true,
        duration: true,
        interesting: true,
      },
    });
  });

  // Delete a job
  fastify.delete('/api/fuzzer/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.fuzzerJob.delete({ where: { id } });
    return { deleted: true };
  });
}
