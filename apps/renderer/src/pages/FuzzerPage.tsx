import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { appEvents } from '../events/appEvents';
import { wsClient } from '../api/ws';

interface JobConfig {
  name: string;
  attackType: string;
  templateReq: { method: string; url: string; headers: Record<string, string>; body: string | null };
  payloadPositions: string[];
  payloads: string[][];
  concurrency: number;
  throttleMs: number;
}

interface JobInfo {
  id: string;
  name: string;
  attackType: string;
  status: string;
  progress: number;
  total: number;
  createdAt: string;
}

interface ResultRow {
  id: string;
  payloads: string;
  statusCode: number;
  responseSize: number;
  duration: number;
  interesting: boolean;
}

const ATTACK_TYPES = [
  { value: 'single', label: 'Single', description: 'One position at a time' },
  { value: 'parallel', label: 'Parallel', description: 'Same payload in all positions' },
  { value: 'paired', label: 'Paired', description: 'Parallel iteration (zip)' },
  { value: 'cartesian', label: 'Cartesian', description: 'All combinations (cartesian product)' },
];

const DEFAULT_CONFIG: JobConfig = {
  name: '',
  attackType: 'single',
  templateReq: { method: 'GET', url: '', headers: {}, body: null },
  payloadPositions: [],
  payloads: [[]],
  concurrency: 10,
  throttleMs: 0,
};

