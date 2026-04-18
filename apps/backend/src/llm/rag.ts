import { db } from '../db.js';
import { vectorStore } from './vector-store.js';

/**
 * RAG (Retrieval-Augmented Generation) module.
 *
 * Indexes HTTP exchanges and findings into the local vector store,
 * then retrieves semantically relevant context for AI prompts.
 */

// Truncation limits for indexing (keep embeddings focused)
const MAX_BODY_INDEX = 1500;    // chars of body to embed
const MAX_HEADERS_INDEX = 500;  // chars of headers to embed

/**
 * Format an exchange into a text string suitable for embedding.
 * Focuses on security-relevant data.
 */
function formatExchangeForEmbedding(exchange: {
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: string;
  requestBody: Uint8Array | null;
  statusCode: number | null;
  responseHeaders: string | null;
  responseBody: Uint8Array | null;
}): string {
  const parts: string[] = [];

  parts.push(`${exchange.method} ${exchange.url} → ${exchange.statusCode || '?'}`);

  // Security-relevant request headers
  try {
    const headers = JSON.parse(exchange.requestHeaders);
    const interesting = ['authorization', 'cookie', 'content-type', 'x-api-key', 'x-csrf-token', 'x-forwarded-for'];
    const headerParts: string[] = [];
    for (const [k, v] of Object.entries(headers)) {
      if (interesting.includes(k.toLowerCase())) {
        headerParts.push(`${k}: ${String(v).slice(0, 200)}`);
      }
    }
    if (headerParts.length > 0) {
      parts.push(headerParts.join(' | '));
    }
  } catch { /* skip */ }

  // Request body
  if (exchange.requestBody && exchange.requestBody.length > 0 && exchange.requestBody.length < 50_000) {
    const body = Buffer.from(exchange.requestBody).toString('utf-8').slice(0, MAX_BODY_INDEX);
    if (body.trim()) parts.push(`Body: ${body}`);
  }

  // Response headers
  if (exchange.responseHeaders) {
    try {
      const rh = JSON.parse(exchange.responseHeaders);
      const interesting = ['content-type', 'set-cookie', 'www-authenticate', 'x-powered-by', 'server', 'location'];
      const headerParts: string[] = [];
      for (const [k, v] of Object.entries(rh)) {
        if (interesting.includes(k.toLowerCase())) {
          headerParts.push(`${k}: ${String(v).slice(0, 200)}`);
        }
      }
      if (headerParts.length > 0) {
        parts.push(`Resp: ${headerParts.join(' | ')}`);
      }
    } catch { /* skip */ }
  }

  // Response body snippet
  if (exchange.responseBody && exchange.responseBody.length > 0 && exchange.responseBody.length < 50_000) {
    const body = Buffer.from(exchange.responseBody).toString('utf-8').slice(0, MAX_BODY_INDEX);
    if (body.trim()) parts.push(`RespBody: ${body}`);
  }

  return parts.join('\n');
}

/** Skip static assets, images, etc. */
function shouldSkipIndex(path: string, contentType?: string | null): boolean {
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(path)) return true;
  if (contentType && /^(image|video|audio|font|application\/(octet-stream|zip|gzip|wasm))/i.test(contentType)) return true;
  return false;
}

/**
 * Index a single exchange into the vector store.
 * Called on every new exchange capture.
 */
export async function indexExchange(exchangeId: string) {
  if (!vectorStore.isReady()) return;
  if (vectorStore.hasDocument(`ex:${exchangeId}`)) return;

  try {
    const exchange = await db.exchange.findUnique({ where: { id: exchangeId } });
    if (!exchange) return;

    // Skip static/binary content
    let contentType: string | null = null;
    if (exchange.responseHeaders) {
      try {
        const rh = JSON.parse(exchange.responseHeaders);
        contentType = rh['content-type'] || rh['Content-Type'] || null;
      } catch { /* skip */ }
    }
    if (shouldSkipIndex(exchange.path, contentType)) return;

    const text = formatExchangeForEmbedding(exchange);
    if (text.length < 20) return; // Too short to be meaningful

    await vectorStore.add(`ex:${exchangeId}`, text, {
      type: 'exchange',
      method: exchange.method,
      host: exchange.host,
      path: exchange.path,
      statusCode: exchange.statusCode || 0,
      exchangeId,
    });
  } catch (err) {
    // Don't let indexing failures break the proxy
    console.error('[rag] index error:', (err as Error).message);
  }
}

