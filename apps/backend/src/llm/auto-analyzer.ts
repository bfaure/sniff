import { db } from '../db.js';
import { llmInvoke } from './client.js';
import { wsHub } from '../ws/hub.js';
import { isInScope } from '../proxy/scope.js';
import { recordFinding, getFindingsForHost, getFalsePositivesForHost } from './findings.js';
import { maybeGenerateSessionSummary } from './session-summary.js';
import { noiseFilter } from './noise-filter.js';
import { buildClassifierPrompt, buildSpecialistUserPrompt, VULN_BY_ID, SPECIALIST_SYSTEM_SUFFIX } from './vuln-catalog.js';

const CLASSIFIER_PROMPT = buildClassifierPrompt();

const DEEP_ANALYSIS_PROMPT = `You are a senior penetration testing expert performing deep analysis on HTTP traffic that was flagged by an automated triage system.

The triage system (a faster, cheaper model) identified something potentially interesting and escalated it to you for deeper examination. You have access to:
1. The triage system's session observations (patterns it has noticed)
2. Recent traffic history
3. The specific exchange(s) that triggered escalation
4. The triage system's initial findings

Your job is to provide expert-level analysis:
- Confirm or dismiss the triage findings with reasoning
- Identify attack chains that span multiple requests
- Suggest concrete exploitation steps with actual payloads
- Assess real-world exploitability (not just theoretical risk)
- Identify business logic vulnerabilities the triage may have missed

Severity calibration — be precise, do not over-rate:
- critical: Directly exploitable, no user interaction, full compromise (RCE, auth bypass, pre-auth SQLi)
- high: Directly exploitable with significant impact (stored XSS, IDOR, SSRF to internal)
- medium: Exploitable but requires conditions or chaining (reflected XSS, CSRF)
- low: Minor issues with limited impact (verbose errors, insecure cookie flags on non-session cookies)
- info: Defense-in-depth, best practices, hardening (missing headers like CSP/HSTS/X-Frame-Options, server version disclosure)

Missing security headers are ALWAYS "info" severity — they are hardening measures, not directly exploitable.

Respond with JSON (no markdown fences):
{
  "findings": [
    {
      "severity": "critical|high|medium|low|info",
      "cvss": 7.5,
      "cvssVector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
      "title": "short title (under 60 chars)",
      "detail": "detailed explanation with concrete exploitation steps and payloads"
    }
  ],
  "observations": "Expert observations to add to session memory (max 500 chars)"
}`;

// Max body sizes for triage (in bytes) — beyond this we truncate before sending to LLM
const MAX_REQUEST_BODY_TRIAGE = 4_000;   // 4KB
const MAX_RESPONSE_BODY_TRIAGE = 2_000;  // 2KB
// Skip entirely if bodies exceed this (likely binary/media)
const MAX_BODY_SKIP = 512_000;           // 512KB

