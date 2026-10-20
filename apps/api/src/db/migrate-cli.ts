import { loadEnv } from '../config/env.js';
import { runMigrations } from './migrate.js';
import { createPool } from './pool.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, 1);

try {
  const applied = await runMigrations(pool, (message) => process.stdout.write(`${message}\n`));
  process.stdout.write(applied.length ? 'Migrations complete\n' : 'Database is up to date\n');
} finally {
  await pool.end();
}
