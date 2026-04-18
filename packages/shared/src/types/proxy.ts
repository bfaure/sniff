export interface ExchangeData {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode: number | null;
  requestHeaders: Record<string, string | string[]>;
  requestBody: Uint8Array | null;
  responseHeaders: Record<string, string | string[]> | null;
  responseBody: Uint8Array | null;
  requestSize: number;
  responseSize: number | null;
  duration: number | null;
  tlsVersion: string | null;
  timestamp: string;
  notes: string | null;
  tags: string[];
  inScope: boolean;
}

export interface ExchangeSummary {
  id: string;
  method: string;
  host: string;
  path: string;
  statusCode: number | null;
  requestSize: number;
  responseSize: number | null;
  duration: number | null;
  timestamp: string;
  contentType: string | null;
  inScope: boolean;
  highlighted: boolean;
}

export interface InterceptedItem {
  id: string;
  type: 'request' | 'response';
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: string | null;
  timestamp: number;
}

export interface ProxyStatus {
  running: boolean;
  port: number;
  interceptEnabled: boolean;
  exchangeCount: number;
}

export interface ProxyConfig {
  port: number;
  interceptEnabled: boolean;
  interceptRequests: boolean;
  interceptResponses: boolean;
}
