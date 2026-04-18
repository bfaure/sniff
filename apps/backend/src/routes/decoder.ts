import type { FastifyInstance } from 'fastify';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { llmInvoke } from '../llm/client.js';
import type { LLMMessage } from '@sniff/shared';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

type TransformType = 'base64' | 'url' | 'html' | 'hex' | 'unicode' | 'jwt' | 'gzip';

interface TransformOp {
  type: TransformType;
  direction: 'encode' | 'decode';
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const REVERSE_HTML_ENTITIES: Record<string, string> = Object.fromEntries(
  Object.entries(HTML_ENTITIES).map(([k, v]) => [v, k]),
);

async function applyTransform(input: string, op: TransformOp): Promise<string> {
  switch (op.type) {
    case 'base64':
      return op.direction === 'encode'
        ? Buffer.from(input, 'utf-8').toString('base64')
        : Buffer.from(input, 'base64').toString('utf-8');

    case 'url':
      return op.direction === 'encode'
        ? encodeURIComponent(input)
        : decodeURIComponent(input);

    case 'html':
      if (op.direction === 'encode') {
        return input.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] || c);
      }
      return input.replace(/&(amp|lt|gt|quot|#39);/g, (m) => REVERSE_HTML_ENTITIES[m] || m);

    case 'hex':
      if (op.direction === 'encode') {
        return Buffer.from(input, 'utf-8').toString('hex');
      }
      return Buffer.from(input, 'hex').toString('utf-8');

    case 'unicode':
      if (op.direction === 'encode') {
        return Array.from(input)
          .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
          .join('');
      }
      return input.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );

    case 'jwt': {
      if (op.direction === 'decode') {
        const parts = input.split('.');
        if (parts.length < 2) return 'Invalid JWT';
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        return JSON.stringify({ header, payload }, null, 2);
      }
      return input; // Encoding JWTs requires signing, not supported here
    }

    case 'gzip':
      if (op.direction === 'encode') {
        const compressed = await gzip(Buffer.from(input, 'utf-8'));
        return compressed.toString('base64');
      }
      const decompressed = await gunzip(Buffer.from(input, 'base64'));
      return decompressed.toString('utf-8');

    default:
      return input;
  }
}

export function decoderRoutes(fastify: FastifyInstance): void {
  fastify.post('/api/decoder/transform', async (req, reply) => {
    const { input, operations } = req.body as {
      input: string;
      operations: TransformOp[];
    };

    let result = input;
    const steps: string[] = [input];

    try {
      for (const op of operations) {
        result = await applyTransform(result, op);
        steps.push(result);
      }
      return reply.send({ result, steps });
    } catch (err) {
      return reply.code(400).send({
        error: `Transform failed: ${(err as Error).message}`,
      });
    }
  });

  // LLM-powered encoding/format suggestion
  fastify.post('/api/decoder/suggest', async (req, reply) => {
    const { input } = req.body as { input: string };
    if (!input || !input.trim()) {
      return reply.code(400).send({ error: 'Input is required' });
    }

    const truncated = input.length > 4000 ? input.slice(0, 4000) + '... [truncated]' : input;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are an expert in data encoding, cryptography, and serialization formats. Given an encoded or obfuscated string, identify what encoding(s) or format(s) it uses. Consider all possibilities including layered/nested encodings.

Respond with a JSON object (no markdown fences) in this exact format:
{
  "suggestions": [
    {
      "format": "short name of the encoding/format",
      "confidence": "high|medium|low",
      "explanation": "why you think this is the format, citing specific patterns",
      "decodingSteps": ["step 1 description", "step 2 if nested", ...]
    }
  ],
  "rawAnalysis": "brief overall analysis of the string's characteristics"
}

Common encodings to consider: Base64, Base64url, URL encoding (percent-encoding), HTML entities, Hex encoding, Unicode escapes, JWT, gzip+base64, ASCII85, Base32, ROT13, XOR, binary, octal, serialized objects (Java, PHP, Python pickle), Protocol Buffers, MessagePack, BSON, regex, cron expression, UUID, hash (MD5, SHA1, SHA256), RSA/PGP public key, certificate (PEM/DER), SAML, XML, JSON (possibly encoded), CSV, YAML, INI, SQL, shell command, MIME/quoted-printable, uuencode.

Also consider multi-layer encodings (e.g., base64-encoded URL-encoded string, double URL encoding, hex-encoded base64).`,
      },
      {
        role: 'user',
        content: `Analyze this string and suggest what encoding(s) or format(s) it might be:\n\n${truncated}`,
      },
    ];

    try {
      const result = await llmInvoke(messages, 'fast');
      let parsed;
      try {
        const cleaned = result.text.replace(/```(?:json)?\s*\n?/g, '').replace(/```\s*$/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = {
          suggestions: [{ format: 'Unknown', confidence: 'low', explanation: result.text, decodingSteps: [] }],
          rawAnalysis: result.text,
        };
      }

      return reply.send({
        ...parsed,
        modelId: result.modelId,
        costUsd: result.costUsd,
      });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
