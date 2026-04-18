export interface ScopeRule {
  id: string;
  type: 'include' | 'exclude';
  protocol: string | null;
  host: string;
  port: number | null;
  path: string | null;
  enabled: boolean;
  order: number;
}

export interface ScopeTestResult {
  url: string;
  inScope: boolean;
  matchedRule: ScopeRule | null;
}
