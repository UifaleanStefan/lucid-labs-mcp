import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FILES_DIR, SITES } from '../config.js';
import { q, qSafe } from '../db.js';
import { hqGet } from '../hq.js';
import { DATE, dayRange, tool } from './registry.js';

const HQ_SITE_KEYS = 'manele, melodie, regalo, cadeau, cancion, songgift, geschenk, podarunek, doro, hediye, tucancion, santa (Magic Chapter RO), santa_it, santa_es, santa_fr, santa_de, santa_el, santa_pl, santa_hu, santa_bg, santa_hr, santa_sr, santa_cs, santa_nl, santa_pt, santa_sk, santa_sv, santa_fi, santa_uk, santa_tr';
const W = ['orders', 'paidOrders', 'drafts', 'revenueNative', 'revenueEur', 'adsEur', 'metaEur', 'tiktokEur', 'googleEur', 'profitEur', 'roas', 'roasMeta', 'roasTiktok', 'roasGoogle', 'convPct', 'marginPct', 'breakEvenEur', 'stripeEur', 'sunoEur', 'openaiEur', 'infraEur'];
const pick = (o: any, keys = W) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : null);

tool({
  name: 'today',
  title: 'Today, live: orders, revenue, ads, profit per site',
  description:
    'The real-time picture HQ shows on its first screen: today and yesterday (Romanian days) for the whole fleet and per site: orders, paid orders, drafts, revenue (native + EUR), ad spend (Meta/TikTok/Google, EUR), ROAS, conversion %, profit. ' +
    'Also the pace vs the same hour yesterday, HQ alerts, and the operational queue counts (paid-undelivered, stuck generating, unfinished payments, missing invoices). Source: HQ /api/hq/fleet (ProfitSnapshot, refreshed ~every 10 min).',
  input: { site: z.string().optional().describe(`optional, one HQ site key: ${HQ_SITE_KEYS}`) },
  run: async ({ site }) => {
    const f = await hqGet('/api/hq/fleet', 60_000);
    let counts: unknown = null;
    try { counts = (await hqGet('/api/hq/orders?counts=1', 60_000)).counts; } catch (e) { counts = { error: (e as Error).message }; }
    const sites = (f.sites || []).filter((s: any) => !site || s.key === site).map((s: any) => ({
      key: s.key, label: s.label, currency: s.currency,
      today: pick(s.windows?.today), yesterday: pick(s.windows?.yesterday),
      data_ok: s.snapshot?.ok, stale: s.snapshot?.stale, adsError: s.snapshot?.adsError || null, tiktokError: s.snapshot?.tiktokError || null,
    }));
    if (site && !sites.length) throw new Error(`unknown HQ site "${site}". Known: ${HQ_SITE_KEYS}`);
    return {
      data: {
        snapshotAt: f.snapshotAt, snapshotAgeMin: f.snapshotAgeMin, eurToRon: f.eurToRon,
        fleet: site ? undefined : { today: pick(f.totals?.today), yesterday: pick(f.totals?.yesterday), pace_same_hour_yesterday: f.paceTotals },
        sites, alerts: f.alerts, queues: counts,
        notes: 'All money in EUR unless "Native". Days are Romanian days. Ads bill in RON and HQ converts. Google may be an assumed daily figure until its push arrives; TikTok can be carried forward on an API failure.',
      },
      rows: sites.length,
    };
  },
});

