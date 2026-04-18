import { db } from '../db.js';
import type { TokenUsage, CostSummary } from '@sniff/shared';

class CostTracker {
  private sessionTotal = 0;

  async record(modelId: string, usage: TokenUsage, costUsd: number, feature: string = 'unknown'): Promise<void> {
    this.sessionTotal += costUsd;

    await db.costRecord.create({
      data: {
        modelId,
        feature,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
      },
    });
  }

  async getBreakdown(scope: 'session' | 'daily' | 'all-time' = 'daily'): Promise<Array<{ feature: string; costUsd: number; calls: number }>> {
    const where: Record<string, unknown> = {};
    if (scope === 'daily') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      where.timestamp = { gte: today };
    }
    const rows = await db.costRecord.groupBy({
      by: ['feature'],
      _sum: { costUsd: true },
      _count: { id: true },
      where,
      orderBy: { _sum: { costUsd: 'desc' } },
    });
    return rows.map((r) => ({
      feature: r.feature,
      costUsd: r._sum.costUsd ?? 0,
      calls: r._count.id,
    }));
  }

  async getSummary(): Promise<CostSummary> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [dailyResult, allTimeResult] = await Promise.all([
      db.costRecord.aggregate({
        _sum: { costUsd: true },
        where: { timestamp: { gte: today } },
      }),
      db.costRecord.aggregate({
        _sum: { costUsd: true },
      }),
    ]);

    return {
      sessionTotal: this.sessionTotal,
      dailyTotal: dailyResult._sum.costUsd ?? 0,
      allTimeTotal: allTimeResult._sum.costUsd ?? 0,
    };
  }

  getSessionTotal(): number {
    return this.sessionTotal;
  }
}

export const costTracker = new CostTracker();
