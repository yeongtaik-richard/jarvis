import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema';

neonConfig.webSocketConstructor = ws;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

declare global {
  // eslint-disable-next-line no-var
  var __jarvis_pool: Pool | undefined;
}

const pool = globalThis.__jarvis_pool ?? new Pool({ connectionString: url });
if (process.env.NODE_ENV !== 'production') globalThis.__jarvis_pool = pool;

export const db = drizzle(pool, { schema });
export type DB = typeof db;
