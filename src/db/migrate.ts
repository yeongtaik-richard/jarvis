import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const dir = resolve(process.cwd(), 'drizzle');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migrations found in', dir);
    return;
  }

  const sql = neon(url);

  for (const file of files) {
    console.log(`\n=== Applying ${file} ===`);
    const text = readFileSync(resolve(dir, file), 'utf8');
    const statements = splitSql(text);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      process.stdout.write(`  > ${trimmed.slice(0, 70).replace(/\s+/g, ' ')}…\n`);
      await sql.query(trimmed);
    }
  }
  console.log('\nAll migrations applied.');
}

// Split top-level `;`, treating $$ ... $$ as opaque blocks.
function splitSql(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (input.slice(i, i + 2) === '$$') {
      inDollar = !inDollar;
      buf += '$$';
      i += 2;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
