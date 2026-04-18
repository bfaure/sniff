import * as http from 'http';
import * as https from 'https';
import { db } from '../db.js';
import { wsHub } from '../ws/hub.js';
import type { FuzzerJobStatus } from '@sniff/shared';

interface TemplateReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

interface RunningJob {
  id: string;
  status: FuzzerJobStatus;
  abortControllers: AbortController[];
}

const PLACEHOLDER = '§';

function applyPayloads(template: TemplateReq, positions: string[], payloads: string[]): TemplateReq {
  let url = template.url;
  let body = template.body;
  const headers = { ...template.headers };

  for (let i = 0; i < positions.length; i++) {
    const marker = `${PLACEHOLDER}${positions[i]}${PLACEHOLDER}`;
    const value = payloads[i] ?? '';
    url = url.replaceAll(marker, value);
    if (body) body = body.replaceAll(marker, value);
    for (const [k, v] of Object.entries(headers)) {
      headers[k] = v.replaceAll(marker, value);
    }
  }

  return { method: template.method, url, headers, body };
}

function generatePayloadCombinations(
  attackType: string,
  payloadLists: string[][],
  positions: string[],
): string[][] {
  switch (attackType) {
    case 'single': {
      // One position at a time, iterate through its payloads
      const combos: string[][] = [];
      for (let posIdx = 0; posIdx < positions.length; posIdx++) {
        for (const payload of payloadLists[0] || []) {
          const row = positions.map((_, i) => (i === posIdx ? payload : ''));
          combos.push(row);
        }
      }
      return combos;
    }

    case 'parallel': {
      // Same payload in all positions simultaneously
      const combos: string[][] = [];
      for (const payload of payloadLists[0] || []) {
        combos.push(positions.map(() => payload));
      }
      return combos;
    }

    case 'paired': {
      // Parallel iteration — zip payload lists
      const maxLen = Math.max(...payloadLists.map((l) => l.length), 0);
      const combos: string[][] = [];
      for (let i = 0; i < maxLen; i++) {
        combos.push(positions.map((_, posIdx) => (payloadLists[posIdx] || [])[i] || ''));
      }
      return combos;
    }

    case 'cartesian': {
      // Cartesian product of all payload lists
      const combos: string[][] = [];
      const lists = positions.map((_, i) => payloadLists[i] || ['']);

      function recurse(depth: number, current: string[]) {
        if (depth === lists.length) {
          combos.push([...current]);
          return;
        }
        for (const val of lists[depth]) {
          current.push(val);
          recurse(depth + 1, current);
          current.pop();
        }
      }
      recurse(0, []);
      return combos;
    }

    default:
      return [];
  }
}

async function sendRequest(req: TemplateReq, signal?: AbortSignal): Promise<{
  statusCode: number;
  responseSize: number;
  duration: number;
  responseBody: Buffer;
}> {
  const parsedUrl = new URL(req.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const outReq = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: req.headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 0,
            responseSize: body.length,
            duration: Date.now() - startTime,
            responseBody: body,
          });
        });
      },
    );

    if (signal) {
      signal.addEventListener('abort', () => outReq.destroy(new Error('Aborted')));
    }

    outReq.on('error', reject);
    outReq.setTimeout(30000, () => outReq.destroy(new Error('Timeout')));

    if (req.body) {
      outReq.end(req.body);
    } else {
      outReq.end();
    }
  });
}

// Simple heuristic: flag results that differ significantly from baseline
function isInteresting(statusCode: number, responseSize: number, baselineStatus?: number, baselineSize?: number): boolean {
  if (!baselineStatus) return false;
  if (statusCode !== baselineStatus) return true;
  if (baselineSize && Math.abs(responseSize - baselineSize) > baselineSize * 0.1) return true;
  return false;
}

class FuzzerEngine {
  private jobs = new Map<string, RunningJob>();

  async createJob(data: {
    name: string;
    attackType: string;
    templateReq: TemplateReq;
    payloadPositions: string[];
    payloads: string[][];
    concurrency?: number;
    throttleMs?: number;
  }) {
    const combos = generatePayloadCombinations(data.attackType, data.payloads, data.payloadPositions);

    const job = await db.fuzzerJob.create({
      data: {
        name: data.name,
        attackType: data.attackType,
        templateReq: JSON.stringify(data.templateReq),
        payloads: JSON.stringify(data.payloads),
        status: 'pending',
        total: combos.length,
        concurrency: data.concurrency || 10,
        throttleMs: data.throttleMs || 0,
      },
    });

    return { job, totalCombinations: combos.length };
  }

