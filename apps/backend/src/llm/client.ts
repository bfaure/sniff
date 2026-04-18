import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { MODEL_TIERS, DEFAULT_MODEL_TIERS, calculateCost, type ModelTier } from '@sniff/shared';
import type { LLMMessage, TokenUsage } from '@sniff/shared';
import { costTracker } from './cost-tracker.js';

let client: BedrockRuntimeClient | null = null;

export function initBedrockClient(region: string = 'us-east-1') {
  // Uses default credential chain (env vars, ~/.aws/credentials, IAM role, etc.)
  client = new BedrockRuntimeClient({ region });
}

function getClient(): BedrockRuntimeClient {
  if (!client) {
    // Auto-init with default region
    initBedrockClient();
  }
  return client!;
}

function toLLMMessages(messages: LLMMessage[]): { system: string | undefined; converseMsgs: Message[] } {
  let system: string | undefined;
  const converseMsgs: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
    } else {
      converseMsgs.push({
        role: msg.role as 'user' | 'assistant',
        content: [{ text: msg.content } as ContentBlock],
      });
    }
  }

  return { system, converseMsgs };
}

export async function llmInvoke(
  messages: LLMMessage[],
  tier: ModelTier = 'fast',
  modelOverride?: string,
  feature: string = 'unknown',
): Promise<{ text: string; usage: TokenUsage; costUsd: number; modelId: string }> {
  const modelId = modelOverride || MODEL_TIERS[tier];
  const { system, converseMsgs } = toLLMMessages(messages);

  const command = new ConverseCommand({
    modelId,
    messages: converseMsgs,
    ...(system ? { system: [{ text: system }] } : {}),
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.3,
    },
  });

  const response = await getClient().send(command);

  const usage: TokenUsage = {
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
  };
  const costUsd = calculateCost(modelId, usage.inputTokens, usage.outputTokens);

  // Track cost
  await costTracker.record(modelId, usage, costUsd, feature);

  const text = response.output?.message?.content?.[0]?.text ?? '';

  return { text, usage, costUsd, modelId };
}

export async function loadModelOverrides() {
  // Dynamically import db to avoid circular deps
  const { db } = await import('../db.js');
  const settings = await db.settings.findMany({
    where: { key: { in: ['model_fast', 'model_reasoning', 'model_deep'] } },
  });
  for (const s of settings) {
    if (s.value) {
      const tier = s.key.replace('model_', '') as keyof typeof MODEL_TIERS;
      if (tier in MODEL_TIERS) {
        MODEL_TIERS[tier] = s.value;
        console.log(`[llm] model override: ${tier} → ${s.value}`);
      }
    }
  }
}

export async function* llmStream(
  messages: LLMMessage[],
  tier: ModelTier = 'fast',
  modelOverride?: string,
  feature: string = 'unknown',
): AsyncGenerator<{ type: 'chunk'; text: string } | { type: 'done'; usage: TokenUsage; costUsd: number; modelId: string }> {
  const modelId = modelOverride || MODEL_TIERS[tier];
  const { system, converseMsgs } = toLLMMessages(messages);

  const command = new ConverseStreamCommand({
    modelId,
    messages: converseMsgs,
    ...(system ? { system: [{ text: system }] } : {}),
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.3,
    },
  });

  const response = await getClient().send(command);

  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  if (response.stream) {
    for await (const event of response.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        yield { type: 'chunk', text: event.contentBlockDelta.delta.text };
      }
      if (event.metadata?.usage) {
        usage = {
          inputTokens: event.metadata.usage.inputTokens ?? 0,
          outputTokens: event.metadata.usage.outputTokens ?? 0,
        };
      }
    }
  }

  const costUsd = calculateCost(modelId, usage.inputTokens, usage.outputTokens);
  await costTracker.record(modelId, usage, costUsd, feature);

  yield { type: 'done', usage, costUsd, modelId };
}
