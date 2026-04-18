import React, { useState } from 'react';
import { api } from '../api/client';

const TRANSFORMS = [
  { value: 'base64', label: 'Base64' },
  { value: 'url', label: 'URL Encoding' },
  { value: 'html', label: 'HTML Entities' },
  { value: 'hex', label: 'Hex' },
  { value: 'unicode', label: 'Unicode Escapes' },
  { value: 'jwt', label: 'JWT Decode' },
  { value: 'gzip', label: 'Gzip (Base64)' },
];

interface TransformStep {
  id: number;
  type: string;
  direction: 'encode' | 'decode';
}

interface Suggestion {
  format: string;
  confidence: string;
  explanation: string;
  decodingSteps: string[];
}

let stepId = 0;

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-emerald-400 bg-emerald-950 border-emerald-800',
  medium: 'text-amber-400 bg-amber-950 border-amber-800',
  low: 'text-gray-400 bg-gray-800 border-gray-700',
};

export function DecoderPage() {
  const [input, setInput] = useState('');
  const [steps, setSteps] = useState<TransformStep[]>([
    { id: stepId++, type: 'base64', direction: 'decode' },
  ]);
  const [results, setResults] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [rawAnalysis, setRawAnalysis] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestCost, setSuggestCost] = useState<number | null>(null);

  const addStep = () => {
    setSteps((prev) => [...prev, { id: stepId++, type: 'base64', direction: 'encode' }]);
  };

  const removeStep = (id: number) => {
    setSteps((prev) => prev.filter((s) => s.id !== id));
  };

  const updateStep = (id: number, updates: Partial<TransformStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...updates } : s)));
  };

  const runTransform = async () => {
    const operations = steps.map((s) => ({ type: s.type, direction: s.direction }));
    try {
      const result = await api.decoder.transform(input, operations);
      setResults(result.steps.slice(1));
    } catch (err) {
      setResults([`Error: ${(err as Error).message}`]);
    }
  };

  const runSuggest = async () => {
    if (!input.trim()) return;
    setSuggesting(true);
    setSuggestions([]);
    setRawAnalysis('');
    setSuggestCost(null);
    try {
      const result = await api.decoder.suggest(input);
      setSuggestions(result.suggestions || []);
      setRawAnalysis(result.rawAnalysis || '');
      setSuggestCost(result.costUsd);
    } catch (err) {
      setRawAnalysis(`Error: ${(err as Error).message}`);
    } finally {
      setSuggesting(false);
    }
  };

  // Apply a suggestion: set up the transform chain based on the suggestion's decoding steps
  const applySuggestion = (suggestion: Suggestion) => {
    const format = suggestion.format.toLowerCase();
    // Map common format names to our transform types
    const formatMap: Record<string, string> = {
      'base64': 'base64',
      'base64url': 'base64',
      'url encoding': 'url',
      'url': 'url',
      'percent-encoding': 'url',
      'html entities': 'html',
      'html': 'html',
      'hex': 'hex',
      'hex encoding': 'hex',
      'hexadecimal': 'hex',
      'unicode': 'unicode',
      'unicode escapes': 'unicode',
      'jwt': 'jwt',
      'json web token': 'jwt',
      'gzip': 'gzip',
      'gzip+base64': 'gzip',
    };

    // Try to find a matching transform
    const matchedType = Object.entries(formatMap).find(([key]) =>
      format.includes(key)
    )?.[1];

    if (matchedType) {
      setSteps([{ id: stepId++, type: matchedType, direction: 'decode' }]);
    }
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-auto">
      <h2 className="text-lg font-bold text-gray-300">Decoder / Encoder</h2>

      {/* Input */}
      <div>
        <label className="text-xs text-gray-500 uppercase tracking-wider">Input</label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="w-full h-32 bg-gray-900 border border-gray-800 rounded p-2 text-sm font-mono text-gray-300 resize-none focus:outline-none focus:border-emerald-600 mt-1"
          placeholder="Enter text to encode/decode..."
        />
      </div>

      {/* Transform chain */}
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-center gap-2">
            <span className="text-xs text-gray-600 w-4">{i + 1}.</span>
            <select
              value={step.type}
              onChange={(e) => updateStep(step.id, { type: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
            >
              {TRANSFORMS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <select
              value={step.direction}
              onChange={(e) => updateStep(step.id, { direction: e.target.value as 'encode' | 'decode' })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
            >
              <option value="encode">Encode</option>
              <option value="decode">Decode</option>
            </select>
            <button
              onClick={() => removeStep(step.id)}
              className="text-gray-600 hover:text-red-400 text-sm"
            >
              Remove
            </button>

            {/* Result for this step */}
            {results[i] !== undefined && (
              <div className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm font-mono text-emerald-400 truncate">
                {results[i]}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={addStep}
          className="px-3 py-1 rounded text-sm bg-gray-800 hover:bg-gray-700 text-gray-300"
        >
          + Add Step
        </button>
        <button
          onClick={runTransform}
          className="px-4 py-1 rounded text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
        >
          Transform
        </button>
        <button
          onClick={runSuggest}
          disabled={!input.trim() || suggesting}
          className="px-4 py-1 rounded text-sm bg-purple-600 hover:bg-purple-700 text-white font-medium disabled:opacity-50"
        >
          {suggesting ? 'Analyzing...' : 'Suggest Format'}
        </button>
      </div>

      {/* Final result */}
      {results.length > 0 && (
        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wider">Final Result</label>
          <pre className="bg-gray-900 border border-gray-800 rounded p-2 text-sm font-mono text-emerald-400 whitespace-pre-wrap break-all mt-1 max-h-48 overflow-auto">
            {results[results.length - 1]}
          </pre>
        </div>
      )}

      {/* LLM Suggestions */}
      {(suggestions.length > 0 || rawAnalysis) && (
        <div className="border border-purple-800/50 rounded bg-purple-950/20">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-purple-800/30">
            <span className="text-xs text-purple-400 font-medium uppercase tracking-wider">AI Analysis</span>
            {suggestCost !== null && (
              <span className="text-[10px] text-gray-600">${suggestCost.toFixed(4)}</span>
            )}
            <div className="flex-1" />
            <button
              onClick={() => { setSuggestions([]); setRawAnalysis(''); }}
              className="text-[10px] text-gray-600 hover:text-gray-400"
            >
              dismiss
            </button>
          </div>

          {rawAnalysis && (
            <div className="px-3 py-2 text-xs text-gray-400 border-b border-purple-800/20">
              {rawAnalysis}
            </div>
          )}

          <div className="divide-y divide-purple-800/20">
            {suggestions.map((s, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-200">{s.format}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${CONFIDENCE_COLORS[s.confidence] || CONFIDENCE_COLORS.low}`}>
                    {s.confidence}
                  </span>
                  <button
                    onClick={() => applySuggestion(s)}
                    className="ml-auto px-2 py-0.5 rounded text-[10px] bg-purple-900/50 hover:bg-purple-900 text-purple-300 border border-purple-800"
                  >
                    Apply
                  </button>
                </div>
                <div className="text-xs text-gray-400 mb-1">{s.explanation}</div>
                {s.decodingSteps.length > 0 && (
                  <div className="text-[10px] text-gray-500">
                    Steps: {s.decodingSteps.join(' -> ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
