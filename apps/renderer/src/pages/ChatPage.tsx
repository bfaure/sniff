import React, { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import { useLLMStream } from '../hooks/useLLMStream';
import { useNavigate } from '../App';
import { appEvents } from '../events/appEvents';
import { api } from '../api/client';
import { LLMNotConfigured, isLLMNotConfigured } from '../components/shared/LLMNotConfigured';

const CHAT_STORAGE_KEY = 'ui_chat_history';
const MAX_PERSISTED_MESSAGES = 100;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  modelId?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
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
    } catch { /* skip */ }
  }
  return actions;
}

function stripActionBlocks(text: string): string {
  return text.replace(/```action\s*\n[\s\S]*?```/g, '').trim();
}

const QUICK_PROMPTS = [
  { label: 'Attack Strategy', prompt: 'Based on the traffic you can see, what are the highest-priority attack vectors I should investigate? Give me a concrete plan.' },
  { label: 'Summarize Findings', prompt: 'Summarize all the security findings discovered so far. Group by severity and suggest which ones to investigate first.' },
  { label: 'What Do You See?', prompt: 'Describe the target application based on the traffic captured so far. What tech stack, endpoints, auth mechanisms, and interesting patterns do you see?' },
  { label: 'Suggest Next Steps', prompt: 'What should I test next? Consider what has already been discovered and suggest concrete next steps with specific requests to try.' },
];

