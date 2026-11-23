import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FILES_DIR } from '../config.js';
import { q } from '../db.js';
import { hqGet } from '../hq.js';
import { redactString } from '../redact.js';
import { tool } from './registry.js';
import { readSynced, syncedAt } from './live.js';
import { INBOXES, inboxAddress, inboxConfigured, readThread, searchThreads } from '../gmail.js';

const BRANDS = ['melodie', 'manele', 'regalo', 'cadeau', 'cancion', 'songgift', 'geschenk', 'podarunek', 'doro', 'hediye', 'tucancion', 'santa'];

tool({
  name: 'support_threads',
  title: 'Support conversations: e-mail, WhatsApp, Sofia chat',
  description:
    'Read what customers wrote and what we answered. channel="email": the live support inboxes in Gmail (every shop, Magic Chapter, the company inbox): search by who / q (Gmail syntax) / days, then read a thread in full with inbox + thread. ' +
    'channel="whatsapp": WhatsApp conversations (no who: the latest conversations; who=<phone>: the full conversation). ' +
    'channel="chat": Sofia\'s chat / Messenger / Instagram sessions (session=<id> for the full action log of one session). ' +
    'Filter by brand, who (e-mail or phone), text q, and days back (default 3).',
  input: {
    channel: z.enum(['email', 'whatsapp', 'chat']),
    inbox: z.enum(INBOXES as [string, ...string[]]).optional().describe('e-mail only: which inbox (default: all). company = lucidlabsorg@, santa = Magic Chapter'),
    thread: z.string().regex(/^[A-Za-z0-9]+$/).optional().describe('e-mail only: Gmail thread id to read in full (with inbox)'),
    source: z.enum(['gmail', 'hub_log']).optional().describe('e-mail only: gmail (live, default) or hub_log (the hub processing log, until Aug 2026)'),
    brand: z.enum(BRANDS as [string, ...string[]]).optional(),
    who: z.string().optional().describe('customer e-mail or phone'),
    q: z.string().optional().describe('text to search for'),
    session: z.string().optional().describe('chat session id (channel=chat)'),
    days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  run: async ({ channel, inbox, thread, source, brand, who, q: text, session, days, limit }) => {
    const d = days ?? 3;
    const lim = limit ?? 60;
    const since = `(now() at time zone 'UTC') - make_interval(days => ${d})`;
    if (channel === 'email') {
      // the full thread
      if (thread) {
        if (!inbox) throw new Error(`give inbox= with thread= (one of ${INBOXES.join(', ')})`);
        const t = await readThread(inbox, thread);
        return { data: t, rows: t.messages.length };
      }
      // the hub's old processing log (until Aug 2026)
      if (source === 'hub_log') {
        const p: unknown[] = []; const w: string[] = [`"processedAt" > ${since}`];
        if (brand) { p.push(brand); w.push(`brand = $${p.length}`); }
        if (who) { p.push(`%${who}%`); w.push(`"fromEmail" ILIKE $${p.length}`); }
        if (text) { p.push(`%${text}%`); w.push(`(subject ILIKE $${p.length} OR "replyText" ILIKE $${p.length})`); }
        const rows = await q('agent', `SELECT "processedAt", brand, "fromEmail", subject, decision, status, "escalationReason", left("replyText", 3000) AS "replyText", "threadId"
          FROM "HandledEmail" WHERE ${w.join(' AND ')} ORDER BY "processedAt" DESC LIMIT ${lim}`, p);
        return { data: { source: 'hub_log', emails: rows }, rows: rows.length };
      }
      // live Gmail search across the inboxes
      const boxes = (inbox ? [inbox] : brand ? [brand] : INBOXES).filter(inboxConfigured);
      const query = [`newer_than:${d}d`, who ? `(from:${who} OR to:${who})` : '', text || ''].filter(Boolean).join(' ');
      const per = Math.max(3, Math.min(25, Math.ceil(lim / Math.max(1, boxes.length))));
      const results = await Promise.all(boxes.map(async (b) => { try { return { inbox: b, threads: await searchThreads(b, query, per) }; } catch (e) { return { inbox: b, threads: [], error: (e as Error).message }; } }));
      const threads = results.flatMap((r) => r.threads).sort((a, b) => +new Date(b.last_date) - +new Date(a.last_date));
      return {
        data: {
          gmail_query: query, inboxes: boxes.map((b) => `${b} <${inboxAddress(b)}>`), count: threads.length, threads,
          errors: results.filter((r) => r.error).map((r) => r.error),
          note: 'Read one thread in full with channel=email, inbox=<inbox>, thread=<threadId>. q accepts Gmail search syntax (subject:, has:attachment, in:sent, label:...). An inbox error means UNKNOWN for that inbox, not "no mail".',
        },
        rows: threads.length,
      };
    }
    if (channel === 'whatsapp') {
      const p: unknown[] = []; const w: string[] = [`"createdAt" > ${since}`];
      if (brand) { p.push(brand); w.push(`brand = $${p.length}`); }
      if (text) { p.push(`%${text}%`); w.push(`body ILIKE $${p.length}`); }
      if (who) {
        const digits = who.replace(/[^0-9]/g, '');
        p.push(`%${digits.slice(-9)}%`); w.push(`regexp_replace(phone, '[^0-9]', '', 'g') LIKE $${p.length}`);
        const rows = await q('agent', `SELECT "createdAt", brand, phone, direction, kind, "msgType", source, status, "orderId", left(body, 2000) AS body, "errorTitle"
          FROM "WaMessage" WHERE ${w.join(' AND ')} ORDER BY "createdAt" ASC LIMIT ${Math.max(lim, 200)}`, p);
        return { data: { channel, who, days: d, count: rows.length, messages: rows }, rows: rows.length };
      }
      const rows = await q('agent', `SELECT phone, brand, count(*)::int AS messages, count(*) FILTER (WHERE direction = 'in')::int AS inbound, max("createdAt") AS last_at,
          (array_agg(left(body, 300) ORDER BY "createdAt" DESC) FILTER (WHERE direction = 'in'))[1] AS last_inbound,
          (array_agg(left(body, 300) ORDER BY "createdAt" DESC) FILTER (WHERE direction <> 'in'))[1] AS last_outbound,
          (array_agg("orderId" ORDER BY "createdAt" DESC) FILTER (WHERE "orderId" IS NOT NULL))[1] AS order_id
        FROM "WaMessage" WHERE ${w.join(' AND ')} GROUP BY phone, brand ORDER BY max("createdAt") DESC LIMIT ${lim}`, p);
      return { data: { channel, days: d, count: rows.length, conversations: rows, note: 'Pass who=<phone> for the whole conversation.' }, rows: rows.length };
    }
    // chat
    if (session) {
      const rows = await q('agent', `SELECT ts, brand, kind, tool, "orderRef", left(note, 1000) AS note, left("inputJson"::text, 2000) AS input, left("outputJson"::text, 2000) AS output
        FROM "ActionLog" WHERE "sessionId" = $1 ORDER BY ts ASC LIMIT 400`, [session]);
      const [s] = await q('agent', `SELECT id, title, brand, operator, "createdAt" FROM "Session" WHERE id = $1`, [session]);
      return { data: { channel, session: s || session, actions: rows }, rows: rows.length };
    }
    const p: unknown[] = []; const w: string[] = [`s."createdAt" > ${since}`];
    if (brand) { p.push(brand); w.push(`s.brand = $${p.length}`); }
    if (text) { p.push(`%${text}%`); w.push(`(s.title ILIKE $${p.length} OR EXISTS (SELECT 1 FROM "ActionLog" a WHERE a."sessionId" = s.id AND (a.note ILIKE $${p.length} OR a."inputJson"::text ILIKE $${p.length})))`); }
    if (who) { p.push(`%${who}%`); w.push(`(s.title ILIKE $${p.length} OR EXISTS (SELECT 1 FROM "ActionLog" a WHERE a."sessionId" = s.id AND a."inputJson"::text ILIKE $${p.length}))`); }
    const rows = await q('agent', `SELECT s.id, s.title, s.brand, s.operator, s."createdAt",
        (SELECT count(*)::int FROM "ActionLog" a WHERE a."sessionId" = s.id) AS actions,
        (SELECT max(a.ts) FROM "ActionLog" a WHERE a."sessionId" = s.id) AS last_at
      FROM "Session" s WHERE ${w.join(' AND ')} ORDER BY s."createdAt" DESC LIMIT ${lim}`, p);
    return { data: { channel, days: d, count: rows.length, sessions: rows, note: 'Pass session=<id> for one session in full.' }, rows: rows.length };
  },
});

tool({
  name: 'escalations',
  title: 'Support escalation cases',
  description:
    'The cases the support bot could not finish alone (Sofia / e-mail / WhatsApp), with the customer, subject, our note, the fix status and whether it is an owner-only (money / legal) case. Default: the open ones (pending = waiting on us, replied = we answered and wait for the customer).',
  input: {
    status: z.enum(['open', 'pending', 'replied', 'resolved', 'ignored', 'all']).optional().describe('open (default) = pending + replied'),
    brand: z.enum(BRANDS as [string, ...string[]]).optional(),
    code: z.string().optional().describe('one case code, e.g. KANP'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  run: async ({ status, brand, code, limit }) => {
    const p: unknown[] = []; const w: string[] = ['true'];
    if (code) { p.push(code.toUpperCase()); w.push(`code = $${p.length}`); }
    else {
      const st = status || 'open';
      if (st === 'open') w.push(`status NOT IN ('resolved', 'ignored')`);
      else if (st !== 'all') { p.push(st); w.push(`status = $${p.length}`); }
      if (brand) { p.push(brand); w.push(`brand = $${p.length}`); }
    }
    const rows = await q('agent', `SELECT code, brand, channel, status, "fixStatus", "ownerOnly", "fromEmail", subject, "createdAt", "resolvedAt", "remindedAt", "reminderCount",
        left("operatorNote", 1500) AS "operatorNote", left("suggestedReply", 1500) AS "suggestedReply", left("operatorReply", 1500) AS "operatorReply",
        left("proposedFixJson"::text, 1500) AS "proposedFix", "threadId", "sessionId"
      FROM "EscalationCase" WHERE ${w.join(' AND ')} ORDER BY "createdAt" DESC LIMIT ${limit ?? 40}`, p);
    const counts = await q('agent', `SELECT status, count(*)::int AS n FROM "EscalationCase" GROUP BY 1 ORDER BY 2 DESC`);
    return { data: { counts, cases: rows, note: 'ownerOnly = money/legal: the owner decides. ageH = now - createdAt.' }, rows: rows.length };
  },
});

tool({
  name: 'owner_relay',
  title: 'Questions the agents are waiting on the owner for',
  description: 'Every bus thread parked on an owner question (status needs_info), oldest first: thread id, age, which agent asks, and the question itself. Same list as D:/lucid-ops/bus/owner-relay.mjs list. Read-only.',
  input: {},
  run: async () => {
    const { threads } = await hqGet('/api/hq/bus/threads?status=needs_info&limit=200', 60_000);
    const list = (threads || []).filter((t: any) => t.status === 'needs_info').sort((a: any, b: any) => +new Date(a.updatedAt || a.createdAt) - +new Date(b.updatedAt || b.createdAt));
    const out = [];
    for (const t of list.slice(0, 40)) {
      try {
        const { thread } = await hqGet(`/api/hq/bus/threads/${encodeURIComponent(t.id)}`, 30_000);
        const qm = [...(thread.messages || [])].reverse().find((m: any) => m.kind === 'question' && m.to === '' && m.from !== 'owner');
        out.push({ id: t.id, title: thread.title, asked_by: qm?.from || null, asked_at: qm?.createdAt || null, age_h: qm ? Math.round((Date.now() - +new Date(qm.createdAt)) / 3.6e6) : null, question: String(qm?.body || '').slice(0, 2500) });
      } catch (e) { out.push({ id: t.id, title: t.title, error: (e as Error).message }); }
    }
    return { data: { waiting_on_owner: out.length, threads: out }, rows: out.length };
  },
});

tool({
  name: 'health',
  title: 'Health: HQ red cards + error backlog',
  description:
    'What is broken right now: HQ\'s health board (every check on every site; returns the failing, warning and STALE checks with their message), the counts, and the daily error backlog (front-end errors seen on the sites, new / regressed). ' +
    'all=true returns every check, green ones included.',
  input: { all: z.boolean().optional(), site: z.string().optional() },
  run: async ({ all, site }) => {
    const h = await hqGet('/api/hq/health', 60_000);
    const reg = new Map<string, any>((h.registry || []).map((r: any) => [r.id, r]));
    const now = Date.now();
    const results = (h.results || []).filter((r: any) => !site || r.site === site).map((r: any) => {
      const every = Number(reg.get(r.checkId)?.everyMin || 0);
      const stale = every > 0 && now - +new Date(r.ranAt) > 2 * every * 60_000;
      return { check: r.checkId, title: reg.get(r.checkId)?.title, site: r.site, status: r.status, stale, message: r.message, ranAt: r.ranAt };
    });
    const shown = all ? results : results.filter((r: any) => r.status === 'fail' || r.status === 'warn' || r.status === 'error' || r.stale);
    const backlog = readSynced('errors/ERROR-BACKLOG.md');
    return {
      data: {
        at: h.at, counts: h.counts,
        problems: shown.sort((a: any, b: any) => (a.status === 'fail' ? 0 : a.status === 'warn' ? 1 : 2) - (b.status === 'fail' ? 0 : b.status === 'warn' ? 1 : 2)),
        error_backlog: backlog ? backlog.slice(0, 20_000) : 'not synced yet',
        error_backlog_synced_at: syncedAt(),
      },
      rows: shown.length,
    };
  },
});

// ── reports: the orchestrator's written reports, synced from D:/lucid-ops ──
const TEXT_EXT = /\.(md|txt|json|csv|html|log|tsv|yml|yaml)$/i;
function walk(dir: string, base = dir, out: { path: string; bytes: number; modified: string }[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (TEXT_EXT.test(e.name)) { const st = fs.statSync(p); out.push({ path: path.relative(base, p).replace(/\\/g, '/'), bytes: st.size, modified: st.mtime.toISOString() }); }
  }
  return out;
}

tool({
  name: 'reports',
  title: 'Company reports and notes (D:/lucid-ops)',
  description:
    'The orchestrator\'s written work, synced from D:/lucid-ops every 15 minutes: reports/ (audits, plans, analyses), EXPERIMENTS.md, BACKLOG.md, errors/, support-watch/, experiments/, whatsapp/, santa/, black-friday / christmas plans, finance/, new-markets/ and more. ' +
    'action="list" (optionally under a folder, newest first), "read" a file by path (use offset for long files), or "search" for text across all of them.',
  input: {
    action: z.enum(['list', 'read', 'search']),
    path: z.string().optional().describe('file path for read, folder for list (e.g. "reports")'),
    query: z.string().optional().describe('text for search'),
    offset: z.number().int().min(0).optional().describe('character offset for read'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  run: async ({ action, path: rel, query, offset, limit }) => {
    if (!fs.existsSync(FILES_DIR)) throw new Error('nothing synced yet');
    const root = path.resolve(FILES_DIR);
    const resolve = (r: string) => { const p = path.resolve(root, r.replace(/^\/+/, '')); if (!p.startsWith(root)) throw new Error('path outside the shared folder'); return p; };
    if (action === 'list') {
      const dir = rel ? resolve(rel) : root;
      const files = walk(dir, root).sort((a, b) => b.modified.localeCompare(a.modified));
      return { data: { syncedAt: syncedAt(), folder: rel || '/', count: files.length, files: files.slice(0, limit ?? 300) }, rows: files.length };
    }
    if (action === 'read') {
      if (!rel) throw new Error('give the path of the file to read (see action=list)');
      const p = resolve(rel);
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new Error(`no file "${rel}"`);
      const text = fs.readFileSync(p, 'utf8');
      const start = offset ?? 0;
      const chunk = text.slice(start, start + 120_000);
      return { data: { path: rel, bytes: text.length, offset: start, more: start + chunk.length < text.length ? `continue with offset=${start + chunk.length}` : null, text: redactString(chunk) } };
    }
    if (!query) throw new Error('give a query for search');
    const needle = query.toLowerCase();
    const hits: { path: string; line: number; text: string }[] = [];
    for (const f of walk(root).sort((a, b) => b.modified.localeCompare(a.modified))) {
      const lines = fs.readFileSync(path.join(root, f.path), 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => { if (hits.length < (limit ?? 200) && l.toLowerCase().includes(needle)) hits.push({ path: f.path, line: i + 1, text: redactString(l.slice(0, 400)) }); });
      if (hits.length >= (limit ?? 200)) break;
    }
    return { data: { query, syncedAt: syncedAt(), hits }, rows: hits.length };
  },
});
