import { z } from 'zod';
import { PEOPLE } from '../config.js';
import { hqGet, hqTicketWrite } from '../hq.js';
import { tool } from './registry.js';

/**
 * The company to-do board (HQ → Agenți → De făcut, /hq/companie/de-facut). Asked for by Răzvan on 24 Nov 2026:
 * his Claude should add tasks straight to the board and change their status.
 * Status columns: backlog, todo, doing, done. Priority 1 urgent … 4 low.
 */
const STATUS = z.enum(['backlog', 'todo', 'doing', 'done']);
const ASSIGNEE = z.enum(['stefan', 'edi', 'razvan', '']);
const HQ_ACCOUNT: Record<string, string> = { razvan: 'razvan', edi: 'edi', stefan: 'stefan' };
const BOARD = 'https://manele-cadou.ro/hq/companie/de-facut';

function author(person: string, by?: string): { account: string; name: string } {
  const key = (by || person || '').toLowerCase();
  const account = HQ_ACCOUNT[key] || HQ_ACCOUNT[person] || 'stefan';
  const name = PEOPLE[key] || PEOPLE[person] || by || person;
  return { account, name };
}

const slim = (t: any) => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority, assignee: t.assignee || '', dueDay: t.dueDay || '',
  labels: t.labels || [], createdBy: t.createdBy, updatedAt: t.updatedAt,
  description: t.description ? String(t.description).slice(0, 400) : '',
  steps: (t.steps || []).map((s: any) => `${s.done ? '[x]' : '[ ]'} ${s.text}`),
});

tool({
  name: 'todo_list',
  title: 'The company to-do board (HQ «De făcut»)',
  description:
    'Read the to-do board: every active ticket with id, title, status (backlog | todo | doing | done), priority (1 urgent … 4 low), assignee (stefan | edi | razvan), due day and labels. ' +
    'Filter with status, assignee or q (text). Use it before todo_add to avoid duplicates, and to find the id for todo_update.',
  input: {
    status: STATUS.optional(),
    assignee: ASSIGNEE.optional(),
    q: z.string().max(100).optional(),
  },
  run: async ({ status, assignee, q }) => {
    const r = await hqGet('/api/hq/tickets', 30_000);
    let list = (r.tickets || []).map(slim);
    if (status) list = list.filter((t: any) => t.status === status);
    if (assignee !== undefined) list = list.filter((t: any) => t.assignee === assignee);
    if (q) { const s = q.toLowerCase(); list = list.filter((t: any) => `${t.title} ${t.description}`.toLowerCase().includes(s)); }
    return { data: { today: r.today, count: list.length, tickets: list, board: BOARD }, rows: list.length };
  },
});

tool({
  name: 'todo_add',
  title: 'Add a task to the company to-do board',
  description:
    'Write a new ticket on the HQ to-do board («De făcut»). It lands at the top of its column (default todo) and HQ notifies the team. ' +
    'Give a short title; put details, context and links in description. The board records who added it (your HQ account; with the shared team key pass by = your first name). ' +
    'Check todo_list first so the same task is not added twice.',
  readOnly: false,
  input: {
    title: z.string().min(3).max(300),
    description: z.string().max(10_000).optional(),
    status: STATUS.optional().describe('default todo'),
    priority: z.number().int().min(1).max(4).optional().describe('1 urgent, 2 important, 3 normal (default), 4 low'),
    assignee: ASSIGNEE.optional().describe('who should do it; empty = nobody yet'),
    dueDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    labels: z.array(z.string().max(24)).max(7).optional(),
    by: z.string().regex(/^[a-zA-Z]{2,20}$/).optional().describe('your first name when you use the shared team key (razvan, edi, adrian…)'),
  },
  run: async (a, ctx) => {
    const { account, name } = author(ctx.person, a.by);
    const sig = account === 'stefan' ? `(Added by ${name} through the team MCP.)` : '(Added through the team MCP.)';
    const r = await hqTicketWrite('POST', {
      title: a.title, description: a.description ? `${a.description}\n\n${sig}` : sig, status: a.status || 'todo',
      priority: a.priority ?? 3, assignee: a.assignee || '', dueDay: a.dueDay || '', labels: [...(a.labels || []), 'mcp'],
    }, account);
    return { data: { added: slim(r.ticket), board: BOARD }, rows: 1 };
  },
});

tool({
  name: 'todo_update',
  title: 'Change a task on the to-do board (status, priority, assignee …)',
  description:
    'Change one ticket by id (from todo_list or todo_add): status (backlog | todo | doing | done), priority, assignee, due day, title, description, labels or steps. ' +
    'Moving it to done is how a task is closed. Tickets cannot be deleted or archived from here; that stays on the board. ' +
    'Ids starting with "todo:" are old quick-list items: open them on the board once to turn them into tickets.',
  readOnly: false,
  input: {
    id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    status: STATUS.optional(),
    priority: z.number().int().min(1).max(4).optional(),
    assignee: ASSIGNEE.optional(),
    dueDay: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional().describe('YYYY-MM-DD, or empty to clear'),
    title: z.string().min(3).max(300).optional(),
    description: z.string().max(10_000).optional(),
    labels: z.array(z.string().max(24)).max(8).optional(),
    steps: z.array(z.object({ text: z.string().min(1).max(200), done: z.boolean() })).max(40).optional(),
    by: z.string().regex(/^[a-zA-Z]{2,20}$/).optional(),
  },
  run: async (a, ctx) => {
    const { account } = author(ctx.person, a.by);
    const patch: Record<string, unknown> = { id: a.id };
    for (const k of ['status', 'priority', 'assignee', 'dueDay', 'title', 'description', 'labels', 'steps'] as const) if (a[k] !== undefined) patch[k] = a[k];
    if (Object.keys(patch).length === 1) throw new Error('nothing to change: pass at least one of status, priority, assignee, dueDay, title, description, labels, steps');
    const r = await hqTicketWrite('PATCH', patch, account);
    const t = r.ticket || r;
    return { data: { updated: t?.id ? slim(t) : { id: a.id, ...patch } }, rows: 1 };
  },
});
