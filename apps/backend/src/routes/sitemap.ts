import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

interface SiteMapNode {
  name: string;
  path: string;
  children: SiteMapNode[];
  requestCount: number;
  methods: string[];
  statusCodes: number[];
}

export function sitemapRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/sitemap', async (req, reply) => {
    const query = req.query as { inScope?: string };
    const where: Record<string, unknown> = {};
    if (query.inScope === 'true') where.inScope = true;

    const exchanges = await db.exchange.findMany({
      where,
      select: {
        host: true,
        path: true,
        method: true,
        statusCode: true,
      },
    });

    // Build tree: host -> path segments
    const hosts = new Map<string, SiteMapNode>();

    for (const ex of exchanges) {
      if (!hosts.has(ex.host)) {
        hosts.set(ex.host, {
          name: ex.host,
          path: ex.host,
          children: [],
          requestCount: 0,
          methods: [],
          statusCodes: [],
        });
      }

      const hostNode = hosts.get(ex.host)!;
      hostNode.requestCount++;
      if (!hostNode.methods.includes(ex.method)) hostNode.methods.push(ex.method);
      if (ex.statusCode && !hostNode.statusCodes.includes(ex.statusCode)) {
        hostNode.statusCodes.push(ex.statusCode);
      }

      // Parse path segments and build sub-tree
      const segments = ex.path.split('/').filter(Boolean);
      let currentNode = hostNode;

      for (const segment of segments) {
        let child = currentNode.children.find((c) => c.name === segment);
        if (!child) {
          child = {
            name: segment,
            path: currentNode.path + '/' + segment,
            children: [],
            requestCount: 0,
            methods: [],
            statusCodes: [],
          };
          currentNode.children.push(child);
        }
        child.requestCount++;
        if (!child.methods.includes(ex.method)) child.methods.push(ex.method);
        if (ex.statusCode && !child.statusCodes.includes(ex.statusCode)) {
          child.statusCodes.push(ex.statusCode);
        }
        currentNode = child;
      }
    }

    return reply.send(Array.from(hosts.values()));
  });

  fastify.delete('/api/sitemap', async (req, reply) => {
    const { host, path } = req.query as { host: string; path?: string };
    if (!host) return reply.code(400).send({ error: 'host is required' });

    const where: Record<string, unknown> = { host };
    if (path) {
      where.path = { startsWith: path };
    }

    const result = await db.exchange.deleteMany({ where });
    return reply.send({ deleted: result.count });
  });
}
