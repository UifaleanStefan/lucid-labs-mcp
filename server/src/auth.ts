import crypto from 'node:crypto';
import fs from 'node:fs';
import { KEYS_FILE, LIMITS } from './config.js';

/**
 * Bearer-key auth. The server only ever sees sha256 hashes of the keys (KEYS_FILE, written by admin/keys.mjs).
 * The file is re-read whenever it changes, so revoking or rotating a key takes effect within seconds, no restart.
 *
 * keys.json: { "keys": [ { "person": "razvan", "sha256": "<hex>", "created": "2026-11-23T…", "revoked": false } ] }
 */
interface KeyRow { person: string; sha256: string; created?: string; revoked?: boolean }

let cache: { mtimeMs: number; byHash: Map<string, KeyRow> } = { mtimeMs: -1, byHash: new Map() };

function load(): Map<string, KeyRow> {
  try {
    const st = fs.statSync(KEYS_FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) as { keys?: KeyRow[] };
      const m = new Map<string, KeyRow>();
      for (const k of j.keys || []) if (k && !k.revoked && /^[a-f0-9]{64}$/.test(k.sha256) && /^[a-z0-9_-]{2,32}$/.test(k.person)) m.set(k.sha256, k);
      cache = { mtimeMs: st.mtimeMs, byHash: m };
      console.log(`[auth] keys loaded: ${m.size} active (${[...new Set([...m.values()].map((k) => k.person))].join(', ')})`);
    }
  } catch (e) {
    console.error(`[auth] cannot read keys file: ${(e as Error).message}`);
  }
  return cache.byHash;
}

export function activePeople(): string[] {
  return [...new Set([...load().values()].map((k) => k.person))];
}

/** Returns the person for a valid key, else null. Constant-time compare on the hash. */
export function personForKey(authHeader: string | undefined): string | null {
  const m = /^Bearer\s+(lk_[A-Za-z0-9]{32,128})\s*$/.exec(authHeader || '');
  if (!m) return null;
  const h = crypto.createHash('sha256').update(m[1]).digest('hex');
  const keys = load();
  for (const [hash, row] of keys) {
    if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(h, 'hex'))) return row.person;
  }
  return null;
}

// ── rate limit: N calls per rolling minute + M in flight, per person ──
const recent = new Map<string, number[]>();
const inflight = new Map<string, number>();

export function rateCheck(person: string): string | null {
  const now = Date.now();
  const arr = (recent.get(person) || []).filter((t) => now - t < 60_000);
  if (arr.length >= LIMITS.ratePerMin) return `rate limit: max ${LIMITS.ratePerMin} calls per minute per person; wait a few seconds`;
  if ((inflight.get(person) || 0) >= LIMITS.concurrent) return `rate limit: max ${LIMITS.concurrent} calls at the same time per person; wait for one to finish`;
  arr.push(now);
  recent.set(person, arr);
  return null;
}
export function enter(person: string): void { inflight.set(person, (inflight.get(person) || 0) + 1); }
export function leave(person: string): void { inflight.set(person, Math.max(0, (inflight.get(person) || 0) - 1)); }

/** Failed-auth limiter per IP (stops key guessing). */
const badByIp = new Map<string, number[]>();
export const BAD_AUTH_LIMIT = 30;
export function badAuth(ip: string): boolean {
  const now = Date.now();
  if (badByIp.size > 5000) for (const [k, v] of badByIp) if (!v.some((t) => now - t < 10 * 60_000)) badByIp.delete(k);
  const arr = (badByIp.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  arr.push(now);
  badByIp.set(ip, arr);
  return arr.length > BAD_AUTH_LIMIT;
}
export function ipBlocked(ip: string): boolean {
  const now = Date.now();
  return ((badByIp.get(ip) || []).filter((t) => now - t < 10 * 60_000).length) > BAD_AUTH_LIMIT;
}