export function FuzzerPage() {
  const [config, setConfig] = useState<JobConfig>({ ...DEFAULT_CONFIG });
  const [rawUrl, setRawUrl] = useState('');
  const [rawHeaders, setRawHeaders] = useState('');
  const [rawBody, setRawBody] = useState('');
  const [payloadText, setPayloadText] = useState(''); // newline-separated
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [showInteresting, setShowInteresting] = useState(false);
  const [view, setView] = useState<'config' | 'results'>('config');

  // Load jobs on mount
  useEffect(() => {
    loadJobs();
  }, []);

  // Listen for LLM-generated fuzzer configs
  useEffect(() => {
    return appEvents.on('send-to-fuzzer', (data) => {
      setConfig({
        name: data.name,
        attackType: data.attackType,
        templateReq: data.templateReq,
        payloadPositions: data.payloadPositions,
        payloads: data.payloads,
        concurrency: 10,
        throttleMs: 0,
      });
      setRawUrl(data.templateReq.url);
      setRawHeaders(Object.entries(data.templateReq.headers).map(([k, v]) => `${k}: ${v}`).join('\n'));
      setRawBody(data.templateReq.body || '');
      setPayloadText(data.payloads[0]?.join('\n') || '');
      setView('config');
    });
  }, []);

  // Listen for real-time results
  useEffect(() => {
    const unsubResult = wsClient.on('fuzzer:result', (data) => {
      if (selectedJob && data.jobId === selectedJob) {
        setResults((prev) => [...prev, data as unknown as ResultRow]);
      }
    });

    const unsubProgress = wsClient.on('fuzzer:progress', (data) => {
      setJobs((prev) => prev.map((j) =>
        j.id === data.jobId ? { ...j, progress: data.completed, status: 'running' } : j
      ));
    });

    return () => { unsubResult(); unsubProgress(); };
  }, [selectedJob]);

  const loadJobs = async () => {
    try {
      const data = await api.fuzzer.listJobs();
      setJobs(data as JobInfo[]);
    } catch { /* ignore */ }
  };

  const extractPositions = (url: string, body: string, headers: string): string[] => {
    const text = `${url} ${body} ${headers}`;
    const regex = /§([^§]+)§/g;
    const positions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (!positions.includes(match[1])) positions.push(match[1]);
    }
    return positions;
  };

  const createAndStart = async () => {
    const headers: Record<string, string> = {};
    rawHeaders.split('\n').forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const positions = extractPositions(rawUrl, rawBody, rawHeaders);
    const payloads = payloadText.split('\n').filter((l) => l.trim());

    try {
      const { id, total } = await api.fuzzer.createJob({
        name: config.name || `Job ${new Date().toLocaleTimeString()}`,
        attackType: config.attackType,
        templateReq: { method: config.templateReq.method, url: rawUrl, headers, body: rawBody || null },
        payloadPositions: positions,
        payloads: [payloads],
        concurrency: config.concurrency,
        throttleMs: config.throttleMs,
      });

      await api.fuzzer.startJob(id);
      setSelectedJob(id);
      setResults([]);
      setView('results');
      loadJobs();
    } catch (err) {
      console.error('Failed to create job:', err);
    }
  };

  const loadResults = async (jobId: string) => {
    setSelectedJob(jobId);
    try {
      const data = await api.fuzzer.getResults(jobId, showInteresting);
      setResults(data as ResultRow[]);
      setView('results');
    } catch { /* ignore */ }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800">
        <button
          onClick={() => setView('config')}
          className={`px-2 py-1 rounded text-xs ${view === 'config' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Configure
        </button>
        <button
          onClick={() => setView('results')}
          className={`px-2 py-1 rounded text-xs ${view === 'results' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Results
        </button>
        <div className="flex-1" />
        {view === 'config' && (
          <button
            onClick={createAndStart}
            disabled={!rawUrl}
            className="px-3 py-1 rounded text-sm bg-orange-600 hover:bg-orange-700 text-white font-medium disabled:opacity-50"
          >
            Start Attack
          </button>
        )}
      </div>

      {view === 'config' && (
        <div className="flex-1 overflow-auto p-4 space-y-4 max-w-3xl">
          {/* Job name */}
          <div>
            <label className="text-xs text-gray-500 block mb-1">Job Name</label>
            <input
              value={config.name}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-full focus:outline-none focus:border-orange-600"
              placeholder="e.g. IDOR user_id fuzz"
            />
          </div>

          {/* Attack type */}
          <div>
            <label className="text-xs text-gray-500 block mb-1">Attack Type</label>
            <div className="grid grid-cols-2 gap-2">
              {ATTACK_TYPES.map((at) => (
                <button
                  key={at.value}
                  onClick={() => setConfig({ ...config, attackType: at.value })}
                  className={`px-3 py-2 rounded text-left text-sm border ${
                    config.attackType === at.value
                      ? 'border-orange-600 bg-orange-950/50 text-orange-300'
                      : 'border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700'
                  }`}
                >
                  <div className="font-medium">{at.label}</div>
                  <div className="text-[10px] text-gray-600">{at.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Request template */}
          <div>
            <label className="text-xs text-gray-500 block mb-1">
              Request Template <span className="text-gray-700">(mark injection points with §name§)</span>
            </label>
            <div className="flex gap-2 mb-2">
              <select
                value={config.templateReq.method}
                onChange={(e) => setConfig({ ...config, templateReq: { ...config.templateReq, method: e.target.value } })}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300"
              >
                {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <input
                value={rawUrl}
                onChange={(e) => setRawUrl(e.target.value)}
                className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 font-mono focus:outline-none focus:border-orange-600"
                placeholder="http://example.com/api/users/§user_id§"
              />
            </div>
            <textarea
              value={rawHeaders}
              onChange={(e) => setRawHeaders(e.target.value)}
              rows={3}
              className="w-full bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300 font-mono focus:outline-none focus:border-orange-600 mb-2"
              placeholder="Header-Name: value&#10;Authorization: Bearer §token§"
            />
            <textarea
              value={rawBody}
              onChange={(e) => setRawBody(e.target.value)}
              rows={3}
              className="w-full bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300 font-mono focus:outline-none focus:border-orange-600"
              placeholder='Request body (optional)&#10;{"username": "§user§", "role": "admin"}'
            />
            {extractPositions(rawUrl, rawBody, rawHeaders).length > 0 && (
              <div className="mt-1 text-[10px] text-orange-400">
                Positions: {extractPositions(rawUrl, rawBody, rawHeaders).map((p) => `§${p}§`).join(', ')}
              </div>
            )}
          </div>

          {/* Payloads */}
          <div>
            <label className="text-xs text-gray-500 block mb-1">Payloads (one per line)</label>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              rows={8}
              className="w-full bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300 font-mono focus:outline-none focus:border-orange-600"
              placeholder="1&#10;2&#10;3&#10;admin&#10;' OR 1=1--&#10;../../etc/passwd"
            />
            <div className="text-[10px] text-gray-600 mt-1">
              {payloadText.split('\n').filter((l) => l.trim()).length} payloads
            </div>
          </div>

          {/* Options */}
          <div className="flex gap-4">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Concurrency</label>
              <input
                type="number"
                min={1}
                max={100}
                value={config.concurrency}
                onChange={(e) => setConfig({ ...config, concurrency: parseInt(e.target.value) || 10 })}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-20"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Throttle (ms)</label>
              <input
                type="number"
                min={0}
                value={config.throttleMs}
                onChange={(e) => setConfig({ ...config, throttleMs: parseInt(e.target.value) || 0 })}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-sm text-gray-300 w-20"
              />
            </div>
          </div>
        </div>
      )}

      {view === 'results' && (
        <div className="flex-1 flex overflow-hidden">
          {/* Job list */}
          <div className="w-48 border-r border-gray-800 overflow-auto">
            <div className="px-2 py-1.5 text-xs text-gray-500 uppercase tracking-wider border-b border-gray-800">
              Jobs
            </div>
            {jobs.map((job) => (
              <button
                key={job.id}
                onClick={() => loadResults(job.id)}
                className={`w-full text-left px-2 py-1.5 text-xs border-b border-gray-800/50 ${
                  selectedJob === job.id ? 'bg-gray-800 text-orange-400' : 'text-gray-400 hover:bg-gray-800/50'
                }`}
              >
                <div className="font-medium truncate">{job.name}</div>
                <div className="text-[10px] text-gray-600 flex items-center gap-2">
                  <span>{job.attackType}</span>
                  <span>{job.progress}/{job.total}</span>
                  <span className={
                    job.status === 'running' ? 'text-emerald-400' :
                    job.status === 'done' ? 'text-gray-500' :
                    job.status === 'cancelled' ? 'text-red-400' : 'text-gray-600'
                  }>{job.status}</span>
                </div>
              </button>
            ))}
            {jobs.length === 0 && (
              <div className="px-2 py-4 text-xs text-gray-600 text-center">No jobs yet</div>
            )}
          </div>

          {/* Results table */}
          <div className="flex-1 overflow-auto">
            {selectedJob ? (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-900 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-1.5 w-8">#</th>
                    <th className="text-left px-3 py-1.5">Payload</th>
                    <th className="text-left px-3 py-1.5 w-16">Status</th>
                    <th className="text-right px-3 py-1.5 w-20">Size</th>
                    <th className="text-right px-3 py-1.5 w-16">Time</th>
                    <th className="text-center px-3 py-1.5 w-8">!</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => {
                    const payloads = typeof r.payloads === 'string' ? JSON.parse(r.payloads) : r.payloads;
                    return (
                      <tr
                        key={r.id}
                        className={`border-b border-gray-800/30 ${r.interesting ? 'bg-orange-950/30' : ''}`}
                      >
                        <td className="px-3 py-1 text-gray-600">{i + 1}</td>
                        <td className="px-3 py-1 text-gray-300 font-mono text-xs truncate max-w-xs">
                          {(payloads as string[]).join(', ')}
                        </td>
                        <td className="px-3 py-1">
                          <span className={`text-xs font-bold ${
                            r.statusCode >= 500 ? 'text-red-400' :
                            r.statusCode >= 400 ? 'text-amber-400' :
                            r.statusCode >= 300 ? 'text-blue-400' :
                            r.statusCode >= 200 ? 'text-emerald-400' :
                            'text-gray-500'
                          }`}>{r.statusCode || 'ERR'}</span>
                        </td>
                        <td className="px-3 py-1 text-right text-gray-500 text-xs">{r.responseSize}B</td>
                        <td className="px-3 py-1 text-right text-gray-500 text-xs">{r.duration}ms</td>
                        <td className="px-3 py-1 text-center">
                          {r.interesting && <span className="text-orange-400 text-xs">*</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="flex items-center justify-center h-48 text-gray-600 text-sm">
                Select a job to view results
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
