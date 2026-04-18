import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { wsClient } from '../../api/ws';

export function StatusBar() {
  const [proxyStatus, setProxyStatus] = useState({
    running: false,
    port: 8080,
    interceptEnabled: false,
  });
  const [sessionCost, setSessionCost] = useState(0);
  const [findingsCount, setFindingsCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);

  useEffect(() => {
    api.proxy.status().then((data) => {
      setProxyStatus({ running: data.running, port: data.port, interceptEnabled: data.interceptEnabled });
    }).catch(() => {});

    const unsubProxy = wsClient.on('proxy:status', (data) => {
      setProxyStatus(data);
    });

    const unsubCost = wsClient.on('cost:update', (data) => {
      setSessionCost(data.sessionTotal);
    });

    const unsubLLM = wsClient.on('llm:done', (data) => {
      if (data.costUsd > 0) {
        setSessionCost((prev) => prev + data.costUsd);
      }
    });

    const unsubFinding = wsClient.on('llm:finding', (data) => {
      setFindingsCount((prev) => prev + 1);
      if (data.severity === 'critical' || data.severity === 'high') {
        setCriticalCount((prev) => prev + 1);
      }
    });

    return () => {
      unsubProxy();
      unsubCost();
      unsubLLM();
      unsubFinding();
    };
  }, []);

  return (
    <div className="h-6 bg-gray-900 border-t border-gray-800 flex items-center px-3 text-[11px] font-mono gap-4">
      <div className="flex items-center gap-1.5">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            proxyStatus.running ? 'bg-emerald-400' : 'bg-gray-600'
          }`}
        />
        <span className="text-gray-400">
          Proxy: {proxyStatus.running ? `port ${proxyStatus.port}` : 'stopped'}
        </span>
      </div>

      <div className="text-gray-500">|</div>

      <div className="text-gray-400">
        Hold: {proxyStatus.interceptEnabled ? (
          <span className="text-amber-400">ON</span>
        ) : (
          <span className="text-gray-600">OFF</span>
        )}
      </div>

      {findingsCount > 0 && (
        <>
          <div className="text-gray-500">|</div>
          <div className="flex items-center gap-1.5">
            {criticalCount > 0 && (
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            )}
            <span className={criticalCount > 0 ? 'text-red-400' : 'text-purple-400'}>
              {findingsCount} finding{findingsCount !== 1 ? 's' : ''}
              {criticalCount > 0 && ` (${criticalCount} critical/high)`}
            </span>
          </div>
        </>
      )}

      <div className="flex-1" />

      {sessionCost > 0 && (
        <div className="text-gray-500">
          LLM cost: <span className="text-amber-400">${sessionCost.toFixed(4)}</span>
        </div>
      )}

      <span className="text-gray-600 text-[10px]">Cmd+Shift+P</span>
    </div>
  );
}
