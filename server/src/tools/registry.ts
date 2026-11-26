import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { LIMITS } from '../config.js';
import { appQuery } from '../db.js';
import { enter, leave, rateCheck } from '../auth.js';
import { redact, redactString } from '../redact.js';

export interface Ctx { person: string; ip: string }

export interface ToolOut {
  /** what the caller sees (JSON-serialised) */
  data: unknown;
  /** rows returned, for the audit log */
  rows?: number;
}

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  run: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: Ctx) => Promise<ToolOut>;
  /** false for the only tool that writes anything (ask_agent opens a bus thread) */
  readOnly?: boolean;
}

export const ALL: ToolDef<any>[] = [];
export function tool<S extends ZodRawShape>(def: ToolDef<S>): void { ALL.push(def as ToolDef<any>); }

function countRows(d: unknown): number | undefined {
  if (Array.isArray(d)) return d.length;
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>;
    for (const k of ['rows', 'items', 'results', 'data', 'orders', 'threads']) if (Array.isArray(o[k])) return (o[k] as unknown[]).length;
  }
  return undefined;
}

async function audit(person: string, name: string, args: unknown, ok: boolean, rows: number | undefined, ms: number, error: string | undefined, ip: string) {
  const summary = redactString(JSON.stringify(redact(args) ?? {})).slice(0, 4000); // long enough to re-run a logged SQL query in an audit
  await appQuery('INSERT INTO audit_log (person, tool, args, ok, row_count, ms, error, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [person, name, summary, ok, rows ?? null, ms, error ? error.slice(0, 500) : null, ip]).catch((e) => console.error(`[audit] write failed: ${e.message}`));
  console.log(`[call] ${person} ${name} ${ok ? 'ok' : 'ERR'} rows=${rows ?? '-'} ${ms}ms ${summary.slice(0, 160)}${error ? ' :: ' + error.slice(0, 160) : ''}`);
}

export function registerAll(server: McpServer, ctx: Ctx): void {
  for (const def of ALL) {
    server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: { readOnlyHint: def.readOnly !== false, openWorldHint: true },
    }, (async (args: any) => {
      const t0 = Date.now();
      const limited = rateCheck(ctx.person);
      if (limited) {
        await audit(ctx.person, def.name, args, false, 0, 0, limited, ctx.ip);
        return { isError: true, content: [{ type: 'text', text: limited }] };
      }
      enter(ctx.person);
      try {
        const out = await def.run(args, ctx);
        let text = typeof out.data === 'string' ? redactString(out.data) : JSON.stringify(redact(out.data), null, 1);
        if (text.length > LIMITS.maxResponseChars) {
          text = text.slice(0, LIMITS.maxResponseChars) + `\n…[answer cut at ${LIMITS.maxResponseChars} characters: ask for fewer rows / a narrower range]`;
        }
        const rows = out.rows ?? countRows(out.data);
        await audit(ctx.person, def.name, args, true, rows, Date.now() - t0, undefined, ctx.ip);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = redactString((e as Error).message || String(e));
        await audit(ctx.person, def.name, args, false, 0, Date.now() - t0, msg, ctx.ip);
        return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] };
      } finally {
        leave(ctx.person);
      }
    }) as any);
  }
}

// ── small shared helpers ──
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export function dayRange(from?: string, to?: string, defDays = 7): { from: string; to: string } {
  const today = new Date();
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : isoDay(today);
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : isoDay(new Date(new Date(`${t}T12:00:00Z`).getTime() - (defDays - 1) * 864e5));
  if (f > t) throw new Error(`from (${f}) is after to (${t})`);
  return { from: f, to: t };
}
export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