/**
 * Index a finding into the vector store.
 */
export async function indexFinding(finding: {
  id: string;
  severity: string;
  title: string;
  detail: string;
  method?: string;
  url?: string;
  evidence?: string;
  categoryName?: string;
}) {
  if (!vectorStore.isReady()) return;
  if (vectorStore.hasDocument(`finding:${finding.id}`)) return;

  try {
    const parts = [
      `[${finding.severity.toUpperCase()}] ${finding.title}`,
      finding.detail,
      finding.evidence ? `Evidence: ${finding.evidence.slice(0, 500)}` : '',
      finding.method && finding.url ? `${finding.method} ${finding.url}` : '',
      finding.categoryName ? `Category: ${finding.categoryName}` : '',
    ].filter(Boolean);

    await vectorStore.add(`finding:${finding.id}`, parts.join('\n'), {
      type: 'finding',
      severity: finding.severity,
      title: finding.title,
    });
  } catch (err) {
    console.error('[rag] finding index error:', (err as Error).message);
  }
}

/**
 * Retrieve relevant context for an AI prompt.
 * Returns formatted text suitable for injection into system prompts.
 */
export async function retrieveContext(
  query: string,
  topK = 8,
  filter?: Record<string, string | number | boolean | null>,
): Promise<string> {
  if (!vectorStore.isReady() || vectorStore.getDocumentCount() === 0) {
    return '';
  }

  const results = await vectorStore.query(query, topK, filter);
  if (results.length === 0) return '';

  // Only include results above a minimum relevance threshold
  const relevant = results.filter((r) => r.score > 0.25);
  if (relevant.length === 0) return '';

  const sections = relevant.map((r, i) => {
    const typeLabel = r.metadata.type === 'finding' ? 'FINDING' : 'EXCHANGE';
    return `[${typeLabel} #${i + 1}, relevance: ${(r.score * 100).toFixed(0)}%]\n${r.text}`;
  });

  return `=== RELEVANT CONTEXT (retrieved from ${vectorStore.getDocumentCount()} indexed items) ===\n${sections.join('\n\n')}`;
}

/**
 * Rebuild the entire index from the database.
 * Useful if the index was cleared or corrupted.
 */
export async function rebuildIndex(): Promise<number> {
  console.log('[rag] rebuilding index...');
  await vectorStore.clear();

  const exchanges = await db.exchange.findMany({
    orderBy: { timestamp: 'desc' },
    take: 2000, // Index last 2000 exchanges
  });

  let indexed = 0;
  for (const ex of exchanges) {
    let contentType: string | null = null;
    if (ex.responseHeaders) {
      try {
        const rh = JSON.parse(ex.responseHeaders);
        contentType = rh['content-type'] || rh['Content-Type'] || null;
      } catch { /* skip */ }
    }
    if (shouldSkipIndex(ex.path, contentType)) continue;

    const text = formatExchangeForEmbedding(ex);
    if (text.length < 20) continue;

    await vectorStore.add(`ex:${ex.id}`, text, {
      type: 'exchange',
      method: ex.method,
      host: ex.host,
      path: ex.path,
      statusCode: ex.statusCode || 0,
      exchangeId: ex.id,
    });
    indexed++;
  }

  await vectorStore.saveToDisk();
  console.log(`[rag] rebuilt index: ${indexed} exchanges indexed`);
  return indexed;
}

export function getRAGStats() {
  return {
    ready: vectorStore.isReady(),
    documentCount: vectorStore.getDocumentCount(),
  };
}
