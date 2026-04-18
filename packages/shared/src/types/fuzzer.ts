export type AttackType = 'single' | 'parallel' | 'paired' | 'cartesian';

export type FuzzerJobStatus = 'pending' | 'running' | 'paused' | 'done' | 'cancelled';

export interface FuzzerJobData {
  id: string;
  name: string;
  attackType: AttackType;
  templateReq: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  };
  payloadPositions: string[];
  payloads: string[][];
  status: FuzzerJobStatus;
  progress: number;
  total: number;
  concurrency: number;
  throttleMs: number;
  createdAt: string;
}

export interface FuzzerResultData {
  id: string;
  jobId: string;
  payloads: string[];
  statusCode: number;
  responseSize: number;
  duration: number;
  interesting: boolean;
}
