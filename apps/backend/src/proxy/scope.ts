import { db } from '../db.js';

interface ParsedUrl {
  protocol: string;
  host: string;
  port: number | null;
  path: string;
}

function parseUrl(url: string): ParsedUrl {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : null,
      path: parsed.pathname + parsed.search,
    };
  } catch {
    return { protocol: 'http', host: '', port: null, path: '/' };
  }
}

function globMatch(pattern: string, value: string): boolean {
  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export async function isInScope(url: string): Promise<boolean> {
  const rules = await db.scopeRule.findMany({
    where: { enabled: true },
    orderBy: { order: 'asc' },
  });

  // If no rules exist, everything is in scope
  if (rules.length === 0) return true;

  const parsed = parseUrl(url);

  for (const rule of rules) {
    // Check protocol
    if (rule.protocol && rule.protocol !== '*' && rule.protocol !== parsed.protocol) {
      continue;
    }

    // Check host
    if (!globMatch(rule.host, parsed.host)) {
      continue;
    }

    // Check port
    if (rule.port !== null && rule.port !== parsed.port) {
      continue;
    }

    // Check path
    if (rule.path && !globMatch(rule.path, parsed.path)) {
      continue;
    }

    // Rule matched — return based on type
    return rule.type === 'include';
  }

  // No rule matched — default: in scope if there are only exclude rules,
  // out of scope if there are include rules
  const hasIncludeRules = rules.some((r) => r.type === 'include');
  return !hasIncludeRules;
}

export { globMatch, parseUrl };
