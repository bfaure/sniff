import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { ProjectSelector } from './ProjectSelector';
import { findingsStore } from '../../stores/findingsStore';

interface NavItem {
  id: string;
  label: string;
  shortcut?: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Traffic',
    items: [
      { id: 'history', label: 'History', shortcut: '1' },
      { id: 'proxy', label: 'Hold', shortcut: '2' },
      { id: 'failed', label: 'Failed' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'replay', label: 'Replay', shortcut: '3' },
      { id: 'fuzzer', label: 'Fuzzer', shortcut: '4' },
      { id: 'decoder', label: 'Decoder', shortcut: '5' },
      { id: 'comparer', label: 'Comparer', shortcut: '6' },
    ],
  },
  {
    label: 'Target',
    items: [
      { id: 'sitemap', label: 'Site Map', shortcut: '7' },
      { id: 'scope', label: 'Scope', shortcut: '8' },
    ],
  },
  {
    label: 'AI',
    items: [
      { id: 'findings', label: 'Findings', shortcut: '9' },
      { id: 'ai-activity', label: 'Activity' },
      { id: 'chat', label: 'Chat' },
    ],
  },
];

const PINNED_STORAGE_KEY = 'sniff-pinned-nav';

function loadPinned(): Set<string> {
  try {
    const saved = localStorage.getItem(PINNED_STORAGE_KEY);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch { return new Set(); }
}

function savePinned(pinned: Set<string>) {
  localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...pinned]));
}

interface SidebarProps {
  activePage: string;
  onNavigate: (page: string) => void;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const allFindings = useSyncExternalStore(findingsStore.subscribe, findingsStore.getFindings);
  const lastSeen = findingsStore.getLastSeenTimestamp();
  const [pinned, setPinned] = useState<Set<string>>(loadPinned);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // Mark all as seen when user visits findings page
  useEffect(() => {
    if (activePage === 'findings') {
      findingsStore.markSeen();
    }
  }, [activePage, allFindings.length]);

  const newCount = lastSeen === 0
    ? 0 // first load — don't badge everything
    : allFindings.filter((f) => f.timestamp > lastSeen).length;
  const hasCritical = newCount > 0 && allFindings
    .filter((f) => f.timestamp > lastSeen)
    .some((f) => f.severity === 'critical' || f.severity === 'high');

  const togglePin = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(pinned);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPinned(next);
    savePinned(next);
  };

  const toggleSection = (label: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // Collect pinned items in order
  const allItems = NAV_SECTIONS.flatMap((s) => s.items);
  const pinnedItems = allItems.filter((item) => pinned.has(item.id));

  const renderNavButton = (item: NavItem, isPinnedSection: boolean) => {
    const isActive = activePage === item.id;
    return (
      <button
        key={item.id}
        onClick={() => onNavigate(item.id)}
        className={`w-full text-left px-4 py-1.5 text-sm flex items-center justify-between transition-colors group ${
          isActive
            ? 'bg-gray-800 text-emerald-400 border-l-2 border-emerald-400'
            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 border-l-2 border-transparent'
        }`}
      >
        <span className="flex items-center gap-2">
          {item.label}
          {item.id === 'findings' && newCount > 0 && activePage !== 'findings' && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
              hasCritical
                ? 'bg-red-600 text-white animate-pulse'
                : 'bg-purple-600 text-white'
            }`}>
              {newCount}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          <button
            onClick={(e) => togglePin(item.id, e)}
            className={`text-[10px] transition-opacity ${
              pinned.has(item.id)
                ? 'text-emerald-500 opacity-60 hover:opacity-100'
                : 'text-gray-700 opacity-0 group-hover:opacity-100 hover:text-gray-400'
            }`}
            title={pinned.has(item.id) ? 'Unpin' : 'Pin to top'}
          >
            {pinned.has(item.id) ? '\u25C6' : '\u25C7'}
          </button>
          {item.shortcut && (
            <span className="text-[10px] text-gray-600 w-3 text-right">{item.shortcut}</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <nav className="w-48 bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-lg font-bold text-emerald-400 tracking-wider">SNIFF</h1>
        <p className="text-[10px] text-gray-600 mt-0.5">interception proxy</p>
      </div>

      <ProjectSelector />

      <div className="flex-1 overflow-auto py-1">
        {/* Pinned items */}
        {pinnedItems.length > 0 && (
          <div className="mb-1 pb-1 border-b border-gray-800/50">
            {pinnedItems.map((item) => renderNavButton(item, true))}
          </div>
        )}

        {/* Sections */}
        {NAV_SECTIONS.map((section) => {
          const isCollapsed = collapsedSections.has(section.label);
          // Items not pinned (pinned ones show at top already)
          const visibleItems = section.items.filter((item) => !pinned.has(item.id));
          // If all items pinned, still show section header but collapsed
          const hasActiveItem = section.items.some((item) => activePage === item.id);

          return (
            <div key={section.label} className="mb-0.5">
              <button
                onClick={() => toggleSection(section.label)}
                className="w-full flex items-center px-4 py-1 text-[10px] font-bold text-gray-600 uppercase tracking-wider hover:text-gray-400"
              >
                <span className="w-3 text-center mr-1">{isCollapsed ? '\u25B8' : '\u25BE'}</span>
                {section.label}
              </button>
              {!isCollapsed && visibleItems.map((item) => renderNavButton(item, false))}
            </div>
          );
        })}
      </div>

      {/* Settings pinned to bottom */}
      <div className="border-t border-gray-800">
        <button
          onClick={() => onNavigate('settings')}
          className={`w-full text-left px-4 py-2 text-sm flex items-center transition-colors ${
            activePage === 'settings'
              ? 'bg-gray-800 text-emerald-400 border-l-2 border-emerald-400'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 border-l-2 border-transparent'
          }`}
        >
          Settings
        </button>
      </div>
    </nav>
  );
}
