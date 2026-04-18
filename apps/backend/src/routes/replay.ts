import type { FastifyInstance } from 'fastify';
import * as http from 'http';
import * as https from 'https';
import { db } from '../db.js';

interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export function replayRoutes(fastify: FastifyInstance): void {
  // --- Tab persistence ---

  fastify.get('/api/replay/tabs', async () => {
    return db.replayTab.findMany({ orderBy: { sortOrder: 'asc' } });
  });

  fastify.post('/api/replay/tabs', async (req) => {
    const { id, name, method, url, headers, body, sortOrder } = req.body as {
      id?: string; name: string; method: string; url: string; headers: string; body: string; sortOrder: number;
    };
    return db.replayTab.create({
      data: { ...(id ? { id } : {}), name, method, url, headers, body, sortOrder },
    });
  });

  fastify.patch('/api/replay/tabs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const data = req.body as Partial<{ name: string; method: string; url: string; headers: string; body: string; sortOrder: number }>;
    return db.replayTab.update({ where: { id }, data });
  });

  fastify.delete('/api/replay/tabs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.replayTab.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // --- Tab history ---

  fastify.get('/api/replay/tabs/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    return db.replayHistory.findMany({
      where: { tabId: id },
      orderBy: { sortOrder: 'asc' },
    });
  });

  fastify.post('/api/replay/tabs/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    const { sortOrder, method, url, headers, body, statusCode, responseHeaders, responseBody, duration } = req.body as {
      sortOrder: number; method: string; url: string; headers: string; body: string;
      statusCode?: number; responseHeaders?: string; responseBody?: string; duration?: number;
    };
    return db.replayHistory.create({
      data: { tabId: id, sortOrder, method, url, headers, body, statusCode, responseHeaders, responseBody, duration },
    });
  });

  fastify.delete('/api/replay/tabs/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.replayHistory.deleteMany({ where: { tabId: id } });
    return reply.send({ ok: true });
  });

  // --- Send request ---

  fastify.post('/api/replay/send', async (req, reply) => {
    const { method, url, headers, body } = req.body as ReplayRequest;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'Invalid URL' });
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const startTime = Date.now();

    try {
      const result = await new Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
        body: string;
        bodyBase64: string;
        duration: number;
      }>((resolve, reject) => {
        const outReq = transport.request(
          {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers,
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers,
                body: buf.toString('utf-8'),
                bodyBase64: buf.toString('base64'),
                duration: Date.now() - startTime,
              });
            });
          },
        );

        outReq.on('error', reject);
        outReq.setTimeout(30000, () => {
          outReq.destroy(new Error('Request timeout'));
        });

        if (body) {
          outReq.end(body);
        } else {
          outReq.end();
        }
      });

      return reply.send(result);
    } catch (err) {
      return reply.code(502).send({
        error: `Request failed: ${(err as Error).message}`,
      });
    }
  });
}
