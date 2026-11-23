#!/usr/bin/env node
/**
 * End-to-end test of every tool over HTTPS with a real MCP client (the official SDK).
 *   MCP_KEY=lk_… node admin/test-tools.mjs            (or it reads the "owner" line of the keys file)
 *   node admin/test-tools.mjs today sql               only some tools
 * Prints one line per tool: OK/ERR, time, size, and a short excerpt. Never prints the key.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);

const URL_ = process.env.MCP_URL || 'https://mcp.159.195.252.107.nip.io/mcp';
const TXT = process.env.MCP_KEYS_TXT || 'D:/lucid-ops/migration/env/mcp-team-keys.txt';
const key = process.env.MCP_KEY || (/^owner=(lk_\S+)/m.exec(fs.readFileSync(TXT, 'utf8')) || [])[1];
if (!key) { console.error('no key'); process.exit(2); }

const today = new Date().toISOString().slice(0, 10);
const d7 = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
const CASES = [
  ['today', {}],
  ['kpis', { from: d7, to: today }],
  ['profit', { window: 'yesterday' }],
  ['live_queue', {}],
  ['sql', { site: 'regalo', query: 'SELECT count(*) AS paid_7d FROM "Order" WHERE "paymentConfirmedAt" > now() - interval \'7 days\'' }],
  ['sql', { site: 'santa', query: 'SELECT id, "accessToken", status FROM "Order" ORDER BY "createdAt" DESC', max_rows: 2 }],
  ['sql', { site: 'manele', query: 'DELETE FROM "Order" WHERE false' }],
  ['sql', { site: 'manele', query: 'SELECT 1 FROM (SELECT 1) x WHERE true) ; DELETE FROM "Order" WHERE (false' }],
  ['sql', { site: 'manele', query: 'WITH d AS (DELETE FROM "Order" WHERE false RETURNING 1) SELECT count(*) FROM d' }],
  ['sql', { site: 'agent', query: 'SELECT token FROM "MetaPageConnection"' }],
  ['sql', { site: 'manele', query: 'SELECT rolpassword FROM pg_authid' }],
  ['schema', { site: 'santa' }],
  ['schema', { site: 'agent', table: 'EscalationCase' }],
  ['find_customer', { query: '@hotmail.it' }],
  ['order', { id: '__FIRST_ORDER__' }],
  ['order', { id: '__FIRST_FILM__' }],
  ['experiments', {}],
  ['experiments', { id: 'E155' }],
  ['stripe', { resource: 'balance' }],
  ['stripe', { resource: 'charges', created_from: today, max: 3 }],
  ['stripe', { resource: 'account', account: 'magic_chapter' }],
  ['invoices', { from: d7, to: today }],
  ['invoices', { source: 'oblio', series: 'MCIT', from: d7, to: today, max: 5 }],
  ['meta_accounts', {}],
  ['meta_insights', { account: 'regalo', from: d7, to: today, level: 'ad' }],
  ['meta_insights', { account: 'santa', from: d7, to: today }],
  ['tiktok_report', { from: d7, to: today, brand: 'melodie' }],
  ['tiktok_report', { from: d7, to: today, brand: 'santa' }],
  ['google_ads', { from: d7, to: today }],
  ['support_threads', { channel: 'email', days: 2, limit: 6 }],
  ['support_threads', { channel: 'email', inbox: '__INBOX__', thread: '__THREAD__' }],
  ['support_threads', { channel: 'whatsapp', days: 1, limit: 5 }],
  ['support_threads', { channel: 'chat', days: 1, limit: 5 }],
  ['escalations', {}],
  ['owner_relay', {}],
  ['health', {}],
  ['reports', { action: 'list', path: 'reports', limit: 5 }],
  ['reports', { action: 'search', query: 'Magic Chapter', limit: 3 }],
  ['agent_threads', { agents: true }],
  ['agent_threads', { status: 'active', limit: 5 }],
  ['ask_agent', { title: 'Team MCP connection test (no action needed)', text: 'Automated end-to-end test of the new Lucid Labs team MCP server (ask_agent tool). No action needed: reply "ok" on this thread and close it.' }],
  ['hq', { path: `/api/hq/traffic?from=${d7}&to=${today}` }],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const client = new Client({ name: 'lucid-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
const { tools } = await client.listTools();
console.log(`connected: ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`);

let firstOrder = '', firstFilm = '', mailInbox = '', mailThread = '';
const withAsk = process.argv.includes('--with-ask');
const SECRET_SHAPES = /(sk_live_|rk_live_|whsec_|EAA[A-Za-z0-9]{40}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|lk_[A-Za-z0-9]{30})/;
let fails = 0;
for (let [name, args] of CASES) {
  if (only.length && !only.includes(name)) continue;
  if (args.id === '__FIRST_ORDER__') args = { id: firstOrder };
  if (args.id === '__FIRST_FILM__') args = { id: firstFilm };
  if (args.id === '') continue;
  if (args.thread === '__THREAD__') { if (!mailThread) continue; args = { channel: 'email', inbox: mailInbox, thread: mailThread }; }
  if (name === 'ask_agent' && !withAsk) continue;
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
    const text = r.content?.map((c) => c.text || '').join('') || '';
    if (name === 'find_customer' && !firstOrder) { try { const j = JSON.parse(text); firstOrder = j.shops?.find((s) => s.site !== 'santa')?.orders?.[0]?.id || ''; } catch {} }
    if (name === 'support_threads' && args.channel === 'email' && !args.thread && !mailThread) { try { const j = JSON.parse(text); mailInbox = j.threads?.[0]?.inbox || ''; mailThread = j.threads?.[0]?.threadId || ''; } catch {} }
    if (name === 'live_queue' && !firstFilm) { try { const j = JSON.parse(text); firstFilm = j.running_or_queued?.find((x) => x.order_id)?.order_id || j.late_films?.[0]?.id || ''; } catch {} }
    const leak = SECRET_SHAPES.test(text) ? '  !!! SECRET-LOOKING VALUE IN OUTPUT' : '';
    if (r.isError) fails++;
    console.log(`${r.isError ? 'ERR' : 'OK '} ${name.padEnd(16)} ${String(Date.now() - t0).padStart(6)}ms ${String(text.length).padStart(8)}B  ${JSON.stringify(args).slice(0, 70).padEnd(70)} | ${text.replace(/\s+/g, ' ').slice(0, 220)}${leak}`);
  } catch (e) {
    fails++;
    console.log(`EXC ${name.padEnd(16)} ${String(Date.now() - t0).padStart(6)}ms ${JSON.stringify(args).slice(0, 70)} | ${e.message}`);
  }
}
await client.close();
console.log(`\n${fails} failing call(s)`);