tool({
  name: 'kpis',
  title: 'KPIs for any date range',
  description:
    'Orders, paid orders, drafts, revenue, ad spend per channel, ROAS, conversion %, margin and profit for a date range (Romanian days, inclusive), fleet total and per site, with the previous equal period for comparison. ' +
    'Source: HQ /api/hq/fleet/range (built from the daily ProfitSnapshots). Default: the last 7 complete days.',
  input: { from: DATE.optional(), to: DATE.optional(), site: z.string().optional().describe(`optional HQ site key: ${HQ_SITE_KEYS}`) },
  run: async ({ from, to, site }) => {
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const r = dayRange(from, to ?? yesterday, 7);
    const d = await hqGet(`/api/hq/fleet/range?from=${r.from}&to=${r.to}&prev=1`, 90_000);
    if (site) {
      const s = d.sites?.[site];
      if (!s) throw new Error(`no site "${site}" in the range answer. Known: ${Object.keys(d.sites || {}).join(', ')}`);
      return { data: { from: d.from, to: d.to, days: d.days, site, kpis: s, previous: d.prev?.sites?.[site] ?? null, missingDays: d.siteMissingDays?.[site] ?? d.missingDays } };
    }
    return { data: d, rows: Object.keys(d.sites || {}).length };
  },
});

tool({
  name: 'profit',
  title: 'Profit and costs (HQ profit snapshot)',
  description:
    'Profit, revenue, every cost line (Meta, TikTok, Google, Stripe fees, Suno, OpenAI, infra, shared) and ROAS, from HQ\'s newest ProfitSnapshot (computed every ~10 min for every site). ' +
    'window = today | yesterday | d7 | month | d30. With from/to it uses the range engine instead. With monthly=true it returns the monthly P&L report (HQ /api/hq/report).',
  input: {
    window: z.enum(['today', 'yesterday', 'd7', 'month', 'd30']).optional(),
    from: DATE.optional(), to: DATE.optional(),
    monthly: z.boolean().optional(),
    site: z.string().optional().describe(`optional HQ site key: ${HQ_SITE_KEYS}`),
  },
  run: async ({ window, from, to, monthly, site }) => {
    if (monthly) return { data: await hqGet('/api/hq/report', 90_000) };
    if (from || to) {
      const r = dayRange(from, to, 7);
      const d = await hqGet(`/api/hq/fleet/range?from=${r.from}&to=${r.to}`, 90_000);
      return { data: site ? { from: d.from, to: d.to, site, kpis: d.sites?.[site] ?? null } : { from: d.from, to: d.to, totals: d.totals, sites: d.sites } };
    }
    const w = window || 'today';
    const [row] = await q('manele', `SELECT "createdAt" AS at, payload->'windows'->$1 AS win, payload->'totals'->$1 AS totals, payload->'eurToRon' AS "eurToRon",
        (SELECT jsonb_object_agg(k, jsonb_build_object('label', v->'label', 'ok', v->'ok', 'w', v->'windows'->$1)) FROM jsonb_each(payload->'sites') AS e(k, v)) AS sites
      FROM "ProfitSnapshot" ORDER BY "createdAt" DESC LIMIT 1`, [w]);
    if (!row) throw new Error('no ProfitSnapshot rows');
    const sites = row.sites as Record<string, any>;
    return {
      data: {
        snapshotAt: row.at, window: w, windowBounds: row.win, eurToRon: row.eurToRon,
        totals: site ? undefined : row.totals,
        sites: site ? { [site]: sites?.[site] ?? null } : sites,
        notes: 'EUR. costEur = all costs; profitEur = revenueEur - costEur. Check windowBounds (startIso/endIso) before quoting a day.',
      },
    };
  },
});

