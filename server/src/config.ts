/**
 * Everything the server knows about the fleet, described once.
 *
 * Secrets come ONLY from the process environment (the box's env files, see deploy/README in the admin
 * folder). Nothing in this file is a secret: database names, column names, ad-account ids, domains.
 */

export const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();

/** A shop / database the `sql` tool can read. `db` is the Postgres database name on lucid-postgres-1. */
export interface Site {
  key: string;
  db: string;
  label: string;
  domain: string;
  /** what the shop sells / is */
  kind: 'song' | 'song-manele' | 'film' | 'support' | 'club' | 'audit';
  currency?: string;
  /** Order column stamped when money arrived */
  paidCol?: string;
  emailCol?: string;
  contentCol?: string;
  fbAccountEnv?: string;
  fbTokenEnv?: string;
}

const fork = (key: string, db: string, label: string, domain: string, currency: string, fb?: string): Site => ({
  key, db, label, domain, kind: 'song', currency,
  paidCol: 'paymentConfirmedAt', emailCol: 'email', contentCol: 'attributionUtmContent',
  fbAccountEnv: fb ? `${fb}_AD_ACCOUNT_ID` : undefined, fbTokenEnv: fb ? `${fb}_FB_ADS_TOKEN` : undefined,
});

export const SITES: Site[] = [
  { key: 'manele', db: 'manele', label: 'Manele Cadou (RO) + HQ tables', domain: 'manele-cadou.ro', kind: 'song-manele', currency: 'RON',
    paidCol: 'paidAt', emailCol: 'deliveryEmail', contentCol: 'utmContent', fbAccountEnv: 'META_AD_ACCOUNT_ID', fbTokenEnv: 'META_ACCESS_TOKEN' },
  fork('melodie', 'melodie', 'Melodia Cadou (RO)', 'melodia-cadou.ro', 'RON', 'MELODIE'),
  fork('regalo', 'regalo', 'Melodia Regalo (IT)', 'melodia-regalo.it', 'EUR', 'REGALO'),
  fork('cadeau', 'cadeau', 'Mélodie Cadeau (FR)', 'melodie-cadeau.fr', 'EUR', 'CADEAU'),
  fork('cancion', 'cancion', 'Canción Regalo (ES)', 'cancion-regalo.es', 'EUR', 'CANCION'),
  fork('songgift', 'songgift', 'Gift Melody (EN)', 'gift-melody.com', 'USD', 'SONGGIFT'),
  fork('geschenk', 'geschenk', 'Melodie Geschenk (DE)', 'melodie-geschenk.de', 'EUR', 'GESCHENK'),
  fork('podarunek', 'podarunek', 'Muzyczny Podarunek (PL)', 'muzyczny-podarunek.pl', 'PLN', 'PODARUNEK'),
  fork('doro', 'doro', 'Melodia Doro (GR)', 'melodia-doro.gr', 'EUR', 'DORO'),
  fork('hediye', 'hediye', 'Melodi Hediye (TR)', 'melodihediye.com', 'TRY', 'HEDIYE'),
  fork('tucancion', 'cancionregalo', 'Tu Canción Regalo (ES)', 'tucancionregalo.com', 'EUR'),
  { key: 'santa', db: 'santa', label: 'Magic Chapter (Santa film shop, all countries)', domain: 'magic-chapter.com', kind: 'film', currency: 'per row',
    paidCol: 'paymentConfirmedAt', emailCol: 'email', contentCol: 'attributionUtmContent', fbAccountEnv: 'SANTA_AD_ACCOUNT_ID', fbTokenEnv: 'SANTA_FB_ADS_TOKEN' },
  { key: 'agent', db: 'agent', label: 'Support hub / Sofia (e-mail, WhatsApp, chat, escalations)', domain: 'sofia.melodia-cadou.ro', kind: 'support' },
  { key: 'clubhub', db: 'clubhub', label: 'Gifter Club hub', domain: '', kind: 'club' },
  { key: 'mcp', db: 'mcp', label: 'This server: audit log of every team call', domain: '', kind: 'audit' },
];

export const SITE_KEYS = SITES.map((s) => s.key) as [string, ...string[]];
export const SHOP_SITES = SITES.filter((s) => s.kind === 'song' || s.kind === 'song-manele' || s.kind === 'film');
export const SONG_SITES = SITES.filter((s) => s.kind === 'song' || s.kind === 'song-manele');
export const site = (key: string): Site => {
  const s = SITES.find((x) => x.key === key);
  if (!s) throw new Error(`unknown site "${key}". Known: ${SITE_KEYS.join(', ')}`);
  return s;
};

