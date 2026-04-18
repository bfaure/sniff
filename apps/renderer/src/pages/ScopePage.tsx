import React, { useState, useEffect } from 'react';
import { api } from '../api/client';

interface ScopeRule {
  id: string;
  type: 'include' | 'exclude';
  host: string;
  path: string | null;
  protocol: string | null;
  port: number | null;
  enabled: boolean;
  order: number;
}

export function ScopePage() {
  const [rules, setRules] = useState<ScopeRule[]>([]);
  const [newHost, setNewHost] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newType, setNewType] = useState<'include' | 'exclude'>('include');
  const [testUrl, setTestUrl] = useState('');
  const [testResult, setTestResult] = useState<{ url: string; inScope: boolean } | null>(null);
  const [scopeMode, setScopeMode] = useState<'all' | 'in-scope'>('all');
  const [showScopeDialog, setShowScopeDialog] = useState(false);
  const [pendingAnalysis, setPendingAnalysis] = useState<{ count: number } | null>(null);

  useEffect(() => {
    loadRules();
    api.llm.getAutoAnalyzeStatus().then((s) => setScopeMode(s.scopeMode)).catch(() => {});
  }, []);

  const loadRules = async () => {
    try {
      const data = await api.scope.list() as ScopeRule[];
      setRules(data);
    } catch { /* not critical */ }
  };

  const addRule = async () => {
    const host = newHost.trim();
    if (!host) return;
    const hadRules = rules.length > 0;
    const result = await api.scope.create({
      type: newType,
      host,
      path: newPath.trim() || undefined,
    });
    setNewHost('');
    setNewPath('');
    loadRules();

    if (result.pendingAnalysisCount > 0) {
      setPendingAnalysis({ count: result.pendingAnalysisCount });
    }

    // Show dialog when first scope rule is created
    if (!hadRules) {
      setShowScopeDialog(true);
    }
  };

  const handleScopeChoice = async (mode: 'all' | 'in-scope') => {
    setScopeMode(mode);
    await api.llm.setAIScopeMode(mode);
    setShowScopeDialog(false);
  };

  const deleteRule = async (id: string) => {
    await api.scope.delete(id);
    loadRules();
  };

  const toggleRule = async (rule: ScopeRule) => {
    await api.scope.update(rule.id, { enabled: !rule.enabled });
    loadRules();
  };

  const runTest = async () => {
    if (!testUrl.trim()) return;
    const result = await api.scope.test(testUrl.trim());
    setTestResult(result);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <h2 className="text-lg font-bold text-gray-300">Target Scope</h2>
        <span className="text-xs text-gray-500">{rules.length} rules</span>
      </div>

      <div className="flex-1 overflow-auto p-4 max-w-3xl space-y-6">
        {/* Explanation */}
        <div className="text-xs text-gray-500 space-y-1">
          <p>Scope rules control which traffic is considered "in scope" for your engagement.</p>
          <p><strong className="text-gray-400">Include</strong> rules whitelist matching hosts — only matching traffic is in-scope.</p>
          <p><strong className="text-gray-400">Exclude</strong> rules blacklist matching hosts — matching traffic is out-of-scope even if another rule includes it.</p>
          <p>Rules are evaluated top-to-bottom (first match wins). Use <code className="text-gray-400">*</code> as a wildcard (e.g., <code className="text-gray-400">*.example.com</code>).</p>
          <p>With no rules, all traffic is considered in-scope.</p>
        </div>

        {/* Add rule */}
        <div className="bg-gray-900 rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Add Rule</h3>
          <div className="flex items-end gap-2">
            <div>
              <label className="text-[10px] text-gray-500 block mb-1">Type</label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as 'include' | 'exclude')}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300"
              >
                <option value="include">Include</option>
                <option value="exclude">Exclude</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-gray-500 block mb-1">Host Pattern</label>
              <input
                type="text"
                value={newHost}
                onChange={(e) => setNewHost(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
                placeholder="example.com or *.example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300 placeholder-gray-600 font-mono focus:outline-none focus:border-emerald-600"
              />
            </div>
            <div className="w-40">
              <label className="text-[10px] text-gray-500 block mb-1">Path (optional)</label>
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addRule(); }}
                placeholder="/api/*"
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300 placeholder-gray-600 font-mono focus:outline-none focus:border-emerald-600"
              />
            </div>
            <button
              onClick={addRule}
              disabled={!newHost.trim()}
              className="px-4 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        {/* Rules list */}
        <div>
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Rules</h3>
          {rules.length > 0 ? (
            <div className="bg-gray-900 rounded-lg divide-y divide-gray-800">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5 group">
                  <button
                    onClick={() => toggleRule(rule)}
                    className={`shrink-0 w-16 text-center text-[10px] font-bold rounded px-1.5 py-1 ${
                      rule.enabled
                        ? rule.type === 'include'
                          ? 'bg-emerald-900 text-emerald-300 border border-emerald-800'
                          : 'bg-red-900 text-red-300 border border-red-800'
                        : 'bg-gray-800 text-gray-600 border border-gray-700'
                    }`}
                  >
                    {rule.type === 'include' ? 'INCLUDE' : 'EXCLUDE'}
                  </button>
                  <span className={`text-sm font-mono flex-1 ${rule.enabled ? 'text-gray-300' : 'text-gray-600 line-through'}`}>
                    {rule.host}
                    {rule.path ? <span className="text-gray-500">{rule.path}</span> : ''}
                  </span>
                  {rule.protocol && (
                    <span className="text-[10px] text-gray-600">{rule.protocol}</span>
                  )}
                  {rule.port != null && (
                    <span className="text-[10px] text-gray-600">:{rule.port}</span>
                  )}
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="shrink-0 text-gray-700 hover:text-red-400 text-sm opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-gray-900 rounded-lg p-6 text-center text-gray-600 text-sm">
              No scope rules defined. All traffic is considered in-scope.
            </div>
          )}
        </div>

        {/* AI Scope Mode */}
        {rules.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-4 space-y-3">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">AI Analysis Scope</h3>
            <p className="text-xs text-gray-500">
              Choose whether the AI auto-analyzer processes all captured traffic or only traffic matching your scope rules.
            </p>
            <div className="flex rounded overflow-hidden border border-gray-700 w-fit">
              <button
                onClick={() => handleScopeChoice('all')}
                className={`px-4 py-1.5 text-xs ${scopeMode === 'all' ? 'bg-gray-700 text-gray-200' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}
              >
                All Traffic
              </button>
              <button
                onClick={() => handleScopeChoice('in-scope')}
                className={`px-4 py-1.5 text-xs ${scopeMode === 'in-scope' ? 'bg-emerald-900 text-emerald-300' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}
              >
                In-Scope Only
              </button>
            </div>
            <p className="text-[10px] text-gray-600">
              {scopeMode === 'all'
                ? 'AI will analyze all traffic regardless of scope rules. More findings, higher cost.'
                : 'AI will only analyze traffic matching your scope rules. Focused analysis, lower cost.'}
            </p>
          </div>
        )}

        {/* Test URL */}
        <div className="bg-gray-900 rounded-lg p-4 space-y-3">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Test URL</h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={testUrl}
              onChange={(e) => { setTestUrl(e.target.value); setTestResult(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') runTest(); }}
              placeholder="https://example.com/api/users"
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300 placeholder-gray-600 font-mono focus:outline-none focus:border-emerald-600"
            />
            <button
              onClick={runTest}
              disabled={!testUrl.trim()}
              className="px-4 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 font-medium disabled:opacity-50"
            >
              Test
            </button>
          </div>
          {testResult && (
            <div className={`text-sm font-medium ${testResult.inScope ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.inScope ? 'In Scope' : 'Out of Scope'}
            </div>
          )}
        </div>
      </div>

      {/* Pending analysis dialog — shown when scope change puts existing traffic in scope */}
      {pendingAnalysis && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/60" onClick={() => setPendingAnalysis(null)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6">
            <h3 className="text-sm font-bold text-gray-200 mb-2">Existing Traffic Now In Scope</h3>
            <p className="text-xs text-gray-400 mb-4">
              <span className="text-amber-400 font-semibold">{pendingAnalysis.count}</span> existing request{pendingAnalysis.count !== 1 ? 's' : ''} {pendingAnalysis.count !== 1 ? 'are' : 'is'} now in scope but {pendingAnalysis.count !== 1 ? 'have' : 'has'} not been analyzed by the AI auto-analyzer. Would you like to queue them for analysis?
            </p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  await api.scope.analyzePending();
                  setPendingAnalysis(null);
                }}
                className="flex-1 px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
              >
                Analyze {pendingAnalysis.count} request{pendingAnalysis.count !== 1 ? 's' : ''}
              </button>
              <button
                onClick={() => setPendingAnalysis(null)}
                className="flex-1 px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm border border-gray-700"
              >
                Skip
              </button>
            </div>
            <p className="text-[10px] text-gray-600 mt-2">
              New in-scope traffic will be analyzed automatically going forward.
            </p>
          </div>
        </div>
      )}

      {/* Scope dialog — shown when first rule is created */}
      {showScopeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/60" onClick={() => setShowScopeDialog(false)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-lg shadow-2xl max-w-md w-full mx-4 p-6">
            <h3 className="text-sm font-bold text-gray-200 mb-2">AI Analysis Scope</h3>
            <p className="text-xs text-gray-400 mb-4">
              You've defined a scope rule. Should the AI auto-analyzer only analyze in-scope traffic,
              or continue analyzing all captured traffic?
            </p>
            <div className="space-y-2 mb-4">
              <button
                onClick={() => handleScopeChoice('in-scope')}
                className="w-full text-left px-4 py-3 rounded border border-emerald-800 bg-emerald-950/30 hover:bg-emerald-900/40 transition-colors"
              >
                <div className="text-sm font-medium text-emerald-300">In-Scope Only</div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  Only analyze traffic matching scope rules. Focused results, lower LLM cost.
                </div>
              </button>
              <button
                onClick={() => handleScopeChoice('all')}
                className="w-full text-left px-4 py-3 rounded border border-gray-700 bg-gray-800/50 hover:bg-gray-800 transition-colors"
              >
                <div className="text-sm font-medium text-gray-300">All Traffic</div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  Analyze everything regardless of scope. Broader coverage, higher cost.
                </div>
              </button>
            </div>
            <p className="text-[10px] text-gray-600">
              You can change this anytime in the AI Analysis Scope section below.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
