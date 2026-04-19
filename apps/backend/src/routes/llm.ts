import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { llmInvoke, llmStream } from '../llm/client.js';
import { buildMessages, buildProjectChatMessages, buildGuidedTestMessages, buildAutoAnalyzeMessages, getTierForType } from '../llm/prompts.js';
import { buildProjectContext } from '../llm/project-context.js';
import { costTracker } from '../llm/cost-tracker.js';
import { wsHub } from '../ws/hub.js';
import { autoAnalyzer } from '../llm/auto-analyzer.js';
import { runTargetAssessment, cancelAssessment, getCategories } from '../llm/target-assessment.js';
import { getRAGStats, rebuildIndex } from '../llm/rag.js';
import { vectorStore } from '../llm/vector-store.js';
import { recordFinding, getFindingsForHost } from '../llm/findings.js';
import type { AnalysisType } from '@sniff/shared';

/** Parse a vuln-scan model response and persist any findings to the Finding table. */
async function persistVulnScanFindings(
  responseText: string,
  exchange: { id: string; host: string; method: string; url: string },
) {
  try {
    const cleaned = responseText.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.findings || !Array.isArray(parsed.findings)) return;
    for (const f of parsed.findings) {
      if (!f?.title) continue;
      await recordFinding({
        exchangeId: exchange.id,
        host: exchange.host,
        source: 'on-demand',
        severity: (f.severity || 'info'),
        type: f.type || null,
        title: f.title,
        detail: f.explanation || f.detail || '',
        evidence: f.evidence || null,
        suggestedTest: f.suggestedTest || null,
        method: exchange.method,
        url: exchange.url,
      });
    }
  } catch {
    // Not parseable as findings JSON — that's fine, not all vuln-scan responses are JSON.
  }
}

