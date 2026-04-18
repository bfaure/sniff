export type LLMProvider = 'bedrock' | 'openai';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisResult {
  id: string;
  exchangeId: string;
  modelId: string;
  type: AnalysisType;
  response: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

export type AnalysisType =
  | 'vuln-scan'
  | 'explain'
  | 'suggest-followup'
  | 'generate-payloads'
  | 'pentest-pathway'
  | 'chat';

export interface VulnFinding {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  evidence: string;
  explanation: string;
  suggestedTest: string | null;
}

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
}

export interface CostSummary {
  sessionTotal: number;
  dailyTotal: number;
  allTimeTotal: number;
}

export interface ModelPricing {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
}
