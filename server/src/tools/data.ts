import { z } from 'zod';
import { LIMITS, SHOP_SITES, SITE_KEYS, SITES, site as siteOf } from '../config.js';
import { q, qSafe, runSql } from '../db.js';
import { hqGet } from '../hq.js';
import { tool } from './registry.js';

const SITE_LIST = SITES.map((s) => `${s.key} (${s.label})`).join('; ');

tool({
  name: 'sql',
  title: 'Read-only SQL on any database',
  description:
    `Run ONE read-only SQL query (SELECT / WITH / EXPLAIN) on a company database and get the rows back as JSON. ` +
    `Sites: ${SITE_LIST}. ` +
    `Limits: 15 s statement timeout, at most ${LIMITS.maxRows} rows (set max_rows lower for big tables). Writes are impossible (read-only role + read-only transaction). ` +
    `Postgres with Prisma naming: quote mixed-case names, e.g. SELECT id, "paymentConfirmedAt" FROM "Order". ` +
    `Timestamps are UTC (columns are 'timestamp without time zone' holding UTC; the session runs in UTC; a Romanian day is [D-1 22:00, D 22:00) UTC in winter). ` +
    `Schema split: manele uses "paidAt" + "deliveryEmail" + utmSource/utmContent and the brief on "Song" (dedicatee); every other song shop uses "paymentConfirmedAt" + "email" + attributionUtm*/recipient on "Order"; "Order"."songId" -> "Song".id. ` +
    `"Paid" = the paid column IS NOT NULL (not status='paid'). amount is in minor units (cents/bani) in "Order".currency. ` +
    `manele also holds HQ tables (ProfitSnapshot, GoogleAdsDay, Bus*, HealthCheckResult, EmailLog for manele). santa = Magic Chapter (Order, Video, render_jobs, DemoRequest, OrderCarol, EmailSend). agent = support hub (EscalationCase, HandledEmail, WaMessage, ActionLog, IssueFix). ` +
    `Use the schema tool first if you are unsure of a column. Columns holding credentials or private page tokens come back as "[hidden]".`,
  input: {
    site: z.enum(SITE_KEYS).describe('which database'),
    query: z.string().min(1).describe('one SELECT / WITH / EXPLAIN statement'),
    max_rows: z.number().int().min(1).max(LIMITS.maxRows).optional().describe(`row cap, default ${LIMITS.maxRows}`),
  },
  run: async ({ site, query, max_rows }) => {
    const r = await runSql(site, query, max_rows ?? LIMITS.maxRows);
    return { data: r, rows: r.rowCount };
  },
});

tool({
  name: 'schema',
  title: 'Tables and columns of a database',
  description: 'List the tables of a database (with approximate row counts), or the columns of one table. Use it before writing SQL.',
  input: {
    site: z.enum(SITE_KEYS),
    table: z.string().optional().describe('table name, exact case, e.g. Order. Omit to list tables.'),
  },
  run: async ({ site, table }) => {
    if (table) {
      const cols = await q(site, `SELECT c.table_schema AS schema, c.column_name AS column, c.data_type AS type, c.is_nullable AS nullable
        FROM information_schema.columns c WHERE c.table_name = $1 AND c.table_schema NOT IN ('pg_catalog','information_schema')
        ORDER BY c.table_schema, c.ordinal_position`, [table]);
      if (!cols.length) throw new Error(`no table "${table}" visible in ${site} (names are case-sensitive; call schema without a table to list them)`);
      return { data: { site, table, columns: cols } };
    }
    const tables = await q(site, `SELECT n.nspname AS schema, c.relname AS table, GREATEST(c.reltuples, 0)::bigint AS approx_rows,
        CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND (has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT'))
      ORDER BY 1, 2`);
    return { data: { site, database: siteOf(site).db, tables } };
  },
});

// ── find_customer ─────────────────────────────────────────────────────────
const SONG_FORK_SEARCH = `SELECT o.id, o.email, o.recipient, o."payerName", o."senderName", o."waPhone", o.status, o.amount, o.currency,
    o."createdAt", o."paymentConfirmedAt" AS "paidAt", o."refundedAt"
  FROM "Order" o
  WHERE o.id = $3 OR o.email ILIKE $1 OR o.recipient ILIKE $1 OR o."payerName" ILIKE $1 OR o."senderName" ILIKE $1
     OR ($2 <> '' AND regexp_replace(coalesce(o."waPhone", ''), '[^0-9]', '', 'g') LIKE $2)
  ORDER BY (o."paymentConfirmedAt" IS NOT NULL) DESC, o."createdAt" DESC LIMIT 25`;
