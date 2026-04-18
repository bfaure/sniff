import { db } from '../db.js';
import { llmInvoke } from './client.js';

/**
 * Periodic session summary rollup.
 *
 * Generates a compact narrative of what's been happening in the session
 * (recent findings, hosts touched, patterns) and stashes it in the Settings
 * table. `buildProjectContext` includes it so every downstream LLM call
 * benefits without paying the rollup cost itself.
 *
 * Throttled: regenerates at most once every REGEN_INTERVAL_MS, and only when
 * something has actually changed since the last rollup.
 */

const SETTINGS_KEY = 'session_summary_latest';
const REGEN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface StoredSummary {
  text: string;
  generatedAt: number;
  findingCount: number;
  exchangeCount: number;
}

let inFlight: Promise<void> | null = null;

async function loadStored(): Promise<StoredSummary | null> {
  const row = await db.settings.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return null;
  try { return JSON.parse(row.value) as StoredSummary; } catch { return null; }
}

async function persist(summary: StoredSummary) {
  await db.settings.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(summary) },
    update: { value: JSON.stringify(summary) },
  });
}

/** Returns the most recent summary text, or null if none has been generated yet. */
export async function getLatestSessionSummary(): Promise<string | null> {
  const stored = await loadStored();
  return stored?.text || null;
}

/**
 * Trigger a session summary regeneration if enough time has passed AND there's
 * meaningful new activity. Safe to call from hot paths — throttled and de-duped.
 */
export async function maybeGenerateSessionSummary(): Promise<void> {
  if (inFlight) return;
  inFlight = generateInternal().finally(() => { inFlight = null; });
  await inFlight;
}

async function generateInternal(): Promise<void> {
  const stored = await loadStored();
  const now = Date.now();
  if (stored && now - stored.generatedAt < REGEN_INTERVAL_MS) return;

  const [findingCount, exchangeCount] = await Promise.all([
    db.finding.count({ where: { status: { not: 'false-positive' } } }),
    db.exchange.count(),
  ]);

  // Skip if nothing meaningful changed since last rollup
  if (stored && stored.findingCount === findingCount && stored.exchangeCount === exchangeCount) return;
  // Skip if there's basically nothing to summarize yet
  if (findingCount === 0 && exchangeCount < 5) return;

  const findings = await db.finding.findMany({
    where: { status: { not: 'false-positive' } },
    orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    take: 30,
    select: { severity: true, title: true, host: true, status: true, hits: true },
  });

  const hostStats = await db.exchange.groupBy({
    by: ['host'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 8,
  });

  const findingLines = findings.map((f) =>
    `  [${f.severity.toUpperCase()}${f.status !== 'open' ? `/${f.status}` : ''}] ${f.title} @ ${f.host}${f.hits > 1 ? ` (×${f.hits})` : ''}`
  ).join('\n') || '  (no open findings yet)';

  const hostLines = hostStats.map((h) => `  ${h.host}: ${h._count.id} requests`).join('\n');

  const prompt = `You are summarizing the current state of an active pentest session for the analyst.

Open findings (${findingCount}):
${findingLines}

Top hosts by traffic volume:
${hostLines}

Total exchanges captured: ${exchangeCount}

Write a TIGHT narrative summary (under 500 chars) covering:
1. The big picture — what kind of target this looks like, where the interesting activity is concentrated
2. The most important findings to follow up on (by combined severity + uniqueness)
3. Any obvious gaps or things the analyst should investigate next

Plain prose, no headings, no bullet points, no preamble.`;

  try {
    const result = await llmInvoke(
      [{ role: 'user', content: prompt }],
      'fast',
      undefined,
      'session-summary',
    );

    await persist({
      text: result.text.trim(),
      generatedAt: now,
      findingCount,
      exchangeCount,
    });
  } catch {
    // Non-critical — try again next tick.
  }
}
