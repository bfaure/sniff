import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import type { ExchangeSummary } from '@sniff/shared';

export function historyRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/history', async (req, reply) => {
    const query = req.query as {
      page?: string;
      limit?: string;
      host?: string;
      method?: string;
      statusCode?: string;
      search?: string;
      deep?: string;
      inScope?: string;
      hide?: string; // comma-separated patterns to exclude
    };

    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    // Exclude failed exchanges from main history (they live on the Failed tab)
    where.errorMessage = null;

    if (query.host) where.host = { contains: query.host };
    if (query.method) where.method = query.method;
    if (query.statusCode) where.statusCode = parseInt(query.statusCode, 10);
    if (query.search) where.url = { contains: query.search };
    if (query.inScope === 'true') where.inScope = true;
    if (query.inScope === 'false') where.inScope = false;

    // Hide patterns — exclude exchanges matching any pattern in host, path, or method
    if (query.hide) {
      const patterns = query.hide.split(',').map((p) => p.trim()).filter(Boolean);
      if (patterns.length > 0) {
        where.AND = patterns.map((p) => ({
          NOT: {
            OR: [
              { host: { contains: p } },
              { path: { contains: p } },
              { method: { contains: p } },
            ],
          },
        }));
      }
    }

    // Deep search — searches across URL, headers, and bodies using OR
    if (query.deep) {
      const term = query.deep;
      where.OR = [
        { url: { contains: term } },
        { requestHeaders: { contains: term } },
        { responseHeaders: { contains: term } },
        // SQLite raw query for body search (Bytes fields stored as text in SQLite)
        { path: { contains: term } },
        { host: { contains: term } },
      ];
    }

    const [exchanges, total] = await Promise.all([
      db.exchange.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          method: true,
          host: true,
          path: true,
          statusCode: true,
          requestSize: true,
          responseSize: true,
          duration: true,
          timestamp: true,
          responseHeaders: true,
          inScope: true,
          highlighted: true,
        },
      }),
      db.exchange.count({ where }),
    ]);

    // Map each row to its SQLite rowid, which serves as the per-project request
    // number (rowid auto-increments on insert and the working DB is swapped per
    // project, so the value is meaningful only inside that project).
    const seqById = new Map<string, number>();
    if (exchanges.length > 0) {
      const placeholders = exchanges.map(() => '?').join(',');
      const seqRows = await db.$queryRawUnsafe<Array<{ id: string; seq: bigint | number }>>(
        `SELECT id, rowid AS seq FROM Exchange WHERE id IN (${placeholders})`,
        ...exchanges.map((e) => e.id),
      );
      for (const r of seqRows) seqById.set(r.id, Number(r.seq));
    }

    const summaries: ExchangeSummary[] = exchanges.map((e) => {
      let contentType: string | null = null;
      if (e.responseHeaders) {
        try {
          const headers = JSON.parse(e.responseHeaders);
          contentType = headers['content-type'] || null;
        } catch {}
      }
      return {
        id: e.id,
        seq: seqById.get(e.id) ?? 0,
        method: e.method,
        host: e.host,
        path: e.path,
        statusCode: e.statusCode,
        requestSize: e.requestSize,
        responseSize: e.responseSize,
        duration: e.duration,
        timestamp: e.timestamp.toISOString(),
        contentType,
        inScope: e.inScope,
        highlighted: e.highlighted,
      };
    });

    return reply.send({ data: summaries, total, page, limit });
  });

  fastify.get('/api/history/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { preview } = req.query as { preview?: string };
    const exchange = await db.exchange.findUnique({ where: { id } });

    if (!exchange) {
      return reply.code(404).send({ error: 'Exchange not found' });
    }

    const PREVIEW_LIMIT = 50_000;    // Show first 50KB in preview
    const PREVIEW_THRESHOLD = 500_000; // Only preview bodies over 500KB
    const isPreview = preview === 'true';

    const truncateBody = (buf: Buffer | null) => {
      if (!buf) return { text: null, base64: null, truncated: false, fullSize: 0 };
      const fullSize = buf.length;
      if (isPreview && fullSize > PREVIEW_THRESHOLD) {
        const slice = buf.subarray(0, PREVIEW_LIMIT);
        return {
          text: slice.toString('utf-8'),
          base64: slice.toString('base64'),
          truncated: true,
          fullSize,
        };
      }
      return {
        text: buf.toString('utf-8'),
        base64: buf.toString('base64'),
        truncated: false,
        fullSize,
      };
    };

    const reqBody = truncateBody(exchange.requestBody ? Buffer.from(exchange.requestBody) : null);
    const resBody = truncateBody(exchange.responseBody ? Buffer.from(exchange.responseBody) : null);

    return reply.send({
      ...exchange,
      requestHeaders: JSON.parse(exchange.requestHeaders),
      responseHeaders: exchange.responseHeaders
        ? JSON.parse(exchange.responseHeaders)
        : null,
      tags: JSON.parse(exchange.tags),
      requestBody: reqBody.text,
      requestBodyBase64: reqBody.base64,
      requestBodyTruncated: reqBody.truncated,
      requestBodyFullSize: reqBody.fullSize,
      responseBody: resBody.text,
      responseBodyBase64: resBody.base64,
      responseBodyTruncated: resBody.truncated,
      responseBodyFullSize: resBody.fullSize,
      timestamp: exchange.timestamp.toISOString(),
    });
  });

  // Deep search across all fields including request/response bodies
  fastify.get('/api/history/search', async (req, reply) => {
    const query = req.query as {
      q: string;
      page?: string;
      limit?: string;
      inScope?: string;
      hide?: string;
    };

    if (!query.q) {
      return reply.code(400).send({ error: 'Search query (q) is required' });
    }

    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = (page - 1) * limit;

    // Use raw SQL to search across all text fields including body blobs
    // SQLite stores Bytes as blob but we can cast to text for search
    let scopeClause = '';
    if (query.inScope === 'true') scopeClause = 'AND inScope = 1';
    else if (query.inScope === 'false') scopeClause = 'AND inScope = 0';

    // Build hide clause for excluding patterns from host/path/method
    let hideClause = '';
    const hideParams: string[] = [];
    if (query.hide) {
      const patterns = query.hide.split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of patterns) {
        hideClause += ' AND host NOT LIKE ? AND path NOT LIKE ? AND method NOT LIKE ?';
        const pat = `%${p}%`;
        hideParams.push(pat, pat, pat);
      }
    }

    const searchPattern = `%${query.q}%`;

    const countResult = await db.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT COUNT(*) as count FROM Exchange
       WHERE (
         url LIKE ? OR
         host LIKE ? OR
         path LIKE ? OR
         requestHeaders LIKE ? OR
         responseHeaders LIKE ? OR
         CAST(requestBody AS TEXT) LIKE ? OR
         CAST(responseBody AS TEXT) LIKE ?
       ) ${scopeClause}${hideClause}`,
      searchPattern, searchPattern, searchPattern,
      searchPattern, searchPattern, searchPattern, searchPattern,
      ...hideParams,
    );

    const total = Number(countResult[0].count);

    const rows = await db.$queryRawUnsafe<Array<{
      id: string;
      seq: bigint | number;
      method: string;
      host: string;
      path: string;
      statusCode: number | null;
      requestSize: number;
      responseSize: number | null;
      duration: number | null;
      timestamp: string;
      responseHeaders: string | null;
      inScope: number;
      highlighted: number;
      matchField: string;
    }>>(
      `SELECT id, rowid AS seq, method, host, path, statusCode, requestSize, responseSize, duration, timestamp, responseHeaders, inScope, highlighted,
        CASE
          WHEN url LIKE ? THEN 'url'
          WHEN host LIKE ? THEN 'host'
          WHEN path LIKE ? THEN 'path'
          WHEN requestHeaders LIKE ? THEN 'request headers'
          WHEN responseHeaders LIKE ? THEN 'response headers'
          WHEN CAST(requestBody AS TEXT) LIKE ? THEN 'request body'
          WHEN CAST(responseBody AS TEXT) LIKE ? THEN 'response body'
          ELSE 'unknown'
        END as matchField
       FROM Exchange
       WHERE (
         url LIKE ? OR
         host LIKE ? OR
         path LIKE ? OR
         requestHeaders LIKE ? OR
         responseHeaders LIKE ? OR
         CAST(requestBody AS TEXT) LIKE ? OR
         CAST(responseBody AS TEXT) LIKE ?
       ) ${scopeClause}${hideClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      // CASE params
      searchPattern, searchPattern, searchPattern,
      searchPattern, searchPattern, searchPattern, searchPattern,
      // WHERE params
      searchPattern, searchPattern, searchPattern,
      searchPattern, searchPattern, searchPattern, searchPattern,
      ...hideParams,
      limit, offset,
    );

    const summaries = rows.map((e) => {
      let contentType: string | null = null;
      if (e.responseHeaders) {
        try {
          const headers = JSON.parse(e.responseHeaders);
          contentType = headers['content-type'] || null;
        } catch {}
      }
      return {
        id: e.id,
        seq: Number(e.seq),
        method: e.method,
        host: e.host,
        path: e.path,
        statusCode: e.statusCode,
        requestSize: e.requestSize,
        responseSize: e.responseSize,
        duration: e.duration,
        timestamp: e.timestamp,
        contentType,
        inScope: e.inScope === 1,
        highlighted: e.highlighted === 1,
        matchField: e.matchField,
      };
    });

    return reply.send({ data: summaries, total, page, limit });
  });

  fastify.get('/api/history/failed', async (req, reply) => {
    const query = req.query as {
      page?: string;
      limit?: string;
      host?: string;
      search?: string;
    };

    const page = parseInt(query.page || '1', 10);
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { errorMessage: { not: null } };
    if (query.host) where.host = { contains: query.host };
    if (query.search) where.url = { contains: query.search };

    const [exchanges, total] = await Promise.all([
      db.exchange.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          method: true,
          host: true,
          path: true,
          url: true,
          errorMessage: true,
          duration: true,
          timestamp: true,
          inScope: true,
        },
      }),
      db.exchange.count({ where }),
    ]);

    return reply.send({
      data: exchanges.map((e) => ({ ...e, timestamp: e.timestamp.toISOString() })),
      total,
      page,
      limit,
    });
  });

  fastify.delete('/api/history/failed', async (_req, reply) => {
    await db.exchange.deleteMany({ where: { errorMessage: { not: null } } });
    return reply.send({ status: 'cleared' });
  });

  fastify.delete('/api/history', async (_req, reply) => {
    await db.exchange.deleteMany({ where: { errorMessage: null } });
    return reply.send({ status: 'cleared' });
  });

  fastify.patch('/api/history/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { notes, tags, highlighted } = req.body as { notes?: string; tags?: string[]; highlighted?: boolean };

    const data: Record<string, unknown> = {};
    if (notes !== undefined) data.notes = notes;
    if (tags !== undefined) data.tags = JSON.stringify(tags);
    if (highlighted !== undefined) data.highlighted = highlighted;

    const exchange = await db.exchange.update({ where: { id }, data });
    return reply.send({ id: exchange.id, notes: exchange.notes, tags: JSON.parse(exchange.tags) });
  });
}
