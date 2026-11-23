import pg from 'pg';
import { env, LIMITS, PG_HOST, PG_PORT, site as siteOf, type Site } from './config.js';
import { redact } from './redact.js';

/**
 * Read-only access to every database on lucid-postgres-1.
 *
 * Three independent guards (same design as the support hub's productDb.ts, src/tools/db/productDb.ts):
 *   1. the role `mcp_ro` has SELECT only (and default_transaction_read_only=on, statement_timeout=15s set on the role);
 *   2. every query runs inside BEGIN READ ONLY with SET LOCAL statement_timeout;
 *   3. a pre-flight check: one statement, starting with SELECT / WITH / TABLE / VALUES / EXPLAIN.
 * Plus a row cap (2000) and an output redaction pass (redact.ts).
 *
 * Timestamps: Prisma stores `timestamp without time zone` holding UTC. We return them as ISO strings with a Z,
 * so nobody reads a value 2–3 hours off (the node-pg local-zone trap, playbook-db-read-access §4).
 */
pg.types.setTypeParser(1114, (v: string) => `${v.replace(' ', 'T')}Z`);
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
pg.types.setTypeParser(20, (v: string) => (Number.isSafeInteger(Number(v)) ? Number(v) : v)); // bigint counts
pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric

const pools = new Map<string, pg.Pool>();

function pool(db: string, role: 'ro' | 'app' = 'ro'): pg.Pool {
  const key = `${role}:${db}`;
  let p = pools.get(key);
  if (!p) {
    p = new pg.Pool({
      host: PG_HOST, port: PG_PORT, database: db,
      user: role === 'ro' ? 'mcp_ro' : 'mcp_app',
      password: role === 'ro' ? env('MCP_RO_PASSWORD') : env('MCP_APP_PASSWORD'),
      max: role === 'ro' ? 4 : 3, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 10_000,
      application_name: 'lucid-mcp',
    });
    p.on('error', (e) => console.error(`[db] idle client error on ${db}: ${e.message}`));
    pools.set(key, p);
  }
  return p;
}

/** Pre-flight: a single read statement. The role and the READ ONLY transaction are the hard guarantees. */
export function checkReadOnly(sql: string): string {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('empty query');
  // strip string literals and comments before looking for a second statement
  const bare = s.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (bare.includes(';')) throw new Error('one statement per call (no ";" in the middle)');
  if (!/^\s*(select|with|table|values|explain)\b/i.test(bare)) throw new Error('only SELECT / WITH / TABLE / VALUES / EXPLAIN queries are allowed (read-only)');
  if (/\b(pg_sleep|pg_read_file|pg_read_binary_file|lo_import|lo_export|dblink|set_config|pg_terminate_backend|pg_cancel_backend)\b/i.test(bare)) {
    throw new Error('that function is not allowed here');
  }
  if (/^\s*explain\b/i.test(bare) && /\banalyze\b/i.test(bare)) throw new Error('EXPLAIN ANALYZE is not allowed (it executes the query); use plain EXPLAIN');
  return s;
}

/** Low-level: run inside a READ ONLY transaction with a statement timeout (UTC session). */
export async function roQuery(db: string, text: string, params: unknown[] = [], timeoutMs = LIMITS.statementTimeoutMs): Promise<pg.QueryResult> {
  const c = await pool(db).connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = ${Math.min(Math.max(1000, timeoutMs), LIMITS.statementTimeoutMs)}`);
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const r = await c.query(text, params);
    await c.query('ROLLBACK').catch(() => {});
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Fixed, parameterised read used by the tools (rows already redacted). */
export async function q(siteKey: string, text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const s: Site = siteOf(siteKey);
  const r = await roQuery(s.db, text, params);
  return redact(r.rows) as Record<string, unknown>[];
}

/** Same, but never throws: returns { rows } or { error } so one broken database never sinks a fan-out. */
export async function qSafe(siteKey: string, text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  try { return { rows: await q(siteKey, text, params) }; } catch (e) { return { rows: [], error: `${siteKey}: ${(e as Error).message}` }; }
}

export interface SqlResult { site: string; database: string; rowCount: number; truncated: boolean; ms: number; columns: string[]; rows: Record<string, unknown>[] }

/** The `sql` tool: free read-only SQL, capped at maxRows (≤ 2000). */
export async function runSql(siteKey: string, sql: string, maxRows = LIMITS.maxRows): Promise<SqlResult> {
  const s = siteOf(siteKey);
  const body = checkReadOnly(sql);
  const cap = Math.min(Math.max(1, Math.floor(maxRows) || LIMITS.maxRows), LIMITS.maxRows);
  const t0 = Date.now();
  const isExplain = /^\s*explain\b/i.test(body);
  const r = await roQuery(s.db, isExplain ? body : `SELECT * FROM (\n${body}\n) AS _mcp_q LIMIT ${cap + 1}`);
  const rows = r.rows.slice(0, cap);
  return {
    site: s.key, database: s.db, rowCount: rows.length, truncated: r.rows.length > cap, ms: Date.now() - t0,
    columns: r.fields.map((f) => f.name), rows: redact(rows) as Record<string, unknown>[],
  };
}

// ── the server's own database (audit log). Role mcp_app owns db `mcp`. ──
export async function appQuery(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
  return pool('mcp', 'app').query(text, params);
}

export async function initAppDb(): Promise<void> {
  await appQuery(`CREATE TABLE IF NOT EXISTS audit_log (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    person text NOT NULL,
    tool text NOT NULL,
    args text NOT NULL DEFAULT '',
    ok boolean NOT NULL,
    row_count integer,
    ms integer NOT NULL,
    error text,
    ip text
  )`);
  await appQuery(`CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC)`);
  await appQuery(`CREATE INDEX IF NOT EXISTS audit_log_person ON audit_log (person, at DESC)`);
  await appQuery(`GRANT SELECT ON audit_log TO mcp_ro`).catch(() => {});
}
