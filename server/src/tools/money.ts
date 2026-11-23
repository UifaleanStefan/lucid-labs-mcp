import { z } from 'zod';
import { env, SHOP_SITES } from '../config.js';
import { qSafe } from '../db.js';
import { hqGet } from '../hq.js';
import { DATE, dayRange, tool } from './registry.js';

// ── Stripe (read-only: GET requests only) ─────────────────────────────────
const STRIPE_PATHS: Record<string, string> = {
  balance: '/v1/balance',
  balance_transactions: '/v1/balance_transactions',
  charges: '/v1/charges',
  payment_intents: '/v1/payment_intents',
  checkout_sessions: '/v1/checkout/sessions',
  payouts: '/v1/payouts',
  disputes: '/v1/disputes',
  refunds: '/v1/refunds',
  customers: '/v1/customers',
  payment_method_configurations: '/v1/payment_method_configurations',
  events: '/v1/events',
  invoices: '/v1/invoices',
  products: '/v1/products',
  prices: '/v1/prices',
  coupons: '/v1/coupons',
  promotion_codes: '/v1/promotion_codes',
  tax_rates: '/v1/tax_rates',
  account: '/v1/account',
};
const SEARCHABLE = new Set(['charges', 'payment_intents', 'customers', 'invoices', 'prices', 'products']);

function stripeKey(account: string): string {
  const k = account === 'magic_chapter' ? env('MC_STRIPE_SECRET_KEY') || env('STRIPE_SECRET_KEY') : env('STRIPE_SECRET_KEY');
  if (!k) throw new Error('Stripe is not configured on this server');
  return k;
}

