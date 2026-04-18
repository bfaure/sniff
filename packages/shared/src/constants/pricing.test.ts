import { describe, it, expect } from 'vitest';
import { calculateCost, MODEL_PRICING } from './pricing.js';

describe('calculateCost', () => {
  it('calculates cost for known model', () => {
    const cost = calculateCost(
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      1000,
      500,
    );
    // input: 1000/1000 * 0.003 = 0.003
    // output: 500/1000 * 0.015 = 0.0075
    expect(cost).toBeCloseTo(0.0105);
  });

  it('returns 0 for unknown model', () => {
    expect(calculateCost('unknown-model', 1000, 1000)).toBe(0);
  });

  it('handles zero tokens', () => {
    expect(calculateCost('anthropic.claude-3-5-sonnet-20241022-v2:0', 0, 0)).toBe(0);
  });

  it('has pricing for all listed models', () => {
    for (const modelId of Object.keys(MODEL_PRICING)) {
      const cost = calculateCost(modelId, 100, 100);
      expect(cost).toBeGreaterThan(0);
    }
  });
});