const MANELE_SEARCH = `SELECT o.id, o."deliveryEmail" AS email, s.dedicatee AS recipient, o."payerName", o."waPhone", o.status, o.amount, o.currency,
    o."createdAt", o."paidAt"
  FROM "Order" o LEFT JOIN "Song" s ON s.id = o."songId"
  WHERE o.id = $3 OR o."deliveryEmail" ILIKE $1 OR s.dedicatee ILIKE $1 OR o."payerName" ILIKE $1
     OR ($2 <> '' AND regexp_replace(coalesce(o."waPhone", ''), '[^0-9]', '', 'g') LIKE $2)
  ORDER BY (o."paidAt" IS NOT NULL) DESC, o."createdAt" DESC LIMIT 25`;
const SANTA_SEARCH = `SELECT o.id, o.email, o."leadEmail", o.language, o.market, o."childName", o."child2Name", o.kids, o."payerName", o."senderName", o."fromWho",
    o.status, o.amount, o.currency, o."createdAt", o."paymentConfirmedAt" AS "paidAt", o."refundedAt", v.status AS "filmStatus"
  FROM "Order" o LEFT JOIN "Video" v ON v."orderId" = o.id
  WHERE o.id = $3 OR o.email ILIKE $1 OR o."leadEmail" ILIKE $1 OR o."childName" ILIKE $1 OR o."child2Name" ILIKE $1
     OR o."payerName" ILIKE $1 OR o."senderName" ILIKE $1 OR o."fromWho" ILIKE $1
  ORDER BY (o."paymentConfirmedAt" IS NOT NULL) DESC, o."createdAt" DESC LIMIT 25`;

tool({
  name: 'find_customer',
  title: 'Find a customer across every shop',
  description:
    'Search every song shop, Magic Chapter and the support hub for a customer by e-mail (or part of it), name (buyer, recipient, child, card name) or phone number, or by an order id. ' +
    'Returns their orders per shop (paid first), their WhatsApp contact, support cases and e-mails we handled, plus HQ\'s customer summary (spend in EUR, open issues). Drafts are included and marked by status.',
  input: { query: z.string().min(3).describe('e-mail, name, phone (digits) or order id') },
  run: async ({ query }) => {
    const term = query.trim();
    const like = `%${term.replace(/[%_\\]/g, (c: string) => '\\' + c)}%`;
    const digits = term.replace(/[^0-9]/g, '');
    const phone = digits.length >= 6 && digits.length >= term.replace(/[\s+()-]/g, '').length - 1 ? `%${digits.slice(-9)}%` : '';
    const shops = await Promise.all(SHOP_SITES.map(async (s) => {
      const sql = s.kind === 'film' ? SANTA_SEARCH : s.kind === 'song-manele' ? MANELE_SEARCH : SONG_FORK_SEARCH;
      const r = await qSafe(s.key, sql, [like, phone, term]);
      return { site: s.key, label: s.label, ...r };
    }));
    const support = await Promise.all([
      qSafe('agent', `SELECT brand, phone, lang, "createdAt", "lastInboundAt", "consentAt", "optedOutAt" FROM "WaContact" WHERE $1 <> '' AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1 LIMIT 20`, [phone]),
      qSafe('agent', `SELECT code, brand, channel, status, "fixStatus", "ownerOnly", "fromEmail", subject, "createdAt", "resolvedAt", left("operatorNote", 300) AS "operatorNote"
        FROM "EscalationCase" WHERE "fromEmail" ILIKE $1 OR subject ILIKE $1 ORDER BY "createdAt" DESC LIMIT 20`, [like]),
      qSafe('agent', `SELECT brand, "fromEmail", subject, decision, status, "processedAt", left("replyText", 400) AS "replyText", "threadId"
        FROM "HandledEmail" WHERE "fromEmail" ILIKE $1 ORDER BY "processedAt" DESC LIMIT 20`, [like]),
    ]);
    let hq: unknown = null;
    try { hq = await hqGet(`/api/hq/customer?q=${encodeURIComponent(term)}`, 25_000); } catch (e) { hq = { error: (e as Error).message }; }
    const hits = shops.filter((s) => s.rows.length);
    return {
      data: {
        query: term,
        found_in: hits.map((s) => `${s.site} (${s.rows.length})`),
        shops: hits.map(({ site, label, rows }) => ({ site, label, orders: rows })),
        whatsapp_contacts: support[0].rows,
        support_cases: support[1].rows,
        emails_handled: support[2].rows,
        hq_customer_summary: hq,
        errors: [...shops.map((s) => s.error), ...support.map((s) => s.error)].filter(Boolean),
        note: 'amount is in minor units (cents/bani) of the row currency. An error on a shop means UNKNOWN for that shop, not "no order".',
      },
      rows: hits.reduce((n, s) => n + s.rows.length, 0),
    };
  },
});

