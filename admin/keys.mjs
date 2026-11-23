#!/usr/bin/env node
/**
 * Team MCP keys — run on the OWNER'S PC only.
 *
 *   node admin/keys.mjs list                 who has a key (no key is printed)
 *   node admin/keys.mjs add <person>         new person, new key
 *   node admin/keys.mjs rotate <person>      replace that person's key (the old one stops working within seconds)
 *   node admin/keys.mjs revoke <person>      remove that person's access
 *   node admin/keys.mjs push                 re-send the hash file to the box
 *
 * The plain keys live ONLY in the keys file on this PC (default D:/lucid-ops/migration/env/mcp-team-keys.txt,
 * a git-ignored folder; override with MCP_KEYS_TXT). The box receives only sha256 hashes
 * (/opt/lucid-mcp/data/keys.json), which the server re-reads on change: no restart needed.
 * This script never prints a key: open the keys file to hand one over, privately.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TXT = process.env.MCP_KEYS_TXT || 'D:/lucid-ops/migration/env/mcp-team-keys.txt';
const BOX = process.env.MCP_BOX || 'root@100.114.175.100';
const SSH_KEY = process.env.MCP_BOX_SSH_KEY || path.join(os.homedir(), '.ssh', 'lucid-box');
const REMOTE = '/opt/lucid-mcp/data/keys.json';
const URL_ = 'https://mcp.159.195.252.107.nip.io/mcp';

const HEADER = `# Lucid Labs team MCP keys. PRIVATE: never commit, never paste into a chat or a repo.
# Hand each person ONLY their own line, privately. Server: ${URL_}
# Install (Claude Code): claude mcp add --transport http lucid ${URL_} --header "Authorization: Bearer <key>"
# Rotate / revoke: node D:/lucid-labs-mcp/admin/keys.mjs rotate|revoke <person>
`;

function newKey() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  while (s.length < 48) { const b = crypto.randomBytes(64); for (const x of b) if (x < 248 && s.length < 48) s += abc[x % 62]; }
  return `lk_${s}`;
}
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');

function read() {
  const rows = [];
  if (!fs.existsSync(TXT)) return rows;
  for (const line of fs.readFileSync(TXT, 'utf8').split(/\r?\n/)) {
    const m = /^([a-z0-9_-]{2,32})=(lk_[A-Za-z0-9]{32,128})(?:\s+#\s*created\s+(\S+))?\s*$/.exec(line.trim());
    if (m) rows.push({ person: m[1], key: m[2], created: m[3] || '' });
  }
  return rows;
}
function write(rows) {
  fs.mkdirSync(path.dirname(TXT), { recursive: true });
  fs.writeFileSync(TXT, HEADER + rows.map((r) => `${r.person}=${r.key}  # created ${r.created}`).join('\n') + '\n', { mode: 0o600 });
}
function push(rows) {
  const json = JSON.stringify({ updated: new Date().toISOString(), keys: rows.map((r) => ({ person: r.person, sha256: sha(r.key), created: r.created, revoked: false })) }, null, 1);
  execFileSync('ssh', ['-i', SSH_KEY, '-o', 'ConnectTimeout=15', BOX,
    `mkdir -p /opt/lucid-mcp/data && cat > ${REMOTE}.new && chmod 644 ${REMOTE}.new && mv ${REMOTE}.new ${REMOTE}`], { input: json, stdio: ['pipe', 'inherit', 'inherit'] });
  console.log(`hashes pushed to the box (${rows.length} active: ${rows.map((r) => r.person).join(', ')})`);
}

const [cmd, who] = process.argv.slice(2);
const rows = read();
const now = new Date().toISOString().slice(0, 19) + 'Z';
const valid = (p) => /^[a-z0-9_-]{2,32}$/.test(p || '');

if (cmd === 'list') {
  for (const r of rows) console.log(`${r.person.padEnd(12)} sha256 ${sha(r.key).slice(0, 10)}…  created ${r.created}`);
  if (!rows.length) console.log('no keys yet');
} else if (cmd === 'init') {
  for (const p of ['adrian', 'razvan', 'owner']) if (!rows.some((r) => r.person === p)) rows.push({ person: p, key: newKey(), created: now });
  write(rows); push(rows);
  console.log(`keys file: ${TXT}`);
} else if ((cmd === 'add' || cmd === 'rotate') && valid(who)) {
  const i = rows.findIndex((r) => r.person === who);
  if (cmd === 'add' && i >= 0) { console.error(`${who} already has a key; use rotate`); process.exit(2); }
  if (cmd === 'rotate' && i < 0) { console.error(`${who} has no key; use add`); process.exit(2); }
  const row = { person: who, key: newKey(), created: now };
  if (i >= 0) rows[i] = row; else rows.push(row);
  write(rows); push(rows);
  console.log(`${cmd === 'add' ? 'added' : 'rotated'} ${who}; the new key is in ${TXT} (the old one, if any, no longer works)`);
} else if (cmd === 'revoke' && valid(who)) {
  const left = rows.filter((r) => r.person !== who);
  if (left.length === rows.length) { console.error(`${who} has no key`); process.exit(2); }
  write(left); push(left);
  console.log(`revoked ${who}`);
} else if (cmd === 'push') {
  push(rows);
} else {
  console.log('usage: node admin/keys.mjs list | init | add <person> | rotate <person> | revoke <person> | push');
  process.exit(2);
}