export function ChatPage() {
  const { streaming, text, error, errorCode, modelId, inputTokens, outputTokens, costUsd, projectChat, reset } = useLLMStream();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  // Load persisted chat history on mount
  useEffect(() => {
    api.settings.getAll().then((all) => {
      const raw = all[CHAT_STORAGE_KEY];
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as ChatMessage[];
          if (Array.isArray(parsed)) setMessages(parsed);
        } catch { /* ignore */ }
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  // Debounced persist whenever messages change (after initial load)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const toPersist = messages.slice(-MAX_PERSISTED_MESSAGES);
      api.settings.set(CHAT_STORAGE_KEY, JSON.stringify(toPersist)).catch(() => {});
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, loaded]);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, text]);

  // When streaming finishes, add to messages
  useEffect(() => {
    if (!streaming && text) {
      setMessages((prev) => {
        if (prev.length > 0 && prev[prev.length - 1].role === 'assistant' && prev[prev.length - 1].content === text) {
          return prev;
        }
        return [...prev, {
          role: 'assistant',
          content: text,
          modelId: modelId || undefined,
          tokens: { input: inputTokens, output: outputTokens },
          costUsd,
        }];
      });
    }
  }, [streaming, text, modelId, inputTokens, outputTokens, costUsd]);

  const send = (msg?: string) => {
    const userMsg = (msg || input).trim();
    if (!userMsg || streaming) return;
    setInput('');

    const newMessages: ChatMessage[] = [...messages, { role: 'user', content: userMsg }];
    setMessages(newMessages);

    // Build conversation history (exclude the new user message)
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    projectChat(userMsg, history);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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

  const clearChat = () => {
    setMessages([]);
    reset();
    api.settings.set(CHAT_STORAGE_KEY, JSON.stringify([])).catch(() => {});
  };

  const totalCost = messages.reduce((sum, m) => sum + (m.costUsd || 0), 0);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold text-gray-300">AI Chat</h2>
          <span className="text-[10px] text-gray-600">
            Project-level discussion with full context (scope, findings, endpoints, observations)
          </span>
        </div>
        <div className="flex items-center gap-3">
          {totalCost > 0 && (
            <span className="text-[10px] text-amber-500 font-mono">${totalCost.toFixed(4)}</span>
          )}
          <button
            onClick={clearChat}
            className="px-2 py-1 text-[10px] text-gray-600 hover:text-gray-400 rounded bg-gray-800 hover:bg-gray-700"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full px-8">
            <div className="text-gray-600 text-sm mb-6 text-center max-w-lg">
              Chat with the AI about your project. It has access to your scope rules, discovered endpoints,
              session observations, and recent findings.
            </div>
            <div className="grid grid-cols-2 gap-2 max-w-lg w-full">
              {QUICK_PROMPTS.map((qp) => (
                <button
                  key={qp.label}
                  onClick={() => send(qp.prompt)}
                  className="text-left px-3 py-2.5 rounded border border-gray-800 bg-gray-900 hover:bg-gray-800 hover:border-gray-700 transition-colors"
                >
                  <div className="text-xs text-emerald-400 font-medium">{qp.label}</div>
                  <div className="text-[10px] text-gray-600 mt-0.5 line-clamp-2">{qp.prompt}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="px-4 py-3 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={msg.role === 'user' ? 'flex justify-end' : ''}>
              <div className={`max-w-[85%] ${msg.role === 'user' ? 'ml-12' : 'mr-12'}`}>
                <div className={`flex items-center gap-2 mb-1 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  <span className={`text-[10px] font-medium ${msg.role === 'user' ? 'text-blue-500' : 'text-purple-500'}`}>
                    {msg.role === 'user' ? 'You' : 'AI'}
                  </span>
                  {msg.role === 'assistant' && msg.modelId && (
                    <span className="text-[10px] text-gray-700">
                      {msg.modelId.includes('haiku') ? 'Haiku' : msg.modelId.includes('sonnet') ? 'Sonnet' : msg.modelId.includes('opus') ? 'Opus' : ''}
                      {msg.tokens ? ` \u00b7 ${msg.tokens.input}+${msg.tokens.output}t` : ''}
                      {msg.costUsd ? ` \u00b7 $${msg.costUsd.toFixed(4)}` : ''}
                    </span>
                  )}
                </div>
                <div className={`rounded-lg px-3 py-2 text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-950/50 text-gray-200'
                    : 'bg-gray-900 text-gray-300 border border-gray-800'
                }`}>
                  {msg.role === 'assistant' ? (
                    <div className="ai-prose">
                      <Markdown>{stripActionBlocks(msg.content)}</Markdown>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{msg.content}</div>
                  )}
                  {msg.role === 'assistant' && (
                    <ActionButtons actions={parseActions(msg.content)} onExecute={executeAction} />
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Streaming */}
          {streaming && (
            <div>
              <div className="max-w-[85%] mr-12">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-medium text-purple-500">AI</span>
                  <span className="text-[10px] text-emerald-400 animate-pulse">thinking...</span>
                </div>
                <div className="rounded-lg px-3 py-2 text-sm bg-gray-900 text-gray-300 border border-gray-800">
                  <div className="ai-prose">
                    <Markdown>{stripActionBlocks(text) || '...'}</Markdown>
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            isLLMNotConfigured(error, errorCode)
              ? <LLMNotConfigured />
              : <div className="text-red-400 text-xs bg-red-950/30 rounded px-3 py-2">{error}</div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 p-3">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your target, discuss findings, plan attacks..."
            disabled={streaming}
            rows={2}
            className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-300 placeholder-gray-600 resize-none focus:outline-none focus:border-emerald-600 disabled:opacity-50"
          />
          <button
            onClick={() => send()}
            disabled={streaming || !input.trim()}
            className="px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium self-end py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-gray-700">Shift+Enter for new line. Uses reasoning model with full project context.</span>
        </div>
      </div>
    </div>
  );
}

function methodColor(method: string): string {
  const m = method.toUpperCase();
  if (m === 'GET') return 'text-emerald-400';
  if (m === 'POST') return 'text-blue-400';
  if (m === 'PUT') return 'text-amber-400';
  if (m === 'PATCH') return 'text-orange-400';
  if (m === 'DELETE') return 'text-red-400';
  return 'text-gray-400';
}

function ActionCard({ action, onExecute }: { action: ActionBlock; onExecute: (a: ActionBlock) => void }) {
  const [expanded, setExpanded] = useState(false);

  if (action.type === 'send-to-replay') {
    const method = ((action.method as string) || 'GET').toUpperCase();
    const url = (action.url as string) || '';
    const headers = (action.headers as Record<string, string>) || {};
    const body = (action.body as string | null) || null;
    const headerCount = Object.keys(headers).length;
    const bodyPreview = body ? body.slice(0, 120) : '';
    const note = (action.note as string) || (action.description as string) || '';

    return (
      <div className="rounded border border-blue-900/60 bg-blue-950/20 overflow-hidden">
        <div className="flex items-start gap-2 px-2.5 py-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className={`text-[11px] font-bold font-mono ${methodColor(method)}`}>{method}</span>
              <span className="text-[11px] font-mono text-gray-300 truncate" title={url}>{url}</span>
            </div>
            {note && <div className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{note}</div>}
            <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-600">
              {headerCount > 0 && <span>{headerCount} header{headerCount === 1 ? '' : 's'}</span>}
              {body && <span>{body.length}B body</span>}
              {(headerCount > 0 || body) && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="text-gray-500 hover:text-gray-300"
                >
                  {expanded ? 'Hide details' : 'Show details'}
                </button>
              )}
            </div>
            {expanded && (
              <div className="mt-1.5 space-y-1">
                {headerCount > 0 && (
                  <pre className="text-[10px] font-mono bg-gray-950 rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all text-gray-400">
                    {Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </pre>
                )}
                {bodyPreview && (
                  <pre className="text-[10px] font-mono bg-gray-950 rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all text-gray-300">
                    {body!.length > 500 ? body!.slice(0, 500) + '\n...' : body}
                  </pre>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => onExecute(action)}
            className="shrink-0 px-2 py-1 rounded bg-blue-900/70 hover:bg-blue-800 text-blue-200 border border-blue-800 text-[11px] font-medium whitespace-nowrap"
          >
            Send to Replay
          </button>
        </div>
      </div>
    );
  }

  if (action.type === 'create-fuzzer-job') {
    const name = (action.name as string) || 'Untitled';
    const attackType = (action.attackType as string) || 'single';
    const tpl = action.templateReq as { method?: string; url?: string } | undefined;
    const positionCount = Array.isArray(action.payloadPositions) ? (action.payloadPositions as unknown[]).length : 0;
    const payloadLists = Array.isArray(action.payloads) ? (action.payloads as unknown[][]) : [];
    const payloadTotal = payloadLists.reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);

    return (
      <div className="rounded border border-orange-900/60 bg-orange-950/20 px-2.5 py-2 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-orange-300 truncate">{name}</div>
          {tpl?.url && (
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className={`text-[10px] font-mono ${methodColor(tpl.method || 'GET')}`}>{(tpl.method || 'GET').toUpperCase()}</span>
              <span className="text-[10px] font-mono text-gray-400 truncate" title={tpl.url}>{tpl.url}</span>
            </div>
          )}
          <div className="text-[10px] text-gray-600 mt-0.5">
            {attackType} · {positionCount} position{positionCount === 1 ? '' : 's'} · {payloadTotal} payload{payloadTotal === 1 ? '' : 's'}
          </div>
        </div>
        <button
          onClick={() => onExecute(action)}
          className="shrink-0 px-2 py-1 rounded bg-orange-900/70 hover:bg-orange-800 text-orange-200 border border-orange-800 text-[11px] font-medium whitespace-nowrap"
        >
          Create Job
        </button>
      </div>
    );
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 px-2.5 py-2 flex items-center justify-between gap-2">
      <span className="text-[11px] text-gray-400">{action.type}</span>
      <button
        onClick={() => onExecute(action)}
        className="shrink-0 px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-[11px] font-medium"
      >
        Run
      </button>
    </div>
  );
}

function ActionButtons({ actions, onExecute }: { actions: ActionBlock[]; onExecute: (a: ActionBlock) => void }) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-gray-800">
      {actions.map((action, i) => (
        <ActionCard key={i} action={action} onExecute={onExecute} />
      ))}
    </div>
  );
}