  async startJob(jobId: string) {
    const job = await db.fuzzerJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error('Job not found');

    const template: TemplateReq = JSON.parse(job.templateReq);
    const payloadLists: string[][] = JSON.parse(job.payloads);

    // We need positions — extract from template by finding §markers§
    const positions = this.extractPositions(template);
    const combos = generatePayloadCombinations(job.attackType, payloadLists, positions);

    await db.fuzzerJob.update({
      where: { id: jobId },
      data: { status: 'running', total: combos.length },
    });

    const running: RunningJob = { id: jobId, status: 'running' as FuzzerJobStatus, abortControllers: [] };
    this.jobs.set(jobId, running);

    // Run in background
    this.executeJob(running, template, positions, combos, job.concurrency, job.throttleMs);

    return { status: 'running', total: combos.length };
  }

  private extractPositions(template: TemplateReq): string[] {
    const regex = new RegExp(`${PLACEHOLDER}([^${PLACEHOLDER}]+)${PLACEHOLDER}`, 'g');
    const positions: string[] = [];
    const text = `${template.url} ${template.body || ''} ${Object.values(template.headers).join(' ')}`;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (!positions.includes(match[1])) {
        positions.push(match[1]);
      }
    }
    return positions;
  }

  private async executeJob(
    running: RunningJob,
    template: TemplateReq,
    positions: string[],
    combos: string[][],
    concurrency: number,
    throttleMs: number,
  ) {
    let completed = 0;
    let baselineStatus: number | undefined;
    let baselineSize: number | undefined;

    // Process in batches of `concurrency`
    for (let i = 0; i < combos.length; i += concurrency) {
      if ((running.status as string) === 'cancelled') break;
      while ((running.status as string) === 'paused') {
        await new Promise((r) => setTimeout(r, 500));
      }
      if ((running.status as string) === 'cancelled') break;

      const batch = combos.slice(i, i + concurrency);
      const promises = batch.map(async (payloads) => {
        const req = applyPayloads(template, positions, payloads);
        const ac = new AbortController();
        running.abortControllers.push(ac);

        try {
          const result = await sendRequest(req, ac.signal);

          // Set baseline from first result
          if (baselineStatus === undefined) {
            baselineStatus = result.statusCode;
            baselineSize = result.responseSize;
          }

          const interesting = isInteresting(result.statusCode, result.responseSize, baselineStatus, baselineSize);

          const saved = await db.fuzzerResult.create({
            data: {
              jobId: running.id,
              payloads: JSON.stringify(payloads),
              statusCode: result.statusCode,
              responseSize: result.responseSize,
              duration: result.duration,
              responseBody: new Uint8Array(result.responseBody),
              interesting,
            },
          });

          wsHub.broadcast({
            type: 'fuzzer:result',
            data: {
              id: saved.id,
              jobId: running.id,
              payloads,
              statusCode: result.statusCode,
              responseSize: result.responseSize,
              duration: result.duration,
              interesting,
            },
          });
        } catch {
          // Request failed — record as 0 status
          await db.fuzzerResult.create({
            data: {
              jobId: running.id,
              payloads: JSON.stringify(payloads),
              statusCode: 0,
              responseSize: 0,
              duration: 0,
              interesting: false,
            },
          });
        }
      });

      await Promise.all(promises);
      completed += batch.length;

      await db.fuzzerJob.update({
        where: { id: running.id },
        data: { progress: completed },
      });

      wsHub.broadcast({
        type: 'fuzzer:progress',
        data: { jobId: running.id, completed, total: combos.length },
      });

      if (throttleMs > 0) {
        await new Promise((r) => setTimeout(r, throttleMs));
      }
    }

    const finalStatus = running.status === 'cancelled' ? 'cancelled' : 'done';
    await db.fuzzerJob.update({
      where: { id: running.id },
      data: { status: finalStatus, progress: completed },
    });
    this.jobs.delete(running.id);
  }

  async pauseJob(jobId: string) {
    const running = this.jobs.get(jobId);
    if (running) running.status = 'paused';
    await db.fuzzerJob.update({ where: { id: jobId }, data: { status: 'paused' } });
  }

  async resumeJob(jobId: string) {
    const running = this.jobs.get(jobId);
    if (running) running.status = 'running';
    await db.fuzzerJob.update({ where: { id: jobId }, data: { status: 'running' } });
  }

  async cancelJob(jobId: string) {
    const running = this.jobs.get(jobId);
    if (running) {
      running.status = 'cancelled';
      running.abortControllers.forEach((ac) => ac.abort());
    }
    await db.fuzzerJob.update({ where: { id: jobId }, data: { status: 'cancelled' } });
  }
}

export const fuzzerEngine = new FuzzerEngine();
