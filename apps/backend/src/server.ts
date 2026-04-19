import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { ProxyEngine } from './proxy/engine.js';
import { wsHub } from './ws/hub.js';
import { proxyRoutes } from './routes/proxy.js';
import { historyRoutes } from './routes/history.js';
import { replayRoutes } from './routes/replay.js';
import { decoderRoutes } from './routes/decoder.js';
import { scopeRoutes } from './routes/scope.js';
import { certificateRoutes } from './routes/certificates.js';
import { sitemapRoutes } from './routes/sitemap.js';
import { comparerRoutes } from './routes/comparer.js';
import { llmRoutes } from './routes/llm.js';
import { fuzzerRoutes } from './routes/fuzzer.js';
import { settingsRoutes } from './routes/settings.js';
import { projectRoutes } from './routes/projects.js';
import { findingsRoutes } from './routes/findings.js';
import { noiseFilterRoutes } from './routes/noise-filter.js';
import { autoAnalyzer } from './llm/auto-analyzer.js';
import { loadModelOverrides } from './llm/client.js';
import { vectorStore } from './llm/vector-store.js';
import { indexExchange } from './llm/rag.js';
import { db } from './db.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ExchangeSummary, InterceptedItem } from '@sniff/shared';

async function ensureSchema(): Promise<void> {
  // Probe for any known table; if it exists the schema is already applied.
  try {
    await db.$queryRawUnsafe(`SELECT 1 FROM "Settings" LIMIT 1`);
    return;
  } catch {
    // Table missing -> apply the bundled schema below.
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  // schema.sql lives in apps/backend/prisma/. From dist/server.js that's ../prisma/;
  // from src/server.ts it's also ../prisma/. Same relative path either way.
  const schemaPath = path.resolve(here, '..', 'prisma', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error('[db] schema.sql not found at', schemaPath);
    return;
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  // Split on `;` at end of line, then for each chunk strip leading comment
  // lines (the generated schema prefixes each DDL with `-- CreateTable` etc.)
  // before deciding if there's any real SQL to execute.
  const statements = sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.$executeRawUnsafe(stmt);
  }
  console.log(`[db] applied schema (${statements.length} statements)`);
}

// DNS-rebinding protection: the backend binds to 127.0.0.1 only, but browsers
// can still reach it via DNS rebinding. Reject requests whose Host header does
// not look like a local loopback, preventing malicious websites from pivoting
// through the API.
const ALLOWED_HOSTS = new Set([
  `localhost:${parseInt(process.env.SNIFF_SERVER_PORT || '47120', 10)}`,
  `127.0.0.1:${parseInt(process.env.SNIFF_SERVER_PORT || '47120', 10)}`,
  `[::1]:${parseInt(process.env.SNIFF_SERVER_PORT || '47120', 10)}`,
]);

export async function createServer() {
  const fastify = Fastify({ logger: false });

  fastify.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!host || !ALLOWED_HOSTS.has(host.toLowerCase())) {
      return reply.code(403).send({ error: 'Forbidden host' });
    }
  });

  // Ensure DB schema exists. In dev, `prisma db push` keeps the schema in sync;
  // in a packaged app the prisma CLI isn't available, so we ship a precomputed
  // schema.sql (generated at build time via `prisma migrate diff`) and execute
  // it once against an empty database.
  await ensureSchema();

  // WebSocket support
  await fastify.register(websocket);

  // Create proxy engine
  const engine = new ProxyEngine(config.proxyPort);

  // Wire proxy events to WebSocket hub
  engine.onEvent((event, data) => {
    if (event === 'traffic:new') {
      wsHub.broadcast({ type: 'traffic:new', data: data as ExchangeSummary });
      const summary = data as ExchangeSummary;
      // Index for RAG (non-blocking)
      indexExchange(summary.id).catch(() => {});
      // Auto-analyze if enabled
      autoAnalyzer.enqueue(summary.id);
    } else if (event === 'proxy:status') {
      wsHub.broadcast({ type: 'proxy:status', data: data as ExchangeSummary & { running: boolean; port: number; interceptEnabled: boolean; exchangeCount: number } });
    }
  });

  // Wire intercept events to WebSocket hub
  engine.intercept.onEvent((event, item) => {
    if (event === 'new') {
      wsHub.broadcast({ type: 'intercept:new', data: item as InterceptedItem });
    } else if (event === 'resolved') {
      wsHub.broadcast({ type: 'intercept:resolved', data: { id: item.id } });
    }
  });

  // WebSocket endpoint — must be inside register() per @fastify/websocket docs
  await fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      wsHub.addClient(socket);
      socket.send(JSON.stringify({ type: 'proxy:status', data: engine.getStatus() }));
    });
  });

  // Register routes
  proxyRoutes(fastify, engine);
  historyRoutes(fastify);
  replayRoutes(fastify);
  decoderRoutes(fastify);
  scopeRoutes(fastify);
  certificateRoutes(fastify);
  sitemapRoutes(fastify);
  comparerRoutes(fastify);
  llmRoutes(fastify);
  fuzzerRoutes(fastify);
  settingsRoutes(fastify);
  projectRoutes(fastify);
  findingsRoutes(fastify);
  noiseFilterRoutes(fastify);

  // Load model overrides from DB
  loadModelOverrides().catch(() => {});

  // Apply saved Bedrock credentials so the LLM features work on a fresh
  // server start without requiring the user to re-save them from Settings.
  (await import('./routes/settings.js')).applyBedrockCredentials().catch((err) => {
    console.error('[llm] failed to apply saved Bedrock credentials:', err?.message ?? err);
  });

  // Restore persisted auto-analyzer state (enabled flag, scope mode, memory, etc.)
  autoAnalyzer.init().catch((err) => {
    console.error('[auto-analyzer] init error:', err.message);
  });

  // Initialize RAG vector store (loads model + persisted index in background)
  vectorStore.init().catch((err) => {
    console.error('[vector-store] init error:', err.message);
  });

  // Health check
  fastify.get('/api/health', async () => ({ status: 'ok' }));

  // Serve the renderer static assets when the packaged Electron main hands
  // us a directory via SNIFF_RENDERER_DIR. We serve from the same origin as
  // the API so the renderer's relative `/api/*` fetches and the `/ws`
  // WebSocket upgrade work without CORS config or an extra port. In dev,
  // Vite serves the renderer at :5173 and proxies to us — this block is
  // inert there since SNIFF_RENDERER_DIR is unset.
  const rendererDir = process.env.SNIFF_RENDERER_DIR;
  if (rendererDir && fs.existsSync(rendererDir)) {
    await fastify.register(fastifyStatic, {
      root: rendererDir,
      prefix: '/',
      // Don't intercept /api or /ws — let the explicit routes win.
      decorateReply: false,
    });
    console.log(`[server] serving renderer from ${rendererDir}`);
  }

  // Auto-start proxy on server boot
  engine.start().then(() => {
    console.log(`[proxy] auto-started on port ${config.proxyPort}`);
  }).catch((err) => {
    console.error('[proxy] failed to auto-start:', err.message);
  });

  return { fastify, engine };
}

// Allow standalone execution for dev
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  (async () => {
    const { fastify } = await createServer();
    fastify.listen({ port: config.serverPort, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`[server] listening on ${address}`);
    });
  })();
}