async function stripeGet(account: string, path: string, params: URLSearchParams): Promise<any> {
  const url = `https://api.stripe.com${path}${params.toString() ? '?' + params.toString() : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${stripeKey(account)}`, 'Stripe-Version': '2024-06-20' }, signal: AbortSignal.timeout(45_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${path} → HTTP ${r.status}: ${j?.error?.message || ''}`);
  return j;
}

const unix = (d: string, end = false) => Math.floor(new Date(`${d}T${end ? '23:59:59' : '00:00:00'}Z`).getTime() / 1000);

tool({
  name: 'stripe',
  title: 'Stripe (read-only)',
  description:
    'Read Stripe: balance, balance_transactions, charges, payment_intents, checkout_sessions, payouts, disputes, refunds, customers, payment_method_configurations, events, invoices, products, prices, coupons, promotion_codes, tax_rates, account. ' +
    'One Stripe account serves every song shop; account="magic_chapter" uses Magic Chapter\'s key (same or separate account, the answer says which). ' +
    'Filter with created_from/created_to (YYYY-MM-DD, UTC), status, or a Stripe search query (search=, for charges/payment_intents/customers/invoices, e.g. "metadata[\'orderId\']:\'cm…\'" or "email:\'a@b.c\'"). ' +
    'id retrieves one object. max = how many objects to page through (default 25, up to 1000). Only GET requests are ever made: nothing can be refunded or changed. Amounts are in minor units (cents/bani).',
  input: {
    resource: z.enum(Object.keys(STRIPE_PATHS) as [string, ...string[]]),
    account: z.enum(['main', 'magic_chapter']).optional(),
    id: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
    created_from: DATE.optional(), created_to: DATE.optional(),
    status: z.string().regex(/^[a-z_]+$/).optional(),
    search: z.string().max(500).optional(),
    customer: z.string().regex(/^cus_[A-Za-z0-9]+$/).optional(),
    payment_intent: z.string().regex(/^pi_[A-Za-z0-9]+$/).optional(),
    expand: z.array(z.string().regex(/^[a-z_.]+$/)).max(5).optional(),
    max: z.number().int().min(1).max(1000).optional(),
  },
  run: async (a) => {
    const account = a.account || 'main';
    const base = STRIPE_PATHS[a.resource];
    const p = new URLSearchParams();
    for (const e of a.expand || []) p.append('expand[]', e);
    if (a.resource === 'balance' || a.resource === 'account') {
      const acct = await stripeGet(account, base, p);
      if (a.resource === 'account') return { data: { id: acct.id, country: acct.country, default_currency: acct.default_currency, business_profile: acct.business_profile, charges_enabled: acct.charges_enabled, payouts_enabled: acct.payouts_enabled, settings: { payouts: acct.settings?.payouts } } };
      return { data: acct };
    }
    if (a.id) return { data: await stripeGet(account, `${base}/${a.id}`, p) };
    const max = a.max ?? 25;
    if (a.search) {
      if (!SEARCHABLE.has(a.resource)) throw new Error(`search works for ${[...SEARCHABLE].join(', ')}`);
      p.set('query', a.search);
    } else {
      if (a.created_from) p.set('created[gte]', String(unix(a.created_from)));
      if (a.created_to) p.set('created[lte]', String(unix(a.created_to, true)));
      if (a.status) p.set('status', a.status);
      if (a.customer) p.set('customer', a.customer);
      if (a.payment_intent) p.set('payment_intent', a.payment_intent);
    }
    const out: unknown[] = [];
    let cursor = '';
    for (let page = 0; page < 20 && out.length < max; page++) {
      p.set('limit', String(Math.min(100, max - out.length)));
      if (cursor) p.set(a.search ? 'page' : 'starting_after', cursor);
      const j = await stripeGet(account, a.search ? `${base}/search` : base, p);
      out.push(...(j.data || []));
      if (!j.has_more) break;
      cursor = a.search ? j.next_page : j.data?.[j.data.length - 1]?.id;
      if (!cursor) break;
    }
    return { data: { resource: a.resource, account, count: out.length, data: out }, rows: out.length };
  },
});

// ── Invoices: DB view + Oblio + HQ accounting/OSS ──────────────────────────
let oblioToken: { token: string; exp: number } | null = null;
async function oblio(path: string): Promise<any> {
  const email = env('OBLIO_EMAIL'), secret = env('OBLIO_SECRET');
  if (!email || !secret) throw new Error('Oblio is not configured on this server');
  if (!oblioToken || oblioToken.exp < Date.now() + 60_000) {
    const r = await fetch('https://www.oblio.eu/api/authorize/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: email, client_secret: secret }), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Oblio auth failed (HTTP ${r.status})`);
    oblioToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  }
  const r = await fetch(`https://www.oblio.eu/api${path}`, { headers: { Authorization: `Bearer ${oblioToken.token}` }, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Oblio ${path.split('?')[0]} → HTTP ${r.status}: ${j?.statusMessage || ''}`);
  return j;
}

tool({
  name: 'invoices',
  title: 'Invoices, accounting and OSS/VAT',
  description:
    'Invoicing for a date range. source="db" (default): per shop, paid orders vs invoiced (Order.invoiceSeries/Number), with the paid orders that have NO invoice listed. ' +
    'source="oblio": the invoices in Oblio for a series (MCRO, MCIT, MCFR, MCES, MCEN, MCGE, MAGIC, …; CIF 54838465), paged. ' +
    'source="accounting": HQ\'s charged-vs-invoiced report per month. source="oss": HQ\'s OSS / VAT view (EU sales per country, VAT due). ' +
    'Read-only: nothing is issued, cancelled or sent.',
  input: {
    source: z.enum(['db', 'oblio', 'accounting', 'oss']).optional(),
    from: DATE.optional(), to: DATE.optional(),
    site: z.string().optional().describe('shop key for db/accounting (e.g. melodie, regalo, santa)'),
    series: z.string().regex(/^[A-Z]{2,8}$/).optional().describe('Oblio series, for source=oblio'),
    max: z.number().int().min(1).max(2000).optional(),
  },
  run: async ({ source, from, to, site, series, max }) => {
    const r = dayRange(from, to, 7);
    const src = source || 'db';
    if (src === 'accounting') return { data: await hqGet(`/api/hq/accounting${site ? `?site=${encodeURIComponent(site)}` : ''}`, 90_000) };
    if (src === 'oss') return { data: await hqGet('/api/hq/oss', 90_000) };
    if (src === 'oblio') {
      if (!series) throw new Error('give a series for source=oblio (e.g. MCRO, MCIT, MCFR, MCES, MCEN, MCGE, MAGIC)');
      const cif = env('OBLIO_CIF', '54838465');
      const cap = max ?? 300;
      const out: any[] = [];
      for (let offset = 0; out.length < cap && offset < 5000; offset += 100) {
        const j = await oblio(`/docs/invoice/list?cif=${cif}&seriesName=${series}&issuedAfter=${r.from}&issuedBefore=${r.to}&limitPerPage=100&offset=${offset}`);
        const rows = j.data || [];
        out.push(...rows);
        if (rows.length < 100) break;
      }
      const list = out.slice(0, cap).map((d: any) => ({ series: d.seriesName, number: d.number, issueDate: d.issueDate, total: d.total, currency: d.currency, client: d.client?.name, canceled: d.canceled, collected: d.collected, einvoice: d.einvoice ?? d.indexUpload ?? null, link: d.link }));
      return { data: { series, from: r.from, to: r.to, count: list.length, invoices: list }, rows: list.length };
    }
    const shops = SHOP_SITES.filter((s) => !site || s.key === site);
    if (!shops.length) throw new Error(`unknown shop "${site}"`);
    const per = await Promise.all(shops.map(async (s) => {
      const paid = `o."${s.paidCol}"`;
      const real = s.kind === 'film' ? `AND o."stripeSessionId" <> 'simulated'` : '';
      const email = s.kind === 'song-manele' ? 'o."deliveryEmail"' : 'o.email';
      const sum = await qSafe(s.key, `SELECT count(*)::int AS paid_orders, count(*) FILTER (WHERE o."invoiceNumber" IS NOT NULL AND o."invoiceNumber" <> '')::int AS invoiced,
          count(*) FILTER (WHERE o."invoiceIssuedAt" IS NOT NULL AND coalesce(o."invoiceNumber", '') = '')::int AS claimed_no_number,
          coalesce(sum(o.amount), 0)::bigint AS amount_minor, string_agg(DISTINCT o.currency, ',') AS currencies, string_agg(DISTINCT o."invoiceSeries", ',') AS series
        FROM "Order" o WHERE ${paid} >= $1::date AND ${paid} < ($2::date + 1) AND o.amount > 0 ${real}`, [r.from, r.to]);
      const missing = await qSafe(s.key, `SELECT o.id, ${email} AS email, o.amount, o.currency, ${paid} AS "paidAt", o."invoiceIssuedAt"
        FROM "Order" o WHERE ${paid} >= $1::date AND ${paid} < ($2::date + 1) AND o.amount > 0 ${real} AND coalesce(o."invoiceNumber", '') = '' AND o."refundedAt" IS NULL
          AND ${paid} < (now() at time zone 'UTC') - interval '2 hours' ORDER BY ${paid} LIMIT 50`.replace('AND o."refundedAt" IS NULL', s.kind === 'song-manele' ? '' : 'AND o."refundedAt" IS NULL'), [r.from, r.to]);
      return { site: s.key, ...(sum.rows[0] || {}), missing_invoice_after_2h: missing.rows, error: sum.error || missing.error };
    }));
    return { data: { from: r.from, to: r.to, note: 'UTC days on the paid column. amount_minor in the row currency. "claimed_no_number" usually already has an invoice in Oblio (find it by payment intent).', shops: per }, rows: per.length };
  },
});
