import { wsClient } from '../api/ws';
import { api } from '../api/client';

export interface StoredFinding {
  id: string;
  exchangeId?: string | null;
  source: 'auto-analyzer' | 'assessment' | 'on-demand' | 'manual';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  type?: string | null;
  title: string;
  detail: string;
  evidence?: string | null;
  suggestedTest?: string | null;
  method?: string | null;
  url?: string | null;
  host: string;
  categoryName?: string | null;
  owaspId?: string | null;
  cvss?: number | null;
  cvssVector?: string | null;
  escalated?: boolean;
  status: 'open' | 'confirmed' | 'false-positive' | 'fixed';
  hits: number;
  createdAt: string;
  timestamp: number;
}

type Listener = () => void;

const MAX_FINDINGS = 1000;
let findings: StoredFinding[] = [];
let lastSeenTimestamp: number = 0; // timestamp when user last viewed findings
const listeners = new Set<Listener>();

function notify() {
  for (const fn of listeners) fn();
}

function toStored(raw: any): StoredFinding {
  return {
    id: raw.id,
    exchangeId: raw.exchangeId ?? null,
    source: raw.source,
    severity: raw.severity,
    type: raw.type ?? null,
    title: raw.title,
    detail: raw.detail || '',
    evidence: raw.evidence ?? null,
    suggestedTest: raw.suggestedTest ?? null,
    method: raw.method ?? null,
    url: raw.url ?? null,
    host: raw.host,
    categoryName: raw.categoryName ?? null,
    owaspId: raw.owaspId ?? null,
    cvss: raw.cvss ?? null,
    cvssVector: raw.cvssVector ?? null,
    escalated: raw.escalated ?? false,
    status: raw.status || 'open',
    hits: raw.hits ?? 1,
    createdAt: raw.createdAt,
    timestamp: new Date(raw.createdAt).getTime(),
  };
}

let initialized = false;
let initPromise: Promise<void> | null = null;

let wsSubscribed = false;

async function init() {
  // Subscribe to WS once, regardless of API load state, so we don't miss live
  // events even if the initial load is retrying after a transient failure.
  if (!wsSubscribed) {
    wsSubscribed = true;
    wsClient.on('finding:new' as any, (data: any) => {
      const stored = toStored(data);
      findings = [stored, ...findings.filter((f) => f.id !== stored.id)].slice(0, MAX_FINDINGS);
      notify();
    });
    // Resync from the API whenever the WS reconnects (e.g. after backend restart)
    wsClient.on('__reconnect__' as any, async () => {
      try {
        const res = await api.findings.list({ limit: MAX_FINDINGS });
        findings = res.findings.map(toStored);
        initialized = true;
        notify();
      } catch { /* ignore */ }
    });
  }

  if (initialized) return initPromise ?? Promise.resolve();

  initPromise = (async () => {
    try {
      const res = await api.findings.list({ limit: MAX_FINDINGS });
      findings = res.findings.map(toStored);
      initialized = true; // only mark ready on success so retries can happen
      notify();
    } catch (err) {
      console.error('[findingsStore] failed to load findings:', err);
      initPromise = null; // allow future retries
    }
  })();
  return initPromise;
}

async function updateStatus(id: string, status: StoredFinding['status']) {
  await api.findings.update(id, { status });
  findings = findings.map((f) => (f.id === id ? { ...f, status } : f));
  notify();
}

async function deleteFinding(id: string) {
  await api.findings.delete(id);
  findings = findings.filter((f) => f.id !== id);
  notify();
}

async function clearAll() {
  await api.findings.clear();
  findings = [];
  notify();
}

function markSeen() {
  lastSeenTimestamp = Date.now();
  notify();
}

export const findingsStore = {
  init,
  getFindings: () => findings,
  subscribe: (fn: Listener): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  updateStatus,
  deleteFinding,
  clear: clearAll,
  ready: () => initPromise,
  markSeen,
  getLastSeenTimestamp: () => lastSeenTimestamp,
};
