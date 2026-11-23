import { z } from 'zod';
import { env, META_ACCOUNTS, site as siteOf, TIKTOK_ADVERTISER } from '../config.js';
import { q, qSafe } from '../db.js';
import { hqGet } from '../hq.js';
import { DATE, dayRange, tool } from './registry.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

// ── FX (same source as HQ's fxRate.ts) ──
let fx: { at: number; rates: Record<string, number> } | null = null;
async function eurRates(): Promise<Record<string, number>> {
  if (fx && Date.now() - fx.at < 3600_000) return fx.rates;
  try {
    const j: any = await (await fetch('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(10_000) })).json();
    if (j?.rates?.RON) fx = { at: Date.now(), rates: j.rates };
  } catch { /* keep the old one */ }
  return fx?.rates || { EUR: 1, RON: 5.09, USD: 1.08, PLN: 4.25, TRY: 37, GBP: 0.85, HUF: 400, CZK: 25, SEK: 11.3, RSD: 117 };
}
async function toRon(amountMinor: number, currency: string): Promise<number> {
  const r = await eurRates();
  const cur = (currency || 'EUR').toUpperCase();
  const eur = (amountMinor / 100) / (r[cur] || 1);
  return eur * (r.RON || 5);
}

// ── Meta ──
interface AcctState { key: string; label: string; id: string; available: boolean; reason?: string; name?: string; currency?: string; status?: number; timezone?: string }
let acctCache: { at: number; list: AcctState[] } | null = null;

async function graph(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Meta ${path.split('?')[0]}: ${j?.error?.message || `HTTP ${r.status}`}`.replace(/access_token=[^&\s]+/g, 'access_token=[hidden]'));
  return j;
}

async function metaAccounts(force = false): Promise<AcctState[]> {
  if (!force && acctCache && Date.now() - acctCache.at < 10 * 60_000) return acctCache.list;
  const list = await Promise.all(META_ACCOUNTS.map(async (a): Promise<AcctState> => {
    const id = env(a.idEnv).replace(/^act_/, '');
    const token = env(a.tokenEnv);
    if (!id) return { key: a.key, label: a.label, id: '', available: false, reason: 'no ad account id configured for this shop' };
    if (!token) return { key: a.key, label: a.label, id: `act_${id}`, available: false, reason: 'no access token for this ad account yet' };
    try {
      const j = await graph(`/act_${id}`, token, { fields: 'name,currency,account_status,timezone_name' });
      return { key: a.key, label: a.label, id: `act_${id}`, available: true, name: j.name, currency: j.currency, status: j.account_status, timezone: j.timezone_name };
    } catch (e) {
      return { key: a.key, label: a.label, id: `act_${id}`, available: false, reason: `the token cannot read this account: ${(e as Error).message.slice(0, 200)}` };
    }
  }));
  acctCache = { at: Date.now(), list };
  return list;
}

tool({
  name: 'meta_accounts',
  title: 'Meta ad accounts and whether each one is readable',
  description: 'Every Meta (Facebook/Instagram) ad account of the company: shop, account id, name, currency, status, and whether this server can read it right now (with the reason when it cannot).',
  input: { refresh: z.boolean().optional() },
  run: async ({ refresh }) => {
    const list = await metaAccounts(!!refresh);
    return { data: { accounts: list, note: 'Every account bills in RON. account_status 1 = active. An unavailable account is reported, never guessed.' }, rows: list.length };
  },
});

const LEVEL_FIELDS: Record<string, string> = {
  account: 'account_id,account_name',
  campaign: 'campaign_id,campaign_name',
  adset: 'campaign_id,campaign_name,adset_id,adset_name',
  ad: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name',
};
const METRICS = 'spend,impressions,reach,frequency,clicks,inline_link_clicks,cpm,cpc,ctr,inline_link_click_ctr,actions,action_values,purchase_roas';

tool({
  name: 'meta_insights',
  title: 'Meta ads performance (spend, CPM, CTR, CPA, ROAS) with DB revenue',
  description:
    'Meta Ads insights for one ad account (or "all") and a date range, at level account | campaign | adset | ad, optionally per day. ' +
    'Returns spend (RON), impressions, reach, clicks, CPM, CPC, CTR, Meta-reported purchases / value / ROAS, and, at ad and campaign level, the REAL revenue from our database (paid orders whose utm_content = ad id), converted to RON, with db_roas = DB revenue / spend and db_cpa. ' +
    'ROAS you can defend = DB revenue ÷ spend; Meta "purchases" over-report. Use meta_accounts to see which accounts are readable.',
  input: {
    account: z.string().describe(`one of: ${META_ACCOUNTS.map((a) => a.key).join(', ')}, or "all"`),
    from: DATE.optional(), to: DATE.optional(),
    level: z.enum(['account', 'campaign', 'adset', 'ad']).optional(),
    daily: z.boolean().optional().describe('one row per day'),
    active_only: z.boolean().optional().describe('only rows with spend > 0 (default true)'),
  },
  run: async ({ account, from, to, level, daily, active_only }) => {
    const r = dayRange(from, to, 7);
    const lvl = level || 'campaign';
    const accts = await metaAccounts();
    const wanted = account === 'all' ? accts : accts.filter((a) => a.key === account);
    if (!wanted.length) throw new Error(`unknown account "${account}". Known: ${accts.map((a) => a.key).join(', ')}`);
    const unavailable = wanted.filter((a) => !a.available).map((a) => ({ account: a.key, id: a.id, reason: a.reason }));
    const results = await Promise.all(wanted.filter((a) => a.available).map(async (a) => {
      const cfg = META_ACCOUNTS.find((x) => x.key === a.key)!;
      const token = env(cfg.tokenEnv);
      const rows: any[] = [];
      let next: string | null = null;
      const params: Record<string, string> = {
        level: lvl, fields: `${LEVEL_FIELDS[lvl]},${METRICS}`, time_range: JSON.stringify({ since: r.from, until: r.to }), limit: '500',
      };
      if (daily) params.time_increment = '1';
      let j = await graph(`/${a.id}/insights`, token, params);
      rows.push(...(j.data || []));
      for (let i = 0; i < 10 && j.paging?.next; i++) {
        next = j.paging.next as string;
        const resp = await fetch(next, { signal: AbortSignal.timeout(60_000) });
        j = await resp.json();
        rows.push(...(j.data || []));
      }
      const slim = rows.map((x) => {
        const purchases = (x.actions || []).find((y: any) => y.action_type === 'purchase' || y.action_type === 'offsite_conversion.fb_pixel_purchase');
        const value = (x.action_values || []).find((y: any) => y.action_type === 'purchase' || y.action_type === 'offsite_conversion.fb_pixel_purchase');
        const out: Record<string, unknown> = {};
        for (const k of LEVEL_FIELDS[lvl].split(',')) out[k] = x[k];
        if (daily) out.day = x.date_start;
        Object.assign(out, {
          spend: Number(x.spend || 0), impressions: Number(x.impressions || 0), reach: Number(x.reach || 0), frequency: x.frequency ? Number(x.frequency) : null,
          clicks: Number(x.clicks || 0), link_clicks: Number(x.inline_link_clicks || 0), cpm: x.cpm ? Number(x.cpm) : null, cpc: x.cpc ? Number(x.cpc) : null,
          ctr: x.ctr ? Number(x.ctr) : null, link_ctr: x.inline_link_click_ctr ? Number(x.inline_link_click_ctr) : null,
          meta_purchases: purchases ? Number(purchases.value) : 0, meta_purchase_value: value ? Number(value.value) : 0,
          meta_roas: x.purchase_roas?.[0]?.value ? Number(x.purchase_roas[0].value) : null,
        });
        return out;
      }).filter((x) => active_only === false || (x.spend as number) > 0);

      // DB revenue join (ad id = utm_content; campaign id = utm_campaign) — same join as HQ's per-ad view.
      if ((lvl === 'ad' || lvl === 'campaign') && !daily) {
        const s = siteOf(cfg.site);
        const col = lvl === 'ad' ? s.contentCol! : (s.kind === 'song-manele' ? 'utmCampaign' : 'attributionUtmCampaign');
        const ids = [...new Set(slim.map((x) => String(lvl === 'ad' ? x.ad_id : x.campaign_id)))].filter(Boolean);
        if (ids.length) {
          const real = s.kind === 'film' ? `AND "stripeSessionId" <> 'simulated'` : '';
          const rev = await qSafe(s.key, `SELECT "${col}" AS k, count(*)::int AS n, currency, sum(amount)::bigint AS amt FROM "Order"
            WHERE "${s.paidCol}" >= $1::date AND "${s.paidCol}" < ($2::date + 1) AND amount > 0 AND "${col}" = ANY($3) ${real} GROUP BY 1, 3`, [r.from, r.to, ids]);
          const by = new Map<string, { n: number; ron: number }>();
          for (const row of rev.rows) {
            const cur = by.get(String(row.k)) || { n: 0, ron: 0 };
            cur.n += Number(row.n); cur.ron += await toRon(Number(row.amt), String(row.currency));
            by.set(String(row.k), cur);
          }
          for (const x of slim) {
            const hit = by.get(String(lvl === 'ad' ? x.ad_id : x.campaign_id));
            x.db_paid_orders = hit?.n ?? 0;
            x.db_revenue_ron = hit ? Math.round(hit.ron * 100) / 100 : 0;
            x.db_roas = (x.spend as number) > 0 && hit ? Math.round((hit.ron / (x.spend as number)) * 100) / 100 : (hit ? null : 0);
            x.db_cpa_ron = hit?.n ? Math.round(((x.spend as number) / hit.n) * 100) / 100 : null;
          }
          if (rev.error) slim.push({ db_join_error: rev.error });
        }
      }
      const totalSpend = slim.reduce((n, x) => n + (Number(x.spend) || 0), 0);
      return { account: a.key, id: a.id, name: a.name, currency: a.currency, total_spend: Math.round(totalSpend * 100) / 100, rows: slim };
    }));
    return {
      data: { from: r.from, to: r.to, level: lvl, results, unavailable, notes: 'Spend in the account currency (RON). DB revenue converted to RON at today\'s rate (open.er-api.com, as HQ). Orders without the ad id in utm_content are not joined (no fake 0 for them at campaign level: see HQ ads/individual for coverage).' },
      rows: results.reduce((n, x) => n + x.rows.length, 0),
    };
  },
});

// ── TikTok ──
const TT = 'https://business-api.tiktok.com/open_api/v1.3';
async function tt(path: string, params: Record<string, unknown>): Promise<any> {
  const token = env('TT_ADS_TOKEN');
  if (!token) throw new Error('TikTok reporting is not configured on this server');
  const u = new URL(TT + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(u, { headers: { 'Access-Token': token }, signal: AbortSignal.timeout(60_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 0) throw new Error(`TikTok ${path}: ${j?.message || `HTTP ${r.status}`} (code ${j?.code})`);
  return j.data;
}

const MC_TT_ADVERTISER = env('MC_TT_ADVERTISER_ID', '7705919739184529414');
const TT_BRANDS = ['manele', 'melodie', 'regalo', 'cadeau', 'cancion'];
function brandOfCampaign(id: string): string {
  for (const b of TT_BRANDS) if (env(`${b.toUpperCase()}_TT_CAMPAIGN_IDS`).split(',').map((x) => x.trim()).includes(id)) return b;
  return '';
}

tool({
  name: 'tiktok_report',
  title: 'TikTok ads performance',
  description:
    'TikTok Ads report for a date range: spend, impressions, clicks, CTR, CPM, CPC, conversions, Complete Payment count and value, Complete-Payment ROAS, per campaign (or adgroup / ad), optionally per day. ' +
    `The song shops share one account (${TIKTOK_ADVERTISER}); filter by campaign_id or brand (manele, melodie, regalo, cadeau, cancion). ` +
    'Magic Chapter runs on a separate account (SRL1108); its numbers come from HQ\'s TikTok feed table when the API cannot read that account. ' +
    'Note: the account clock is UTC+2; TikTok\'s "purchase" metrics read 0 — the real ones are complete_payment*. Also returns DB revenue attributed to TikTok per shop.',
  input: {
    from: DATE.optional(), to: DATE.optional(),
    level: z.enum(['campaign', 'adgroup', 'ad']).optional(),
    brand: z.enum(['manele', 'melodie', 'regalo', 'cadeau', 'cancion', 'santa']).optional(),
    campaign_id: z.string().regex(/^\d+$/).optional(),
    daily: z.boolean().optional(),
  },
  run: async ({ from, to, level, brand, campaign_id, daily }) => {
    const r = dayRange(from, to, 7);
    const lvl = level || 'campaign';
    if (brand === 'santa') {
      let apiNote = '';
      try {
        await tt('/report/integrated/get/', { advertiser_id: MC_TT_ADVERTISER, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: ['campaign_id'], metrics: ['spend'], start_date: r.from, end_date: r.from, page_size: 1 });
        apiNote = 'the API can read this account now: ask the server maintainer to switch Magic Chapter to the API';
      } catch (e) { apiNote = `TikTok API cannot read the Magic Chapter account ${MC_TT_ADVERTISER}: ${(e as Error).message}`; }
      const rows = await q('manele', `SELECT day, level, "campaignId", "campaignName", "entityId", "adName", currency, spend, impressions, clicks, ctr, cpc, cpm, conversions, "costPerConversion", "fetchedAt"
        FROM "TtFeedRow" WHERE day >= $1 AND day <= $2 ORDER BY day DESC, spend DESC LIMIT 1000`, [r.from, r.to]);
      return { data: { from: r.from, to: r.to, advertiser: MC_TT_ADVERTISER, source: 'HQ TikTok feed (TtFeedRow, read from the Ads Manager UI for the Magic Chapter account, refreshed a few times a day)', api_status: apiNote, rows }, rows: rows.length };
    }
    const dataLevel = { campaign: 'AUCTION_CAMPAIGN', adgroup: 'AUCTION_ADGROUP', ad: 'AUCTION_AD' }[lvl];
    const dimKey = { campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'ad_id' }[lvl];
    const metrics = ['spend', 'impressions', 'clicks', 'ctr', 'cpm', 'cpc', 'conversion', 'cost_per_conversion', 'complete_payment', 'value_per_complete_payment', 'complete_payment_roas', 'total_complete_payment_rate',
      'campaign_name', ...(lvl !== 'campaign' ? ['adgroup_name'] : []), ...(lvl === 'ad' ? ['ad_name'] : []), ...(lvl !== 'campaign' ? ['campaign_id'] : [])];
    const campaigns = campaign_id ? [campaign_id] : brand ? env(`${brand.toUpperCase()}_TT_CAMPAIGN_IDS`).split(',').map((x) => x.trim()).filter(Boolean) : [];
    if (brand && !campaigns.length) throw new Error(`no TikTok campaigns are mapped to ${brand}`);
    const params: Record<string, unknown> = {
      advertiser_id: TIKTOK_ADVERTISER, report_type: 'BASIC', data_level: dataLevel,
      dimensions: daily ? [dimKey, 'stat_time_day'] : [dimKey], metrics, start_date: r.from, end_date: r.to, page_size: 1000,
    };
    if (campaigns.length) params.filtering = [{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify(campaigns) }];
    const d = await tt('/report/integrated/get/', params);
    const rows = (d.list || []).map((x: any) => {
      const m = x.metrics || {};
      const num = (k: string) => (m[k] === undefined || m[k] === '-' ? null : Number(m[k]));
      const cid = m.campaign_id || x.dimensions?.campaign_id;
      return {
        ...x.dimensions, campaign_name: m.campaign_name, adgroup_name: m.adgroup_name, ad_name: m.ad_name, brand: brandOfCampaign(String(cid || '')) || null,
        spend: num('spend'), impressions: num('impressions'), clicks: num('clicks'), ctr: num('ctr'), cpm: num('cpm'), cpc: num('cpc'),
        conversions: num('conversion'), cost_per_conversion: num('cost_per_conversion'),
        complete_payments: num('complete_payment'), complete_payment_value: num('total_complete_payment_rate'), value_per_complete_payment: num('value_per_complete_payment'), complete_payment_roas: num('complete_payment_roas'),
      };
    }).filter((x: any) => (x.spend || 0) > 0 || (x.impressions || 0) > 0);
    // DB revenue attributed to TikTok (playbook-ads-apis: utm_source tiktok or a ttclid), per shop, in RON
    const db: Record<string, unknown> = {};
    for (const b of brand ? [brand] : TT_BRANDS) {
      const s = siteOf(b);
      const where = s.kind === 'song-manele'
        ? `(lower("utmSource") LIKE '%tiktok%' OR coalesce("ttclid", '') <> '')`
        : `("attributionUtmSource" ILIKE '%tiktok%' OR coalesce("attributionTtclid", '') <> '')`;
      const res = await qSafe(b, `SELECT count(*)::int AS n, currency, sum(amount)::bigint AS amt FROM "Order" WHERE "${s.paidCol}" >= $1::date AND "${s.paidCol}" < ($2::date + 1) AND amount > 0 AND ${where} GROUP BY currency`, [r.from, r.to]);
      let ron = 0, n = 0;
      for (const row of res.rows) { ron += await toRon(Number(row.amt), String(row.currency)); n += Number(row.n); }
      db[b] = res.error ? { error: res.error } : { paid_orders: n, revenue_ron: Math.round(ron * 100) / 100 };
    }
    return { data: { from: r.from, to: r.to, advertiser: TIKTOK_ADVERTISER, level: lvl, currency: 'RON', rows, db_revenue_tiktok_attributed: db }, rows: rows.length };
  },
});

tool({
  name: 'google_ads',
  title: 'Google Ads (from the daily push into HQ)',
  description:
    'Google Ads spend, clicks, impressions, conversions and conversion value per site and campaign for a date range. There is no Google Ads API here: each account pushes its daily rows into HQ (table GoogleAdsDay), so "today" is empty until the next push. ' +
    'Returns HQ\'s per-site summary (with DB revenue and ROAS) and the raw daily campaign rows.',
  input: { from: DATE.optional(), to: DATE.optional(), site: z.string().optional() },
  run: async ({ from, to, site }) => {
    const r = dayRange(from, to, 7);
    let summary: unknown;
    try { summary = await hqGet(`/api/hq/google-ads?from=${r.from}&to=${r.to}`, 60_000); } catch (e) { summary = { error: (e as Error).message }; }
    const rows = await q('manele', `SELECT day, site, "accountId", "campaignId", "campaignName", currency, cost, clicks, impressions, conversions, "convValue"
      FROM "GoogleAdsDay" WHERE day >= $1 AND day <= $2 ${site ? 'AND site = $3' : ''} ORDER BY day DESC, cost DESC LIMIT 2000`, site ? [r.from, r.to, site] : [r.from, r.to]);
    return { data: { from: r.from, to: r.to, hq_summary: summary, daily_rows: rows }, rows: rows.length };
  },
});
