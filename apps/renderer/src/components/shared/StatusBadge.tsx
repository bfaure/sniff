import React, { useState, useRef } from 'react';

interface StatusBadgeProps {
  statusCode: number | null;
}

function statusColor(code: number | null): string {
  if (!code) return 'text-gray-500';
  if (code < 200) return 'text-blue-400';
  if (code < 300) return 'text-emerald-400';
  if (code < 400) return 'text-cyan-400';
  if (code < 500) return 'text-amber-400';
  return 'text-red-400';
}

function statusBg(code: number | null): string {
  if (!code) return 'bg-gray-800';
  if (code < 200) return 'bg-blue-950';
  if (code < 300) return 'bg-emerald-950';
  if (code < 400) return 'bg-cyan-950';
  if (code < 500) return 'bg-amber-950';
  return 'bg-red-950';
}

const STATUS_DESCRIPTIONS: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found (Temporary Redirect)',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized — authentication required',
  403: 'Forbidden — server refuses to authorize',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone — resource permanently removed',
  411: 'Length Required',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  418: "I'm a Teapot",
  422: 'Unprocessable Entity',
  429: 'Too Many Requests — rate limited',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function statusDescription(code: number | null): string {
  if (!code) return '';
  if (STATUS_DESCRIPTIONS[code]) return `${code} ${STATUS_DESCRIPTIONS[code]}`;
  if (code < 200) return `${code} Informational`;
  if (code < 300) return `${code} Success`;
  if (code < 400) return `${code} Redirection`;
  if (code < 500) return `${code} Client Error`;
  return `${code} Server Error`;
}

export function StatusBadge({ statusCode }: StatusBadgeProps) {
  const desc = statusDescription(statusCode);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const onEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setHover(true);
  };

  return (
    <span
      ref={ref}
      className="inline-block"
      onMouseEnter={onEnter}
      onMouseLeave={() => setHover(false)}
    >
      <span
        className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono font-bold ${statusColor(statusCode)} ${statusBg(statusCode)} cursor-default`}
      >
        {statusCode ?? '---'}
      </span>
      {desc && hover && (
        <span
          className="fixed px-2 py-0.5 rounded bg-gray-800 text-gray-200 text-[11px] whitespace-nowrap pointer-events-none border border-gray-700 shadow-lg"
          style={{ zIndex: 99999, left: pos.x, top: pos.y, transform: 'translate(-50%, -100%) translateY(-4px)' }}
        >
          {desc}
        </span>
      )}
    </span>
  );
}
