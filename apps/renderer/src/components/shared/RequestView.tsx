import React from 'react';

interface RequestViewProps {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: string | null;
}

function methodColor(method: string): string {
  const colors: Record<string, string> = {
    GET: 'text-emerald-400',
    POST: 'text-blue-400',
    PUT: 'text-amber-400',
    PATCH: 'text-orange-400',
    DELETE: 'text-red-400',
    OPTIONS: 'text-purple-400',
    HEAD: 'text-gray-400',
  };
  return colors[method] || 'text-gray-300';
}

export function RequestView({ method, url, headers, body }: RequestViewProps) {
  return (
    <div className="font-mono text-sm space-y-3">
      <div className="flex items-center gap-2">
        <span className={`font-bold ${methodColor(method)}`}>{method}</span>
        <span className="text-gray-300 break-all">{url}</span>
      </div>

      <div>
        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-1">Headers</h4>
        <div className="bg-gray-900 rounded p-2 space-y-0.5">
          {Object.entries(headers).map(([key, value]) => (
            <div key={key} className="flex">
              <span className="text-cyan-400 min-w-[150px] shrink-0">{key}:</span>
              <span className="text-gray-300 break-all">
                {Array.isArray(value) ? value.join(', ') : value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {body && (
        <div>
          <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-1">Body</h4>
          <pre className="bg-gray-900 rounded p-2 text-gray-300 whitespace-pre-wrap break-all max-h-64 overflow-auto">
            {body}
          </pre>
        </div>
      )}
    </div>
  );
}

export { methodColor };
