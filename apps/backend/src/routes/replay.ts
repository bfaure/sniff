import type { FastifyInstance } from 'fastify';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { db } from '../db.js';

// Decompress an upstream response body based on its Content-Encoding. Browsers
// do this transparently; Node's http client does not. Without this, replayed
// responses come back as gzipped bytes with a `Content-Encoding: gzip` header,
// which the UI then tries (and fails) to render as text.
function decodeBody(encoding: string | undefined, buf: Buffer): Buffer {
  const enc = (encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch {
    // Corrupt / truncated — fall through to raw bytes.
  }
  return buf;
}

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

    // Recompute Content-Length from the actual body bytes. The body shown in
    // the UI may have been edited after capture; forwarding a stale length
    // desyncs from what we're about to write and makes servers misbehave.
    // We match any case variant of the header name.
    const outHeaders = { ...headers };
    for (const k of Object.keys(outHeaders)) {
      if (k.toLowerCase() === 'content-length') delete outHeaders[k];
    }
    if (body != null && body.length > 0) {
      outHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
    }

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
            headers: outHeaders,
            rejectUnauthorized: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks);
              const decoded = decodeBody(res.headers['content-encoding'] as string | undefined, raw);
              // Strip headers that described the wire encoding — we return
              // decoded bytes, so both Content-Encoding and the old
              // Content-Length no longer apply.
              const outHeaders: Record<string, string | string[] | undefined> = { ...res.headers };
              delete outHeaders['content-encoding'];
              delete outHeaders['content-length'];
              resolve({
                statusCode: res.statusCode || 0,
                headers: outHeaders,
                body: decoded.toString('utf-8'),
                bodyBase64: decoded.toString('base64'),
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
