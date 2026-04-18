import type { FastifyInstance } from 'fastify';
import * as http from 'http';
import * as https from 'https';
import { db } from '../db.js';
import { llmInvoke } from '../llm/client.js';
import { buildMessages } from '../llm/prompts.js';
import { makeDedupeKey } from '../llm/findings.js';

interface ReplayResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function replayExchange(method: string, url: string, headers: Record<string, string>, body: string | null): Promise<ReplayResult> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body) req.end(body);
    else req.end();
  });
}

export function findingsRoutes(fastify: FastifyInstance) {
  // List findings with optional filters
  fastify.get('/api/findings', async (req) => {
    const q = req.query as {
      host?: string;
      severity?: string;
      status?: string;
      source?: string;
      limit?: string;
    };
    const where: Record<string, unknown> = {};
    if (q.host) where.host = q.host;
    if (q.severity) where.severity = q.severity;
    if (q.status) where.status = q.status;
    if (q.source) where.source = q.source;

    const limit = Math.min(parseInt(q.limit || '500', 10), 2000);
    const findings = await db.finding.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
    return { findings, total: findings.length };
  });

  // Get a single finding
  fastify.get('/api/findings/:id', async (req) => {
    const { id } = req.params as { id: string };
    return db.finding.findUnique({ where: { id } });
  });

  // Update finding status (open/confirmed/false-positive/fixed) or other fields
  fastify.patch('/api/findings/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { status?: string; detail?: string; severity?: string };
    const data: Record<string, unknown> = {};
    if (body.status) data.status = body.status;
    if (body.detail !== undefined) data.detail = body.detail;
    if (body.severity) data.severity = body.severity;
    return db.finding.update({ where: { id }, data });
  });

  // Delete a finding
  fastify.delete('/api/findings/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.finding.delete({ where: { id } });
    return { deleted: true };
  });

  // Re-test a finding by replaying its exchange and re-running vuln-scan.
  // If the model no longer reports a matching finding, mark this one as 'fixed'.
  fastify.post('/api/findings/:id/retest', async (req, reply) => {
    const { id } = req.params as { id: string };
    const finding = await db.finding.findUnique({ where: { id } });
    if (!finding) return reply.code(404).send({ error: 'Finding not found' });
    if (!finding.exchangeId) return reply.code(400).send({ error: 'Finding has no associated exchange to replay' });

    const exchange = await db.exchange.findUnique({ where: { id: finding.exchangeId } });
    if (!exchange) return reply.code(400).send({ error: 'Original exchange no longer exists' });

    let replay: ReplayResult;
    try {
      const headers = JSON.parse(exchange.requestHeaders) as Record<string, string>;
      const body = exchange.requestBody ? Buffer.from(exchange.requestBody).toString('utf-8') : null;
      replay = await replayExchange(exchange.method, exchange.url, headers, body);
    } catch (err) {
      return reply.code(502).send({ error: `Replay failed: ${(err as Error).message}` });
    }

    // Build vuln-scan prompt against the replayed response
    const ctx = {
      method: exchange.method,
      url: exchange.url,
      requestHeaders: JSON.parse(exchange.requestHeaders),
      requestBody: exchange.requestBody ? Buffer.from(exchange.requestBody).toString('utf-8') : null,
      statusCode: replay.statusCode,
      responseHeaders: replay.headers as Record<string, string>,
      responseBody: replay.body,
    };
    const messages = buildMessages('vuln-scan', ctx, undefined, undefined);
    const result = await llmInvoke(messages, 'reasoning', undefined, 'regression-retest');

    // Parse and look for a matching dedupeKey
    const targetKey = finding.dedupeKey;
    let stillPresent = false;
    try {
      const cleaned = result.text.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.findings)) {
        for (const f of parsed.findings) {
          if (!f?.title) continue;
          const key = makeDedupeKey(finding.host, f.title, f.type || null);
          if (key === targetKey) {
            stillPresent = true;
            break;
          }
        }
      }
    } catch {
      // Couldn't parse — treat as inconclusive (don't change status)
      return reply.send({ stillPresent: null, inconclusive: true, replayStatus: replay.statusCode });
    }

    const newStatus = stillPresent ? finding.status : 'fixed';
    const updated = await db.finding.update({
      where: { id },
      data: { status: newStatus },
    });

    return reply.send({
      stillPresent,
      replayStatus: replay.statusCode,
      finding: updated,
    });
  });

  // Bulk clear (e.g. start fresh)
  fastify.delete('/api/findings', async () => {
    const result = await db.finding.deleteMany({});
    return { deleted: result.count };
  });
}
