import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { wsClient } from '../api/ws';

interface SiteMapNode {
  name: string;
  path: string;
  children: SiteMapNode[];
  requestCount: number;
  methods: string[];
  statusCodes: number[];
}

interface AssessmentFinding {
  categoryId: string;
  categoryName: string;
  owaspId?: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  evidence: string;
  explanation: string;
  suggestedTest: string | null;
}

interface AssessmentState {
  assessmentId: string;
  host: string;
  pathPrefix: string | null;
  currentCategory: string;
  currentCategoryIndex: number;
  totalCategories: number;
  findings: AssessmentFinding[];
  status: 'running' | 'done' | 'error';
  totalCost: number;
  error?: string;
}

function TreeNode({
  node,
  depth = 0,
  hostName,
  onAssess,
  onAddToScope,
  onDelete,
  assessingTarget,
}: {
  node: SiteMapNode;
  depth?: number;
  hostName?: string;
  onAssess: (host: string, pathPrefix?: string) => void;
  onAddToScope: (host: string) => void;
  onDelete: (host: string, path?: string) => void;
  assessingTarget: string | null;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [scopeAdded, setScopeAdded] = useState(false);
  const hasChildren = node.children.length > 0;
  const isHost = depth === 0;
  const host = isHost ? node.name : hostName!;
  const assessLabel = isHost ? host : `${host}${node.path}`;
  const isAssessing = assessingTarget === assessLabel;

  const statusIndicator = () => {
    if (node.statusCodes.some((c) => c >= 500)) return 'bg-red-400';
    if (node.statusCodes.some((c) => c >= 400)) return 'bg-amber-400';
    return 'bg-emerald-400';
  };

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-0.5 hover:bg-gray-800/50 cursor-pointer text-sm group`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-gray-600 w-4 text-center text-xs select-none">
          {hasChildren ? (expanded ? '\u25BE' : '\u25B8') : '\u00A0'}
        </span>
        <span className={`inline-block w-2 h-2 rounded-full ${statusIndicator()} mr-1`} />
        <span className="text-gray-300">{node.name}</span>
        <span className="text-gray-600 text-xs ml-2">({node.requestCount})</span>
        <div className="flex gap-1 ml-2">
          {node.methods.map((m) => {
            const color = m === 'GET' ? 'text-emerald-400 bg-emerald-950' :
              m === 'POST' ? 'text-blue-400 bg-blue-950' :
              m === 'DELETE' ? 'text-red-400 bg-red-950' :
              'text-amber-400 bg-amber-950';
            return (
              <span key={m} className={`text-[10px] px-1 rounded ${color}`}>
                {m}
              </span>
            );
          })}
        </div>
        <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isHost && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!scopeAdded) {
                  onAddToScope(node.name);
                  setScopeAdded(true);
                }
              }}
              disabled={scopeAdded}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                scopeAdded
                  ? 'bg-emerald-900 text-emerald-400 border-emerald-700'
                  : 'bg-emerald-900/50 hover:bg-emerald-900 text-emerald-300 border-emerald-800'
              }`}
            >
              {scopeAdded ? 'Scoped' : '+ Scope'}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAssess(host, isHost ? undefined : node.path);
            }}
            disabled={isAssessing}
            className="px-2 py-0.5 rounded text-[10px] font-medium bg-purple-900/50 hover:bg-purple-900 text-purple-300 border border-purple-800 disabled:opacity-50"
          >
            {isAssessing ? 'Assessing...' : 'Assess'}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(host, isHost ? undefined : node.path);
            }}
            className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:text-red-300 hover:bg-red-900/30"
            title={isHost ? `Delete all exchanges for ${node.name}` : `Delete exchanges under ${node.path}`}
          >
            ×
          </button>
        </div>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} hostName={host} onAssess={onAssess} onAddToScope={onAddToScope} onDelete={onDelete} assessingTarget={assessingTarget} />
          ))}
        </div>
      )}
    </div>
  );
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-600 text-white',
  medium: 'bg-amber-600 text-black',
  low: 'bg-blue-600 text-white',
  info: 'bg-gray-600 text-white',
};

