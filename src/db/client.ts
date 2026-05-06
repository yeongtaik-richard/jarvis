import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema';

neonConfig.webSocketConstructor = ws;

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

declare global {
  // eslint-disable-next-line no-var
  var __jarvis_db: DrizzleDb | undefined;
}

function create(): DrizzleDb {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

// 빌드 타임에 DATABASE_URL이 없을 수 있으므로, 첫 사용 시점에 초기화한다.
// Next의 page-data collection은 모듈을 import만 하고 실제 호출은 안 하므로 안전.
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, _receiver) {
    const real = (globalThis.__jarvis_db ??= create());
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

export type DB = DrizzleDb;
