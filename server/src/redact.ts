/**
 * Last line of defence: no tool answer may carry a secret, token or env value.
 *
 * 1. By KEY: any field whose name says it is a credential gets "[hidden]" (string values only, so
 *    numeric counters such as `promptTokens` or `input_tokens` stay readable).
 * 2. By VALUE: anything that looks like a live credential inside free text is masked
 *    (Stripe/OpenAI/Anthropic/GitHub/Meta/Google keys, JWTs, Bearer headers, DB URLs with a password,
 *    and the private access token in a film-page link `?t=…`).
 */
const SECRET_KEY = /(^|[_.-])(access_?token|accesstoken|token|tokens?_?hash|secret|client_?secret|password|passwd|pass_?hash|password_?hash|code_?hash|api_?key|apikey|private_?key|refresh_?token|authorization|cookie|share_?token|webhook_?secret|signing_?key|session_?token|otp)$/i;
const SECRET_KEY_CAMEL = /(accessToken|shareToken|tokenHash|passHash|passwordHash|codeHash|clientSecret|apiKey|privateKey|refreshToken|webhookSecret|signingKey|sessionToken)$/;

const VALUE_PATTERNS: [RegExp, string][] = [
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, '[hidden-stripe-key]'],
  [/\bwhsec_[A-Za-z0-9]{10,}/g, '[hidden-webhook-secret]'],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[hidden-api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[hidden-github-token]'],
  [/\bEAA[A-Za-z0-9]{40,}/g, '[hidden-meta-token]'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[hidden-google-token]'],
  [/\b1\/\/0[A-Za-z0-9_-]{30,}/g, '[hidden-google-refresh-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[hidden-jwt]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [hidden]'],
  [/\b(postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\/([^:/@\s]+):([^@\s]+)@/gi, '$1://$2:[hidden]@'],
  [/([?&](?:t|token|access_token|key|sig|signature)=)[A-Za-z0-9._~%-]{12,}/g, '$1[hidden]'],
  [/\blk_[A-Za-z0-9]{30,}/g, '[hidden-mcp-key]'],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function isSecretKey(k: string): boolean {
  return SECRET_KEY.test(k) || SECRET_KEY_CAMEL.test(k);
}

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[too deep]';
  if (typeof v === 'string') return redactString(v);
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (isSecretKey(k) && (typeof val === 'string' || (val && typeof val === 'object'))) out[k] = val === '' ? '' : '[hidden]';
    else out[k] = redact(val, depth + 1);
  }
  return out;
}