function AssessmentPanel({ assessment, onCancel, onClose }: {
  assessment: AssessmentState;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [expandedFinding, setExpandedFinding] = useState<number | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

  const findings = assessment.findings
    .filter((f) => !filterSeverity || f.severity === filterSeverity)
    .filter((f) => !filterCategory || f.categoryId === filterCategory)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5));

  const severityCounts = assessment.findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const categories = [...new Set(assessment.findings.map((f) => f.categoryId))].map((id) => {
    const f = assessment.findings.find((ff) => ff.categoryId === id)!;
    return { id, name: f.categoryName, owaspId: f.owaspId };
  });

  const progress = assessment.status === 'running'
    ? Math.round((assessment.currentCategoryIndex / assessment.totalCategories) * 100)
    : 100;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <h3 className="text-sm font-bold text-purple-300">Assessment: {assessment.host}{assessment.pathPrefix || ''}</h3>
        <div className="flex-1" />
        {assessment.status === 'running' && (
          <>
            <span className="text-xs text-purple-400 animate-pulse">{assessment.currentCategory}</span>
            <span className="text-xs text-gray-500">{assessment.currentCategoryIndex}/{assessment.totalCategories}</span>
            <button
              onClick={onCancel}
              className="px-2 py-0.5 rounded text-xs bg-red-900/50 hover:bg-red-900 text-red-300 border border-red-800"
            >
              Cancel
            </button>
          </>
        )}
        {assessment.status === 'done' && (
          <span className="text-xs text-gray-500">${assessment.totalCost.toFixed(4)} total</span>
        )}
        {assessment.status === 'error' && (
          <span className="text-xs text-red-400">{assessment.error}</span>
        )}
        <button
          onClick={onClose}
          className="px-2 py-0.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
        >
          Close
        </button>
      </div>

      {/* Progress bar */}
      {assessment.status === 'running' && (
        <div className="h-1 bg-gray-800">
          <div
            className="h-full bg-purple-600 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Severity summary */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/50">
        <span className="text-xs text-gray-500">{assessment.findings.length} findings:</span>
        {['critical', 'high', 'medium', 'low', 'info'].map((sev) => {
          const count = severityCounts[sev] || 0;
          if (count === 0) return null;
          const isActive = filterSeverity === sev;
          return (
            <button
              key={sev}
              onClick={() => setFilterSeverity(isActive ? null : sev)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${SEVERITY_COLORS[sev]} ${isActive ? 'ring-2 ring-white/50' : 'opacity-80 hover:opacity-100'}`}
            >
              {count} {sev}
            </button>
          );
        })}
        {filterSeverity && (
          <button onClick={() => setFilterSeverity(null)} className="text-[10px] text-gray-500 hover:text-gray-300">
            clear
          </button>
        )}
      </div>

      {/* Category filter */}
      {categories.length > 1 && (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-gray-800/50 flex-wrap">
          <span className="text-[10px] text-gray-600 mr-1">Category:</span>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setFilterCategory(filterCategory === cat.id ? null : cat.id)}
              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                filterCategory === cat.id
                  ? 'border-purple-600 bg-purple-950/50 text-purple-300'
                  : 'border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-700'
              }`}
            >
              {cat.owaspId ? `${cat.owaspId} ` : ''}{cat.name}
            </button>
          ))}
        </div>
      )}

      {/* Findings list */}
      <div className="flex-1 overflow-auto">
        {findings.length === 0 && assessment.status !== 'running' && (
          <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
            {assessment.findings.length === 0 ? 'No findings detected.' : 'No findings match the current filter.'}
          </div>
        )}
        {findings.length === 0 && assessment.status === 'running' && (
          <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
            Analyzing... findings will appear as each category completes.
          </div>
        )}
        {findings.map((f, i) => {
          const isExpanded = expandedFinding === i;
          return (
            <div key={i} className="border-b border-gray-800/30">
              <button
                onClick={() => setExpandedFinding(isExpanded ? null : i)}
                className="w-full text-left px-4 py-2 hover:bg-gray-800/30 flex items-center gap-2"
              >
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${SEVERITY_COLORS[f.severity]}`}>
                  {f.severity.toUpperCase()}
                </span>
                <span className="text-sm text-gray-300 flex-1">{f.title}</span>
                <span className="text-[10px] text-gray-600">
                  {f.owaspId && `${f.owaspId} · `}{f.categoryName}
                </span>
                <span className="text-gray-600 text-xs">{isExpanded ? '\u25BE' : '\u25B8'}</span>
              </button>
              {isExpanded && (
                <div className="px-4 pb-3 space-y-2">
                  <div>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Explanation</div>
                    <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words bg-gray-900 rounded p-2">
                      {f.explanation}
                    </pre>
                  </div>
                  {f.evidence && (
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Evidence</div>
                      <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words bg-gray-900 rounded p-2 font-mono">
                        {f.evidence}
                      </pre>
                    </div>
                  )}
                  {f.suggestedTest && (
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Suggested Test</div>
                      <pre className="text-xs text-emerald-300 whitespace-pre-wrap break-words bg-gray-900 rounded p-2 font-mono">
                        {f.suggestedTest}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SiteMapPage() {
  const [nodes, setNodes] = useState<SiteMapNode[]>([]);
  const [assessment, setAssessment] = useState<AssessmentState | null>(null);
  const [scopeOnly, setScopeOnly] = useState(true);

  useEffect(() => {
    api.sitemap.get(scopeOnly || undefined).then((data) => setNodes(data as SiteMapNode[]));
  }, [scopeOnly]);

  // Listen for assessment progress.
  // Defensive: only accept events that correspond to the currently displayed
  // assessment (or set the initial one if nothing is shown yet). Otherwise an
  // event from a previous run can replace the active panel and make it appear
  // to flicker. Merge fields rather than replacing wholesale so partial events
  // can never blank out the findings list.
  useEffect(() => {
    const unsub = wsClient.on('assessment:progress', (data) => {
      const incoming = data as AssessmentState;
      if (!incoming || !incoming.assessmentId) return;
      setAssessment((prev) => {
        if (prev && prev.assessmentId !== incoming.assessmentId) {
          // Ignore cross-talk from a different (stale) assessment run
          return prev;
        }
        return { ...(prev || {}), ...incoming };
      });
    });
    return unsub;
  }, []);

  const refresh = () => {
    api.sitemap.get(scopeOnly || undefined).then((data) => setNodes(data as SiteMapNode[]));
  };

  const startAssessment = async (host: string, pathPrefix?: string) => {
    try {
      const { assessmentId } = await api.llm.startAssessment(host, pathPrefix);
      setAssessment({
        assessmentId,
        host,
        pathPrefix: pathPrefix || null,
        currentCategory: 'Starting...',
        currentCategoryIndex: 0,
        totalCategories: 13,
        findings: [],
        status: 'running',
        totalCost: 0,
      });
    } catch (err) {
      console.error('Failed to start assessment:', err);
    }
  };

  const cancelAssessment = async () => {
    if (assessment) {
      await api.llm.cancelAssessment(assessment.assessmentId);
    }
  };

  const addToScope = async (host: string) => {
    try {
      await api.scope.create({ type: 'include', host });
    } catch (err) {
      console.error('Failed to add scope rule:', err);
    }
  };

  const deleteFromSiteMap = async (host: string, path?: string) => {
    try {
      await api.sitemap.delete(host, path);
      refresh();
    } catch (err) {
      console.error('Failed to delete from site map:', err);
    }
  };

  const assessingTarget = assessment?.status === 'running'
    ? `${assessment.host}${assessment.pathPrefix || ''}`
    : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <h2 className="text-lg font-bold text-gray-300">Site Map</h2>
        <button
          onClick={refresh}
          className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
        >
          Refresh
        </button>
        <div className="flex rounded border border-gray-700 overflow-hidden">
          <button
            onClick={() => setScopeOnly(true)}
            className={`px-2 py-0.5 text-[10px] ${scopeOnly ? 'bg-emerald-900 text-emerald-300' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
          >
            In Scope
          </button>
          <button
            onClick={() => setScopeOnly(false)}
            className={`px-2 py-0.5 text-[10px] ${!scopeOnly ? 'bg-gray-700 text-gray-300' : 'bg-gray-800 text-gray-500 hover:text-gray-300'}`}
          >
            All
          </button>
        </div>
        <span className="text-xs text-gray-500">{nodes.length} hosts</span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Tree panel */}
        <div className={`${assessment ? 'w-1/3 border-r border-gray-800' : 'flex-1'} overflow-auto py-2`}>
          {nodes.length > 0 ? (
            nodes.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                onAssess={startAssessment}
                onAddToScope={addToScope}
                onDelete={deleteFromSiteMap}
                assessingTarget={assessingTarget}
              />
            ))
          ) : (
            <div className="flex items-center justify-center h-48 text-gray-600 text-sm">
              No traffic captured yet. Start the proxy to build the site map.
            </div>
          )}
        </div>

        {/* Assessment panel */}
        {assessment && (
          <div className="flex-1 overflow-hidden">
            <AssessmentPanel
              assessment={assessment}
              onCancel={cancelAssessment}
              onClose={() => setAssessment(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
