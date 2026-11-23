import { env } from './config.js';

/**
 * Read-only Gmail access to the company's support inboxes, with the same OAuth refresh tokens the support agent
 * (Sofia, container esknm7…) uses. Only GET calls are made: nothing is sent, labelled, archived or deleted.
 */
export const INBOXES = ['melodie', 'manele', 'regalo', 'cadeau', 'cancion', 'songgift', 'geschenk', 'podarunek', 'doro', 'hediye', 'santa', 'company', 'outreach'];

const tokens = new Map<string, { token: string; exp: number }>();

export function inboxConfigured(inbox: string): boolean {
  return !!env(`${inbox.toUpperCase()}_GMAIL_REFRESH_TOKEN`) && !!env('GMAIL_OAUTH_CLIENT_ID');
}
const learned = new Map<string, string>();
export function inboxAddress(inbox: string): string { return env(`${inbox.toUpperCase()}_GMAIL_ADDRESS`) || learned.get(inbox) || ''; }
async function learnAddress(inbox: string): Promise<void> {
  if (inboxAddress(inbox)) return;
  try { const p = await gget(inbox, '/profile'); if (p?.emailAddress) learned.set(inbox, String(p.emailAddress)); } catch { /* not important */ }
}

async function accessToken(inbox: string): Promise<string> {
  const c = tokens.get(inbox);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const refresh = env(`${inbox.toUpperCase()}_GMAIL_REFRESH_TOKEN`);
  if (!refresh) throw new Error(`no Gmail access for the ${inbox} inbox`);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GMAIL_OAUTH_CLIENT_ID'), client_secret: env('GMAIL_OAUTH_CLIENT_SECRET'), refresh_token: refresh, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`${inbox} inbox: Gmail token refresh failed (${j.error || r.status}${j.error === 'invalid_grant' ? ': the inbox needs a re-auth by the owner' : ''})`);
  tokens.set(inbox, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

async function gget(inbox: string, path: string): Promise<any> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${await accessToken(inbox)}` }, signal: AbortSignal.timeout(30_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${inbox} inbox: Gmail ${r.status} ${j?.error?.message || ''}`);
  return j;
}

const hdr = (m: any, name: string) => String((m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '');
const b64 = (s: string) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function bodyText(part: any): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64(part.body.data);
  if (part.parts) {
    const plain = part.parts.map(bodyText).filter(Boolean);
    if (plain.length) return plain.join('\n');
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return b64(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n');
  }
  return '';
}
function attachments(part: any, out: string[] = []): string[] {
  if (part?.filename) out.push(`${part.filename} (${part.mimeType}, ${part.body?.size || 0} B)`);
  for (const p of part?.parts || []) attachments(p, out);
  return out;
}

export async function searchThreads(inbox: string, query: string, max: number) {
  await learnAddress(inbox);
  const j = await gget(inbox, `/threads?maxResults=${Math.min(max, 50)}&q=${encodeURIComponent(query)}&includeSpamTrash=true`);
  const out = [];
  for (const t of (j.threads || []).slice(0, max)) {
    const th = await gget(inbox, `/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    const msgs = th.messages || [];
    const first = msgs[0], last = msgs[msgs.length - 1];
    out.push({
      inbox, threadId: t.id, subject: hdr(first, 'Subject'), from: hdr(first, 'From'), last_from: hdr(last, 'From'), last_date: hdr(last, 'Date'),
      messages: msgs.length, labels: [...new Set(msgs.flatMap((m: any) => m.labelIds || []))].filter((l) => !/^(CATEGORY_|UNREAD$|IMPORTANT$)/.test(l as string)),
      snippet: last?.snippet || '',
    });
  }
  return out;
}

export async function readThread(inbox: string, threadId: string) {
  const th = await gget(inbox, `/threads/${encodeURIComponent(threadId)}?format=full`);
  return {
    inbox, address: inboxAddress(inbox), threadId,
    messages: (th.messages || []).map((m: any) => ({
      id: m.id, date: hdr(m, 'Date'), from: hdr(m, 'From'), to: hdr(m, 'To'), subject: hdr(m, 'Subject'), labels: m.labelIds,
      text: bodyText(m.payload).slice(0, 12_000), attachments: attachments(m.payload),
    })),
  };
}