// Skip analysis for these patterns
function shouldSkip(method: string, path: string, contentType?: string | null, responseSize?: number | null): boolean {
  if (/\.(css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(path)) return true;
  if (/\/(health|ping|ready|alive|status)$/i.test(path)) return true;
  if (path === '/favicon.ico') return true;
  if (method === 'OPTIONS') return true;
  // Skip binary content types
  if (contentType && /^(image|video|audio|font|application\/(octet-stream|zip|gzip|pdf|wasm))/i.test(contentType)) return true;
  // Skip very large responses
  if (responseSize != null && responseSize > MAX_BODY_SKIP) return true;
  return false;
}

function formatExchangeBrief(exchange: {
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
  const headers = JSON.parse(exchange.requestHeaders);

  parts.push(`${exchange.method} ${exchange.url}`);

  // Include security-relevant headers
  const interestingHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'content-type', 'x-csrf-token', 'x-forwarded-for'];
  for (const [k, v] of Object.entries(headers)) {
    if (interestingHeaders.includes(k.toLowerCase())) {
      parts.push(`${k}: ${v}`);
    }
  }

  if (exchange.requestBody && exchange.requestBody.length <= MAX_BODY_SKIP) {
    const body = Buffer.from(exchange.requestBody).toString('utf-8');
    if (body.length > MAX_REQUEST_BODY_TRIAGE) {
      parts.push(`\nRequest Body (${body.length} chars, truncated): ${body.slice(0, MAX_REQUEST_BODY_TRIAGE)}`);
    } else {
      parts.push(`\nRequest Body: ${body}`);
    }
  }

  if (exchange.statusCode != null) {
    parts.push(`\nResponse: ${exchange.statusCode}`);
    if (exchange.responseHeaders) {
      const resHeaders = JSON.parse(exchange.responseHeaders);
      for (const [k, v] of Object.entries(resHeaders)) {
        if (interestingHeaders.includes(k.toLowerCase()) || k.toLowerCase() === 'www-authenticate') {
          parts.push(`${k}: ${v}`);
        }
      }
    }
    if (exchange.responseBody && exchange.responseBody.length <= MAX_BODY_SKIP) {
      const body = Buffer.from(exchange.responseBody).toString('utf-8');
      if (body.length > MAX_RESPONSE_BODY_TRIAGE) {
        parts.push(`\nResponse body (${body.length} chars, truncated): ${body.slice(0, MAX_RESPONSE_BODY_TRIAGE)}`);
      } else {
        parts.push(`\nResponse body: ${body}`);
      }
    }
  }

  return parts.join('\n');
}

function tryPath(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

/**
 * Normalize a URL path into a "shape" so /users/123 and /users/456 collapse to /users/{id}.
 * Replaces numeric segments, UUIDs, hex hashes, and long opaque tokens with placeholders.
 * Also collapses query parameter VALUES while keeping the parameter keys (sorted).
 */
export function urlShape(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  const segs = parsed.pathname.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return '{id}';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
    if (/^[0-9a-f]{32,}$/i.test(seg)) return '{hash}';
    if (/^[A-Za-z0-9_-]{24,}$/.test(seg)) return '{token}';
    return seg;
  });
  const path = segs.join('/');
  const paramKeys = [...parsed.searchParams.keys()].sort();
  const query = paramKeys.length > 0 ? `?${paramKeys.join('&')}` : '';
  return `${path}${query}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

interface RecentExchange {
  method: string;
  url: string;
  statusCode: number | null;
  hasAuth: boolean;
  params: string[];
}

class AutoAnalyzer {
  private enabled = false;
  private queue: string[] = [];
  private processing = false;
  private currentExchangeId: string | null = null;
  private dailyCost = 0;
  private dailyCostDate = ''; // YYYY-MM-DD this dailyCost belongs to
  private maxDailyCost = 5.0;
  private escalationEnabled = true;
  private scopeMode: 'all' | 'in-scope' = 'in-scope'; // Whether AI analyzes all traffic or only in-scope

  // Cross-request session memory — accumulates observations across all analyzed requests
  private sessionObservations = '';

  // Endpoint shapes already analyzed this session — keys like "host|METHOD|/users/{id}".
  // Skips redundant LLM calls when the same endpoint shape is hit repeatedly.
  private analyzedShapes = new Set<string>();

  // Hosts we've already produced a baseline recon for in this session (loaded + persisted).
  private baselinedHosts = new Set<string>();

  // Recent exchange summaries for cross-request pattern detection (rolling window)
  private recentExchanges: RecentExchange[] = [];
  private maxRecentExchanges = 30;

  // Persistent memory — loaded from/saved to DB Settings
  private persistentMemory = '';

  // Escalation buffer — collects exchanges for batch deep analysis
  private escalationBuffer: Array<{ exchangeId: string; triageFindings: string; briefText: string }> = [];
  private escalationTimer: ReturnType<typeof setTimeout> | null = null;

  async init() {
    // Load noise filter rules
    await noiseFilter.init();

    // Load persistent memory from DB
    const saved = await db.settings.findUnique({ where: { key: 'auto_analyzer_memory' } });
    if (saved) {
      this.persistentMemory = saved.value;
      this.sessionObservations = saved.value;
    }

    // Load cost limit from DB
    const costLimit = await db.settings.findUnique({ where: { key: 'daily_cost_limit' } });
    if (costLimit) {
      this.maxDailyCost = parseFloat(costLimit.value) || 5.0;
    }

    // Load escalation setting
    const escalation = await db.settings.findUnique({ where: { key: 'escalation_enabled' } });
    if (escalation) {
      this.escalationEnabled = escalation.value !== 'false';
    }

    // Load baselined hosts
    const baselined = await db.settings.findUnique({ where: { key: 'auto_analyzer_baselined_hosts' } });
    if (baselined) {
      try {
        const list = JSON.parse(baselined.value) as string[];
        if (Array.isArray(list)) this.baselinedHosts = new Set(list);
      } catch { /* ignore */ }
    }

    // Load scope mode
    const scopeModeSetting = await db.settings.findUnique({ where: { key: 'ai_scope_mode' } });
    if (scopeModeSetting) {
      this.scopeMode = scopeModeSetting.value === 'in-scope' ? 'in-scope' : 'all';
    }

    // Load persisted enabled flag — survives backend restarts
    const enabledSetting = await db.settings.findUnique({ where: { key: 'auto_analyze_enabled' } });
    if (enabledSetting) {
      this.enabled = enabledSetting.value === 'true';
    }

    // Load persisted daily cost (only restore if it's still the same calendar day)
    const today = todayStr();
    const dailyCostState = await db.settings.findUnique({ where: { key: 'auto_analyzer_daily_cost' } });
    if (dailyCostState) {
      try {
        const { date, cost } = JSON.parse(dailyCostState.value) as { date: string; cost: number };
        if (date === today) {
          this.dailyCost = cost;
          this.dailyCostDate = date;
        } else {
          this.dailyCostDate = today;
        }
      } catch {
        this.dailyCostDate = today;
      }
    } else {
      this.dailyCostDate = today;
    }
  }

  /** Add cost atomically — handles day rollover and persists to DB. */
  private async addCost(amount: number) {
    const today = todayStr();
    if (today !== this.dailyCostDate) {
      this.dailyCost = 0;
      this.dailyCostDate = today;
    }
    this.dailyCost += amount;
    // Fire-and-forget persistence
    db.settings.upsert({
      where: { key: 'auto_analyzer_daily_cost' },
      create: { key: 'auto_analyzer_daily_cost', value: JSON.stringify({ date: this.dailyCostDate, cost: this.dailyCost }) },
      update: { value: JSON.stringify({ date: this.dailyCostDate, cost: this.dailyCost }) },
    }).catch(() => {});
  }

  enable() {
    this.enabled = true;
    this.init().catch(() => {});
    db.settings.upsert({
      where: { key: 'auto_analyze_enabled' },
      create: { key: 'auto_analyze_enabled', value: 'true' },
      update: { value: 'true' },
    }).catch(() => {});
    console.log('[auto-analyzer] enabled');
  }

  disable() {
    this.enabled = false;
    this.savePersistentMemory().catch(() => {});
    db.settings.upsert({
      where: { key: 'auto_analyze_enabled' },
      create: { key: 'auto_analyze_enabled', value: 'false' },
      update: { value: 'false' },
    }).catch(() => {});
    console.log('[auto-analyzer] disabled');
  }

  isEnabled() {
    return this.enabled;
  }

  getSessionObservations() {
    return this.sessionObservations;
  }

  setDailyCostLimit(limit: number) {
    this.maxDailyCost = limit;
    console.log(`[auto-analyzer] daily cost limit set to $${limit}`);
  }

  getDailyCostLimit() {
    return this.maxDailyCost;
  }

  setEscalationEnabled(enabled: boolean) {
    this.escalationEnabled = enabled;
    console.log(`[auto-analyzer] escalation ${enabled ? 'enabled' : 'disabled'}`);
  }

  isEscalationEnabled() {
    return this.escalationEnabled;
  }

  setScopeMode(mode: 'all' | 'in-scope') {
    this.scopeMode = mode;
    db.settings.upsert({
      where: { key: 'ai_scope_mode' },
      create: { key: 'ai_scope_mode', value: mode },
      update: { value: mode },
    }).catch(() => {});
    console.log(`[auto-analyzer] scope mode set to: ${mode}`);
  }

  getScopeMode() {
    return this.scopeMode;
  }

  clearMemory() {
    this.sessionObservations = '';
    this.persistentMemory = '';
    this.recentExchanges = [];
    this.analyzedShapes.clear();
    this.baselinedHosts.clear();
    db.settings.deleteMany({ where: { key: 'auto_analyzer_baselined_hosts' } }).catch(() => {});
    console.log('[auto-analyzer] memory cleared');
  }

  private async savePersistentMemory() {
    if (!this.sessionObservations) return;
    await db.settings.upsert({
      where: { key: 'auto_analyzer_memory' },
      create: { key: 'auto_analyzer_memory', value: this.sessionObservations },
      update: { value: this.sessionObservations },
    });
    this.persistentMemory = this.sessionObservations;
  }

  private broadcastActivity(event: string, data: Record<string, unknown> = {}) {
    wsHub.broadcast({
      type: 'analyzer:activity',
      data: {
        event,
        dailyCost: this.dailyCost,
        queueLength: this.queue.length,
        timestamp: Date.now(),
        ...data,
      },
    } as any);
  }

  enqueue(exchangeId: string) {
    if (!this.enabled) return;
    // Roll over the daily counter if the calendar day changed
    const today = todayStr();
    if (today !== this.dailyCostDate) {
      this.dailyCost = 0;
      this.dailyCostDate = today;
    }
    if (this.dailyCost >= this.maxDailyCost) {
      console.log('[auto-analyzer] daily cost cap reached, skipping');
      this.broadcastActivity('cost-cap', { exchangeId, message: 'Daily cost cap reached' });
      return;
    }
    this.queue.push(exchangeId);
    this.processQueue();
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const exchangeId = this.queue.shift()!;
      this.currentExchangeId = exchangeId;
      try {
        await this.analyzeExchange(exchangeId);
      } catch (err) {
        this.broadcastActivity('error', {
          exchangeId,
          message: `Error: ${(err as Error).message}`,
        });
        console.error('[auto-analyzer] error:', (err as Error).message);
      }
    }

    this.currentExchangeId = null;
    this.processing = false;

    // Save observations after every analysis — cheap upsert, and means a
    // backend restart loses at most one analysis worth of context.
    this.savePersistentMemory().catch(() => {});

    // Throttled session summary regeneration (no-op if recently generated)
    maybeGenerateSessionSummary().catch(() => {});
  }

  /**
   * Pull recent findings on the same host from the Finding table.
   * Returns a compact text summary the model can use for dedupe + chain detection.
   */
  private async buildPriorFindingsForHost(host: string): Promise<string> {
    const rows = await getFindingsForHost(host, 25);
    if (rows.length === 0) return '';
    return rows.map((f) => {
      const where = f.method && f.url ? `${f.method} ${tryPath(f.url)}` : '';
      const detail = (f.detail || '').slice(0, 140);
      return `  [${f.severity.toUpperCase()}] ${f.title}${where ? ` @ ${where}` : ''} — ${detail}`;
    }).join('\n');
  }

  /**
   * One-shot baseline recon for a host the analyzer is seeing for the first time.
   * Produces broad observations about the target (tech stack hints, auth scheme, surface area)
   * and records a single info-level Finding so the analyst sees it surfaced in the UI.
   * Persists the host to settings so we don't re-baseline across restarts.
   */
  private async runBaselineRecon(host: string, firstExchange: { method: string; url: string; requestHeaders: string; responseHeaders: string | null; statusCode: number | null; responseBody: Uint8Array | null }) {
    if (this.baselinedHosts.has(host)) return;
    this.baselinedHosts.add(host);
    // Persist immediately so a crash mid-call doesn't cause a re-baseline
    db.settings.upsert({
      where: { key: 'auto_analyzer_baselined_hosts' },
      create: { key: 'auto_analyzer_baselined_hosts', value: JSON.stringify([...this.baselinedHosts]) },
      update: { value: JSON.stringify([...this.baselinedHosts]) },
    }).catch(() => {});

    if (this.dailyCost >= this.maxDailyCost) return;

    this.broadcastActivity('baseline-start', { message: `Baseline recon for new host ${host}` });

    const reqHeaders = (() => { try { return JSON.parse(firstExchange.requestHeaders); } catch { return {}; } })();
    const resHeaders = (() => { try { return firstExchange.responseHeaders ? JSON.parse(firstExchange.responseHeaders) : {}; } catch { return {}; } })();
    const bodySnippet = firstExchange.responseBody ? Buffer.from(firstExchange.responseBody).toString('utf-8').slice(0, 1500) : '';

    const prompt = `You are doing initial reconnaissance on a new web target a pentester just started intercepting.

Host: ${host}
First exchange: ${firstExchange.method} ${firstExchange.url} → ${firstExchange.statusCode ?? '?'}
Request headers (interesting only):
${Object.entries(reqHeaders).filter(([k]) => /auth|cookie|api|csrf|origin|referer|user-agent/i.test(k)).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)'}
Response headers:
${Object.entries(resHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n').slice(0, 1200)}
Response body (first 1500 chars):
${bodySnippet}

Produce a SHORT (under 350 chars) baseline summary covering:
- Likely tech stack / framework hints
- Auth scheme observed (if any)
- Notable security headers present or missing
- Suggested initial pentest pivots to watch for as more traffic comes in

Plain prose, no markdown headings, no JSON.`;

    try {
      const result = await llmInvoke(
        [{ role: 'user', content: prompt }],
        'fast',
        undefined,
        'baseline-recon',
      );
      await this.addCost(result.costUsd);

      await recordFinding({
        host,
        source: 'auto-analyzer',
        severity: 'info',
        title: `Host baseline: ${host}`,
        detail: result.text.trim().slice(0, 1000),
        type: 'baseline',
      });

      this.broadcastActivity('baseline-done', { message: `Baseline recon complete for ${host}`, costUsd: result.costUsd });
    } catch (err) {
      this.broadcastActivity('error', { message: `Baseline recon error for ${host}: ${(err as Error).message}` });
    }
  }

  private async analyzeExchange(exchangeId: string) {
    const exchange = await db.exchange.findUnique({ where: { id: exchangeId } });
    if (!exchange) return;

    // Only analyze in-scope traffic when scope mode is 'in-scope'
    if (this.scopeMode === 'in-scope') {
      // Require at least one include rule — otherwise "in-scope only" with no rules
      // would scan everything (since isInScope returns true when no rules exist).
      const includeRuleCount = await db.scopeRule.count({ where: { enabled: true, type: 'include' } });
      if (includeRuleCount === 0) {
        this.broadcastActivity('skipped', {
          exchangeId,
          method: exchange.method,
          url: exchange.url,
          message: `Skipped ${exchange.method} ${exchange.path} (no scope rules defined)`,
        });
        return;
      }
      const inScope = await isInScope(exchange.url);
      if (!inScope) {
        this.broadcastActivity('skipped', {
          exchangeId,
          method: exchange.method,
          url: exchange.url,
          message: `Skipped ${exchange.method} ${exchange.path} (out of scope)`,
        });
        return;
      }
    }

    // Determine content type from response headers
    let contentType: string | null = null;
    if (exchange.responseHeaders) {
      try {
        const resHeaders = JSON.parse(exchange.responseHeaders);
        contentType = resHeaders['content-type'] || resHeaders['Content-Type'] || null;
      } catch { /* ignore */ }
    }

    const responseSize = exchange.responseBody ? exchange.responseBody.length : null;
    // Noise filter: skip repetitive high-frequency patterns (e.g. polling, pings)
    const { skip: isNoise, pattern: noisePattern, reason: noiseReason } = await noiseFilter.shouldSkip(
      exchange.host, exchange.method, exchange.url
    );
    if (isNoise) {
      this.broadcastActivity('skipped', {
        exchangeId,
        method: exchange.method,
        url: exchange.url,
        message: `Skipped ${exchange.method} ${exchange.path} (${noiseReason}: noise filter)`,
        noisePattern,
      });
      return;
    }

    // Endpoint shape dedupe: skip if we've already analyzed this shape on this host this session
    const shapeKey = `${exchange.host}|${exchange.method}|${urlShape(exchange.url)}`;
    if (this.analyzedShapes.has(shapeKey)) {
      this.broadcastActivity('skipped', {
        exchangeId,
        method: exchange.method,
        url: exchange.url,
        message: `Skipped ${exchange.method} ${exchange.path} (shape already analyzed)`,
      });
      return;
    }

    if (shouldSkip(exchange.method, exchange.path, contentType, responseSize)) {
      this.broadcastActivity('skipped', {
        exchangeId,
        method: exchange.method,
        url: exchange.url,
        message: `Skipped ${exchange.method} ${exchange.path} (static/binary)`,
      });
      return;
    }

    // First-time host detection: run baseline recon (fire-and-forget — runs in parallel with triage)
    if (!this.baselinedHosts.has(exchange.host)) {
      this.runBaselineRecon(exchange.host, exchange).catch(() => {});
    }

    this.broadcastActivity('analyzing', {
      exchangeId,
      method: exchange.method,
      url: exchange.url,
      message: `Classifying ${exchange.method} ${exchange.path}`,
    });

    // Track exchange in recent history for cross-request context
    const headers = JSON.parse(exchange.requestHeaders);
    const hasAuth = !!(headers.authorization || headers.cookie || headers['x-api-key']);
    const urlObj = new URL(exchange.url);
    const params = [...urlObj.searchParams.keys()];

    this.recentExchanges.push({
      method: exchange.method,
      url: exchange.url,
      statusCode: exchange.statusCode,
      hasAuth,
      params,
    });
    if (this.recentExchanges.length > this.maxRecentExchanges) {
      this.recentExchanges.shift();
    }

    const briefText = formatExchangeBrief(exchange);

    // Build context with session memory and recent traffic summary
    const recentSummary = this.recentExchanges
      .slice(-10)
      .map((e) => `  ${e.method} ${e.url} → ${e.statusCode || '?'} ${e.hasAuth ? '[AUTH]' : ''} ${e.params.length ? `params: ${e.params.join(',')}` : ''}`)
      .join('\n');

    // Pull prior findings for this host so the model can dedupe and reason about chaining
    const priorFindingsText = await this.buildPriorFindingsForHost(exchange.host);

    // Pull false-positives so the model knows what NOT to re-report
    const falsePositives = await getFalsePositivesForHost(exchange.host, 25);
    const fpText = falsePositives.length > 0
      ? falsePositives.map((f) => `  [${f.severity.toUpperCase()}] ${f.title}${f.detail ? ` — ${f.detail.slice(0, 120)}` : ''}`).join('\n')
      : '';

    // ── Stage 1: Classification ──
    // Ask the classifier which vulnerability categories could apply
    const classifierContext = [
      this.sessionObservations ? `=== SESSION OBSERVATIONS ===\n${this.sessionObservations}` : '',
      priorFindingsText ? `=== PRIOR FINDINGS ON ${exchange.host} ===\n${priorFindingsText}` : '',
      fpText ? `=== FALSE POSITIVES (do not re-report these patterns) ===\n${fpText}` : '',
      `=== RECENT TRAFFIC (last ${Math.min(10, this.recentExchanges.length)} requests) ===\n${recentSummary}`,
      `=== CURRENT EXCHANGE ===\n${briefText}`,
    ].filter(Boolean).join('\n\n');

    const classResult = await llmInvoke(
      [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: classifierContext },
      ],
      'fast',
      undefined,
      'auto-triage',
    );
    await this.addCost(classResult.costUsd);
    this.analyzedShapes.add(shapeKey);

    try {
      const classified = JSON.parse(stripCodeFences(classResult.text));

      // Update session observations from classifier's response
      if (classified.observations && typeof classified.observations === 'string') {
        this.sessionObservations = classified.observations;
      }

      const matches: Array<{ vulnId: string; reason: string }> = classified.matches || [];

      if (matches.length > 0) {
        // ── Stage 2: Specialist analysis for each matched category ──
        this.broadcastActivity('analyzing', {
          exchangeId,
          method: exchange.method,
          url: exchange.url,
          message: `Testing ${matches.map((m) => m.vulnId).join(', ')} on ${exchange.method} ${exchange.path}`,
        });

        let totalSpecialistCost = 0;

        for (const match of matches) {
          const vuln = VULN_BY_ID.get(match.vulnId);
          if (!vuln) {
            console.log(`[auto-analyzer] unknown vuln ID from classifier: ${match.vulnId}`);
            continue;
          }

          const specialistSystem = vuln.specialistPrompt + SPECIALIST_SYSTEM_SUFFIX;
          const specialistUser = buildSpecialistUserPrompt(vuln, match.reason, briefText, priorFindingsText, fpText);

          const specResult = await llmInvoke(
            [
              { role: 'system', content: specialistSystem },
              { role: 'user', content: specialistUser },
            ],
            'fast',
            undefined,
            'auto-specialist',
          );
          await this.addCost(specResult.costUsd);
          totalSpecialistCost += specResult.costUsd;

          try {
            const specParsed = JSON.parse(stripCodeFences(specResult.text));

            if (specParsed.findings && specParsed.findings.length > 0) {
              for (const finding of specParsed.findings) {
                const { isNew, suppressed } = await recordFinding({
                  exchangeId,
                  host: exchange.host,
                  source: 'auto-analyzer',
                  severity: (finding.severity || 'info') as any,
                  title: finding.title,
                  detail: finding.detail || '',
                  evidence: finding.evidence || null,
                  suggestedTest: finding.suggestedTest || null,
                  method: exchange.method,
                  url: exchange.url,
                  type: vuln.id,
                  cvss: finding.cvss ?? null,
                  cvssVector: finding.cvssVector || null,
                });

                if (suppressed) {
                  console.log(`[auto-analyzer] suppressed (false-positive): ${finding.title}`);
                  continue;
                }

                this.broadcastActivity('finding', {
                  exchangeId,
                  method: exchange.method,
                  url: exchange.url,
                  message: `${isNew ? '' : '[dup] '}[${vuln.id.toUpperCase()}] [${(finding.severity || 'info').toUpperCase()}] ${finding.title}`,
                  costUsd: specResult.costUsd,
                });

                console.log(`[auto-analyzer] ${isNew ? '' : '[dup] '}[${vuln.id}] ${(finding.severity || 'info').toUpperCase()}: ${finding.title}`);
              }
            } else {
              console.log(`[auto-analyzer] [${vuln.id}] specialist found no confirmed vulnerability`);
            }
          } catch {
            console.error(`[auto-analyzer] failed to parse specialist response for ${vuln.id}`);
          }
        }

        if (totalSpecialistCost === 0) {
          this.broadcastActivity('done', {
            exchangeId,
            method: exchange.method,
            url: exchange.url,
            message: `No confirmed findings for ${exchange.method} ${exchange.path} (tested: ${matches.map((m) => m.vulnId).join(', ')})`,
            costUsd: classResult.costUsd,
            observations: classified.observations || undefined,
          });
        }
      } else {
        this.broadcastActivity('done', {
          exchangeId,
          method: exchange.method,
          url: exchange.url,
          message: `No vulnerability indicators for ${exchange.method} ${exchange.path}`,
          costUsd: classResult.costUsd,
          observations: classified.observations || undefined,
        });
      }

      // Handle escalation: if classifier says escalate, buffer for deep analysis
      if (classified.escalate && this.escalationEnabled) {
        const triageSummary = matches
          .map((m) => `[${m.vulnId}] ${m.reason}`)
          .join('\n');

        this.escalationBuffer.push({
          exchangeId,
          triageFindings: triageSummary,
          briefText,
        });

        this.broadcastActivity('escalating', {
          exchangeId,
          method: exchange.method,
          url: exchange.url,
          message: `Escalating ${exchange.method} ${exchange.path} for deep analysis`,
        });
        console.log(`[auto-analyzer] escalation requested for ${exchange.method} ${exchange.path}`);

        // Debounce: wait 5s for more escalations to batch together
        if (this.escalationTimer) clearTimeout(this.escalationTimer);
        this.escalationTimer = setTimeout(() => this.runDeepAnalysis(), 5000);
      }
    } catch {
      // Model didn't return valid JSON — skip silently
    }
  }

  private async runDeepAnalysis() {
    if (this.escalationBuffer.length === 0) return;
    if (this.dailyCost >= this.maxDailyCost) {
      console.log('[auto-analyzer] daily cost cap reached, skipping deep analysis');
      this.escalationBuffer = [];
      return;
    }

    const batch = this.escalationBuffer.splice(0);
    console.log(`[auto-analyzer] running deep analysis on ${batch.length} escalated exchange(s)`);
    this.broadcastActivity('deep-start', {
      message: `Deep analysis starting on ${batch.length} escalated exchange(s)`,
    });

    // Build the deep analysis context
    const exchangeDetails = batch.map((item, i) => {
      return [
        `--- Exchange ${i + 1} ---`,
        item.briefText,
        item.triageFindings ? `\nTriage findings:\n${item.triageFindings}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const recentSummary = this.recentExchanges
      .slice(-15)
      .map((e) => `  ${e.method} ${e.url} → ${e.statusCode || '?'} ${e.hasAuth ? '[AUTH]' : ''} ${e.params.length ? `params: ${e.params.join(',')}` : ''}`)
      .join('\n');

    const contextBlock = [
      this.sessionObservations ? `=== SESSION OBSERVATIONS ===\n${this.sessionObservations}` : '',
      `=== RECENT TRAFFIC ===\n${recentSummary}`,
      `=== ESCALATED EXCHANGES ===\n${exchangeDetails}`,
    ].filter(Boolean).join('\n\n');

    try {
      const result = await llmInvoke(
        [
          { role: 'system', content: DEEP_ANALYSIS_PROMPT },
          { role: 'user', content: contextBlock },
        ],
        'reasoning',
        undefined,
        'auto-deep',
      );
      await this.addCost(result.costUsd);

      const parsed = JSON.parse(stripCodeFences(result.text));

      // Update observations with expert insights
      if (parsed.observations && typeof parsed.observations === 'string') {
        this.sessionObservations = parsed.observations;
      }

      if (parsed.findings && parsed.findings.length > 0) {
        // Try to attach method/url/host from the first exchange in the batch
        const firstExchange = await db.exchange.findUnique({ where: { id: batch[0].exchangeId } });
        const host = firstExchange?.host || '';
        const method = firstExchange?.method || null;
        const url = firstExchange?.url || null;

        for (const finding of parsed.findings) {
          const { isNew, suppressed } = await recordFinding({
            exchangeId: batch[0].exchangeId,
            host,
            source: 'auto-analyzer',
            severity: (finding.severity || 'info') as any,
            title: `[Deep] ${finding.title}`,
            detail: finding.detail || '',
            method,
            url,
            type: finding.type || null,
            cvss: finding.cvss ?? null,
            cvssVector: finding.cvssVector || null,
            escalated: true,
          });

          if (suppressed) continue;

          this.broadcastActivity('finding', {
            exchangeId: batch[0].exchangeId,
            method: method || undefined,
            url: url || undefined,
            message: `${isNew ? '' : '[dup] '}[DEEP] [${(finding.severity || 'info').toUpperCase()}] ${finding.title}`,
            costUsd: result.costUsd,
          });

          console.log(`[auto-analyzer] ${isNew ? '' : '[dup] '}[DEEP] ${(finding.severity || 'info').toUpperCase()}: ${finding.title}`);
        }
      }

      this.broadcastActivity('deep-done', {
        message: `Deep analysis complete (${parsed.findings?.length || 0} findings)`,
        costUsd: result.costUsd,
      });
    } catch (err) {
      this.broadcastActivity('error', {
        message: `Deep analysis error: ${(err as Error).message}`,
      });
      console.error('[auto-analyzer] deep analysis error:', (err as Error).message);
    }
  }

  getDailyCost() {
    return this.dailyCost;
  }

  getQueueState() {
    return {
      currentExchangeId: this.currentExchangeId,
      queuedIds: [...this.queue],
      processing: this.processing,
    };
  }
}

export const autoAnalyzer = new AutoAnalyzer();
