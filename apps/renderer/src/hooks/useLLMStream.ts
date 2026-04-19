import { useState, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { wsClient } from '../api/ws';
import type { AnalysisType } from '@sniff/shared';

interface LLMStreamState {
  streaming: boolean;
  text: string;
  error: string | null;
  errorCode: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function useLLMStream() {
  const [state, setState] = useState<LLMStreamState>({
    streaming: false,
    text: '',
    error: null,
    errorCode: null,
    modelId: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });

  const cleanupRef = useRef<(() => void) | null>(null);

  const analyze = useCallback(async (
    exchangeId: string,
    type: AnalysisType,
    userMessage?: string,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => {
    // Clean up previous stream listeners
    cleanupRef.current?.();

    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setState({ streaming: true, text: '', error: null, errorCode: null, modelId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const unsubChunk = wsClient.on('llm:chunk', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({ ...prev, text: prev.text + data.text }));
      }
    });

    const unsubDone = wsClient.on('llm:done', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({
          ...prev,
          streaming: false,
          modelId: data.modelId,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          error: data.error || null,
          errorCode: data.errorCode || null,
        }));
        unsubChunk();
        unsubDone();
      }
    });

    cleanupRef.current = () => { unsubChunk(); unsubDone(); };

    try {
      await api.llm.analyzeStream(exchangeId, type, streamId, userMessage, conversationHistory);
    } catch (err) {
      setState((prev) => ({ ...prev, streaming: false, error: (err as Error).message }));
      unsubChunk();
      unsubDone();
    }
  }, []);

  const projectChat = useCallback(async (
    userMessage: string,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
    exchangeIds?: string[],
  ) => {
    cleanupRef.current?.();

    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setState({ streaming: true, text: '', error: null, errorCode: null, modelId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const unsubChunk = wsClient.on('llm:chunk', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({ ...prev, text: prev.text + data.text }));
      }
    });

    const unsubDone = wsClient.on('llm:done', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({
          ...prev,
          streaming: false,
          modelId: data.modelId,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          error: data.error || null,
          errorCode: data.errorCode || null,
        }));
        unsubChunk();
        unsubDone();
      }
    });

    cleanupRef.current = () => { unsubChunk(); unsubDone(); };

    try {
      await api.llm.projectChatStream(userMessage, streamId, conversationHistory, exchangeIds);
    } catch (err) {
      setState((prev) => ({ ...prev, streaming: false, error: (err as Error).message }));
      unsubChunk();
      unsubDone();
    }
  }, []);

  const guidedTest = useCallback(async (
    vulnType: string | undefined,
    exchange: {
      method: string;
      url: string;
      requestHeaders: Record<string, string>;
      requestBody: string | null;
      statusCode: number | null;
      responseHeaders: Record<string, string> | null;
      responseBody: string | null;
    },
    userMessage?: string,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => {
    cleanupRef.current?.();

    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setState({ streaming: true, text: '', error: null, errorCode: null, modelId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const unsubChunk = wsClient.on('llm:chunk', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({ ...prev, text: prev.text + data.text }));
      }
    });

    const unsubDone = wsClient.on('llm:done', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({
          ...prev,
          streaming: false,
          modelId: data.modelId,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          error: data.error || null,
          errorCode: data.errorCode || null,
        }));
        unsubChunk();
        unsubDone();
      }
    });

    cleanupRef.current = () => { unsubChunk(); unsubDone(); };

    try {
      await api.llm.guidedTestStream(vulnType, exchange, streamId, userMessage, conversationHistory);
    } catch (err) {
      setState((prev) => ({ ...prev, streaming: false, error: (err as Error).message }));
      unsubChunk();
      unsubDone();
    }
  }, []);

  const chainAnalysis = useCallback(async (host: string) => {
    cleanupRef.current?.();
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setState({ streaming: true, text: '', error: null, errorCode: null, modelId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const unsubChunk = wsClient.on('llm:chunk', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({ ...prev, text: prev.text + data.text }));
      }
    });
    const unsubDone = wsClient.on('llm:done', (data) => {
      if (data.streamId === streamId) {
        setState((prev) => ({
          ...prev,
          streaming: false,
          modelId: data.modelId,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          error: data.error || null,
          errorCode: data.errorCode || null,
        }));
        unsubChunk();
        unsubDone();
      }
    });
    cleanupRef.current = () => { unsubChunk(); unsubDone(); };

    try {
      await api.llm.chainAnalysisStream(host, streamId);
    } catch (err) {
      setState((prev) => ({ ...prev, streaming: false, error: (err as Error).message }));
      unsubChunk();
      unsubDone();
    }
  }, []);

  const reset = useCallback(() => {
    cleanupRef.current?.();
    setState({ streaming: false, text: '', error: null, errorCode: null, modelId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  }, []);

  return { ...state, analyze, projectChat, guidedTest, chainAnalysis, reset };
}
