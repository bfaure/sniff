import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';

interface Command {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: string) => void;
}

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme, fontSize, setFontSize } = useTheme();

  const commands: Command[] = [
    // Navigation
    { id: 'nav-history', label: 'Go to History', category: 'Navigate', shortcut: 'Cmd+1', action: () => onNavigate('history') },
    { id: 'nav-hold', label: 'Go to Hold', category: 'Navigate', shortcut: 'Cmd+2', action: () => onNavigate('proxy') },
    { id: 'nav-replay', label: 'Go to Replay', category: 'Navigate', shortcut: 'Cmd+3', action: () => onNavigate('replay') },
    { id: 'nav-fuzzer', label: 'Go to Fuzzer', category: 'Navigate', shortcut: 'Cmd+4', action: () => onNavigate('fuzzer') },
    { id: 'nav-decoder', label: 'Go to Decoder', category: 'Navigate', shortcut: 'Cmd+5', action: () => onNavigate('decoder') },
    { id: 'nav-comparer', label: 'Go to Comparer', category: 'Navigate', shortcut: 'Cmd+6', action: () => onNavigate('comparer') },
    { id: 'nav-sitemap', label: 'Go to Site Map', category: 'Navigate', shortcut: 'Cmd+7', action: () => onNavigate('sitemap') },
    { id: 'nav-scope', label: 'Go to Scope', category: 'Navigate', shortcut: 'Cmd+8', action: () => onNavigate('scope') },
    { id: 'nav-findings', label: 'Go to Findings', category: 'Navigate', shortcut: 'Cmd+9', action: () => onNavigate('findings') },
    { id: 'nav-ai', label: 'Go to AI Activity', category: 'Navigate', action: () => onNavigate('ai-activity') },
    { id: 'nav-chat', label: 'Go to AI Chat', category: 'Navigate', action: () => onNavigate('chat') },
    { id: 'nav-settings', label: 'Go to Settings', category: 'Navigate', action: () => onNavigate('settings') },

    // Theme
    { id: 'theme-dark', label: 'Switch to Dark Mode', category: 'Appearance', action: () => setTheme('dark') },
    { id: 'theme-light', label: 'Switch to Light Mode', category: 'Appearance', action: () => setTheme('light') },
    { id: 'theme-toggle', label: `Toggle Theme (currently ${theme})`, category: 'Appearance', action: () => setTheme(theme === 'dark' ? 'light' : 'dark') },

    // Font size
    { id: 'font-increase', label: `Increase Font Size (currently ${fontSize}px)`, category: 'Appearance', action: () => { const sizes = [12,13,14,15,16]; const idx = sizes.indexOf(fontSize); if (idx < sizes.length - 1) setFontSize(sizes[idx+1] as any); } },
    { id: 'font-decrease', label: `Decrease Font Size (currently ${fontSize}px)`, category: 'Appearance', action: () => { const sizes = [12,13,14,15,16]; const idx = sizes.indexOf(fontSize); if (idx > 0) setFontSize(sizes[idx-1] as any); } },
    { id: 'font-12', label: 'Font Size: 12px', category: 'Appearance', action: () => setFontSize(12 as any) },
    { id: 'font-14', label: 'Font Size: 14px', category: 'Appearance', action: () => setFontSize(14 as any) },
    { id: 'font-16', label: 'Font Size: 16px', category: 'Appearance', action: () => setFontSize(16 as any) },
  ];

  const filtered = query.trim()
    ? commands.filter((cmd) => {
        const q = query.toLowerCase();
        return cmd.label.toLowerCase().includes(q) || cmd.category.toLowerCase().includes(q);
      })
    : commands;

  // Reset selection when query changes
  useEffect(() => { setSelectedIdx(0); }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-cmd-item]');
    items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const runCommand = useCallback((cmd: Command) => {
    cmd.action();
    onClose();
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIdx]) {
      e.preventDefault();
      runCommand(filtered[selectedIdx]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!open) return null;

  // Group by category
  const groups: { category: string; items: Command[] }[] = [];
  for (const cmd of filtered) {
    const existing = groups.find((g) => g.category === cmd.category);
    if (existing) existing.items.push(cmd);
    else groups.push({ category: cmd.category, items: [cmd] });
  }

  let flatIdx = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative w-[500px] max-h-[60vh] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-gray-800">
          <span className="text-gray-500 mr-2 text-sm">{'>'}</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-gray-600 text-sm">No matching commands</div>
          )}
          {groups.map((group) => (
            <div key={group.category}>
              <div className="px-4 py-1 text-[10px] font-bold text-gray-600 uppercase tracking-wider">
                {group.category}
              </div>
              {group.items.map((cmd) => {
                const idx = flatIdx++;
                const isSelected = idx === selectedIdx;
                return (
                  <button
                    key={cmd.id}
                    data-cmd-item
                    onClick={() => runCommand(cmd)}
                    onMouseEnter={() => setSelectedIdx(idx)}
                    className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between ${
                      isSelected
                        ? 'bg-emerald-900/30 text-emerald-300'
                        : 'text-gray-300 hover:bg-gray-800/50'
                    }`}
                  >
                    <span>{cmd.label}</span>
                    {cmd.shortcut && (
                      <span className="text-[10px] text-gray-600 font-mono">{cmd.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
