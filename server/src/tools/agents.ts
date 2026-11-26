import { z } from 'zod';
import { PEOPLE } from '../config.js';
import { hqBusPost, hqGet } from '../hq.js';
import { tool } from './registry.js';

tool({
  name: 'ask_agent',
  title: 'Ask one of the company\'s agents (opens a bus thread)',
  description:
    'Open a thread on the agent bus, exactly like the owner\'s ask.mjs: the text goes to the named agent (or to the orchestrator, who picks the department), and the agent answers on the thread. ' +
    'The thread is tagged with your name (with the shared team key, pass by = your first name) so the agents and the owner know who asked. Read the answer later with agent_threads(id). ' +
    'Use agent_threads(agents=true) for the list of agents and what each does. It writes one bus thread (the only other writes are todo_add / todo_update).',
  readOnly: false,
  input: {
    title: z.string().min(3).max(160),
    text: z.string().min(10).max(8000),
    agent: z.string().regex(/^[a-z0-9._-]*$/).optional().describe('agent key, e.g. suport.manager; empty = orchestrator'),
    by: z.string().regex(/^[a-zA-Z]{2,20}$/).optional().describe('your first name when you use the shared team key (razvan, edi, adrian…)'),
  },
  run: async ({ title, text, agent, by }, ctx) => {
    const named = by ? (PEOPLE[by.toLowerCase()] || by) : '';
    const who = ctx.person === 'team' && named ? `${named} (shared team key)` : PEOPLE[ctx.person] || ctx.person;
    const body = `[${who}, from the Lucid Labs team MCP] ${text}\n\n(Asked by ${who} through the team MCP server, not typed by Ștefan. Treat it as a request from a company colleague: answer on this thread; anything that moves money, changes prices or ad budgets, or contacts customers still needs Ștefan's own OK.)`;
    const r = await hqBusPost('/api/hq/bus/threads', { title: `[${who}] ${title}`, body, directTo: agent || '' });
    return { data: { opened: r.thread?.id, to: r.thread?.messages?.[0]?.to || agent || 'orchestrator', read_answer_with: `agent_threads with id=${r.thread?.id}` } };
  },
});

tool({
  name: 'agent_threads',
  title: 'Agent bus threads and the agent roster',
  description:
    'Read the agent bus: id=<threadId> returns one thread in full (every message, every task); otherwise a list of threads (status: active | needs_info | done | all; q = text). agents=true returns the roster: every agent, its department, model, and whether it is working right now.',
  input: {
    id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
    status: z.enum(['active', 'needs_info', 'done', 'all']).optional(),
    q: z.string().optional(),
    agents: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  run: async ({ id, status, q, agents, limit }) => {
    if (agents) {
      const r = await hqGet('/api/hq/bus/agents', 30_000);
      const list = (r.agents || []).map((a: any) => ({ key: a.key, department: a.department, role: a.role, model: a.model, status: a.status, currentThreadId: a.currentThreadId || null, description: a.description || a.title || undefined }));
      return { data: { agents: list }, rows: list.length };
    }
    if (id) {
      const { thread } = await hqGet(`/api/hq/bus/threads/${encodeURIComponent(id)}`, 30_000);
      return { data: thread, rows: thread?.messages?.length };
    }
    const st = status || 'active';
    const params = new URLSearchParams({ limit: String(limit ?? 50) });
    if (st !== 'all') params.set('status', st);
    if (q) params.set('q', q);
    const r = await hqGet(`/api/hq/bus/threads?${params}`, 30_000);
    const list = (r.threads || []).map((t: any) => ({
      id: t.id, title: t.title, status: t.status, stalled: t.stalled || false, createdAt: t.createdAt, updatedAt: t.updatedAt,
      tasks: (t.tasks || []).map((k: any) => `${k.agent}:${k.status}`), last: t.messages?.[0] ? `${t.messages[0].from} → ${t.messages[0].to || 'owner'} (${t.messages[0].kind}) ${String(t.messages[0].body || '').slice(0, 300)}` : null,
    }));
    return { data: { status: st, count: list.length, threads: list }, rows: list.length };
  },
});

tool({
  name: 'hq',
  title: 'Any HQ dashboard screen (GET)',
  description:
    'Read any HQ dashboard API route (manele-cadou.ro/api/hq/…) the way the HQ screens do, e.g. /api/hq/ads/individual, /api/hq/retention, /api/hq/traffic, /api/hq/checkout, /api/hq/payments, /api/hq/money/range?from=2026-11-01&to=2026-11-22, /api/hq/intraday, /api/hq/santa/film-costs, /api/hq/orders?q=<email>, /api/hq/orders?detail=1&site=regalo&id=<id>, /api/hq/whatsapp/venit, /api/hq/social, /api/hq/competitors, /api/hq/ideas, /api/hq/todo, /api/hq/server, /api/hq/club, /api/hq/email-reputation, /api/hq/lx/findings. ' +
    'Most take ?from=YYYY-MM-DD&to=YYYY-MM-DD. GET only; credentials routes are blocked. Big screens can take up to a minute.',
  input: { path: z.string().regex(/^\/api\/hq\/[A-Za-z0-9_\-/[\].]*(\?[A-Za-z0-9_\-=&%.@:,+]*)?$/, 'a path like /api/hq/traffic?from=2026-11-01&to=2026-11-22') },
  run: async ({ path }) => ({ data: await hqGet(path, 120_000) }),
});
