import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { URL } from 'url';
import { db } from '../db.js';
import { isInScope } from './scope.js';
import { InterceptQueue } from './intercept.js';
import { generateCACertificate, generateHostCertificate, type CACert } from './ca.js';
import type { ExchangeSummary } from '@sniff/shared';

export type ProxyEventListener = (event: string, data: unknown) => void;

export class ProxyEngine {
  private server: http.Server | null = null;
  private _port: number;
  private _running = false;
  private exchangeCount = 0;
  private ca: CACert | null = null;
  private certCache = new Map<string, tls.SecureContext>();
  readonly intercept = new InterceptQueue();
  private listeners: ProxyEventListener[] = [];

  constructor(port = 8080) {
    this._port = port;
  }

  get port(): number {
    return this._port;
  }

  get running(): boolean {
    return this._running;
  }

  onEvent(listener: ProxyEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      listener(event, data);
    }
  }

  async start(): Promise<void> {
    if (this._running) return;

    // Generate or load CA certificate
    this.ca = await generateCACertificate();

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.server.on('connect', (req, clientSocket: net.Socket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    this.server.on('error', (err) => {
      console.error('[proxy] server error:', err.message);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this._port, '0.0.0.0', () => {
        this._running = true;
        console.log(`[proxy] listening on port ${this._port}`);
        this.emit('proxy:status', this.getStatus());
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this._running || !this.server) return;

    this.intercept.forwardAll();

    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        this._running = false;
        console.log('[proxy] stopped');
        this.emit('proxy:status', this.getStatus());
        resolve();
      });
    });

    this.server = null;
  }

  getStatus() {
    return {
      running: this._running,
      port: this._port,
      interceptEnabled: this.intercept.enabled,
      exchangeCount: this.exchangeCount,
    };
  }

  // Handle plain HTTP proxy requests
  private async handleHttpRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ): Promise<void> {
    const startTime = Date.now();
    const url = clientReq.url || '/';

    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch {
      clientRes.writeHead(400);
      clientRes.end('Invalid URL');
      return;
    }

    const inScope = await isInScope(url);
    const requestHeaders = this.flattenHeaders(clientReq.headers);
    const requestBody = await this.readBody(clientReq);

    // Intercept request if enabled and in scope
    let finalHeaders = requestHeaders;
    let finalBody: string | null = requestBody ? requestBody.toString('utf-8') : null;

    if (this.intercept.enabled && inScope) {
      try {
        const { promise } = this.intercept.enqueue(
          'request',
          clientReq.method || 'GET',
          url,
          requestHeaders,
          finalBody,
        );
        const modified = await promise;
        finalHeaders = modified.headers;
        finalBody = modified.body;
      } catch {
        // Request was dropped
        clientRes.writeHead(502);
        clientRes.end('Request dropped by intercept');
        return;
      }
    }

    // Make outbound request
    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: this.unflattenHeaders(finalHeaders),
      },
      async (proxyRes) => {
        const duration = Date.now() - startTime;
        const responseHeaders = this.flattenHeaders(proxyRes.headers);
        const responseBody = await this.readDecodedResponseBody(proxyRes, responseHeaders);

        // Intercept response if enabled and in scope
        let finalResHeaders = responseHeaders;
        let finalResBody = responseBody;

        if (this.intercept.enabled && inScope) {
          try {
            const { promise } = this.intercept.enqueue(
              'response',
              clientReq.method || 'GET',
              url,
              responseHeaders,
              responseBody ? responseBody.toString('utf-8') : null,
            );
            const modified = await promise;
            finalResHeaders = modified.headers;
            finalResBody = modified.body ? Buffer.from(modified.body, 'utf-8') : null;
          } catch {
            clientRes.writeHead(502);
            clientRes.end('Response dropped by intercept');
            return;
          }
        }

        // Forward response to client
        clientRes.writeHead(proxyRes.statusCode || 502, this.unflattenHeaders(finalResHeaders));
        if (finalResBody) {
          clientRes.end(finalResBody);
        } else {
          clientRes.end();
        }

        // Record exchange
        await this.recordExchange({
          method: clientReq.method || 'GET',
          url,
          host: targetUrl.hostname,
          path: targetUrl.pathname + targetUrl.search,
          statusCode: proxyRes.statusCode || null,
          requestHeaders,
          requestBody,
          responseHeaders,
          responseBody,
          requestSize: requestBody?.length || 0,
          responseSize: responseBody?.length || null,
          duration,
          tlsVersion: null,
          inScope,
        });
      },
    );

    proxyReq.on('error', (err) => {
      console.error('[proxy] outbound request error:', err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end(`Proxy error: ${err.message}`);
      }
      this.recordExchange({
        method: clientReq.method || 'GET',
        url,
        host: targetUrl.hostname,
        path: targetUrl.pathname + targetUrl.search,
        statusCode: null,
        requestHeaders,
        requestBody,
        responseHeaders: null,
        responseBody: null,
        requestSize: requestBody?.length || 0,
        responseSize: null,
        duration: Date.now() - startTime,
        tlsVersion: null,
        inScope,
        errorMessage: err.message,
      }).catch(() => {});
    });

    if (finalBody) {
      proxyReq.end(Buffer.from(finalBody, 'utf-8'));
    } else {
      proxyReq.end();
    }
  }

  // Handle HTTPS CONNECT tunneling with MITM
  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    _head: Buffer,
  ): Promise<void> {
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    if (!this.ca) {
      clientSocket.end('HTTP/1.1 500 No CA Certificate\r\n\r\n');
      return;
    }

    // Tell client the tunnel is established
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Get or generate certificate for this host
    const secureContext = this.getSecureContext(host);

    // Create TLS server on the client socket
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
    });

    // Handle decrypted HTTP requests on this TLS connection
    const internalServer = http.createServer(async (req, res) => {
      const startTime = Date.now();
      const fullUrl = `https://${host}:${port}${req.url || '/'}`;
      const inScope = await isInScope(fullUrl);
      const requestHeaders = this.flattenHeaders(req.headers);
      const requestBody = await this.readBody(req);

      let finalHeaders = requestHeaders;
      let finalBody: string | null = requestBody ? requestBody.toString('utf-8') : null;

      if (this.intercept.enabled && inScope) {
        try {
          const { promise } = this.intercept.enqueue(
            'request',
            req.method || 'GET',
            fullUrl,
            requestHeaders,
            finalBody,
          );
          const modified = await promise;
          finalHeaders = modified.headers;
          finalBody = modified.body;
        } catch {
          res.writeHead(502);
          res.end('Request dropped by intercept');
          return;
        }
      }

      // Connect to the real server
      const targetSocket = tls.connect(
        {
          host,
          port,
          servername: host,
          rejectUnauthorized: false, // We're a proxy; user accepts the risk
        },
        () => {
          const proxyReq = http.request(
            {
              hostname: host,
              port,
              path: req.url || '/',
              method: req.method,
              headers: this.unflattenHeaders(finalHeaders),
              createConnection: () => targetSocket,
            },
            async (proxyRes) => {
              const duration = Date.now() - startTime;
              const responseHeaders = this.flattenHeaders(proxyRes.headers);
              const responseBody = await this.readDecodedResponseBody(proxyRes, responseHeaders);

              let finalResHeaders = responseHeaders;
              let finalResBody = responseBody;

              if (this.intercept.enabled && inScope) {
                try {
                  const { promise } = this.intercept.enqueue(
                    'response',
                    req.method || 'GET',
                    fullUrl,
                    responseHeaders,
                    responseBody ? responseBody.toString('utf-8') : null,
                  );
                  const modified = await promise;
                  finalResHeaders = modified.headers;
                  finalResBody = modified.body ? Buffer.from(modified.body, 'utf-8') : null;
                } catch {
                  res.writeHead(502);
                  res.end('Response dropped by intercept');
                  return;
                }
              }

              res.writeHead(proxyRes.statusCode || 502, this.unflattenHeaders(finalResHeaders));
              if (finalResBody) {
                res.end(finalResBody);
              } else {
                res.end();
              }

              const tlsInfo = targetSocket.getCipher();
              await this.recordExchange({
                method: req.method || 'GET',
                url: fullUrl,
                host,
                path: req.url || '/',
                statusCode: proxyRes.statusCode || null,
                requestHeaders,
                requestBody,
                responseHeaders,
                responseBody,
                requestSize: requestBody?.length || 0,
                responseSize: responseBody?.length || null,
                duration,
                tlsVersion: tlsInfo?.version || null,
                inScope,
              });
            },
          );

          proxyReq.on('error', (err) => {
            console.error('[proxy] HTTPS outbound error:', err.message);
            if (!res.headersSent) {
              res.writeHead(502);
              res.end(`Proxy error: ${err.message}`);
            }
            this.recordExchange({
              method: req.method || 'GET',
              url: fullUrl,
              host,
              path: req.url || '/',
              statusCode: null,
              requestHeaders,
              requestBody,
              responseHeaders: null,
              responseBody: null,
              requestSize: requestBody?.length || 0,
              responseSize: null,
              duration: Date.now() - startTime,
              tlsVersion: null,
              inScope,
              errorMessage: err.message,
            }).catch(() => {});
          });

          if (finalBody) {
            proxyReq.end(Buffer.from(finalBody, 'utf-8'));
          } else {
            proxyReq.end();
          }
        },
      );

      targetSocket.on('error', (err) => {
        console.error('[proxy] TLS connect error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(`TLS error: ${err.message}`);
        }
        this.recordExchange({
          method: req.method || 'GET',
          url: fullUrl,
          host,
          path: req.url || '/',
          statusCode: null,
          requestHeaders,
          requestBody,
          responseHeaders: null,
          responseBody: null,
          requestSize: requestBody?.length || 0,
          responseSize: null,
          duration: Date.now() - startTime,
          tlsVersion: null,
          inScope,
          errorMessage: `TLS: ${err.message}`,
        }).catch(() => {});
      });
    });

    // Feed the TLS socket into the internal HTTP server
    internalServer.emit('connection', tlsSocket);

    tlsSocket.on('error', (err) => {
      // TLS errors are common (client closing early, etc.)
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        console.error('[proxy] TLS socket error:', err.message);
      }
    });

    clientSocket.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        console.error('[proxy] client socket error:', err.message);
      }
    });
  }

  private getSecureContext(host: string): tls.SecureContext {
    let ctx = this.certCache.get(host);
    if (ctx) return ctx;

    // LRU eviction
    if (this.certCache.size >= 500) {
      const firstKey = this.certCache.keys().next().value!;
      this.certCache.delete(firstKey);
    }

    const { cert, key } = generateHostCertificate(this.ca!, host);
    ctx = tls.createSecureContext({ cert, key });
    this.certCache.set(host, ctx);
    return ctx;
  }

  /**
   * Decompress a response body buffer based on the content-encoding header.
   * Returns the original buffer if encoding is unknown or decoding fails.
   */
  private decodeBody(buf: Buffer, encoding: string | undefined): Buffer {
    if (!buf || buf.length === 0 || !encoding) return buf;
    try {
      const enc = encoding.toLowerCase().trim();
      if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
      if (enc === 'deflate') {
        try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
      }
      if (enc === 'br') return zlib.brotliDecompressSync(buf);
      return buf;
    } catch {
      // Bad/partial encoding — fall back to raw bytes rather than dropping the body
      return buf;
    }
  }

  /**
   * Read body, then decompress per content-encoding so stored bodies are
   * human-readable. Mutates the response headers map to strip content-encoding
   * and update content-length so downstream consumers (UI, LLM) see the
   * decoded payload accurately.
   */
  private async readDecodedResponseBody(
    proxyRes: http.IncomingMessage,
    headers: Record<string, string | string[]>,
  ): Promise<Buffer | null> {
    const raw = await this.readBody(proxyRes);
    if (!raw) return null;
    const encoding = proxyRes.headers['content-encoding'];
    const encStr = Array.isArray(encoding) ? encoding[0] : encoding;
    const decoded = this.decodeBody(raw, encStr);
    if (decoded !== raw) {
      delete headers['content-encoding'];
      delete headers['Content-Encoding'];
      headers['content-length'] = String(decoded.length);
    }
    return decoded;
  }

  private readBody(stream: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (chunks.length === 0) {
          resolve(null);
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
      stream.on('error', () => resolve(null));
    });
  }

  private flattenHeaders(
    headers: http.IncomingHttpHeaders,
  ): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  private unflattenHeaders(
    headers: Record<string, string | string[]>,
  ): http.OutgoingHttpHeaders {
    return headers as http.OutgoingHttpHeaders;
  }

  private async recordExchange(data: {
    method: string;
    url: string;
    host: string;
    path: string;
    statusCode: number | null;
    requestHeaders: Record<string, string | string[]>;
    requestBody: Buffer | null;
    responseHeaders: Record<string, string | string[]> | null;
    responseBody: Buffer | null;
    requestSize: number;
    responseSize: number | null;
    duration: number | null;
    tlsVersion: string | null;
    inScope: boolean;
    errorMessage?: string | null;
  }): Promise<void> {
    try {
      const exchange = await db.exchange.create({
        data: {
          method: data.method,
          url: data.url,
          host: data.host,
          path: data.path,
          statusCode: data.statusCode,
          requestHeaders: JSON.stringify(data.requestHeaders),
          requestBody: data.requestBody ? new Uint8Array(data.requestBody) : null,
          responseHeaders: data.responseHeaders
            ? JSON.stringify(data.responseHeaders)
            : null,
          responseBody: data.responseBody ? new Uint8Array(data.responseBody) : null,
          requestSize: data.requestSize,
          responseSize: data.responseSize,
          duration: data.duration,
          tlsVersion: data.tlsVersion,
          inScope: data.inScope,
          errorMessage: data.errorMessage || null,
        },
      });

      this.exchangeCount++;

      // SQLite rowid increments on insert and is unique per project DB,
      // giving us a stable per-project request number from 1..N.
      const seqRows = await db.$queryRawUnsafe<Array<{ seq: bigint | number }>>(
        'SELECT rowid AS seq FROM Exchange WHERE id = ?',
        exchange.id,
      );
      const seq = Number(seqRows[0]?.seq ?? 0);

      const summary: ExchangeSummary = {
        id: exchange.id,
        seq,
        method: exchange.method,
        host: exchange.host,
        path: exchange.path,
        statusCode: exchange.statusCode,
        requestSize: exchange.requestSize,
        responseSize: exchange.responseSize,
        duration: exchange.duration,
        timestamp: exchange.timestamp.toISOString(),
        contentType: data.responseHeaders
          ? (data.responseHeaders['content-type'] as string) || null
          : null,
        inScope: exchange.inScope,
        highlighted: false,
      };

      this.emit('traffic:new', summary);
    } catch (err) {
      console.error('[proxy] failed to record exchange:', err);
    }
  }
}
