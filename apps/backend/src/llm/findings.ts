import { db } from '../db.js';
import { wsHub } from '../ws/hub.js';
import { indexFinding } from './rag.js';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'confirmed' | 'false-positive' | 'fixed';
export type FindingSource = 'auto-analyzer' | 'assessment' | 'on-demand' | 'manual';

export interface FindingInput {
  exchangeId?: string | null;
  host: string;
  source: FindingSource;
  severity: FindingSeverity;
  type?: string | null;
  title: string;
  detail: string;
  evidence?: string | null;
  suggestedTest?: string | null;
  method?: string | null;
  url?: string | null;
  categoryName?: string | null;
  owaspId?: string | null;
  cvss?: number | null;
  cvssVector?: string | null;
  escalated?: boolean;
}

/** Lower-case alphanumeric-only normalization for dedupe key. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 80);
}

export function makeDedupeKey(host: string, title: string, typeOrCategory?: string | null): string {
  return `${normalize(host)}::${normalize(title)}::${normalize(typeOrCategory || '')}`;
}

/**
 * Record a finding with dedupe semantics:
 * - If a finding with the same dedupeKey exists and is open/confirmed: bump hits + update detail/severity, return { isNew: false }.
 * - If it exists and is false-positive or fixed: do NOT re-report (return { isNew: false, suppressed: true }).
 * - If it doesn't exist: create it, broadcast, index in RAG, return { isNew: true }.
 */
/**
 * Post-hoc severity correction: LLMs consistently over-rate certain finding types.
 * This applies deterministic caps based on the finding title/type to enforce
 * correct severity regardless of what the LLM returned.
 */
function correctSeverity(input: FindingInput): FindingSeverity {
  const title = input.title.toLowerCase();
  const type = (input.type || '').toLowerCase();

  // Missing security headers are always info (defense-in-depth, not directly exploitable)
  const headerPatterns = [
    'missing content-security-policy', 'missing csp', 'content-security-policy',
    'missing strict-transport-security', 'missing hsts', 'hsts',
    'missing x-frame-options', 'x-frame-options', 'clickjacking',
    'missing x-content-type-options', 'x-content-type-options', 'nosniff',
    'missing referrer-policy', 'referrer-policy',
    'missing permissions-policy', 'permissions-policy',
    'missing x-xss-protection',
    'server version', 'server header', 'x-powered-by',
  ];
  if (headerPatterns.some((p) => title.includes(p)) || type === 'missing-headers' || type === 'security-headers') {
    return capSeverity(input.severity, 'info');
  }

  // Insecure cookie flags (missing HttpOnly, Secure, SameSite) are low at most
  const cookiePatterns = ['missing httponly', 'missing secure flag', 'missing samesite', 'cookie.*flag', 'insecure cookie'];
  if (cookiePatterns.some((p) => title.match(new RegExp(p)))) {
    return capSeverity(input.severity, 'low');
  }

  // CORS info disclosure (without credentials) is low
  if (title.includes('cors') && !title.includes('credential')) {
    return capSeverity(input.severity, 'low');
  }

  return input.severity;
}

/** Cap severity to a maximum level */
function capSeverity(current: FindingSeverity, maxLevel: FindingSeverity): FindingSeverity {
  const rank = severityRank(current);
  const maxRank = severityRank(maxLevel);
  // Higher rank = lower severity. If current rank < max rank, downgrade.
  return rank < maxRank ? maxLevel : current;
}

export async function recordFinding(input: FindingInput): Promise<{ finding: Awaited<ReturnType<typeof db.finding.create>> | null; isNew: boolean; suppressed: boolean }> {
  // Apply severity correction before recording
  input = { ...input, severity: correctSeverity(input) };

  const dedupeKey = makeDedupeKey(input.host, input.title, input.type || input.categoryName);

  const existing = await db.finding.findUnique({ where: { dedupeKey } });

  if (existing) {
    if (existing.status === 'false-positive' || existing.status === 'fixed') {
      // Suppressed — analyst already triaged this away.
      return { finding: existing, isNew: false, suppressed: true };
    }
    // Bump hit count + refresh details (the new sighting may have richer info).
    const updated = await db.finding.update({
      where: { id: existing.id },
      data: {
        hits: { increment: 1 },
        // Only escalate severity, never downgrade
        severity: severityRank(input.severity) < severityRank(existing.severity as FindingSeverity) ? input.severity : existing.severity,
        detail: input.detail || existing.detail,
        evidence: input.evidence || existing.evidence,
        suggestedTest: input.suggestedTest || existing.suggestedTest,
        cvss: input.cvss ?? existing.cvss,
        cvssVector: input.cvssVector || existing.cvssVector,
      },
    });
    return { finding: updated, isNew: false, suppressed: false };
  }

  const created = await db.finding.create({
    data: {
      exchangeId: input.exchangeId || null,
      host: input.host,
      source: input.source,
      severity: input.severity,
      type: input.type || null,
      title: input.title,
      detail: input.detail,
      evidence: input.evidence || null,
      suggestedTest: input.suggestedTest || null,
      method: input.method || null,
      url: input.url || null,
      categoryName: input.categoryName || null,
      owaspId: input.owaspId || null,
      cvss: input.cvss ?? null,
      cvssVector: input.cvssVector || null,
      escalated: input.escalated || false,
      dedupeKey,
      status: 'open',
    },
  });

  // Broadcast new finding event
  wsHub.broadcast({
    type: 'finding:new' as any,
    data: {
      id: created.id,
      exchangeId: created.exchangeId,
      host: created.host,
      source: created.source as FindingSource,
      severity: created.severity as FindingSeverity,
      type: created.type,
      title: created.title,
      detail: created.detail,
      evidence: created.evidence,
      suggestedTest: created.suggestedTest,
      method: created.method,
      url: created.url,
      categoryName: created.categoryName,
      owaspId: created.owaspId,
      cvss: created.cvss,
      cvssVector: created.cvssVector,
      escalated: created.escalated,
      status: created.status,
      hits: created.hits,
      createdAt: created.createdAt.toISOString(),
    },
  });

  // Index in RAG (fire-and-forget)
  indexFinding({
    id: created.id,
    severity: created.severity,
    title: created.title,
    detail: created.detail,
    method: created.method || undefined,
    url: created.url || undefined,
    evidence: created.evidence || undefined,
    categoryName: created.categoryName || undefined,
  }).catch(() => {});

  return { finding: created, isNew: true, suppressed: false };
}

function severityRank(s: FindingSeverity): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s];
}

/** Get all open findings for a host (for prior-findings injection in prompts + dedupe). */
export async function getFindingsForHost(host: string, limit = 50) {
  return db.finding.findMany({
    where: { host, status: { not: 'false-positive' } },
    orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    take: limit,
  });
}

/** Get false-positive findings for a host — used to tell the model "do not report these again". */
export async function getFalsePositivesForHost(host: string, limit = 25) {
  return db.finding.findMany({
    where: { host, status: 'false-positive' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}