tool({
  name: 'live_queue',
  title: 'Magic Chapter live production queue',
  description:
    'What the Magic Chapter (Santa film) factory is doing right now: render queue by state, jobs running and their workers, LATE films (paid > 60 min, not ready, no later delivery date chosen), HELD / FAILED films that need a person, demos stuck > 20 min, carols in production, and the song shops\' stuck queues. Read live from the databases.',
  input: { hours: z.number().int().min(1).max(168).optional().describe('look-back for held/failed lists, default 48') },
  run: async ({ hours }) => {
    const h = hours ?? 48;
    const [states, running, workers, late, held, demos, carols, recentDone] = await Promise.all([
      q('santa', `SELECT kind, state, count(*)::int AS n FROM render_jobs WHERE created_at > (now() at time zone 'UTC') - interval '7 days' OR state IN ('queued','running') GROUP BY 1,2 ORDER BY 1,2`),
      q('santa', `SELECT id, kind, variant, order_id, demo_id, worker, priority, attempts, created_at, started_at, heartbeat_at FROM render_jobs WHERE state IN ('running','queued') ORDER BY state DESC, priority DESC, created_at LIMIT 100`),
      q('santa', `SELECT name, state, job_id, started_at, seen_at FROM render_workers ORDER BY name`),
      q('santa', `SELECT o.id, o.language, o.market, o."childName", o."child2Name", o.kids, o."paymentConfirmedAt" AS "paidAt",
          floor(extract(epoch FROM ((now() at time zone 'UTC') - o."paymentConfirmedAt")) / 60)::int AS "minutesSincePaid", o.status, v.status AS film,
          (SELECT j.state FROM render_jobs j WHERE j.order_id = o.id AND j.kind = 'film' ORDER BY j.created_at DESC LIMIT 1) AS job
        FROM "Order" o LEFT JOIN "Video" v ON v."orderId" = o.id
        WHERE o."paymentConfirmedAt" IS NOT NULL AND o."refundedAt" IS NULL AND o.status NOT IN ('completed') AND coalesce(v.status, '') <> 'ready'
          AND (o."deliverAt" IS NULL OR o."deliverAt" <= (now() at time zone 'UTC'))
          AND o."paymentConfirmedAt" < (now() at time zone 'UTC') - interval '60 minutes' AND o."stripeSessionId" <> 'simulated'
        ORDER BY o."paymentConfirmedAt" LIMIT 200`),
      q('santa', `SELECT j.id, j.kind, j.state, j.order_id, j.demo_id, left(j.reason, 300) AS reason, j.attempts, j.created_at, j.finished_at
        FROM render_jobs j WHERE j.state IN ('held','failed') AND j.created_at > (now() at time zone 'UTC') - make_interval(hours => $1)
        ORDER BY j.created_at DESC LIMIT 200`, [h]),
      q('santa', `SELECT id, status, lang, "createdAt", floor(extract(epoch FROM ((now() at time zone 'UTC') - "createdAt")) / 60)::int AS minutes, left(error, 200) AS error
        FROM "DemoRequest" WHERE stub = false AND status NOT IN ('ready','failed','expired') AND "createdAt" < (now() at time zone 'UTC') - interval '20 minutes'
          AND "createdAt" > (now() at time zone 'UTC') - interval '3 days' ORDER BY "createdAt" LIMIT 100`),
      q('santa', `SELECT "orderId", status, attempts, left(error, 200) AS error, "createdAt", "updatedAt" FROM "OrderCarol" WHERE status NOT IN ('ready','done','delivered','sent') ORDER BY "createdAt" DESC LIMIT 100`),
      q('santa', `SELECT kind, count(*)::int AS n, round(avg(render_s))::int AS avg_render_s FROM render_jobs WHERE state = 'done' AND finished_at > (now() at time zone 'UTC') - interval '24 hours' GROUP BY 1`),
    ]);
    let songQueues: unknown = null;
    try { songQueues = (await hqGet('/api/hq/orders?counts=1', 60_000)).counts; } catch (e) { songQueues = { error: (e as Error).message }; }
    return {
      data: {
        at: new Date().toISOString(),
        film_queue_by_state: states, running_or_queued: running, workers,
        late_films: late, held_or_failed_jobs: held, demos_stuck_over_20min: demos, carols_in_production: carols,
        done_last_24h: recentDone, song_shop_queues: songQueues,
        notes: 'Late = paid > 60 min, not ready, delivery not deferred. HELD = the checks stopped a film (name, photo, map…) and the film doctor / a person must act. Times UTC.',
      },
      rows: late.length + held.length,
    };
  },
});

