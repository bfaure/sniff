import React, { useState, useEffect, useRef } from 'react';
import { useLLMStream } from '../../hooks/useLLMStream';
import { api } from '../../api/client';
import { appEvents } from '../../events/appEvents';
import { useNavigate } from '../../App';
import type { AnalysisType } from '@sniff/shared';
import { LLMNotConfigured, isLLMNotConfigured } from './LLMNotConfigured';

interface AnalysisPanelProps {
  exchangeId: string;
}

const ANALYSIS_TYPES: { type: AnalysisType; label: string; description: string }[] = [
  { type: 'vuln-scan', label: 'Vuln Scan', description: 'Scan for vulnerabilities (uses reasoning model)' },
  { type: 'explain', label: 'Explain', description: 'Explain what this exchange does' },
  { type: 'suggest-followup', label: 'Suggest', description: 'Suggest follow-up requests to test' },
  { type: 'generate-payloads', label: 'Payloads', description: 'Generate fuzzing payloads' },
  { type: 'pentest-pathway', label: 'Pathway', description: 'Suggest pentest attack pathway (uses reasoning model)' },
];

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SavedAnalysis {
  id: string;
  type: string;
  modelId: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

interface ActionBlock {
  type: string;
  [key: string]: unknown;
}

function parseActions(text: string): ActionBlock[] {
  const actions: ActionBlock[] = [];
  const regex = /```action\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      actions.push(JSON.parse(match[1].trim()));
    } catch { /* skip invalid */ }
  }
  return actions;
}

function stripActionBlocks(text: string): string {
  return text.replace(/```action\s*\n[\s\S]*?```/g, '').trim();
}

export function AnalysisPanel({ exchangeId }: AnalysisPanelProps) {
  const { streaming, text, error, errorCode, modelId, inputTokens, outputTokens, costUsd, analyze, reset } = useLLMStream();
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysis[]>([]);
  const [activeView, setActiveView] = useState<'actions' | 'history' | 'chat'>('actions');
  const navigate = useNavigate();
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reset();
    setChatMessages([]);
    setSavedAnalyses([]);
    api.llm.getAnalyses(exchangeId).then(setSavedAnalyses).catch(() => {});
  }, [exchangeId, reset]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, text]);

  // When streaming finishes, add assistant message to history
  useEffect(() => {
    if (!streaming && text && activeView === 'chat') {
      setChatMessages((prev) => {
        // Avoid duplicates — check if last message is already this text
        if (prev.length > 0 && prev[prev.length - 1].role === 'assistant' && prev[prev.length - 1].content === text) {
          return prev;
        }
        return [...prev, { role: 'assistant', content: text }];
      });
    }
  }, [streaming, text, activeView]);

  const runAnalysis = (type: AnalysisType) => {
    analyze(exchangeId, type);
  };

  const sendChat = () => {
    if (!chatInput.trim() || streaming) return;
    const userMsg = chatInput.trim();
    setChatInput('');

    const newMessages: ChatMessage[] = [...chatMessages, { role: 'user', content: userMsg }];
    setChatMessages(newMessages);

    // Send with conversation history (exclude the new user message — it goes as userMessage param)
    analyze(exchangeId, 'chat', userMsg, chatMessages);
  };

  const executeAction = async (action: ActionBlock) => {
    if (action.type === 'send-to-replay') {
      appEvents.emit('send-to-replay', {
        method: (action.method as string) || 'GET',
        url: (action.url as string) || '',
        headers: (action.headers as Record<string, string>) || {},
        body: (action.body as string | null) || null,
      });
      navigate('replay');
    } else if (action.type === 'create-fuzzer-job') {
      appEvents.emit('send-to-fuzzer', {
        name: (action.name as string) || 'LLM-generated job',
        attackType: (action.attackType as string) || 'single',
        templateReq: action.templateReq as { method: string; url: string; headers: Record<string, string>; body: string | null },
        payloadPositions: (action.payloadPositions as string[]) || [],
        payloads: (action.payloads as string[][]) || [],
      });
      navigate('fuzzer');
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-800">
        {(['actions', 'chat', 'history'] as const).map((view) => (
          <button
            key={view}
            onClick={() => setActiveView(view)}
            className={`px-3 py-1.5 text-xs uppercase tracking-wider ${
              activeView === view
                ? 'text-emerald-400 border-b-2 border-emerald-400'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {view}
            {view === 'chat' && chatMessages.length > 0 && (
              <span className="ml-1 text-gray-600">({chatMessages.length})</span>
            )}
          </button>
        ))}
      </div>

      {activeView === 'actions' && (
        <div className="flex-1 overflow-auto p-3">
          <div className="grid grid-cols-2 gap-2 mb-3">
            {ANALYSIS_TYPES.map(({ type, label, description }) => (
              <button
                key={type}
                onClick={() => runAnalysis(type)}
                disabled={streaming}
                title={description}
                className={`px-3 py-2 rounded text-sm text-left ${
                  type === 'vuln-scan' || type === 'pentest-pathway'
                    ? 'bg-purple-900/50 hover:bg-purple-900 text-purple-300 border border-purple-800'
                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'
                } disabled:opacity-50`}
              >
                <div className="font-medium">{label}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {type === 'vuln-scan' || type === 'pentest-pathway' ? 'Sonnet' : 'Haiku'}
                </div>
              </button>
            ))}
          </div>

          {/* Results */}
          {(streaming || text || error) && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-xs text-gray-500 uppercase tracking-wider">Result</h4>
                {streaming && <span className="text-xs text-emerald-400 animate-pulse">Streaming...</span>}
                {!streaming && modelId && (
                  <span className="text-[10px] text-gray-600">
                    {modelId.includes('haiku') ? 'Haiku' : modelId.includes('sonnet') ? 'Sonnet' : modelId.split('.').pop()}
                    {' · '}{inputTokens}+{outputTokens} tokens · ${costUsd.toFixed(4)}
                  </span>
                )}
              </div>
              {error && (
                isLLMNotConfigured(error, errorCode)
                  ? <LLMNotConfigured />
                  : <div className="text-red-400 text-sm">{error}</div>
              )}
              <pre className="bg-gray-900 rounded p-3 text-xs text-gray-300 whitespace-pre-wrap break-words max-h-96 overflow-auto">
                {text || '...'}
              </pre>
            </div>
          )}
        </div>
      )}

      {activeView === 'chat' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {chatMessages.length === 0 && !streaming && (
              <div className="text-gray-600 text-sm">
                Ask questions about this exchange. The LLM can suggest follow-up requests, create fuzzer jobs, and more.
              </div>
            )}

            {chatMessages.map((msg, i) => (
              <div key={i} className={`${msg.role === 'user' ? 'ml-8' : 'mr-4'}`}>
                <div className={`text-[10px] mb-0.5 ${msg.role === 'user' ? 'text-right text-blue-500' : 'text-purple-500'}`}>
                  {msg.role === 'user' ? 'You' : 'AI'}
                </div>
                <div className={`rounded p-2 text-xs ${
                  msg.role === 'user'
                    ? 'bg-blue-950/50 text-gray-300'
                    : 'bg-gray-900 text-gray-300'
                }`}>
                  <pre className="whitespace-pre-wrap break-words">{stripActionBlocks(msg.content)}</pre>
                  {msg.role === 'assistant' && (
                    <ActionButtons actions={parseActions(msg.content)} onExecute={executeAction} />
                  )}
                </div>
              </div>
            ))}

            {/* Streaming indicator */}
            {streaming && (
              <div className="mr-4">
                <div className="text-[10px] mb-0.5 text-purple-500">AI</div>
                <div className="rounded p-2 text-xs bg-gray-900 text-gray-300">
                  <pre className="whitespace-pre-wrap break-words">{stripActionBlocks(text) || '...'}</pre>
                  {!streaming && <ActionButtons actions={parseActions(text)} onExecute={executeAction} />}
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {!streaming && modelId && (
            <div className="px-3 py-1 text-[10px] text-gray-600 border-t border-gray-800/50">
              {modelId.includes('haiku') ? 'Haiku' : 'Sonnet'} · {inputTokens}+{outputTokens} tokens · ${costUsd.toFixed(4)}
            </div>
          )}

          <div className="flex gap-2 p-3 border-t border-gray-800">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendChat()}
              placeholder="Ask about this request, or ask to set up a fuzzer job..."
              disabled={streaming}
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300 placeholder-gray-600 focus:outline-none focus:border-emerald-600 disabled:opacity-50"
            />
            <button
              onClick={sendChat}
              disabled={streaming || !chatInput.trim()}
              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {activeView === 'history' && (
        <div className="flex-1 overflow-auto p-3">
          {savedAnalyses.length > 0 ? (
            <div className="space-y-3">
              {savedAnalyses.map((a) => (
                <div key={a.id} className="border border-gray-800 rounded p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-emerald-400">{a.type}</span>
                    <span className="text-[10px] text-gray-600">
                      {a.modelId.includes('haiku') ? 'Haiku' : a.modelId.includes('sonnet') ? 'Sonnet' : a.modelId.split('.').pop()}
                    </span>
                    <span className="text-[10px] text-gray-600">${a.costUsd.toFixed(4)}</span>
                    <span className="text-[10px] text-gray-700 ml-auto">
                      {new Date(a.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <pre className="text-xs text-gray-400 whitespace-pre-wrap break-words max-h-32 overflow-auto">
                    {a.response.slice(0, 500)}{a.response.length > 500 ? '...' : ''}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-600 text-sm">No previous analyses for this exchange.</div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionButtons({ actions, onExecute }: { actions: ActionBlock[]; onExecute: (a: ActionBlock) => void }) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-gray-800">
      {actions.map((action, i) => (
        <button
          key={i}
          onClick={() => onExecute(action)}
          className={`px-2 py-1 rounded text-[11px] font-medium ${
            action.type === 'send-to-replay'
              ? 'bg-blue-900/50 hover:bg-blue-900 text-blue-300 border border-blue-800'
              : action.type === 'create-fuzzer-job'
              ? 'bg-orange-900/50 hover:bg-orange-900 text-orange-300 border border-orange-800'
              : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
          }`}
        >
          {action.type === 'send-to-replay' && 'Send to Replay'}
          {action.type === 'create-fuzzer-job' && `Create Fuzzer Job: ${action.name || 'Untitled'}`}
          {action.type !== 'send-to-replay' && action.type !== 'create-fuzzer-job' && action.type}
        </button>
      ))}
    </div>
  );
}
