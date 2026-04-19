import { useState, useEffect, useCallback } from 'react';

type Theme = 'dark' | 'light';

const THEME_KEY = 'sniff-theme';
const FONT_SIZE_KEY = 'sniff-font-size';

const FONT_SIZES = [12, 13, 14, 15, 16] as const;
type FontSize = typeof FONT_SIZES[number];

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'dark';
}

function getInitialFontSize(): FontSize {
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored) {
      const num = parseInt(stored, 10);
      if (FONT_SIZES.includes(num as FontSize)) return num as FontSize;
    }
  } catch {}
  return 13;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(theme);

  document.body.className = 'bg-gray-950 text-gray-100 antialiased';

  // Tell the Electron main process to flip the native title bar to match.
  // The bridge is only present in the packaged Electron build; in the dev
  // browser there's no native frame to update so we no-op.
  const bridge = (window as unknown as { sniff?: { setNativeTheme?: (m: 'light' | 'dark' | 'system') => void } }).sniff;
  bridge?.setNativeTheme?.(theme);
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.fontSize = `${size}px`;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const [fontSize, setFontSizeState] = useState<FontSize>(getInitialFontSize);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { applyFontSize(fontSize); }, [fontSize]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const setFontSize = useCallback((s: FontSize) => {
    setFontSizeState(s);
    try { localStorage.setItem(FONT_SIZE_KEY, String(s)); } catch {}
  }, []);

  return { theme, setTheme, toggle, fontSize, setFontSize, fontSizes: FONT_SIZES };
}