// ── files synced from the orchestrator's PC (D:/lucid-ops) ────────────────
export function filesRoot(): string { return FILES_DIR; }
export function readSynced(rel: string): string | null {
  const p = path.resolve(FILES_DIR, rel);
  if (!p.startsWith(path.resolve(FILES_DIR))) throw new Error('path outside the shared folder');
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
export function syncedAt(): string | null {
  try { return fs.readFileSync(path.join(FILES_DIR, '.synced-at'), 'utf8').trim(); } catch { return null; }
}

tool({
  name: 'experiments',
  title: 'Experiments (EXPERIMENTS.md + HQ results)',
  description:
    'Every conversion-moving change is an experiment (E1…E156+), logged in EXPERIMENTS.md by the orchestrator. ' +
    'No id: the list of experiments (id, title, status line). With id (e.g. "E155"): the full write-up, plus HQ\'s live result for it when HQ tracks it. With query: experiments whose text matches.',
  input: { id: z.string().regex(/^E?\d{1,4}[a-z]?$/i).optional(), query: z.string().optional(), with_hq_results: z.boolean().optional().describe('default true when id is given') },
  run: async ({ id, query, with_hq_results }) => {
    const md = readSynced('EXPERIMENTS.md');
    if (md == null) throw new Error('EXPERIMENTS.md has not been synced to the server yet');
    const COLS = ['id', 'type', 'experiment', 'sites', 'since', 'method', 'primaryMetric', 'guardrails', 'readouts', 'status'];
    const lines = md.split(/\r?\n/);
    const sections = lines.filter((l) => /^\|\s*E\d+[a-z]?\s*\|/i.test(l)).map((l) => {
      const cells = l.replace(/^\|/, '').replace(/\|\s*$/, '').split(/\s\|\s/).map((c) => c.trim());
      const row: Record<string, string> = {};
      COLS.forEach((c, i) => { row[c] = cells[i] ?? ''; });
      if (cells.length > COLS.length) row.status = cells.slice(COLS.length - 1).join(' | ');
      return { id: row.id.toUpperCase(), head: row.experiment.replace(/\*\*/g, '').slice(0, 220), status: row.status.slice(0, 300), type: row.type.replace(/`/g, ''), row, body: l };
    });
    if (id) {
      const want = id.toUpperCase().startsWith('E') ? id.toUpperCase() : `E${id}`;
      const hits = sections.filter((s) => s.id === want);
      const idRe = new RegExp(`(^|[^A-Za-z0-9])${want}([^0-9a-z]|$)`);
      const mentions = lines.filter((l) => idRe.test(l) && !hits.some((h) => h.body === l)).map((l) => l.slice(0, 1500)).slice(0, 30);
      let hq: unknown = undefined;
      if (with_hq_results !== false) {
        try { hq = await hqGet(`/api/hq/experiments/${encodeURIComponent(want)}`, 90_000); } catch (e) { hq = { note: `HQ has no live result for ${want}: ${(e as Error).message.slice(0, 200)}` }; }
      }
      return { data: { id: want, found: hits.length > 0, entry: hits.map((s) => s.row), other_mentions: mentions, hq_result: hq, syncedAt: syncedAt() } };
    }
    if (query) {
      const needle = query.toLowerCase();
      const hits = sections.filter((s) => s.body.toLowerCase().includes(needle));
      return { data: { query, matches: hits.map((s) => ({ id: s.id, type: s.type, title: s.head, status: s.status, entry: s.row })), syncedAt: syncedAt() } };
    }
    return { data: { count: sections.length, legend: 'Status: 🟢 live · 🟡 built, not live · ⚪ planned · ✅ kept · ↩️ rolled back · ⏸️ paused · ⏹️ closed without a verdict', experiments: sections.map((s) => ({ id: s.id, type: s.type, title: s.head, status: s.status.slice(0, 160) })), syncedAt: syncedAt() } };
  },
});

void SITES; void qSafe;
