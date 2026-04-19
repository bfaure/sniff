import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { isInScope } from '../proxy/scope.js';
import { autoAnalyzer } from '../llm/auto-analyzer.js';

/**
 * Re-evaluate inScope for all existing exchanges against current rules.
 * Runs in batches to avoid blocking. Fire-and-forget from route handlers.
 */
async function reEvaluateScope(): Promise<{ updated: number; newlyInScope: number }> {
  const BATCH = 500;
  let cursor: string | undefined;
  let updated = 0;
  let newlyInScope = 0;
  while (true) {
    const exchanges = await db.exchange.findMany({
      select: { id: true, url: true, inScope: true },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (exchanges.length === 0) break;
    cursor = exchanges[exchanges.length - 1].id;
    for (const ex of exchanges) {
      const now = await isInScope(ex.url);
      if (now !== ex.inScope) {
        await db.exchange.update({ where: { id: ex.id }, data: { inScope: now } });
        updated++;
        if (now) newlyInScope++;
      }
    }
  }
  if (updated > 0) console.log(`[scope] re-evaluated: ${updated} exchanges updated (${newlyInScope} newly in-scope)`);
  return { updated, newlyInScope };
}

export function scopeRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/scope/rules', async (_req, reply) => {
    const rules = await db.scopeRule.findMany({ orderBy: { order: 'asc' } });
    return reply.send(rules);
  });

  fastify.post('/api/scope/rules', async (req, reply) => {
    const { type, protocol, host, port, path, enabled } = req.body as {
      type: 'include' | 'exclude';
      protocol?: string;
      host: string;
      port?: number;
      path?: string;
      enabled?: boolean;
    };

    const maxOrder = await db.scopeRule.aggregate({ _max: { order: true } });
    const order = (maxOrder._max.order ?? -1) + 1;

    const rule = await db.scopeRule.create({
      data: {
        type,
        protocol: protocol || null,
        host,
        port: port || null,
        path: path || null,
        enabled: enabled ?? true,
        order,
      },
    });

    // Re-evaluate scope on all existing exchanges, then count newly in-scope unanalyzed ones
    const reevalResult = await reEvaluateScope();

    // Count exchanges that are now in-scope and have never been auto-analyzed
    let pendingAnalysisCount = 0;
    if (reevalResult.newlyInScope > 0) {
      // Find in-scope exchanges with no auto-analysis
      const analyzed = await db.analysis.findMany({
        where: { type: { startsWith: 'auto' } },
        select: { exchangeId: true },
        distinct: ['exchangeId'],
      });
      const analyzedIds = new Set(analyzed.map((a) => a.exchangeId));
      const inScopeExchanges = await db.exchange.findMany({
        where: { inScope: true },
        select: { id: true },
      });
      pendingAnalysisCount = inScopeExchanges.filter((e) => !analyzedIds.has(e.id)).length;
    }

    return reply.code(201).send({ ...rule, pendingAnalysisCount });
  });

  fastify.put('/api/scope/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = req.body as Record<string, unknown>;
    const rule = await db.scopeRule.update({ where: { id }, data });
    reEvaluateScope().catch(() => {});
    return reply.send(rule);
  });

  fastify.delete('/api/scope/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.scopeRule.delete({ where: { id } });
    reEvaluateScope().catch(() => {});
    return reply.send({ status: 'deleted' });
  });

  fastify.get('/api/scope/analyze-pending/count', async (_req, reply) => {
    const includeRuleCount = await db.scopeRule.count({ where: { enabled: true, type: 'include' } });
    if (includeRuleCount === 0) return reply.send({ count: 0 });

    const analyzed = await db.analysis.findMany({
      where: { type: { startsWith: 'auto' } },
      select: { exchangeId: true },
      distinct: ['exchangeId'],
    });
    const analyzedIds = new Set(analyzed.map((a) => a.exchangeId));
    const inScopeExchanges = await db.exchange.findMany({
      where: { inScope: true },
      select: { id: true },
    });
    const count = inScopeExchanges.filter((e) => !analyzedIds.has(e.id)).length;
    return reply.send({ count });
  });

  // List pending (unanalyzed) in-scope exchanges grouped by host
  fastify.get('/api/scope/analyze-pending/list', async (_req, reply) => {
    const includeRuleCount = await db.scopeRule.count({ where: { enabled: true, type: 'include' } });
    if (includeRuleCount === 0) return reply.send({ exchanges: [], total: 0 });

    const analyzed = await db.analysis.findMany({
      where: { type: { startsWith: 'auto' } },
      select: { exchangeId: true },
      distinct: ['exchangeId'],
    });
    const analyzedIds = new Set(analyzed.map((a) => a.exchangeId));
    const inScopeExchanges = await db.exchange.findMany({
      where: { inScope: true },
      select: { id: true, method: true, url: true, host: true, path: true, statusCode: true },
      orderBy: { timestamp: 'asc' },
    });
    const pending = inScopeExchanges.filter((e) => !analyzedIds.has(e.id));
    return reply.send({ exchanges: pending, total: pending.length });
  });

  fastify.post('/api/scope/analyze-pending', async (req, reply) => {
    const includeRuleCount = await db.scopeRule.count({ where: { enabled: true, type: 'include' } });
    if (includeRuleCount === 0) return reply.send({ queued: 0 });

    // Find in-scope exchanges that have never been auto-analyzed and queue them
    const analyzed = await db.analysis.findMany({
      where: { type: { startsWith: 'auto' } },
      select: { exchangeId: true },
      distinct: ['exchangeId'],
    });
    const analyzedIds = new Set(analyzed.map((a) => a.exchangeId));
    const inScopeExchanges = await db.exchange.findMany({
      where: { inScope: true },
      select: { id: true },
      orderBy: { timestamp: 'asc' },
    });
    let queued = 0;
    let droppedDisabled = 0;
    const enabled = autoAnalyzer.isEnabled();
    for (const ex of inScopeExchanges) {
      if (!analyzedIds.has(ex.id)) {
        if (!enabled) {
          droppedDisabled++;
        } else {
          autoAnalyzer.enqueue(ex.id);
          queued++;
        }
      }
    }
    if (queued > 0) {
      autoAnalyzer.notifyBatchQueued(queued, 'scope re-evaluation');
    }
    console.log(`[scope] analyze-pending: queued=${queued}, droppedDisabled=${droppedDisabled}, enabled=${enabled}`);
    return reply.send({ queued, droppedDisabled, autoAnalyzeEnabled: enabled });
  });

  fastify.post('/api/scope/test', async (req, reply) => {
    const { url } = req.body as { url: string };
    const result = await isInScope(url);
    return reply.send({ url, inScope: result });
  });
}