export function llmRoutes(fastify: FastifyInstance) {
  // Analyze an exchange (non-streaming)
  fastify.post('/api/llm/analyze', async (req) => {
    const { exchangeId, type, userMessage } = req.body as {
      exchangeId: string;
      type: AnalysisType;
      userMessage?: string;
    };

    const exchange = await db.exchange.findUnique({ where: { id: exchangeId } });
    if (!exchange) throw new Error('Exchange not found');

    const context = {
      method: exchange.method,
      url: exchange.url,
      requestHeaders: JSON.parse(exchange.requestHeaders),
      requestBody: exchange.requestBody ? Buffer.from(exchange.requestBody).toString('utf-8') : null,
      statusCode: exchange.statusCode,
      responseHeaders: exchange.responseHeaders ? JSON.parse(exchange.responseHeaders) : null,
      responseBody: exchange.responseBody ? Buffer.from(exchange.responseBody).toString('utf-8') : null,
    };

    const ragQuery = userMessage || `${exchange.method} ${exchange.url}`;
    const projectCtx = await buildProjectContext(ragQuery);
    const messages = buildMessages(type, context, userMessage, projectCtx);
    const tier = getTierForType(type);
    const result = await llmInvoke(messages, tier, undefined, `on-demand:${type}`);

    // Save analysis to DB
    const analysis = await db.analysis.create({
      data: {
        exchangeId,
        modelId: result.modelId,
        type,
        prompt: JSON.stringify(messages),
        response: result.text,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.costUsd,
      },
    });

    // Persist findings to first-class table for vuln-scans
    if (type === 'vuln-scan') {
      await persistVulnScanFindings(result.text, {
        id: exchange.id,
        host: exchange.host,
        method: exchange.method,
        url: exchange.url,
      });
    }

    return {
      id: analysis.id,
      type,
      modelId: result.modelId,
      response: result.text,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.costUsd,
    };
  });

  // Stream analysis via WebSocket events
  fastify.post('/api/llm/analyze/stream', async (req, reply) => {
    const { exchangeId, type, userMessage, streamId, conversationHistory } = req.body as {
      exchangeId: string;
      type: AnalysisType;
      userMessage?: string;
      streamId: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    const exchange = await db.exchange.findUnique({ where: { id: exchangeId } });
    if (!exchange) throw new Error('Exchange not found');

    const context = {
      method: exchange.method,
      url: exchange.url,
      requestHeaders: JSON.parse(exchange.requestHeaders),
      requestBody: exchange.requestBody ? Buffer.from(exchange.requestBody).toString('utf-8') : null,
      statusCode: exchange.statusCode,
      responseHeaders: exchange.responseHeaders ? JSON.parse(exchange.responseHeaders) : null,
      responseBody: exchange.responseBody ? Buffer.from(exchange.responseBody).toString('utf-8') : null,
    };

    const ragQuery = userMessage || `${exchange.method} ${exchange.url}`;
    const projectCtx = await buildProjectContext(ragQuery);
    let messages = buildMessages(type, context, userMessage, projectCtx);

    // For chat with conversation history, inject prior turns after the system message
    if (type === 'chat' && conversationHistory && conversationHistory.length > 0) {
      const systemMsg = messages[0]; // system prompt
      messages = [
        systemMsg,
        ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: userMessage || 'Analyze this request.' },
      ];
    }

    const tier = getTierForType(type);

    // Start streaming in background, respond immediately
    reply.send({ status: 'streaming', streamId });

    let fullText = '';
    try {
      for await (const event of llmStream(messages, tier, undefined, `on-demand:${type}`)) {
        if (event.type === 'chunk') {
          fullText += event.text;
          wsHub.broadcast({ type: 'llm:chunk', data: { streamId, text: event.text } });
        } else {
          // Save analysis
          await db.analysis.create({
            data: {
              exchangeId,
              modelId: event.modelId,
              type,
              prompt: JSON.stringify(messages),
              response: fullText,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costUsd: event.costUsd,
            },
          });

          // Persist findings to first-class table for vuln-scans
          if (type === 'vuln-scan') {
            await persistVulnScanFindings(fullText, {
              id: exchange.id,
              host: exchange.host,
              method: exchange.method,
              url: exchange.url,
            });
          }

          wsHub.broadcast({
            type: 'llm:done',
            data: {
              streamId,
              modelId: event.modelId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costUsd: event.costUsd,
            },
          });
        }
      }
    } catch (err) {
      wsHub.broadcast({
        type: 'llm:done',
        data: { streamId, error: (err as Error).message, errorCode: (err as { code?: string }).code, modelId: '', inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    }
  });

  // Project-level chat (not tied to a specific exchange)
  fastify.post('/api/llm/chat/stream', async (req, reply) => {
    const { userMessage, streamId, conversationHistory, exchangeIds } = req.body as {
      userMessage: string;
      streamId: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
      exchangeIds?: string[];
    };

    const projectCtx = await buildProjectContext(userMessage);

    // Optionally load referenced exchanges
    let referencedExchanges: Array<{ method: string; url: string; statusCode: number | null; requestHeaders: string; responseHeaders: string | null }> | undefined;
    if (exchangeIds && exchangeIds.length > 0) {
      const exchanges = await db.exchange.findMany({
        where: { id: { in: exchangeIds.slice(0, 20) } },
        select: { method: true, url: true, statusCode: true, requestHeaders: true, responseHeaders: true },
      });
      referencedExchanges = exchanges;
    }

    let messages = buildProjectChatMessages(projectCtx, userMessage, referencedExchanges);

    // Inject conversation history after system message
    if (conversationHistory && conversationHistory.length > 0) {
      const systemMsg = messages[0];
      messages = [
        systemMsg,
        ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: userMessage },
      ];
    }

    reply.send({ status: 'streaming', streamId });

    let fullText = '';
    try {
      for await (const event of llmStream(messages, 'reasoning', undefined, 'project-chat')) {
        if (event.type === 'chunk') {
          fullText += event.text;
          wsHub.broadcast({ type: 'llm:chunk', data: { streamId, text: event.text } });
        } else {
          wsHub.broadcast({
            type: 'llm:done',
            data: {
              streamId,
              modelId: event.modelId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costUsd: event.costUsd,
            },
          });
        }
      }
    } catch (err) {
      wsHub.broadcast({
        type: 'llm:done',
        data: { streamId, error: (err as Error).message, errorCode: (err as { code?: string }).code, modelId: '', inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    }
  });

  // Cross-finding chain analysis: load all findings for a host, ask the model
  // to identify attack chains across them.
  fastify.post('/api/llm/chain-analysis/stream', async (req, reply) => {
    const { host, streamId } = req.body as { host: string; streamId: string };

    const findings = await getFindingsForHost(host, 100);
    if (findings.length === 0) {
      reply.send({ status: 'no-findings', streamId });
      wsHub.broadcast({
        type: 'llm:done',
        data: { streamId, error: `No findings found for ${host}`, modelId: '', inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
      return;
    }

    const findingLines = findings.map((f, i) =>
      `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.method && f.url ? ` @ ${f.method} ${(() => { try { return new URL(f.url).pathname; } catch { return f.url; } })()}` : ''}\n   ${f.detail.slice(0, 400)}${f.evidence ? `\n   Evidence: ${f.evidence.slice(0, 200)}` : ''}`
    ).join('\n\n');

    const projectCtx = await buildProjectContext(`attack chain ${host}`);

    const messages = [
      {
        role: 'system' as const,
        content: `You are a senior penetration tester analyzing a set of vulnerabilities discovered on a single target to identify ATTACK CHAINS — sequences of weaknesses that combine to produce greater impact than any single finding alone.

${projectCtx}

You will be given the full list of open findings on ${host}. Your job:
1. Identify attack chains: 2+ findings that combine to enable a higher-impact attack (e.g. info disclosure + IDOR = full account takeover; weak CSRF + stored XSS = worm; SSRF + cloud metadata = credential theft).
2. For each chain, list the participating finding numbers, describe the chained attack scenario step-by-step, give the combined severity, and explain the resulting real-world impact.
3. Prioritize chains by combined impact, not by individual finding severity.
4. If no meaningful chains exist, say so plainly — don't fabricate chains for the sake of producing output.

Format each chain as:

## Chain [N]: [short name] — [combined severity]
**Findings:** #X, #Y, #Z
**Impact:** [what the attacker gains]
**Steps:**
1. ...
2. ...
3. ...
**Why this matters:** [brief justification]

Be concrete and technical. Reference exact finding numbers.`,
      },
      {
        role: 'user' as const,
        content: `Findings on ${host}:\n\n${findingLines}\n\nIdentify the attack chains.`,
      },
    ];

    reply.send({ status: 'streaming', streamId, findingCount: findings.length });

    try {
      for await (const event of llmStream(messages, 'reasoning', undefined, 'chain-analysis')) {
        if (event.type === 'chunk') {
          wsHub.broadcast({ type: 'llm:chunk', data: { streamId, text: event.text } });
        } else {
          wsHub.broadcast({
            type: 'llm:done',
            data: {
              streamId,
              modelId: event.modelId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costUsd: event.costUsd,
            },
          });
        }
      }
    } catch (err) {
      wsHub.broadcast({
        type: 'llm:done',
        data: { streamId, error: (err as Error).message, errorCode: (err as { code?: string }).code, modelId: '', inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    }
  });

  // Replay guided vulnerability test — interactive turn-based session
  // vulnType is optional: if omitted, uses auto-analyze mode
  fastify.post('/api/llm/guided-test/stream', async (req, reply) => {
    const { vulnType, exchange, streamId, userMessage, conversationHistory } = req.body as {
      vulnType?: string;
      exchange: {
        method: string;
        url: string;
        requestHeaders: Record<string, string>;
        requestBody: string | null;
        statusCode: number | null;
        responseHeaders: Record<string, string> | null;
        responseBody: string | null;
      };
      streamId: string;
      userMessage?: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    // Build project context using vuln type (if any) + URL as the RAG query
    const ragQuery = `${vulnType || 'vulnerability analysis'} ${exchange.method} ${exchange.url}`;
    const projectCtx = await buildProjectContext(ragQuery);

    const messages = vulnType
      ? buildGuidedTestMessages(vulnType, exchange, projectCtx, userMessage, conversationHistory)
      : buildAutoAnalyzeMessages(exchange, projectCtx, userMessage, conversationHistory);

    reply.send({ status: 'streaming', streamId });

    let fullText = '';
    try {
      for await (const event of llmStream(messages, 'reasoning', undefined, 'guided-test')) {
        if (event.type === 'chunk') {
          fullText += event.text;
          wsHub.broadcast({ type: 'llm:chunk', data: { streamId, text: event.text } });
        } else {
          wsHub.broadcast({
            type: 'llm:done',
            data: {
              streamId,
              modelId: event.modelId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              costUsd: event.costUsd,
            },
          });
        }
      }
    } catch (err) {
      wsHub.broadcast({
        type: 'llm:done',
        data: { streamId, error: (err as Error).message, errorCode: (err as { code?: string }).code, modelId: '', inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
    }
    void fullText;
  });

  // Get analyses for an exchange
  fastify.get('/api/llm/analyses/:exchangeId', async (req) => {
    const { exchangeId } = req.params as { exchangeId: string };
    return db.analysis.findMany({
      where: { exchangeId },
      orderBy: { timestamp: 'desc' },
    });
  });

  // Get cost summary
  fastify.get('/api/llm/costs', async () => {
    return costTracker.getSummary();
  });

  // Get per-feature cost breakdown
  fastify.get('/api/llm/costs/breakdown', async (req) => {
    const { scope } = (req.query as { scope?: 'session' | 'daily' | 'all-time' }) || {};
    return costTracker.getBreakdown(scope || 'daily');
  });

  // Get cost history (daily breakdown)
  fastify.get('/api/llm/costs/history', async () => {
    const records = await db.costRecord.findMany({
      orderBy: { timestamp: 'desc' },
      take: 100,
    });
    return records;
  });

  // Auto-analyze toggle
  fastify.post('/api/llm/auto-analyze/toggle', async (req) => {
    const { enabled } = req.body as { enabled: boolean };
    if (enabled) {
      autoAnalyzer.enable();
    } else {
      autoAnalyzer.disable();
    }
    return { enabled: autoAnalyzer.isEnabled() };
  });

  fastify.get('/api/llm/auto-analyze/status', async () => {
    return {
      enabled: autoAnalyzer.isEnabled(),
      dailyCost: autoAnalyzer.getDailyCost(),
      scopeMode: autoAnalyzer.getScopeMode(),
      observations: autoAnalyzer.getSessionObservations(),
    };
  });

  // Get the analysis queue with exchange details
  fastify.get('/api/llm/auto-analyze/queue', async () => {
    const state = autoAnalyzer.getQueueState();
    const allIds = [
      ...(state.currentExchangeId ? [state.currentExchangeId] : []),
      ...state.queuedIds,
    ];
    if (allIds.length === 0) return { current: null, queued: [] };

    const exchanges = await db.exchange.findMany({
      where: { id: { in: allIds } },
      select: { id: true, method: true, url: true, host: true, path: true, statusCode: true },
    });
    const byId = new Map(exchanges.map((e) => [e.id, e]));

    return {
      current: state.currentExchangeId ? byId.get(state.currentExchangeId) || null : null,
      queued: state.queuedIds.map((id) => byId.get(id)).filter(Boolean),
    };
  });

  // Set AI scope mode
  fastify.post('/api/llm/auto-analyze/scope-mode', async (req) => {
    const { mode } = req.body as { mode: 'all' | 'in-scope' };
    autoAnalyzer.setScopeMode(mode);
    return { scopeMode: autoAnalyzer.getScopeMode() };
  });

  // Target assessment: get vuln categories
  fastify.get('/api/llm/assessment/categories', async () => {
    return getCategories();
  });

  // Target assessment: start assessment for a host (optionally scoped to a path prefix)
  fastify.post('/api/llm/assessment/start', async (req, reply) => {
    const { host, pathPrefix } = req.body as { host: string; pathPrefix?: string };
    const assessmentId = `assess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Run in background — don't await
    reply.send({ assessmentId, host, pathPrefix: pathPrefix || null, status: 'started' });
    runTargetAssessment(host, assessmentId, pathPrefix).catch((err) => {
      console.error('[assessment] Fatal error:', err);
    });
  });

  // Target assessment: cancel
  fastify.post('/api/llm/assessment/cancel', async (req) => {
    const { assessmentId } = req.body as { assessmentId: string };
    const cancelled = cancelAssessment(assessmentId);
    return { cancelled };
  });

  // RAG status
  fastify.get('/api/llm/rag/status', async () => {
    return getRAGStats();
  });

  // RAG rebuild index
  fastify.post('/api/llm/rag/rebuild', async (_req, reply) => {
    reply.send({ status: 'rebuilding' });
    rebuildIndex().catch((err) => {
      console.error('[rag] rebuild error:', err.message);
    });
  });

  // RAG clear index
  fastify.post('/api/llm/rag/clear', async () => {
    await vectorStore.clear();
    return { cleared: true };
  });
}
