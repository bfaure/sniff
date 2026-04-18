import React from 'react';

interface PillToggleProps {
  enabled: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  enabledLabel?: string;
  disabledLabel?: string;
}

export function PillToggle({ enabled, onChange, label, enabledLabel = 'ON', disabledLabel = 'OFF' }: PillToggleProps) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-sm text-gray-400">{label}</span>}
      <button
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          enabled ? 'bg-emerald-600' : 'bg-gray-700'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className={`text-xs font-mono ${enabled ? 'text-emerald-400' : 'text-gray-500'}`}>
        {enabled ? enabledLabel : disabledLabel}
      </span>
    </div>
  );
}
