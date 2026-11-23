#!/usr/bin/env node
/**
 * Copies the orchestrator's written work (text files only) from D:/lucid-ops to the box, so the team MCP server's
 * `reports`, `experiments` and `health` tools can read it. Runs every 15 min as the hidden scheduled task
 * LucidMcpFileSync (owner's PC). Nothing under migration/ (credentials) is ever included.
 *
 *   node admin/sync-files.mjs          sync now
 *   node admin/sync-files.mjs --dry    list what would be sent
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.LUCID_OPS || 'D:/lucid-ops';
const BOX = process.env.MCP_BOX || 'root@100.114.175.100';
const SSH_KEY = process.env.MCP_BOX_SSH_KEY || path.join(os.homedir(), '.ssh', 'lucid-box');
const TEXT = /\.(md|txt|csv|tsv|html|json)$/i;
const MAX_FILE = 3 * 1024 * 1024;
const MAX_TOTAL = 120 * 1024 * 1024;

// folders (recursive) and single files, relative to D:/lucid-ops
const DIRS = ['reports', 'experiments', 'errors', 'support-watch', 'whatsapp', 'santa', 'black-friday-2026', 'christmas-2026', 'new-markets',
  'finance', 'tiktok-plan-2026-11', 'gifter-club', 'competitors', 'mcp-team', 'oss', 'facturi', 'customers', 'disputes', 'research', 'content', 'song-languages-6', 'spain-funnel', 'partner-kit', 'video-service', 'hq-integrate'];
const NEVER = /(^|\/)(migration|node_modules|\.git|tmp|scratch|locks|logs?|shots?|screens?|frames?|dl|crit|blind|review|renders?|out|baselines|report-data|picker)(\/|$)|(^|\/)(state|workboard)\.json$|\.env|secret|token|credential|password|key/i;
// JSON only where it is a report; elsewhere it is machine state
const JSON_OK = /^(reports|experiments)\/[^/]+\.json$/i;
// how deep to walk each folder (santa holds thousands of build artefacts below its top level)
const DEPTH = { santa: 1, 'spain-funnel': 1, 'video-service': 1, research: 2 };

const files = [];
let total = 0;
function add(rel) {
  if (NEVER.test(rel) || !TEXT.test(rel)) return;
  if (/\.json$/i.test(rel) && !JSON_OK.test(rel)) return;
  const st = fs.statSync(path.join(ROOT, rel));
  if (st.size > MAX_FILE || total + st.size > MAX_TOTAL) return;
  files.push(rel); total += st.size;
}
function walk(rel, depth = 0, max = DEPTH[rel] ?? 4) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs) || depth > max) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (NEVER.test(r)) continue;
    if (e.isDirectory()) walk(r, depth + 1, max); else if (e.isFile()) add(r);
  }
}
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) if (e.isFile() && /\.md$/i.test(e.name)) add(e.name);
console.error(`${new Date().toISOString()} sync: start`);
for (const d of DIRS) walk(d);

if (process.argv.includes('--dry')) { console.log(files.join('\n')); console.log(`${files.length} files, ${(total / 1048576).toFixed(1)} MB`); process.exit(0); }

// A minimal tar writer (ustar + a PAX header for long or non-ASCII names), gzipped by node itself: no external
// tar/gzip, which behave differently (or hang) when the scheduled task runs outside a Git Bash shell.
function tarball(relPaths) {
  const blocks = [];
  const header = (name, size, type = '0') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const rel of relPaths) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    if (Buffer.byteLength(rel) > 99 || /[^\x20-\x7e]/.test(rel)) {
      const rec = (s) => { let len = s.length + 3; let line = `${len} ${s}\n`; while (Buffer.byteLength(line) !== len) { len = Buffer.byteLength(line); line = `${len} ${s}\n`; } return line; };
      const pax = Buffer.from(rec(`path=${rel}`), 'utf8');
      blocks.push(header('PaxHeader', pax.length, 'x'), pax, pad(pax.length));
    }
    blocks.push(header(rel.replace(/[^\x20-\x7e]/g, '_'), data.length), data, pad(data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

console.error(`${new Date().toISOString()} sync: ${files.length} files listed, sending`);
const SSH = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/ssh.exe') ? 'C:/Program Files/Git/usr/bin/ssh.exe' : 'ssh';
const stamp = new Date().toISOString();
execFileSync(SSH, ['-i', SSH_KEY, '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', BOX,
  `set -e; D=/opt/lucid-mcp/data; rm -rf $D/files.new; mkdir -p $D/files.new; tar -xzf - -C $D/files.new; echo '${stamp}' > $D/files.new/.synced-at; ` +
  `chmod -R a+rX $D/files.new; rm -rf $D/files.old; [ -d $D/files ] && mv $D/files $D/files.old; mv $D/files.new $D/files; rm -rf $D/files.old`],
  { input: tarball(files), stdio: ['pipe', 'inherit', 'inherit'], timeout: 180_000 });
console.log(`${stamp} synced ${files.length} files (${(total / 1048576).toFixed(1)} MB)`);
