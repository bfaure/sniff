import { db } from '../db.js';
import { urlShape } from './auto-analyzer.js';

/**
 * Noise Filter — detects repetitive request patterns (e.g. Android pings,
 * health checks, polling endpoints) and suppresses them from auto-analysis
 * after they exceed a frequency threshold.
 *
 * Detection: if the same host|method|shape fires ≥ THRESHOLD times within
 * WINDOW_MS, it's flagged as noise and persisted to the NoiseFilter table.
 * All future hits are skipped without touching the LLM.
 *
 * Users can view, disable, or delete filters via the API.
 */

const THRESHOLD = 4;        // hits within window to trigger auto-suppression
const WINDOW_MS = 60_000;   // 60-second sliding window

interface HitRecord {
  timestamps: number[];
  total: number;
}

class NoiseFilter {
  /** In-memory sliding window counters: pattern → timestamps */
  private hits = new Map<string, HitRecord>();

  /** Patterns confirmed as noise (in DB). Loaded on init, kept in sync. */
  private suppressed = new Map<string, boolean>();  // pattern → enabled

  async init() {
    const rows = await db.noiseFilter.findMany();
    for (const row of rows) {
      this.suppressed.set(row.pattern, row.enabled);
    }
  }

  /**
   * Build the canonical pattern key for a request.
   */
  makeKey(host: string, method: string, url: string): string {
    return `${host}|${method}|${urlShape(url)}`;
  }

  /**
   * Record a hit and return whether this pattern should be SKIPPED.
   * Called from auto-analyzer before sending to LLM.
   */
  async shouldSkip(host: string, method: string, url: string): Promise<{ skip: boolean; pattern: string; reason?: string }> {
    const pattern = this.makeKey(host, method, url);

    // Already suppressed in DB?
    const isKnown = this.suppressed.get(pattern);
    if (isKnown === true) {
      // Bump hit counter in DB (fire-and-forget)
      db.noiseFilter.update({
        where: { pattern },
        data: { hitsTotal: { increment: 1 } },
      }).catch(() => {});
      return { skip: true, pattern, reason: 'noise-filter' };
    }
    // Explicitly disabled by user?
    if (isKnown === false) {
      return { skip: false, pattern };
    }

    // Track in sliding window
    const now = Date.now();
    let record = this.hits.get(pattern);
    if (!record) {
      record = { timestamps: [], total: 0 };
      this.hits.set(pattern, record);
    }
    record.timestamps.push(now);
    record.total++;

    // Trim window
    const cutoff = now - WINDOW_MS;
    record.timestamps = record.timestamps.filter((t) => t >= cutoff);

    // Check threshold
    if (record.timestamps.length >= THRESHOLD) {
      // Auto-suppress: persist to DB
      const shape = urlShape(url);
      try {
        await db.noiseFilter.upsert({
          where: { pattern },
          create: {
            pattern,
            host,
            method,
            shape,
            hitsTotal: record.total,
            reason: 'auto',
            enabled: true,
          },
          update: {
            hitsTotal: record.total,
          },
        });
      } catch { /* unique constraint race — fine */ }
      this.suppressed.set(pattern, true);
      return { skip: true, pattern, reason: 'auto-detected' };
    }

    return { skip: false, pattern };
  }

  /** List all noise filter rules. */
  async list() {
    return db.noiseFilter.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /** Toggle a rule on/off. */
  async toggle(id: string, enabled: boolean) {
    const row = await db.noiseFilter.update({
      where: { id },
      data: { enabled },
    });
    this.suppressed.set(row.pattern, enabled);
    return row;
  }

  /** Delete a rule (pattern will be re-detected if it recurs). */
  async remove(id: string) {
    const row = await db.noiseFilter.delete({ where: { id } });
    this.suppressed.delete(row.pattern);
    this.hits.delete(row.pattern);
    return row;
  }

  /** Manually add a pattern. */
  async addManual(host: string, method: string, shape: string) {
    const pattern = `${host}|${method}|${shape}`;
    const row = await db.noiseFilter.upsert({
      where: { pattern },
      create: {
        pattern,
        host,
        method,
        shape,
        hitsTotal: 0,
        reason: 'manual',
        enabled: true,
      },
      update: {
        reason: 'manual',
        enabled: true,
      },
    });
    this.suppressed.set(pattern, true);
    return row;
  }

  /** Clear all auto-detected rules (keep manual ones). */
  async clearAuto() {
    const deleted = await db.noiseFilter.deleteMany({ where: { reason: 'auto' } });
    // Reload in-memory state
    await this.init();
    return deleted.count;
  }
}

export const noiseFilter = new NoiseFilter();