// ── order ─────────────────────────────────────────────────────────────────
async function locate(id: string): Promise<string[]> {
  const found = await Promise.all(SHOP_SITES.map(async (s) => ((await qSafe(s.key, 'SELECT 1 FROM "Order" WHERE id = $1', [id])).rows.length ? s.key : '')));
  return found.filter(Boolean);
}

async function songOrder(siteKey: string, id: string) {
  const s = siteOf(siteKey);
  const [order] = await q(siteKey, `SELECT to_jsonb(o) AS o FROM "Order" o WHERE o.id = $1`, [id]);
  const o = (order?.o || {}) as Record<string, any>;
  const songId = o.songId;
  const [song] = songId ? await q(siteKey, `SELECT to_jsonb(x) - 'previousSunoTaskIds' AS s FROM "Song" x WHERE x.id = $1`, [songId]) : [];
  const versions = songId ? await qSafe(siteKey, `SELECT "versionNumber", "createdAt", "durationSec", "audioUrl", left(lyrics, 160) AS "lyricsStart" FROM "SongVersion" WHERE "songId" = $1 ORDER BY "versionNumber" DESC LIMIT 20`, [songId]) : { rows: [] };
  const emails = await qSafe(siteKey, `SELECT to_jsonb(e) - 'html' - 'body' AS e FROM "EmailLog" e WHERE e."orderId" = $1 ORDER BY e."sentAt" DESC NULLS LAST LIMIT 30`, [id]);
  const email = String(o[s.emailCol || 'email'] || '');
  const codes = email ? await qSafe(siteKey, `SELECT code, type, amount, "multiUse", "expiresAt", "usedAt", "createdAt" FROM "Discount" WHERE email ILIKE $1 ORDER BY "createdAt" DESC LIMIT 20`, [email]) : { rows: [] };
  const paidAt = o[s.paidCol || 'paymentConfirmedAt'];
  const delivered = emails.rows.some((r: any) => ['song_delivered', 'manual_song_delivered', 'manual_delivery', 'manual_recovery', 'birthday_song'].includes(String(r.e?.type)));
  return {
    site: siteKey, label: s.label, domain: s.domain,
    summary: {
      paid: !!paidAt, paidAt: paidAt || null, amount_minor: o.amount, currency: o.currency, status: o.status,
      generationStatus: (song?.s as any)?.generationStatus ?? null,
      delivered_by_email: delivered,
      note: 'Delivered = an EmailLog row of type song_delivered / manual_song_delivered / manual_delivery / manual_recovery / birthday_song; demo_ready is NOT delivery.',
    },
    order: o, song: song?.s ?? null, versions: versions.rows, emails: emails.rows.map((r: any) => r.e), discount_codes_of_buyer: codes.rows,
  };
}

async function filmOrder(id: string) {
  const [order] = await q('santa', `SELECT to_jsonb(o) - 'letterText' - 'letterTranscript' AS o FROM "Order" o WHERE o.id = $1`, [id]);
  const o = (order?.o || {}) as Record<string, any>;
  const [video] = await q('santa', `SELECT id, status, attempts, engine, "renderedAt", "expiresAt", error, "durationS", "costCents", "createdAt", "updatedAt" FROM "Video" WHERE "orderId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [id]);
  const jobs = await q('santa', `SELECT id, kind, variant, state, reason, attempts, priority, worker, created_at, started_at, finished_at, applied_at, render_s FROM render_jobs WHERE order_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]);
  const carol = await q('santa', `SELECT status, title, attempts, "durationS", error, "createdAt", "notifiedAt", "singingAt" FROM "OrderCarol" WHERE "orderId" = $1`, [id]);
  const mails = await q('santa', `SELECT type, status, error, "createdAt" FROM "EmailSend" WHERE "orderId" = $1 OR key = $1 ORDER BY "createdAt" ASC LIMIT 60`, [id]);
  const fixes = await qSafe('santa', `SELECT id, status, kinds, channel, left(text, 500) AS text, "autoState", "autoReason", attempts, "createdAt" FROM "OrderFix" WHERE "orderId" = $1 ORDER BY "createdAt" DESC LIMIT 20`, [id]);
  const feedback = await qSafe('santa', `SELECT kind, rating, liked, left(comment, 400) AS comment, "childReaction", "createdAt" FROM "Feedback" WHERE "orderId" = $1 ORDER BY "createdAt" DESC LIMIT 10`, [id]);
  const paidAt = o.paymentConfirmedAt ? new Date(o.paymentConfirmedAt).getTime() : 0;
  const ready = o.status === 'completed' || video?.status === 'ready';
  const job = String(jobs.find((j) => j.kind === 'film')?.state || '');
  const held = !!paidAt && !ready && (video?.status === 'failed' || job === 'held' || job === 'failed');
  const minutes = paidAt ? Math.floor((Date.now() - paidAt) / 60_000) : 0;
  const deliverLater = o.deliverAt && new Date(o.deliverAt).getTime() > Date.now();
  const verdict = o.refundedAt ? 'REFUNDED' : !paidAt ? `NOT PAID (${o.status})` : ready ? 'FILM READY' : held ? 'HELD / FAILED: a person must look at it'
    : deliverLater ? `PAID, delivery date chosen by the parent: ${o.deliverAt}` : minutes > 60 ? `LATE: paid ${minutes} min ago, not ready (promise: within 1 hour)` : `PAID, film being made (${minutes} min since payment)`;
  return {
    site: 'santa', label: 'Magic Chapter (film)',
    summary: { verdict, paid: !!paidAt, paidAt: o.paymentConfirmedAt || null, amount_minor: o.amount, currency: o.currency, language: o.language, market: o.market, children: [o.childName, o.child2Name].filter(Boolean).join(' + '), film: video?.status || null, queue: job || null, minutesSincePaid: minutes },
    order: o, video: video || null, render_jobs: jobs, carol, emails: mails, fixes: fixes.rows, feedback: feedback.rows,
    note: 'The private film-page link is not returned (its access token is a secret). Film != song: film matters go to suport.manager on the bus.',
  };
}

