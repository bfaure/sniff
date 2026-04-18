export interface ScopeRule {
  type: string;
  host: string;
  protocol?: string | null;
  port?: number | null;
  path?: string | null;
  enabled?: boolean;
}

export interface ScopeOption {
  label: string;
  description: string;
  rule: { type: string; host: string; protocol?: string; port?: number; path?: string };
}

/**
 * Check if a proposed scope rule is already covered by an existing rule.
 * Returns the matching existing rule's host (for display) or null.
 */
function ruleMatches(existing: ScopeRule, proposed: ScopeOption['rule']): boolean {
  if (existing.type !== proposed.type) return false;
  if (existing.host !== proposed.host) return false;
  // A broader existing rule (no path/protocol/port) covers a narrower proposed one
  const existingPath = existing.path || undefined;
  const existingProto = existing.protocol || undefined;
  const existingPort = existing.port || undefined;
  const proposedPath = proposed.path;
  const proposedProto = proposed.protocol;
  const proposedPort = proposed.port;

  // Exact match
  if (existingPath === proposedPath && existingProto === proposedProto && existingPort === proposedPort) {
    return true;
  }
  // Broader rule: existing has no path/protocol/port constraints, proposed does
  if (!existingPath && !existingProto && !existingPort) {
    return true;
  }
  return false;
}

/**
 * For each option, check if it's already covered by an existing scope rule.
 * Returns a map from option index to the reason it's covered (e.g. "Already covered by: example.com").
 */
export function checkExistingCoverage(
  options: ScopeOption[],
  existingRules: ScopeRule[],
): Map<number, string> {
  const coverage = new Map<number, string>();
  const enabledRules = existingRules.filter((r) => r.enabled !== false);
  for (let i = 0; i < options.length; i++) {
    for (const rule of enabledRules) {
      if (ruleMatches(rule, options[i].rule)) {
        const parts = [rule.host];
        if (rule.path) parts.push(rule.path);
        if (rule.protocol) parts.unshift(rule.protocol + '://');
        coverage.set(i, `Already covered by: ${parts.join('')}`);
        break;
      }
    }
  }
  return coverage;
}

export function buildScopeOptions(rawUrl: string): ScopeOption[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }

  const host = parsed.hostname;
  const protocol = parsed.protocol.replace(':', '');
  const port = parsed.port ? Number(parsed.port) : undefined;
  const pathSegments = parsed.pathname.split('/').filter(Boolean);
  const options: ScopeOption[] = [];

  // Host only
  options.push({
    label: `Host: ${host}`,
    description: `All traffic to ${host} (any path, any protocol)`,
    rule: { type: 'include', host },
  });

  // Host + protocol
  options.push({
    label: `Host + Protocol: ${protocol}://${host}`,
    description: `Only ${protocol.toUpperCase()} traffic to ${host}`,
    rule: { type: 'include', host, protocol },
  });

  // Host + port (if non-standard)
  if (port) {
    options.push({
      label: `Host + Port: ${host}:${port}`,
      description: `Only traffic to ${host} on port ${port}`,
      rule: { type: 'include', host, port },
    });
  }

  // Host + path prefixes (build up path segments)
  let pathPrefix = '';
  for (const seg of pathSegments) {
    pathPrefix += '/' + seg;
    options.push({
      label: `Path prefix: ${host}${pathPrefix}/*`,
      description: `Traffic to ${host} under ${pathPrefix}/`,
      rule: { type: 'include', host, path: pathPrefix + '/*' },
    });
  }

  // Exact path
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    options.push({
      label: `Exact path: ${host}${parsed.pathname}`,
      description: `Only this exact endpoint`,
      rule: { type: 'include', host, path: parsed.pathname },
    });
  }

  // Wildcard subdomain
  const parts = host.split('.');
  if (parts.length > 2) {
    const wildcard = '*.' + parts.slice(1).join('.');
    options.push({
      label: `Wildcard: ${wildcard}`,
      description: `All subdomains of ${parts.slice(1).join('.')}`,
      rule: { type: 'include', host: wildcard },
    });
  }

  return options;
}
