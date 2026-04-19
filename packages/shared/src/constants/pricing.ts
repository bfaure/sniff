import type { ModelPricing } from '../types/llm.js';

// Pricing per 1K tokens in USD
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude 4.x (via Bedrock cross-region inference)
  // Opus 4.7 uses the new Mantle ID format (no date suffix, no -v1:0).
  'us.anthropic.claude-opus-4-7': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.075 },
  'us.anthropic.claude-sonnet-4-6-20250514-v1:0': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  'us.anthropic.claude-opus-4-6-20250514-v1:0': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.075 },
  'us.anthropic.claude-opus-4-20250514-v1:0': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.075 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inputPer1kTokens: 0.0008, outputPer1kTokens: 0.004 },

  // Anthropic Claude 3.x (via Bedrock — both cross-region and direct)
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1kTokens: 0.0008, outputPer1kTokens: 0.004 },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  'anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1kTokens: 0.0008, outputPer1kTokens: 0.004 },

  // DeepSeek (via Bedrock)
  // V3.2 is in-region only on Bedrock — no us./eu./global. prefix.
  'deepseek.v3.2': { inputPer1kTokens: 0.00027, outputPer1kTokens: 0.0011 },
  'us.deepseek.r1-v1:0': { inputPer1kTokens: 0.00135, outputPer1kTokens: 0.0054 },

  // Amazon Nova
  'us.amazon.nova-pro-v1:0': { inputPer1kTokens: 0.0008, outputPer1kTokens: 0.0032 },
  'us.amazon.nova-lite-v1:0': { inputPer1kTokens: 0.00006, outputPer1kTokens: 0.00024 },
  'us.amazon.nova-micro-v1:0': { inputPer1kTokens: 0.000035, outputPer1kTokens: 0.00014 },

  // Meta Llama (Bedrock)
  'us.meta.llama3-3-70b-instruct-v1:0': { inputPer1kTokens: 0.00072, outputPer1kTokens: 0.00072 },

  // Mistral (Bedrock)
  'mistral.mistral-large-2407-v1:0': { inputPer1kTokens: 0.002, outputPer1kTokens: 0.006 },
};

// Default model tiers for automatic selection
// Uses cross-region inference profile IDs (required for on-demand throughput)
export const DEFAULT_MODEL_TIERS = {
  // Cheap + fast: triage, explanations, suggestions, payload generation, chat
  fast: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Reasoning: vuln scanning, pentest pathway analysis
  reasoning: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  // Deep: escalated analysis, complex multi-request patterns
  deep: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
} as const;

// Mutable runtime tiers (overridden by settings)
export const MODEL_TIERS: { fast: string; reasoning: string; deep: string } = { ...DEFAULT_MODEL_TIERS };

export type ModelTier = keyof typeof MODEL_TIERS;

// Available models the user can choose from
export const AVAILABLE_MODELS = [
  // Anthropic Claude
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5', tier: 'fast' as const },
  { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Claude Sonnet 4', tier: 'reasoning' as const },
  { id: 'us.anthropic.claude-sonnet-4-6-20250514-v1:0', label: 'Claude Sonnet 4.6', tier: 'reasoning' as const },
  { id: 'us.anthropic.claude-opus-4-20250514-v1:0', label: 'Claude Opus 4', tier: 'deep' as const },
  { id: 'us.anthropic.claude-opus-4-6-20250514-v1:0', label: 'Claude Opus 4.6', tier: 'deep' as const },
  { id: 'us.anthropic.claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'deep' as const },
  { id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', label: 'Claude Sonnet 3.5 v2', tier: 'reasoning' as const },
  { id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0', label: 'Claude Haiku 3.5', tier: 'fast' as const },

  // DeepSeek
  { id: 'deepseek.v3.2', label: 'DeepSeek V3.2', tier: 'reasoning' as const },
  { id: 'us.deepseek.r1-v1:0', label: 'DeepSeek R1', tier: 'reasoning' as const },

  // Amazon Nova — generally cheaper than Claude, useful for high-volume triage
  { id: 'us.amazon.nova-micro-v1:0', label: 'Amazon Nova Micro', tier: 'fast' as const },
  { id: 'us.amazon.nova-lite-v1:0', label: 'Amazon Nova Lite', tier: 'fast' as const },
  { id: 'us.amazon.nova-pro-v1:0', label: 'Amazon Nova Pro', tier: 'reasoning' as const },

  // Meta Llama
  { id: 'us.meta.llama3-3-70b-instruct-v1:0', label: 'Llama 3.3 70B Instruct', tier: 'reasoning' as const },

  // Mistral
  { id: 'mistral.mistral-large-2407-v1:0', label: 'Mistral Large 2 (2407)', tier: 'reasoning' as const },
] as const;

export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return 0;
  return (
    (inputTokens / 1000) * pricing.inputPer1kTokens +
    (outputTokens / 1000) * pricing.outputPer1kTokens
  );
}
