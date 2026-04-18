import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { initBedrockClient, loadModelOverrides } from '../llm/client.js';
import { autoAnalyzer } from '../llm/auto-analyzer.js';

// Settings keys that are treated as sensitive (masked in GET responses)
const SENSITIVE_KEYS = ['bedrock_access_key_id', 'bedrock_secret_access_key'];

export function settingsRoutes(fastify: FastifyInstance) {
  // Get all settings (masks sensitive values)
  fastify.get('/api/settings', async () => {
    const rows = await db.settings.findMany();
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (SENSITIVE_KEYS.includes(row.key)) {
        result[row.key] = row.value ? '••••••••' : '';
      } else {
        result[row.key] = row.value;
      }
    }
    return result;
  });

  // Update a setting
  fastify.put('/api/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    const { value } = req.body as { value: string };

    await db.settings.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });

    // Side effects for specific settings
    if (key === 'bedrock_region' || key === 'bedrock_access_key_id' || key === 'bedrock_secret_access_key') {
      await applyBedrockCredentials();
    }
    if (key === 'daily_cost_limit') {
      autoAnalyzer.setDailyCostLimit(parseFloat(value) || 5.0);
    }

    return { key, saved: true };
  });

  // Save Bedrock credentials (batch save)
  fastify.post('/api/settings/bedrock-credentials', async (req) => {
    const { accessKeyId, secretAccessKey, region } = req.body as {
      accessKeyId?: string;
      secretAccessKey?: string;
      region?: string;
    };

    if (accessKeyId !== undefined) {
      await db.settings.upsert({
        where: { key: 'bedrock_access_key_id' },
        create: { key: 'bedrock_access_key_id', value: accessKeyId },
        update: { value: accessKeyId },
      });
    }
    if (secretAccessKey !== undefined) {
      await db.settings.upsert({
        where: { key: 'bedrock_secret_access_key' },
        create: { key: 'bedrock_secret_access_key', value: secretAccessKey },
        update: { value: secretAccessKey },
      });
    }
    if (region !== undefined) {
      await db.settings.upsert({
        where: { key: 'bedrock_region' },
        create: { key: 'bedrock_region', value: region },
        update: { value: region },
      });
    }

    await applyBedrockCredentials();
    return { saved: true };
  });

  // Test Bedrock connection
  fastify.post('/api/settings/bedrock-test', async () => {
    try {
      const { llmInvoke } = await import('../llm/client.js');
      const result = await llmInvoke(
        [{ role: 'user', content: 'Respond with just the word "connected".' }],
        'fast',
      );
      return { success: true, modelId: result.modelId, costUsd: result.costUsd };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get LLM configuration (models, cost limits, memory)
  fastify.get('/api/settings/llm-config', async () => {
    const settings = await db.settings.findMany({
      where: {
        key: {
          in: [
            'model_fast', 'model_reasoning', 'model_deep',
            'daily_cost_limit', 'escalation_enabled',
            'auto_analyzer_memory',
          ],
        },
      },
    });

    const config: Record<string, string> = {};
    for (const s of settings) {
      config[s.key] = s.value;
    }

    return {
      modelFast: config.model_fast || '',
      modelReasoning: config.model_reasoning || '',
      modelDeep: config.model_deep || '',
      dailyCostLimit: parseFloat(config.daily_cost_limit || '5'),
      escalationEnabled: config.escalation_enabled !== 'false',
      sessionMemory: autoAnalyzer.getSessionObservations(),
      persistentMemory: config.auto_analyzer_memory || '',
    };
  });

  // Save LLM configuration
  fastify.put('/api/settings/llm-config', async (req) => {
    const body = req.body as {
      modelFast?: string;
      modelReasoning?: string;
      modelDeep?: string;
      dailyCostLimit?: number;
      escalationEnabled?: boolean;
    };

    const updates: Array<{ key: string; value: string }> = [];

    if (body.modelFast !== undefined) updates.push({ key: 'model_fast', value: body.modelFast });
    if (body.modelReasoning !== undefined) updates.push({ key: 'model_reasoning', value: body.modelReasoning });
    if (body.modelDeep !== undefined) updates.push({ key: 'model_deep', value: body.modelDeep });
    if (body.dailyCostLimit !== undefined) {
      updates.push({ key: 'daily_cost_limit', value: String(body.dailyCostLimit) });
      autoAnalyzer.setDailyCostLimit(body.dailyCostLimit);
    }
    if (body.escalationEnabled !== undefined) {
      updates.push({ key: 'escalation_enabled', value: String(body.escalationEnabled) });
      autoAnalyzer.setEscalationEnabled(body.escalationEnabled);
    }

    for (const { key, value } of updates) {
      await db.settings.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }

    // Reload model overrides if any model was changed
    if (updates.some((u) => u.key.startsWith('model_'))) {
      await loadModelOverrides();
    }

    return { saved: true };
  });

  // Clear persistent LLM memory
  fastify.delete('/api/settings/llm-memory', async () => {
    await db.settings.deleteMany({ where: { key: 'auto_analyzer_memory' } });
    autoAnalyzer.clearMemory();
    return { cleared: true };
  });
}

async function applyBedrockCredentials() {
  const rows = await db.settings.findMany({
    where: {
      key: { in: ['bedrock_access_key_id', 'bedrock_secret_access_key', 'bedrock_region'] },
    },
  });

  const creds: Record<string, string> = {};
  for (const r of rows) creds[r.key] = r.value;

  const region = creds.bedrock_region || 'us-east-1';

  // If explicit credentials are provided, set them as env vars for the AWS SDK
  if (creds.bedrock_access_key_id && creds.bedrock_secret_access_key) {
    process.env.AWS_ACCESS_KEY_ID = creds.bedrock_access_key_id;
    process.env.AWS_SECRET_ACCESS_KEY = creds.bedrock_secret_access_key;
  }

  // Re-initialize the Bedrock client with the new region
  initBedrockClient(region);
}
