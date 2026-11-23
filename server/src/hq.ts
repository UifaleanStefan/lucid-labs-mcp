import crypto from 'node:crypto';
import { env, HQ_BASE } from './config.js';
import { redact } from './redact.js';

/**
 * HQ (manele-cadou.ro, code D:/Manele/manele-io) already computes profit, ROAS, accounting, health, queues…
 * We call its own GET routes instead of re-inventing the numbers, signing the same short-lived dashboard cookie
 * that D:/lucid-ops/bus/ask.mjs and owner-relay.mjs sign (HS256 JWT {role:"admin", account}, 10 minutes).
 *
 * The cookie is full owner access on HQ, so this module only ever issues GET, plus the two bus calls that
 * ask_agent needs (open a thread). Nothing else is POSTed.
 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function cookie(account = 'stefan'): string {
  const sec = env('JWT_SECRET');
  if (!sec) throw new Error('HQ access is not configured on this server (JWT_SECRET missing)');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ role: 'admin', account, iat: now, exp: now + 600 });
  return `${h}.${p}.` + crypto.createHmac('sha256', sec).update(`${h}.${p}`).digest('base64url');
}

/** Routes nobody needs through this server (credentials, forced runs, the daemon's mailbox, raw files). */
const BLOCKED = [/^\/api\/hq\/agents\/tokens/, /^\/api\/hq\/bus\/tokens/, /^\/api\/hq\/login/, /^\/api\/hq\/bus\/deliveries/,
  /^\/api\/hq\/studio\/worker/, /^\/api\/hq\/claude-usage\/ingest/, /^\/api\/hq\/health\/ingest/];

export async function hqGet<T = any>(path: string, timeoutMs = 120_000): Promise<T> {
  if (!path.startsWith('/api/hq/')) throw new Error('HQ path must start with /api/hq/');
  if (BLOCKED.some((re) => re.test(path))) throw new Error('that HQ route is not available through this server');
  if (/[?&](run|refresh|backfill)=/.test(path)) throw new Error('forcing an HQ re-run is not available here; HQ refreshes on its own schedule');
  const r = await fetch(HQ_BASE + path, { headers: { Cookie: `dashboard_token=${cookie()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
  if (!r.ok) throw new Error(`HQ ${path} answered HTTP ${r.status}: ${typeof body === 'object' ? JSON.stringify(body).slice(0, 400) : String(body).slice(0, 400)}`);
  return redact(body) as T;
}

/** The only HQ write: open a bus thread / post a message (ask_agent). */
export async function hqBusPost<T = any>(path: string, payload: unknown): Promise<T> {
  if (!/^\/api\/hq\/bus\/threads(\/[A-Za-z0-9_-]+\/messages)?$/.test(path)) throw new Error('only bus threads can be posted to');
  const r = await fetch(HQ_BASE + path, {
    method: 'POST', headers: { Cookie: `dashboard_token=${cookie()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HQ bus ${path} → HTTP ${r.status}: ${(out as any)?.error || ''}`);
  return redact(out) as T;
}
