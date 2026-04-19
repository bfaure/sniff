import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { PillToggle } from '../components/shared/PillToggle';
import { useTheme } from '../hooks/useTheme';
import { AVAILABLE_MODELS, DEFAULT_MODEL_TIERS } from '@sniff/shared';

export function SettingsPage() {
  const { theme, setTheme, fontSize, setFontSize, fontSizes } = useTheme();
  const [proxyPort, setProxyPort] = useState('8080');

  // Bedrock credentials
  const [bedrockKeyId, setBedrockKeyId] = useState('');
  const [bedrockSecret, setBedrockSecret] = useState('');
  const [bedrockRegion, setBedrockRegion] = useState('us-east-1');
  const [credentialStatus, setCredentialStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState('');

  // LLM config
  const [modelFast, setModelFast] = useState('');
  const [modelReasoning, setModelReasoning] = useState('');
  const [modelDeep, setModelDeep] = useState('');
  const [dailyCostLimit, setDailyCostLimit] = useState('5.00');
  const [escalationEnabled, setEscalationEnabled] = useState(true);
  const [llmConfigStatus, setLLMConfigStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Memory
  const [sessionMemory, setSessionMemory] = useState('');
  const [persistentMemory, setPersistentMemory] = useState('');

  // Cost
  const [costs, setCosts] = useState<{ sessionTotal: number; dailyTotal: number; allTimeTotal: number } | null>(null);
  const [costBreakdown, setCostBreakdown] = useState<Array<{ feature: string; costUsd: number; calls: number }>>([]);
  const [breakdownScope, setBreakdownScope] = useState<'daily' | 'all-time'>('daily');

  // RAG
  const [ragStatus, setRagStatus] = useState<{ ready: boolean; documentCount: number } | null>(null);
  const [ragRebuilding, setRagRebuilding] = useState(false);

  // Noise filters
  const [noiseFilters, setNoiseFilters] = useState<Array<{ id: string; pattern: string; host: string; method: string; shape: string; hitsTotal: number; reason: string; enabled: boolean; createdAt: string }>>([]);

  // "Set me up" IAM tutorial modal
  const [setupOpen, setSetupOpen] = useState(false);

  // Saved-credential status (separate from the form state so we can show
  // "saved ending in ...ABCD" and offer a Clear button).
  const [credStatus, setCredStatus] = useState<{ hasAccessKeyId: boolean; hasSecretAccessKey: boolean; accessKeyIdSuffix: string } | null>(null);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
    loadCosts();
    loadRAGStatus();
    loadNoiseFilters();
    loadCredStatus();
  }, []);

  const loadCredStatus = async () => {
    try {
      const s = await api.settings.getBedrockCredentialStatus();
      setCredStatus({ hasAccessKeyId: s.hasAccessKeyId, hasSecretAccessKey: s.hasSecretAccessKey, accessKeyIdSuffix: s.accessKeyIdSuffix });
      if (s.region) setBedrockRegion(s.region);
    } catch { /* not critical */ }
  };

  const clearCredentials = async () => {
    if (!confirm('Remove saved AWS Bedrock credentials? You can re-enter them any time.')) return;
    try {
      await api.settings.clearBedrockCredentials();
      setBedrockKeyId('');
      setBedrockSecret('');
      setCredStatus({ hasAccessKeyId: false, hasSecretAccessKey: false, accessKeyIdSuffix: '' });
    } catch { /* swallow */ }
  };

  const loadNoiseFilters = async () => {
    try {
      const data = await api.noiseFilters.list();
      setNoiseFilters(data);
    } catch { /* not critical */ }
  };

  const loadRAGStatus = async () => {
    try {
      const status = await api.llm.getRAGStatus();
      setRagStatus(status);
    } catch { /* not critical */ }
  };

  const loadSettings = async () => {
    try {
      const [allSettings, llmConfig] = await Promise.all([
        api.settings.getAll(),
        api.settings.getLLMConfig(),
      ]);

      // Region is non-sensitive; the saved-credential indicator handles
      // showing whether a key/secret exist (don't pre-fill bullet chars).
      if (allSettings.bedrock_region) setBedrockRegion(allSettings.bedrock_region);

      // LLM config
      if (llmConfig.modelFast) setModelFast(llmConfig.modelFast);
      if (llmConfig.modelReasoning) setModelReasoning(llmConfig.modelReasoning);
      if (llmConfig.modelDeep) setModelDeep(llmConfig.modelDeep);
      setDailyCostLimit(String(llmConfig.dailyCostLimit));
      setEscalationEnabled(llmConfig.escalationEnabled);
      setSessionMemory(llmConfig.sessionMemory);
      setPersistentMemory(llmConfig.persistentMemory);
    } catch {
      // Settings may not exist yet
    }
  };

  const loadCosts = async () => {
    try {
      const [data, breakdown] = await Promise.all([
        api.llm.getCosts(),
        api.llm.getCostBreakdown(breakdownScope),
      ]);
      setCosts(data);
      setCostBreakdown(breakdown);
    } catch {
      // Not critical
    }
  };

  useEffect(() => {
    api.llm.getCostBreakdown(breakdownScope).then(setCostBreakdown).catch(() => {});
  }, [breakdownScope]);

  // Persist any freshly-typed credentials from the form. Returns true if
  // something was saved (or already on file), false if the form is empty.
  const persistFormCredentials = async (): Promise<boolean> => {
    const creds: { accessKeyId?: string; secretAccessKey?: string; region?: string } = {
      region: bedrockRegion,
    };
    // Only send credentials if they're not the masked placeholder
    if (bedrockKeyId && bedrockKeyId !== '••••••••') creds.accessKeyId = bedrockKeyId;
    if (bedrockSecret && bedrockSecret !== '••••••••') creds.secretAccessKey = bedrockSecret;

    await api.settings.saveBedrockCredentials(creds);
    await loadCredStatus();
    return Boolean(creds.accessKeyId || creds.secretAccessKey || credStatus?.hasAccessKeyId);
  };

  const saveCredentials = async () => {
    setCredentialStatus('saving');
    try {
      await persistFormCredentials();
      setCredentialStatus('saved');
      setTimeout(() => setCredentialStatus('idle'), 2000);
    } catch {
      setCredentialStatus('error');
    }
  };

  const testConnection = async () => {
    setTestStatus('testing');
    setTestError('');
    try {
      // If the user typed creds but hasn't clicked Save, persist them first so
      // the backend actually has something to test with. Otherwise we'd test
      // with whatever was already on file (or nothing, which is confusing).
      await persistFormCredentials();

      const result = await api.settings.testBedrock();
      if (result.success) {
        setTestStatus('success');
        setTimeout(() => setTestStatus('idle'), 3000);
      } else {
        setTestStatus('error');
        setTestError(result.error || 'Connection failed');
      }
    } catch (err) {
      setTestStatus('error');
      setTestError((err as Error).message);
    }
  };

  const saveLLMConfig = async () => {
    setLLMConfigStatus('saving');
    try {
      await api.settings.saveLLMConfig({
        modelFast: modelFast || undefined,
        modelReasoning: modelReasoning || undefined,
        modelDeep: modelDeep || undefined,
        dailyCostLimit: parseFloat(dailyCostLimit) || 5.0,
        escalationEnabled,
      });
      setLLMConfigStatus('saved');
      setTimeout(() => setLLMConfigStatus('idle'), 2000);
    } catch {
      setLLMConfigStatus('idle');
    }
  };

  const clearMemory = async () => {
    await api.settings.clearLLMMemory();
    setSessionMemory('');
    setPersistentMemory('');
  };

  return (
    <div className="h-full overflow-auto p-6 max-w-2xl">
      <h2 className="text-lg font-bold text-gray-300 mb-6">Settings</h2>

      {/* Appearance */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Appearance</h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 w-16">Theme</span>
            <div className="flex rounded overflow-hidden border border-gray-700">
              <button
                onClick={() => setTheme('dark')}
                className={`px-3 py-1 text-xs ${theme === 'dark' ? 'bg-gray-700 text-gray-200' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}
              >
                Dark
              </button>
              <button
                onClick={() => setTheme('light')}
                className={`px-3 py-1 text-xs ${theme === 'light' ? 'bg-gray-700 text-gray-200' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}
              >
                Light
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 w-16">Font Size</span>
            <div className="flex rounded overflow-hidden border border-gray-700">
              {fontSizes.map((size) => (
                <button
                  key={size}
                  onClick={() => setFontSize(size)}
                  className={`px-2.5 py-1 text-xs ${fontSize === size ? 'bg-gray-700 text-gray-200' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}
                >
                  {size}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-gray-600">px</span>
          </div>
        </div>
      </section>

      {/* Proxy settings */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Proxy</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Listen Port</label>
            <input
              type="number"
              value={proxyPort}
              onChange={(e) => setProxyPort(e.target.value)}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-32 focus:outline-none focus:border-emerald-600"
            />
          </div>
        </div>
      </section>

      {/* LLM Credentials */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">LLM — AWS Bedrock</h3>
          <button
            onClick={() => setSetupOpen(true)}
            className="px-3 py-1 rounded text-xs bg-blue-700 hover:bg-blue-600 text-white font-medium"
          >
            Set me up
          </button>
        </div>
        <p className="text-xs text-gray-600 mb-3">
          Provide AWS credentials with Bedrock access, or leave blank to use the default credential chain (~/.aws/credentials, IAM role, etc.)
        </p>
        <div className="space-y-3">
          {credStatus?.hasAccessKeyId && (
            <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded px-3 py-2 text-xs">
              <span className="text-emerald-400">●</span>
              <span className="text-gray-400">
                Saved credentials on file
                {credStatus.accessKeyIdSuffix && (
                  <span className="text-gray-500 font-mono"> (key ID …{credStatus.accessKeyIdSuffix})</span>
                )}
              </span>
              <button
                onClick={clearCredentials}
                className="ml-auto px-2 py-0.5 rounded bg-red-900 hover:bg-red-800 text-red-300 text-[11px]"
              >
                Clear
              </button>
            </div>
          )}
          <div>
            <label className="text-xs text-gray-500 block mb-1">Access Key ID</label>
            <input
              type="password"
              value={bedrockKeyId}
              onChange={(e) => setBedrockKeyId(e.target.value)}
              onFocus={() => { if (bedrockKeyId === '••••••••') setBedrockKeyId(''); }}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-80 font-mono focus:outline-none focus:border-emerald-600"
              placeholder={credStatus?.hasAccessKeyId ? 'Leave blank to keep existing key' : 'AKIA...'}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Secret Access Key</label>
            <input
              type="password"
              value={bedrockSecret}
              onChange={(e) => setBedrockSecret(e.target.value)}
              onFocus={() => { if (bedrockSecret === '••••••••') setBedrockSecret(''); }}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-80 font-mono focus:outline-none focus:border-emerald-600"
              placeholder={credStatus?.hasSecretAccessKey ? 'Leave blank to keep existing secret' : 'wJalr...'}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Region</label>
            <select
              value={bedrockRegion}
              onChange={(e) => setBedrockRegion(e.target.value)}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300"
            >
              <option value="us-east-1">us-east-1</option>
              <option value="us-west-2">us-west-2</option>
              <option value="eu-west-1">eu-west-1</option>
              <option value="ap-northeast-1">ap-northeast-1</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={saveCredentials}
              disabled={credentialStatus === 'saving'}
              className="px-4 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-50"
            >
              {credentialStatus === 'saving' ? 'Saving...' : credentialStatus === 'saved' ? 'Saved!' : 'Save Credentials'}
            </button>
            <button
              onClick={testConnection}
              disabled={testStatus === 'testing'}
              className="px-4 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 font-medium disabled:opacity-50"
            >
              {testStatus === 'testing' ? 'Testing...' : testStatus === 'success' ? 'Connected!' : 'Test Connection'}
            </button>
          </div>
          {testStatus === 'error' && (
            <p className="text-xs text-red-400">{testError}</p>
          )}
          {testStatus === 'success' && (
            <p className="text-xs text-emerald-400">Successfully connected to AWS Bedrock</p>
          )}
        </div>
      </section>

      {/* Model Configuration */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Model Configuration</h3>
        <p className="text-xs text-gray-600 mb-3">
          Choose which models to use for each tier. The fast model handles bulk triage, the reasoning model handles vuln scanning,
          and the deep model is used when the triage model escalates something interesting.
        </p>
        <div className="space-y-3">
          <ModelSelect
            label="Fast / Triage"
            description="Used for: auto-analyze triage, explain, suggest, payloads, chat"
            value={modelFast}
            onChange={setModelFast}
            defaultModelId={DEFAULT_MODEL_TIERS.fast}
          />
          <ModelSelect
            label="Reasoning"
            description="Used for: vulnerability scanning, pentest pathway analysis"
            value={modelReasoning}
            onChange={setModelReasoning}
            defaultModelId={DEFAULT_MODEL_TIERS.reasoning}
          />
          <ModelSelect
            label="Deep / Escalation"
            description="Used when the triage model detects complex patterns and escalates"
            value={modelDeep}
            onChange={setModelDeep}
            defaultModelId={DEFAULT_MODEL_TIERS.deep}
          />

          <div className="pt-2">
            <PillToggle
              enabled={escalationEnabled}
              onChange={setEscalationEnabled}
              label="Enable Escalation"
            />
            <p className="text-xs text-gray-600 mt-1">
              When enabled, the fast triage model can escalate interesting findings to the deep model for expert analysis
            </p>
          </div>
        </div>
      </section>

      {/* Cost Management */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Cost Management</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Daily Cost Limit (USD)</label>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-sm">$</span>
              <input
                type="number"
                step="0.50"
                min="0.50"
                value={dailyCostLimit}
                onChange={(e) => setDailyCostLimit(e.target.value)}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-24 focus:outline-none focus:border-emerald-600"
              />
            </div>
            <p className="text-xs text-gray-600 mt-1">
              Auto-analysis stops when daily LLM spend reaches this limit
            </p>
          </div>

          <button
            onClick={saveLLMConfig}
            disabled={llmConfigStatus === 'saving'}
            className="px-4 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-50"
          >
            {llmConfigStatus === 'saving' ? 'Saving...' : llmConfigStatus === 'saved' ? 'Saved!' : 'Save LLM Config'}
          </button>

          {costs && (
            <div className="bg-gray-900 rounded p-3 space-y-1 mt-2">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Session total:</span>
                <span className="text-amber-400 font-mono">${costs.sessionTotal.toFixed(4)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Today:</span>
                <span className="text-amber-400 font-mono">${costs.dailyTotal.toFixed(4)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">All time:</span>
                <span className="text-gray-400 font-mono">${costs.allTimeTotal.toFixed(4)}</span>
              </div>
              <div className="flex justify-between text-xs pt-1 border-t border-gray-800">
                <span className="text-gray-500">Daily limit:</span>
                <span className={`font-mono ${costs.dailyTotal >= parseFloat(dailyCostLimit) ? 'text-red-400' : 'text-gray-400'}`}>
                  ${parseFloat(dailyCostLimit).toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {/* Per-feature cost breakdown */}
          <div className="bg-gray-900 rounded p-3 mt-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Cost by Feature</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setBreakdownScope('daily')}
                  className={`px-2 py-0.5 text-xs rounded ${breakdownScope === 'daily' ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >
                  Today
                </button>
                <button
                  onClick={() => setBreakdownScope('all-time')}
                  className={`px-2 py-0.5 text-xs rounded ${breakdownScope === 'all-time' ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >
                  All time
                </button>
              </div>
            </div>
            {costBreakdown.length === 0 ? (
              <div className="text-xs text-gray-600 italic">No usage recorded for this period.</div>
            ) : (
              <div className="space-y-1">
                {costBreakdown.map((row) => (
                  <div key={row.feature} className="flex justify-between text-xs">
                    <span className="text-gray-400 font-mono">{row.feature}</span>
                    <span className="text-gray-500">
                      <span className="text-amber-400 font-mono">${row.costUsd.toFixed(4)}</span>
                      <span className="ml-2 text-gray-600">({row.calls} call{row.calls === 1 ? '' : 's'})</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* AI Memory */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">AI Memory</h3>
        <p className="text-xs text-gray-600 mb-3">
          The auto-analyzer builds memory across requests (session) and across sessions (persistent).
          This helps it detect cross-request patterns and remember target application behavior.
        </p>

        {sessionMemory && (
          <div className="mb-3">
            <label className="text-xs text-gray-500 block mb-1">Session Observations</label>
            <pre className="bg-gray-900 rounded p-2 text-xs text-gray-400 whitespace-pre-wrap max-h-32 overflow-auto">
              {sessionMemory}
            </pre>
          </div>
        )}

        {persistentMemory && (
          <div className="mb-3">
            <label className="text-xs text-gray-500 block mb-1">Persistent Memory</label>
            <pre className="bg-gray-900 rounded p-2 text-xs text-gray-400 whitespace-pre-wrap max-h-32 overflow-auto">
              {persistentMemory}
            </pre>
          </div>
        )}

        {!sessionMemory && !persistentMemory && (
          <p className="text-xs text-gray-600 italic mb-3">No memory stored yet. Enable auto-analyze and send some traffic.</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={loadSettings}
            className="px-3 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 text-gray-400"
          >
            Refresh
          </button>
          <button
            onClick={clearMemory}
            className="px-3 py-1 rounded text-xs bg-red-900 hover:bg-red-800 text-red-300"
          >
            Clear All Memory
          </button>
        </div>
      </section>

      {/* RAG / Vector Index */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">RAG — Knowledge Index</h3>
        <p className="text-xs text-gray-600 mb-3">
          HTTP exchanges are embedded and indexed locally using all-MiniLM-L6-v2. When the AI analyzes traffic or you chat,
          it retrieves semantically relevant exchanges and findings for context.
        </p>

        <div className="bg-gray-900 rounded p-3 space-y-2 mb-3">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Status:</span>
            <span className={ragStatus?.ready ? 'text-emerald-400' : 'text-amber-400'}>
              {ragStatus?.ready ? 'Ready' : 'Loading model...'}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Indexed documents:</span>
            <span className="text-gray-300 font-mono">{ragStatus?.documentCount ?? '—'}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={loadRAGStatus}
            className="px-3 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 text-gray-400"
          >
            Refresh
          </button>
          <button
            onClick={async () => {
              setRagRebuilding(true);
              await api.llm.rebuildRAGIndex();
              // Poll for completion
              setTimeout(async () => {
                await loadRAGStatus();
                setRagRebuilding(false);
              }, 3000);
            }}
            disabled={ragRebuilding}
            className="px-3 py-1 rounded text-xs bg-purple-900 hover:bg-purple-800 text-purple-300 disabled:opacity-50"
          >
            {ragRebuilding ? 'Rebuilding...' : 'Rebuild Index'}
          </button>
          <button
            onClick={async () => {
              await api.llm.clearRAGIndex();
              loadRAGStatus();
            }}
            className="px-3 py-1 rounded text-xs bg-red-900 hover:bg-red-800 text-red-300"
          >
            Clear Index
          </button>
        </div>
      </section>

      {/* Noise Filters */}
      <section className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Noise Filters</h3>
        <p className="text-xs text-gray-500 mb-3">
          Repetitive request patterns (polling, pings, health checks) are auto-detected and
          excluded from AI analysis to save cost. You can disable or delete rules below.
        </p>
        {noiseFilters.length === 0 ? (
          <div className="text-xs text-gray-600 italic">No noise filters yet — they are created automatically when repetitive patterns are detected.</div>
        ) : (
          <div className="space-y-1">
            {noiseFilters.map((f) => (
              <div key={f.id} className="flex items-center gap-2 bg-gray-900 rounded px-3 py-1.5 text-xs">
                <button
                  onClick={async () => {
                    await api.noiseFilters.toggle(f.id, !f.enabled);
                    loadNoiseFilters();
                  }}
                  className={`w-8 text-center rounded py-0.5 text-[10px] font-bold ${f.enabled ? 'bg-emerald-900 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}
                  title={f.enabled ? 'Click to disable (allow analysis)' : 'Click to enable (block analysis)'}
                >
                  {f.enabled ? 'ON' : 'OFF'}
                </button>
                <span className="text-blue-400 font-mono font-bold">{f.method}</span>
                <span className="text-gray-400 font-mono flex-1 truncate" title={f.pattern}>{f.host}{f.shape}</span>
                <span className="text-gray-600">{f.hitsTotal} hits</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${f.reason === 'auto' ? 'bg-amber-950 text-amber-400' : 'bg-purple-950 text-purple-300'}`}>
                  {f.reason}
                </span>
                <button
                  onClick={async () => {
                    await api.noiseFilters.remove(f.id);
                    loadNoiseFilters();
                  }}
                  className="text-gray-600 hover:text-red-400 ml-1"
                  title="Delete rule (pattern will be re-detected if it recurs)"
                >
                  x
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <button
                onClick={async () => {
                  await api.noiseFilters.clearAuto();
                  loadNoiseFilters();
                }}
                className="px-3 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 text-gray-400"
              >
                Clear Auto-detected
              </button>
              <button
                onClick={loadNoiseFilters}
                className="px-3 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 text-gray-400"
              >
                Refresh
              </button>
            </div>
          </div>
        )}
      </section>

      {/* CA Certificate */}
      <section>
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">CA Certificate</h3>
        <p className="text-xs text-gray-500 mb-2">
          Download and trust the Sniff CA certificate to intercept HTTPS traffic.
        </p>
        <button
          onClick={async () => {
            const pem = await fetch('/api/certificates/ca').then((r) => r.text());
            const blob = new Blob([pem], { type: 'application/x-pem-file' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'sniff-ca.pem';
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="px-4 py-1.5 rounded text-sm bg-gray-800 hover:bg-gray-700 text-gray-300"
        >
          Download CA Certificate
        </button>
      </section>

      {setupOpen && <BedrockSetupModal onClose={() => setSetupOpen(false)} />}
    </div>
  );
}

function BedrockSetupModal({ onClose }: { onClose: () => void }) {
  const policyJson = JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'SniffBedrockInvoke',
          Effect: 'Allow',
          Action: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
          ],
          Resource: [
            'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
            'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*',
          ],
        },
      ],
    },
    null,
    2,
  );

  const [copied, setCopied] = React.useState(false);
  const copyPolicy = async () => {
    try {
      await navigator.clipboard.writeText(policyJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[85vh] overflow-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-200">Create a narrow-scope AWS IAM credential</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        <p className="text-xs text-gray-400 mb-4">
          Sniff only needs to invoke Anthropic Claude models on Bedrock. Follow these steps to create
          an access key that can do <em>only</em> that — nothing else in your AWS account.
        </p>

        <ol className="text-xs text-gray-300 space-y-3 list-decimal pl-5 mb-4">
          <li>
            <span className="font-medium">Enable Bedrock model access.</span>
            <div className="text-gray-500 mt-1">
              AWS Console → Bedrock → <em>Model access</em> → request access for the Anthropic
              Claude models you plan to use (Haiku, Sonnet, Opus). Approval is usually instant.
            </div>
          </li>
          <li>
            <span className="font-medium">Create an IAM user.</span>
            <div className="text-gray-500 mt-1">
              IAM → Users → <em>Create user</em>. Name it something like <code className="bg-gray-800 px-1 rounded">sniff-bedrock</code>.
              Do <em>not</em> give it console access — programmatic access only.
            </div>
          </li>
          <li>
            <span className="font-medium">Attach this inline policy.</span>
            <div className="text-gray-500 mt-1 mb-2">
              On the new user, add permissions → <em>Create inline policy</em> → JSON tab → paste:
            </div>
            <div className="relative">
              <pre className="bg-gray-950 rounded p-2 text-[11px] text-gray-300 font-mono overflow-x-auto border border-gray-800">{policyJson}</pre>
              <button
                onClick={copyPolicy}
                className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-200"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="text-gray-600 text-[11px] mt-1">
              This grants invoke-only access to Anthropic Claude models (and their inference profiles).
              No data access, no model management, no other AWS services.
            </div>
          </li>
          <li>
            <span className="font-medium">Generate an access key.</span>
            <div className="text-gray-500 mt-1">
              On the user's <em>Security credentials</em> tab → <em>Create access key</em> → choose
              <em> Application running outside AWS</em>. Copy the Access Key ID and Secret Access Key.
            </div>
          </li>
          <li>
            <span className="font-medium">Paste them into Sniff.</span>
            <div className="text-gray-500 mt-1">
              Close this dialog, paste the key ID and secret above, pick the region where you enabled
              Bedrock model access (e.g. <code className="bg-gray-800 px-1 rounded">us-east-1</code>),
              then click <em>Save Credentials</em> and <em>Test Connection</em>.
            </div>
          </li>
        </ol>

        <div className="text-[11px] text-gray-500 border-t border-gray-800 pt-3">
          Keys are stored only in this app's local database on your machine. You can rotate or delete
          the IAM user at any time to revoke access.
        </div>

        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelSelect({ label, description, value, onChange, defaultModelId }: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  defaultModelId: string;
}) {
  const defaultModel = AVAILABLE_MODELS.find((m) => m.id === defaultModelId);
  const defaultLabel = defaultModel ? defaultModel.label : defaultModelId.split('.').pop()?.split('-v')[0] || 'Unknown';

  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-full max-w-md focus:outline-none focus:border-emerald-600"
      >
        <option value="">Default ({defaultLabel})</option>
        {AVAILABLE_MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.label} — {m.id.split('.').pop()?.split('-v')[0]}</option>
        ))}
      </select>
      <p className="text-xs text-gray-600 mt-0.5">{description}</p>
    </div>
  );
}
