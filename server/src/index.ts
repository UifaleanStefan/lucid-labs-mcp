import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { activePeople, badAuth, ipBlocked, personForKey } from './auth.js';
import { env } from './config.js';
import { initAppDb } from './db.js';
import { ALL, registerAll } from './tools/registry.js';
import './tools/data.js';
import './tools/live.js';
import './tools/money.js';
import './tools/ads.js';
import './tools/support.js';
import './tools/agents.js';
import './tools/todo.js';

const VERSION = '1.0.0';
const INSTRUCTIONS = `Lucid Labs team server: a live, read-only view of the whole business (the same data the orchestrator reads).
Shops: song gift shops melodie (RO), manele (RO), regalo (IT), cadeau (FR), cancion (ES), songgift (EN), geschenk (DE), podarunek (PL), doro (GR), hediye (TR), tucancion (ES) and Magic Chapter (santa: the personalised Santa film, many countries).
Start with: today (live numbers), kpis (any range), health (what is broken), live_queue (Magic Chapter factory), find_customer / order (one customer), sql (anything else; use schema first).
Money: profit, stripe, invoices. Ads: meta_accounts, meta_insights, tiktok_report, google_ads. Support: support_threads, escalations. Company: experiments, reports, owner_relay, agent_threads, ask_agent (opens a bus thread to an agent), todo_list / todo_add / todo_update (the company to-do board «De făcut»: add tasks, change status; the only other writes). hq = any HQ dashboard screen.
Rules of thumb: money amounts in the databases are minor units (cents/bani) in the row's currency; DB timestamps are UTC; a Romanian day starts 22:00 UTC (winter). "Paid" = paid column set. Every call is logged with your name.`;

function buildServer(person: string, ip: string): McpServer {
  const server = new McpServer({ name: 'lucid-labs', version: VERSION }, { instructions: INSTRUCTIONS });
  registerAll(server, { person, ip });
  return server;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => { res.json({ ok: true, version: VERSION, tools: ALL.length }); });
app.get('/', (_req, res) => { res.type('text/plain').send('Lucid Labs team MCP server. Endpoint: /mcp (Streamable HTTP, Bearer key).'); });

function clientIp(req: Request): string { return String(req.ip || req.socket.remoteAddress || '?'); }

app.post('/mcp', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  if (ipBlocked(ip)) { res.status(429).json({ error: 'too many failed attempts; try again in 10 minutes' }); return; }
  const person = personForKey(req.headers.authorization);
  if (!person) {
    badAuth(ip);
    res.status(401).set('WWW-Authenticate', 'Bearer realm="lucid-labs-mcp"').json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <your lk_ key>' }, id: null });
    return;
  }
  try {
    const server = buildServer(person, ip);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp] request failed:', (e as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null });
  }
});

// Stateless server: no server-initiated stream, no sessions to delete.
const notAllowed = (req: Request, res: Response) => {
  if (!personForKey(req.headers.authorization)) { res.status(401).set('WWW-Authenticate', 'Bearer realm="lucid-labs-mcp"').json({ error: 'Unauthorized' }); return; }
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
};
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

const port = Number(env('PORT', '3000'));
initAppDb()
  .then(() => console.log('[db] audit table ready'))
  .catch((e) => console.error('[db] audit table init failed (calls still served, audit writes will fail):', e.message))
  .finally(() => {
    app.listen(port, '0.0.0.0', () => console.log(`[mcp] lucid-labs MCP ${VERSION} on :${port} · ${ALL.length} tools · people with keys: ${activePeople().join(', ') || 'none yet'}`));
  });
