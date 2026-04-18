import { db } from '../db.js';
import { autoAnalyzer } from './auto-analyzer.js';
import { retrieveContext } from './rag.js';
import { getLatestSessionSummary } from './session-summary.js';

/**
 * Gathers project-level context for AI prompts:
 * - Scope rules (what the tester is focused on)
 * - Recent findings (what's already been discovered)
 * - Site map summary (what endpoints exist)
 * - Session observations (accumulated patterns)
 * - RAG-retrieved context (semantically relevant exchanges/findings)
 */
export async function buildProjectContext(ragQuery?: string): Promise<string> {
  const sections: string[] = [];

  // 1. Scope rules
  const scopeRules = await db.scopeRule.findMany({
    where: { enabled: true },
    orderBy: { order: 'asc' },
  });
  if (scopeRules.length > 0) {
    const ruleLines = scopeRules.map(
      (r) => `  ${r.type.toUpperCase()}: ${r.protocol || '*'}://${r.host}${r.path || '/*'}${r.port ? `:${r.port}` : ''}`
    );
    sections.push(`=== TARGET SCOPE ===\n${ruleLines.join('\n')}`);
  }

  // 1b. Periodic session summary (rolled up by session-summary.ts)
  const sessionSummary = await getLatestSessionSummary();
  if (sessionSummary) {
    sections.push(`=== SESSION SUMMARY ===\n${sessionSummary}`);
  }

  // 2. Session observations from auto-analyzer
  const observations = autoAnalyzer.getSessionObservations();
  if (observations) {
    sections.push(`=== SESSION OBSERVATIONS ===\n${observations}`);
  }

  // 3. Recent findings from first-class Finding table (excluding false-positives)
  const recentFindings = await db.finding.findMany({
    where: { status: { not: 'false-positive' } },
    orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    take: 25,
    select: { severity: true, title: true, host: true, method: true, url: true, detail: true, status: true },
  });
  if (recentFindings.length > 0) {
    const lines = recentFindings.map((f) => {
      const where = f.method && f.url ? ` ${f.method} ${(() => { try { return new URL(f.url).pathname; } catch { return f.url; } })()}` : '';
      const statusTag = f.status === 'confirmed' ? ' [CONFIRMED]' : f.status === 'fixed' ? ' [FIXED]' : '';
      return `  [${f.severity.toUpperCase()}]${statusTag} ${f.title} @ ${f.host}${where} — ${(f.detail || '').slice(0, 120)}`;
    });
    sections.push(`=== RECENT FINDINGS ===\n${lines.join('\n')}`);
  }

  // 3b. Analyst notes & tags — high-signal user annotations on exchanges
  const annotated = await db.exchange.findMany({
    where: {
      OR: [
        { notes: { not: null } },
        { tags: { not: '[]' } },
      ],
    },
    orderBy: { timestamp: 'desc' },
    take: 25,
    select: { method: true, host: true, path: true, notes: true, tags: true },
  });
  if (annotated.length > 0) {
    const noteLines: string[] = [];
    for (const ex of annotated) {
      let tagList: string[] = [];
      try { tagList = JSON.parse(ex.tags); } catch { /* ignore */ }
      const tagStr = tagList.length > 0 ? ` [${tagList.join(', ')}]` : '';
      const noteStr = ex.notes ? ` — ${ex.notes.slice(0, 200)}` : '';
      noteLines.push(`  ${ex.method} ${ex.host}${ex.path}${tagStr}${noteStr}`);
    }
    sections.push(`=== ANALYST NOTES & TAGS ===\n(These are the tester's own annotations — high signal, prefer these over your own assumptions.)\n${noteLines.join('\n')}`);
  }

  // 4. Site map summary — unique hosts and top paths
  const hostCounts = await db.exchange.groupBy({
    by: ['host'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 20,
  });
  if (hostCounts.length > 0) {
    const hostLines: string[] = [];
    for (const hc of hostCounts.slice(0, 10)) {
      // Get unique paths for this host (top 10)
      const paths = await db.exchange.findMany({
        where: { host: hc.host },
        select: { path: true, method: true },
        distinct: ['path'],
        take: 15,
        orderBy: { timestamp: 'desc' },
      });
      const pathList = paths.map((p) => `${p.method} ${p.path}`).join(', ');
      hostLines.push(`  ${hc.host} (${hc._count.id} requests): ${pathList}`);
    }
    sections.push(`=== DISCOVERED ENDPOINTS ===\n${hostLines.join('\n')}`);
  }

  // 5. RAG — retrieve semantically relevant exchanges and findings
  if (ragQuery) {
    const ragContext = await retrieveContext(ragQuery, 8);
    if (ragContext) {
      sections.push(ragContext);
    }
  }

  return sections.join('\n\n');
}
