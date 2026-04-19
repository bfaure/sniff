import type { ExchangeSummary, InterceptedItem, ProxyStatus } from './proxy.js';
import type { FuzzerResultData } from './fuzzer.js';

// All WebSocket events as a discriminated union
export type WSEvent =
  | { type: 'traffic:new'; data: ExchangeSummary }
  | { type: 'traffic:update'; data: { id: string; statusCode: number; responseSize: number; duration: number } }
  | { type: 'intercept:new'; data: InterceptedItem }
  | { type: 'intercept:resolved'; data: { id: string } }
  | { type: 'fuzzer:progress'; data: { jobId: string; completed: number; total: number } }
  | { type: 'fuzzer:result'; data: FuzzerResultData }
  | { type: 'llm:chunk'; data: { streamId: string; text: string } }
  | { type: 'llm:done'; data: { streamId: string; modelId: string; inputTokens: number; outputTokens: number; costUsd: number; error?: string; errorCode?: string } }
  | { type: 'llm:finding'; data: { exchangeId: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'info'; title: string; detail: string; method: string; url: string; escalated?: boolean } }
  | { type: 'finding:new'; data: {
      id: string;
      exchangeId: string | null;
      host: string;
      source: 'auto-analyzer' | 'assessment' | 'on-demand' | 'manual';
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      type: string | null;
      title: string;
      detail: string;
      evidence: string | null;
      suggestedTest: string | null;
      method: string | null;
      url: string | null;
      categoryName: string | null;
      owaspId: string | null;
      cvss: number | null;
      cvssVector: string | null;
      escalated: boolean;
      status: string;
      hits: number;
      createdAt: string;
    }}
  | { type: 'assessment:progress'; data: {
      assessmentId: string;
      host: string;
      pathPrefix?: string | null;
      currentCategory: string;
      currentCategoryIndex: number;
      totalCategories: number;
      findings: Array<{
        categoryId: string;
        categoryName: string;
        owaspId?: string;
        severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
        title: string;
        evidence: string;
        explanation: string;
        suggestedTest: string | null;
      }>;
      status: 'running' | 'done' | 'error';
      totalCost: number;
      error?: string;
    }}
  | { type: 'analyzer:activity'; data: {
      event: 'queued' | 'analyzing' | 'skipped' | 'done' | 'finding' | 'escalating' | 'deep-start' | 'deep-done' | 'error' | 'cost-cap';
      exchangeId?: string;
      method?: string;
      url?: string;
      message: string;
      costUsd?: number;
      dailyCost?: number;
      queueLength?: number;
      observations?: string;
      timestamp: number;
    }}
  | { type: 'proxy:status'; data: ProxyStatus }
  | { type: 'cost:update'; data: { sessionTotal: number } };

export type WSEventType = WSEvent['type'];

// Helper to extract data type for a given event type
export type WSEventData<T extends WSEventType> = Extract<WSEvent, { type: T }>['data'];
