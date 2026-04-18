import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Ensure DATABASE_URL is set before PrismaClient initializes
if (!process.env.DATABASE_URL) {
  const __dirname_esm = path.dirname(fileURLToPath(import.meta.url));
  const dbPath = path.resolve(__dirname_esm, '../prisma/sniff.db');
  process.env.DATABASE_URL = `file:${dbPath}`;
}

let _db = new PrismaClient();

// Proxy object so all existing imports continue to work after reconnect
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return (_db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export async function reconnectDb(databaseUrl: string): Promise<void> {
  await _db.$disconnect();
  process.env.DATABASE_URL = databaseUrl;
  _db = new PrismaClient({ datasourceUrl: databaseUrl });
  await _db.$connect();
}
