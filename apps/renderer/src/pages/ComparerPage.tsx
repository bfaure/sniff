import React, { useState } from 'react';
import { api } from '../api/client';

interface DiffChunk {
  type: 'equal' | 'added' | 'removed';
  value: string;
}

export function ComparerPage() {
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [mode, setMode] = useState<'line' | 'word'>('line');
  const [diff, setDiff] = useState<DiffChunk[] | null>(null);

  const runDiff = async () => {
    const result = await api.comparer.diff(textA, textB, mode) as { diff: DiffChunk[] };
    setDiff(result.diff);
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-bold text-gray-300">Comparer</h2>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'line' | 'word')}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300"
        >
          <option value="line">Line Diff</option>
          <option value="word">Word Diff</option>
        </select>
        <button
          onClick={runDiff}
          className="px-4 py-1 rounded text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
        >
          Compare
        </button>
      </div>

      {/* Input areas */}
      <div className="flex gap-4 flex-1 min-h-0">
        <div className="flex-1 flex flex-col">
          <label className="text-xs text-gray-500 uppercase tracking-wider mb-1">Item A</label>
          <textarea
            value={textA}
            onChange={(e) => setTextA(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-800 rounded p-2 text-sm font-mono text-gray-300 resize-none focus:outline-none focus:border-emerald-600"
            placeholder="Paste first item..."
          />
        </div>
        <div className="flex-1 flex flex-col">
          <label className="text-xs text-gray-500 uppercase tracking-wider mb-1">Item B</label>
          <textarea
            value={textB}
            onChange={(e) => setTextB(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-800 rounded p-2 text-sm font-mono text-gray-300 resize-none focus:outline-none focus:border-emerald-600"
            placeholder="Paste second item..."
          />
        </div>
      </div>

      {/* Diff result */}
      {diff && (
        <div className="max-h-64 overflow-auto">
          <label className="text-xs text-gray-500 uppercase tracking-wider">Diff</label>
          <pre className="bg-gray-900 border border-gray-800 rounded p-2 text-sm font-mono mt-1">
            {diff.map((chunk, i) => (
              <span
                key={i}
                className={
                  chunk.type === 'added'
                    ? 'bg-emerald-950 text-emerald-300'
                    : chunk.type === 'removed'
                    ? 'bg-red-950 text-red-300'
                    : 'text-gray-400'
                }
              >
                {chunk.value}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