export const PG_HOST = env('MCP_PG_HOST', 'lucid-postgres-1');
export const PG_PORT = Number(env('MCP_PG_PORT', '5432'));
export const HQ_BASE = env('HQ_BASE_URL', 'https://manele-cadou.ro').replace(/\/+$/, '');
export const FILES_DIR = env('MCP_FILES_DIR', '/data/files');
export const KEYS_FILE = env('MCP_KEYS_FILE', '/data/keys.json');

export const LIMITS = {
  maxRows: 2000,
  statementTimeoutMs: 15_000,
  /** largest tool answer sent back, in characters */
  maxResponseChars: 600_000,
  /** calls per person per minute */
  ratePerMin: Number(env('MCP_RATE_PER_MIN', '90')),
  /** calls in flight per person */
  concurrent: Number(env('MCP_CONCURRENT', '6')),
};

/** Meta ad accounts (ids are not secrets). */
export const META_ACCOUNTS: { key: string; label: string; idEnv: string; tokenEnv: string; site: string }[] = [
  { key: 'melodie', label: 'Melodia Cadou (RO)', idEnv: 'MELODIE_AD_ACCOUNT_ID', tokenEnv: 'MELODIE_FB_ADS_TOKEN', site: 'melodie' },
  { key: 'manele', label: 'Manele Cadou (RO)', idEnv: 'META_AD_ACCOUNT_ID', tokenEnv: 'META_ACCESS_TOKEN', site: 'manele' },
  { key: 'regalo', label: 'Melodia Regalo (IT)', idEnv: 'REGALO_AD_ACCOUNT_ID', tokenEnv: 'REGALO_FB_ADS_TOKEN', site: 'regalo' },
  { key: 'cadeau', label: 'Mélodie Cadeau (FR)', idEnv: 'CADEAU_AD_ACCOUNT_ID', tokenEnv: 'CADEAU_FB_ADS_TOKEN', site: 'cadeau' },
  { key: 'cancion', label: 'Canción Regalo (ES)', idEnv: 'CANCION_AD_ACCOUNT_ID', tokenEnv: 'CANCION_FB_ADS_TOKEN', site: 'cancion' },
  { key: 'songgift', label: 'Gift Melody (EN)', idEnv: 'SONGGIFT_AD_ACCOUNT_ID', tokenEnv: 'SONGGIFT_FB_ADS_TOKEN', site: 'songgift' },
  { key: 'geschenk', label: 'Melodie Geschenk (DE)', idEnv: 'GESCHENK_AD_ACCOUNT_ID', tokenEnv: 'GESCHENK_FB_ADS_TOKEN', site: 'geschenk' },
  { key: 'podarunek', label: 'Muzyczny Podarunek (PL)', idEnv: 'PODARUNEK_AD_ACCOUNT_ID', tokenEnv: 'PODARUNEK_FB_ADS_TOKEN', site: 'podarunek' },
  { key: 'doro', label: 'Melodia Doro (GR)', idEnv: 'DORO_AD_ACCOUNT_ID', tokenEnv: 'DORO_FB_ADS_TOKEN', site: 'doro' },
  { key: 'hediye', label: 'Melodi Hediye (TR)', idEnv: 'HEDIYE_AD_ACCOUNT_ID', tokenEnv: 'HEDIYE_FB_ADS_TOKEN', site: 'hediye' },
  { key: 'santa', label: 'Magic Chapter (all countries)', idEnv: 'SANTA_AD_ACCOUNT_ID', tokenEnv: 'SANTA_FB_ADS_TOKEN', site: 'santa' },
];

/** TikTok: one ad account for all brands; campaigns per brand come from <SITE>_TT_CAMPAIGN_IDS. */
export const TIKTOK_ADVERTISER = env('TT_ADVERTISER_ID', '7682865907017793552');
export const TIKTOK_BRANDS = ['manele', 'melodie', 'regalo', 'cadeau', 'cancion', 'santa'];

/** HQ bus agent roster is read live from HQ; this is only the display name of each team member. */
export const PEOPLE: Record<string, string> = { adrian: 'Adrian', razvan: 'Răzvan', owner: 'Ștefan (owner test key)' };