tool({
  name: 'order',
  title: 'Full look-up of one order',
  description:
    'Everything about one order by its id (song shop or Magic Chapter): the order row, the song (or the film + render queue), versions, every e-mail sent, discount codes of the buyer, plus the support side (escalation cases, Sofia actions, WhatsApp messages and fixes that mention it). ' +
    'The shop is found automatically; pass site to skip the search.',
  input: {
    id: z.string().min(6).max(64).regex(/^[A-Za-z0-9_-]+$/),
    site: z.enum(SITE_KEYS).optional(),
  },
  run: async ({ id, site }) => {
    const where = site ? [site] : await locate(id);
    if (!where.length) return { data: { id, found: false, note: 'No order with this id in any shop database. Try find_customer with the e-mail.' }, rows: 0 };
    const shops = await Promise.all(where.map((k) => (siteOf(k).kind === 'film' ? filmOrder(id) : songOrder(k, id))));
    const like = `%${id}%`;
    const [cases, actions, wa, waLink, fixes, memory] = await Promise.all([
      qSafe('agent', `SELECT code, brand, channel, status, "fixStatus", "ownerOnly", "fromEmail", subject, "createdAt", "resolvedAt", left("operatorNote", 400) AS "operatorNote", left("operatorReply", 400) AS "operatorReply"
        FROM "EscalationCase" WHERE subject ILIKE $1 OR "operatorNote" ILIKE $1 OR "proposedFixJson"::text ILIKE $1 ORDER BY "createdAt" DESC LIMIT 15`, [like]),
      qSafe('agent', `SELECT ts, brand, kind, tool, left(note, 300) AS note, "sessionId" FROM "ActionLog" WHERE "orderRef" = $1 ORDER BY ts DESC LIMIT 40`, [id]),
      qSafe('agent', `SELECT "createdAt", brand, direction, kind, "msgType", status, source, left(body, 600) AS body, "errorTitle" FROM "WaMessage" WHERE "orderId" = $1 ORDER BY "createdAt" DESC LIMIT 40`, [id]),
      qSafe('agent', `SELECT brand, "createdAt", "deliveredAt", "messagesSent", rating, "ratedAt", "upsellState" FROM "WaOrderLink" WHERE "orderId" = $1`, [id]),
      qSafe('agent', `SELECT "createdAt", brand, channel, category, status, left(summary, 300) AS summary, left(requested, 400) AS requested, "newOrderId", "followupAt" FROM "IssueFix" WHERE "orderRef" = $1 ORDER BY "createdAt" DESC LIMIT 20`, [id]),
      qSafe('agent', `SELECT "createdAt", channel, left(summary, 500) AS summary FROM "CustomerMemory" WHERE "orderRef" = $1 ORDER BY "createdAt" DESC LIMIT 10`, [id]),
    ]);
    return {
      data: {
        id, found_in: where, shops,
        support: { escalation_cases: cases.rows, sofia_actions: actions.rows, whatsapp_messages: wa.rows, whatsapp_link: waLink.rows, fixes: fixes.rows, customer_memory: memory.rows },
        errors: [cases, actions, wa, waLink, fixes, memory].map((r) => r.error).filter(Boolean),
      },
      rows: shops.length,
    };
  },
});
