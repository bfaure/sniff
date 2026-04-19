// Mimic what electron main does in packaged mode: dynamic-import the
// staged backend from apps/electron/node_modules/ and verify it loads
// + the schema initialization works against a fresh sqlite file.
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_NM = path.resolve(HERE, '..', 'apps', 'electron', 'node_modules');
const TMP_DB = path.resolve(HERE, '..', 'release', 'smoke-test.db');

if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
fs.mkdirSync(path.dirname(TMP_DB), { recursive: true });

process.env.DATABASE_URL = `file:${TMP_DB.replace(/\\/g, '/')}`;
process.env.SNIFF_SERVER_PORT = '47999';

console.log('[smoke] ELECTRON_NM=', ELECTRON_NM);
console.log('[smoke] DATABASE_URL=', process.env.DATABASE_URL);

// Make Node resolution find the staged deps
process.chdir(path.resolve(HERE, '..', 'apps', 'electron'));

const caUrl = path.join(ELECTRON_NM, '@sniff', 'backend', 'dist', 'proxy', 'ca.js');
const serverUrl = path.join(ELECTRON_NM, '@sniff', 'backend', 'dist', 'server.js');

console.log('[smoke] importing ca…');
const ca = await import('file://' + caUrl.replace(/\\/g, '/'));
console.log('[smoke] ca loaded, setCertDir typeof:', typeof ca.setCertDir);

console.log('[smoke] importing server…');
const server = await import('file://' + serverUrl.replace(/\\/g, '/'));
console.log('[smoke] server loaded, createServer typeof:', typeof server.createServer);

console.log('[smoke] calling createServer (will run schema migration)…');
const { fastify } = await server.createServer();

console.log('[smoke] starting fastify listen…');
await fastify.listen({ port: 47999, host: '127.0.0.1' });
console.log('[smoke] fastify listening — test endpoint…');

const res = await fetch('http://127.0.0.1:47999/api/health');
console.log('[smoke] /api/health status:', res.status, 'body:', await res.text());

await fastify.close();
console.log('[smoke] OK');
process.exit(0);
