const BASE = '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> };
  // Only set Content-Type for requests with a body
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

export const api = {
  proxy: {
    start: () => request('/api/proxy/start', { method: 'POST' }),
    stop: () => request('/api/proxy/stop', { method: 'POST' }),
    status: () => request<{ running: boolean; port: number; interceptEnabled: boolean; exchangeCount: number }>('/api/proxy/status'),
    toggleIntercept: (enabled: boolean) =>
      request('/api/proxy/intercept/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    getInterceptQueue: () => request('/api/proxy/intercept/queue'),
    forward: (id: string, modified?: { headers?: Record<string, string | string[]>; body?: string | null }) =>
      request(`/api/proxy/intercept/${id}/forward`, {
        method: 'POST',
        body: JSON.stringify(modified || {}),
      }),
    drop: (id: string) =>
      request(`/api/proxy/intercept/${id}/drop`, { method: 'POST' }),
    forwardAll: () =>
      request('/api/proxy/intercept/forward-all', { method: 'POST' }),
  },

  history: {
    list: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ data: unknown[]; total: number; page: number; limit: number }>(`/api/history${qs}`);
    },
    get: (id: string, preview?: boolean) => request(`/api/history/${id}${preview ? '?preview=true' : ''}`),
    search: (q: string, params?: Record<string, string>) => {
      const qs = new URLSearchParams({ q, ...params }).toString();
      return request<{ data: Array<unknown & { matchField?: string }>; total: number; page: number; limit: number }>(`/api/history/search?${qs}`);
    },
    clear: () => request('/api/history', { method: 'DELETE' }),
    listFailed: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ data: Array<{ id: string; method: string; host: string; path: string; url: string; errorMessage: string; duration: number | null; timestamp: string; inScope: boolean }>; total: number; page: number; limit: number }>(`/api/history/failed${qs}`);
    },
    clearFailed: () => request('/api/history/failed', { method: 'DELETE' }),
    update: (id: string, data: { notes?: string; tags?: string[]; highlighted?: boolean }) =>
      request(`/api/history/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  replay: {
    send: (req: { method: string; url: string; headers: Record<string, string>; body: string | null }) =>
      request('/api/replay/send', {
        method: 'POST',
        body: JSON.stringify(req),
      }),
    getTabs: () =>
      request<Array<{ id: string; name: string; method: string; url: string; headers: string; body: string; sortOrder: number }>>('/api/replay/tabs'),
    createTab: (tab: { id: string; name: string; method: string; url: string; headers: string; body: string; sortOrder: number }) =>
      request<{ id: string }>('/api/replay/tabs', {
        method: 'POST',
        body: JSON.stringify(tab),
      }),
    updateTab: (id: string, data: Partial<{ name: string; method: string; url: string; headers: string; body: string; sortOrder: number }>) =>
      request('/api/replay/tabs/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    deleteTab: (id: string) =>
      request('/api/replay/tabs/' + id, { method: 'DELETE' }),
    getHistory: (tabId: string) =>
      request<Array<{ id: string; sortOrder: number; method: string; url: string; headers: string; body: string; statusCode: number | null; responseHeaders: string | null; responseBody: string | null; duration: number | null }>>(`/api/replay/tabs/${tabId}/history`),
    createHistory: (tabId: string, entry: { sortOrder: number; method: string; url: string; headers: string; body: string; statusCode?: number; responseHeaders?: string; responseBody?: string; duration?: number }) =>
      request(`/api/replay/tabs/${tabId}/history`, {
        method: 'POST',
        body: JSON.stringify(entry),
      }),
    clearHistory: (tabId: string) =>
      request(`/api/replay/tabs/${tabId}/history`, { method: 'DELETE' }),
  },

  decoder: {
    transform: (input: string, operations: Array<{ type: string; direction: string }>) =>
      request<{ result: string; steps: string[] }>('/api/decoder/transform', {
        method: 'POST',
        body: JSON.stringify({ input, operations }),
      }),
    suggest: (input: string) =>
      request<{
        suggestions: Array<{ format: string; confidence: string; explanation: string; decodingSteps: string[] }>;
        rawAnalysis: string;
        modelId: string;
        costUsd: number;
      }>('/api/decoder/suggest', {
        method: 'POST',
        body: JSON.stringify({ input }),
      }),
  },

  scope: {
    list: () => request('/api/scope/rules'),
    create: (rule: { type: string; host: string; protocol?: string; port?: number; path?: string }) =>
      request<{ id: string; pendingAnalysisCount: number }>('/api/scope/rules', {
        method: 'POST',
        body: JSON.stringify(rule),
      }),
    analyzePending: () =>
      request<{ queued: number; droppedDisabled: number; autoAnalyzeEnabled: boolean }>('/api/scope/analyze-pending', { method: 'POST' }),
    analyzePendingCount: () =>
      request<{ count: number }>('/api/scope/analyze-pending/count'),
    analyzePendingList: () =>
      request<{ exchanges: Array<{ id: string; method: string; url: string; host: string; path: string; statusCode: number | null }>; total: number }>('/api/scope/analyze-pending/list'),
    update: (id: string, data: Record<string, unknown>) =>
      request(`/api/scope/rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request(`/api/scope/rules/${id}`, { method: 'DELETE' }),
    test: (url: string) =>
      request<{ url: string; inScope: boolean }>('/api/scope/test', {
        method: 'POST',
        body: JSON.stringify({ url }),
      }),
  },

  sitemap: {
    get: (inScope?: boolean) => {
      const qs = inScope !== undefined ? `?inScope=${inScope}` : '';
      return request(`/api/sitemap${qs}`);
    },
    delete: (host: string, path?: string) => {
      const params = new URLSearchParams({ host });
      if (path) params.set('path', path);
      return request(`/api/sitemap?${params}`, { method: 'DELETE' });
    },
  },

  comparer: {
    diff: (a: string, b: string, mode?: 'line' | 'word') =>
      request('/api/comparer/diff', {
        method: 'POST',
        body: JSON.stringify({ a, b, mode }),
      }),
  },

  fuzzer: {
    createJob: (data: {
      name: string;
      attackType: string;
      templateReq: { method: string; url: string; headers: Record<string, string>; body: string | null };
      payloadPositions: string[];
      payloads: string[][];
      concurrency?: number;
      throttleMs?: number;
    }) =>
      request<{ id: string; total: number; status: string }>('/api/fuzzer/jobs', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    startJob: (id: string) =>
      request(`/api/fuzzer/jobs/${id}/start`, { method: 'POST' }),
    pauseJob: (id: string) =>
      request(`/api/fuzzer/jobs/${id}/pause`, { method: 'POST' }),
    resumeJob: (id: string) =>
      request(`/api/fuzzer/jobs/${id}/resume`, { method: 'POST' }),
    cancelJob: (id: string) =>
      request(`/api/fuzzer/jobs/${id}/cancel`, { method: 'POST' }),
    listJobs: () =>
      request<unknown[]>('/api/fuzzer/jobs'),
    getJob: (id: string) =>
      request(`/api/fuzzer/jobs/${id}`),
    getResults: (id: string, interestingOnly?: boolean) =>
      request<unknown[]>(`/api/fuzzer/jobs/${id}/results${interestingOnly ? '?interesting=true' : ''}`),
    deleteJob: (id: string) =>
      request(`/api/fuzzer/jobs/${id}`, { method: 'DELETE' }),
  },

  certificates: {
    downloadCA: () => fetch('/api/certificates/ca').then((r) => r.text()),
  },

  settings: {
    getAll: () => request<Record<string, string>>('/api/settings'),
    set: (key: string, value: string) =>
      request(`/api/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
    saveBedrockCredentials: (creds: { accessKeyId?: string; secretAccessKey?: string; region?: string }) =>
      request<{ saved: boolean }>('/api/settings/bedrock-credentials', {
        method: 'POST',
        body: JSON.stringify(creds),
      }),
    getBedrockCredentialStatus: () =>
      request<{ hasAccessKeyId: boolean; hasSecretAccessKey: boolean; region: string; accessKeyIdSuffix: string }>(
        '/api/settings/bedrock-credentials/status',
      ),
    clearBedrockCredentials: () =>
      request<{ cleared: boolean }>('/api/settings/bedrock-credentials', { method: 'DELETE' }),
    testBedrock: () =>
      request<{ success: boolean; modelId?: string; costUsd?: number; error?: string }>('/api/settings/bedrock-test', {
        method: 'POST',
      }),
    getLLMConfig: () =>
      request<{
        modelFast: string;
        modelReasoning: string;
        modelDeep: string;
        dailyCostLimit: number;
        escalationEnabled: boolean;
        sessionMemory: string;
        persistentMemory: string;
      }>('/api/settings/llm-config'),
    saveLLMConfig: (config: {
      modelFast?: string;
      modelReasoning?: string;
      modelDeep?: string;
      dailyCostLimit?: number;
      escalationEnabled?: boolean;
    }) =>
      request<{ saved: boolean }>('/api/settings/llm-config', {
        method: 'PUT',
        body: JSON.stringify(config),
      }),
    clearLLMMemory: () =>
      request<{ cleared: boolean }>('/api/settings/llm-memory', { method: 'DELETE' }),
  },

  llm: {
    analyze: (exchangeId: string, type: string, userMessage?: string) =>
      request('/api/llm/analyze', {
        method: 'POST',
        body: JSON.stringify({ exchangeId, type, userMessage }),
      }),
    analyzeStream: (exchangeId: string, type: string, streamId: string, userMessage?: string, conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>) =>
      request('/api/llm/analyze/stream', {
        method: 'POST',
        body: JSON.stringify({ exchangeId, type, streamId, userMessage, conversationHistory }),
      }),
    getAnalyses: (exchangeId: string) =>
      request<Array<{ id: string; type: string; modelId: string; response: string; inputTokens: number; outputTokens: number; costUsd: number; timestamp: string }>>(`/api/llm/analyses/${exchangeId}`),
    getCosts: () =>
      request<{ sessionTotal: number; dailyTotal: number; allTimeTotal: number }>('/api/llm/costs'),
    getCostBreakdown: (scope: 'session' | 'daily' | 'all-time' = 'daily') =>
      request<Array<{ feature: string; costUsd: number; calls: number }>>(`/api/llm/costs/breakdown?scope=${scope}`),
    toggleAutoAnalyze: (enabled: boolean) =>
      request<{ enabled: boolean }>('/api/llm/auto-analyze/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    getAutoAnalyzeStatus: () =>
      request<{ enabled: boolean; dailyCost: number; scopeMode: 'all' | 'in-scope' }>('/api/llm/auto-analyze/status'),
    getAnalyzeQueue: () =>
      request<{
        current: { id: string; method: string; url: string; host: string; path: string; statusCode: number | null } | null;
        queued: Array<{ id: string; method: string; url: string; host: string; path: string; statusCode: number | null }>;
      }>('/api/llm/auto-analyze/queue'),
    setAIScopeMode: (mode: 'all' | 'in-scope') =>
      request<{ scopeMode: string }>('/api/llm/auto-analyze/scope-mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
    getAssessmentCategories: () =>
      request<Array<{ id: string; name: string; owaspId?: string; description: string }>>('/api/llm/assessment/categories'),
    startAssessment: (host: string, pathPrefix?: string) =>
      request<{ assessmentId: string; host: string; pathPrefix: string | null; status: string }>('/api/llm/assessment/start', {
        method: 'POST',
        body: JSON.stringify({ host, ...(pathPrefix ? { pathPrefix } : {}) }),
      }),
    cancelAssessment: (assessmentId: string) =>
      request<{ cancelled: boolean }>('/api/llm/assessment/cancel', {
        method: 'POST',
        body: JSON.stringify({ assessmentId }),
      }),
    projectChatStream: (userMessage: string, streamId: string, conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>, exchangeIds?: string[]) =>
      request('/api/llm/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ userMessage, streamId, conversationHistory, exchangeIds }),
      }),
    chainAnalysisStream: (host: string, streamId: string) =>
      request<{ status: string; streamId: string; findingCount?: number }>('/api/llm/chain-analysis/stream', {
        method: 'POST',
        body: JSON.stringify({ host, streamId }),
      }),
    guidedTestStream: (
      vulnType: string | undefined,
      exchange: {
        method: string;
        url: string;
        requestHeaders: Record<string, string>;
        requestBody: string | null;
        statusCode: number | null;
        responseHeaders: Record<string, string> | null;
        responseBody: string | null;
      },
      streamId: string,
      userMessage?: string,
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
    ) =>
      request('/api/llm/guided-test/stream', {
        method: 'POST',
        body: JSON.stringify({ vulnType, exchange, streamId, userMessage, conversationHistory }),
      }),
    getRAGStatus: () =>
      request<{ ready: boolean; documentCount: number }>('/api/llm/rag/status'),
    rebuildRAGIndex: () =>
      request('/api/llm/rag/rebuild', { method: 'POST' }),
    clearRAGIndex: () =>
      request<{ cleared: boolean }>('/api/llm/rag/clear', { method: 'POST' }),
  },

  findings: {
    list: (filters?: { host?: string; severity?: string; status?: string; source?: string; limit?: number }) => {
      const qs = filters
        ? '?' + new URLSearchParams(
            Object.entries(filters)
              .filter(([, v]) => v !== undefined && v !== null && v !== '')
              .map(([k, v]) => [k, String(v)])
          ).toString()
        : '';
      return request<{ findings: Array<any>; total: number }>(`/api/findings${qs}`);
    },
    get: (id: string) => request<any>(`/api/findings/${id}`),
    update: (id: string, data: { status?: string; detail?: string; severity?: string }) =>
      request<any>(`/api/findings/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/api/findings/${id}`, { method: 'DELETE' }),
    retest: (id: string) =>
      request<{ stillPresent: boolean | null; inconclusive?: boolean; replayStatus: number; finding?: any }>(`/api/findings/${id}/retest`, { method: 'POST' }),
    clear: () =>
      request<{ deleted: number }>('/api/findings', { method: 'DELETE' }),
  },

  noiseFilters: {
    list: () =>
      request<Array<{ id: string; pattern: string; host: string; method: string; shape: string; hitsTotal: number; reason: string; enabled: boolean; createdAt: string }>>('/api/noise-filters'),
    toggle: (id: string, enabled: boolean) =>
      request(`/api/noise-filters/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    remove: (id: string) =>
      request<{ deleted: boolean }>(`/api/noise-filters/${id}`, { method: 'DELETE' }),
    add: (host: string, method: string, shape: string) =>
      request('/api/noise-filters', { method: 'POST', body: JSON.stringify({ host, method, shape }) }),
    clearAuto: () =>
      request<{ deleted: number }>('/api/noise-filters/auto', { method: 'DELETE' }),
  },

  projects: {
    list: () =>
      request<{
        projects: Array<{ id: string; name: string; description: string; createdAt: string; updatedAt: string }>;
        active: { id: string | null; name: string | null };
      }>('/api/projects'),
    saveAs: (name: string, description?: string) =>
      request<{ id: string; name: string }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      }),
    save: () =>
      request<{ saved: boolean }>('/api/projects/save', { method: 'POST' }),
    open: (id: string) =>
      request<{ id: string; name: string }>(`/api/projects/${id}/open`, { method: 'POST' }),
    newProject: () =>
      request<{ status: string }>('/api/projects/new', { method: 'POST' }),
    rename: (id: string, name: string, description?: string) =>
      request(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description }),
      }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  },
};
