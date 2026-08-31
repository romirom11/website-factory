import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../../src/db/schema.js';
import { ensureRequiredQueues } from '../../src/orchestrator/queueReadiness.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface DisposableFactoryDatabase {
  connectionString: string;
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
  boss: PgBoss;
}

/**
 * Run an integration test in a fresh database and always drop it afterwards.
 * Refuses remote Postgres unless the caller explicitly opts in.
 */
export async function withDisposableFactoryDatabase<T>(
  run: (database: DisposableFactoryDatabase) => Promise<T>,
): Promise<T> {
  const baseUrl = new URL(
    process.env.TEST_DATABASE_URL
      ?? process.env.DATABASE_URL
      ?? 'postgres://factory:factory@localhost:5432/factory',
  );
  if (!LOCAL_HOSTS.has(baseUrl.hostname) && process.env.JOB_TEST_ALLOW_REMOTE !== '1') {
    throw new Error(`refusing integration test against non-local host ${baseUrl.hostname}`);
  }

  const databaseName = `factory_job_test_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;

  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  let pool: pg.Pool | null = null;
  let boss: PgBoss | null = null;
  let tearingDown = false;

  try {
    await admin.query(`create database "${databaseName}"`);
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 30 });
    pool.on('error', (error: Error & { code?: string }) => {
      // pg_terminate_backend is the final safety net for a disposable database.
      // Its expected shutdown signal must not turn a successful test red.
      if (!(tearingDown && error.code === '57P01')) {
        console.error('disposable database pool error', error);
        process.exitCode = 1;
      }
    });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });

    boss = new PgBoss({ connectionString: testUrl.toString(), schema: 'pgboss' });
    boss.on('error', (error: Error & { code?: string }) => {
      if (!(tearingDown && error.code === '57P01')) {
        console.error('pg-boss test error', error);
        process.exitCode = 1;
      }
    });
    await boss.start();
    await ensureRequiredQueues(boss);

    return await run({ connectionString: testUrl.toString(), pool, db, boss });
  } finally {
    tearingDown = true;
    // Let pg-boss drain and close its owned pool before the database is dropped.
    // A forced stop can resolve while its manager still has a finishing worker,
    // leaving Postgres to terminate that connection during DROP DATABASE.
    if (boss) await boss.stop({ close: true, graceful: true, wait: true, timeout: 5_000 });
    if (pool) await pool.end();
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName],
    ).catch(() => {});
    await admin.query(`drop database if exists "${databaseName}"`).catch(() => {});
    await admin.end().catch(() => {});
  }
}
