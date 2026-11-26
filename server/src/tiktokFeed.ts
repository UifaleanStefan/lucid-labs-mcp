/**
 * TikTok rows copied from Ads Manager into HQ (table "TtFeedRow" in the manele database).
 *
 * Since mid-November 2026 every live TikTok campaign (the song shops' «… TT Purchase nov26» AND Magic Chapter's) runs on
 * the second advertiser (SRL1108, 7705919739184529414), which the Marketing API token cannot read. HQ gets those numbers
 * from the feed; the API only covers the old song-shop advertiser (SRL0907), which spends 0 since then. So a TikTok answer
 * must merge both, exactly as HQ's profitSnapshot / adsBreakdown do (src/lib/ttFeedCore.ts in manele-io).
 *
 * Campaign -> HQ site, same order as HQ's feedSiteOf: the TT_FEED_CAMPAIGN_SITES map by id, an id in the map ending with
 * the row's (shortened) id, Magic Chapter's market code at the start of the name; plus, here only, a song-shop brand word
 * in the name («FR cadeau TT Purchase nov26») when the map is missing on this server.
 */
export function parseCampaignSites(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || !raw.trim()) return out;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return out; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out;
  const id = (x: unknown) => String(x ?? '').trim();
  for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
    if (Array.isArray(v)) { for (const c of v) if (/^\d{6,}$/.test(id(c))) out.set(id(c), k); }
    else if (typeof v === 'string' && /^\d{6,}$/.test(id(k))) out.set(id(k), v.trim());
    else if (typeof v === 'string' && /^\d{6,}$/.test(id(v))) out.set(id(v), k);
  }
  return out;
}

const MC_MARKET: Record<string, string> = { ro: 'santa', it: 'santa_it', es: 'santa_es', fr: 'santa_fr', de: 'santa_de', el: 'santa_el', gr: 'santa_el', pl: 'santa_pl', hu: 'santa_hu', bg: 'santa_bg', hr: 'santa_hr', sr: 'santa_sr', rs: 'santa_sr', cs: 'santa_cs', cz: 'santa_cs', nl: 'santa_nl', pt: 'santa_pt', sk: 'santa_sk', sv: 'santa_sv', se: 'santa_sv', fi: 'santa_fi', ua: 'santa_uk', tr: 'santa_tr' };
const MC_NAME_RE = new RegExp(`^\\s*(${Object.keys(MC_MARKET).join('|')})\\b[^|]*?\\bmagic\\s*chapter\\b`, 'i');
const SONG_NAME_RE = /\b(manele|melodie|regalo|cadeau|cancion)\b/i;

/** HQ site key of a feed campaign (santa, santa_it, … or a song shop), or '' when it belongs to no site. */
export function feedSiteOf(campaignId: string, campaignName: string | undefined, map: Map<string, string>): string {
  const exact = map.get(campaignId);
  if (exact) return exact;
  if (campaignId.length >= 6) for (const [id, site] of map) if (id.endsWith(campaignId)) return site;
  const m = MC_NAME_RE.exec(campaignName ?? '');
  if (m) return MC_MARKET[m[1].toLowerCase()];
  if (/magic\s*chapter/i.test(campaignName ?? '')) return 'santa';
  const s = SONG_NAME_RE.exec(campaignName ?? '');
  return s ? s[1].toLowerCase() : '';
}

/** The tool's brand of an HQ site key: every Magic Chapter market is "santa". */
export const brandOfSite = (site: string): string => (site.startsWith('santa') ? 'santa' : site);

export interface FeedRow { day: string; level: string; campaignId: string; campaignName: string; entityId: string; adName: string; adgroupId: string; currency: string; spend: number; impressions: number; clicks: number; conversions: number; advertiserId: string }

export interface FeedOut {
  source: 'feed'; advertiser: string; brand: string | null; hq_site: string | null; day?: string;
  campaign_id: string; campaign_name: string; ad_id?: string; ad_name?: string;
  spend: number; impressions: number; clicks: number; ctr: number | null; cpm: number | null; cpc: number | null;
  conversions: number; cost_per_conversion: number | null; currency: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Feed rows of one level -> one row per entity (or per entity and day), ratios recomputed from the summed counts. */
export function aggregateFeed(rows: FeedRow[], level: 'campaign' | 'ad', daily: boolean, map: Map<string, string>): FeedOut[] {
  const by = new Map<string, FeedOut>();
  for (const x of rows) {
    if (x.level !== level) continue;
    const site = feedSiteOf(String(x.campaignId), x.campaignName, map);
    const ent = level === 'ad' ? String(x.entityId) : String(x.campaignId);
    const k = `${ent}|${daily ? x.day : ''}`;
    const cur = by.get(k) || {
      source: 'feed' as const, advertiser: String(x.advertiserId), brand: site ? brandOfSite(site) : null, hq_site: site || null, ...(daily ? { day: x.day } : {}),
      campaign_id: String(x.campaignId), campaign_name: x.campaignName, ...(level === 'ad' ? { ad_id: ent, ad_name: x.adName } : {}),
      spend: 0, impressions: 0, clicks: 0, ctr: null, cpm: null, cpc: null, conversions: 0, cost_per_conversion: null, currency: x.currency || 'RON',
    };
    cur.spend += Number(x.spend) || 0; cur.impressions += Number(x.impressions) || 0; cur.clicks += Number(x.clicks) || 0; cur.conversions += Number(x.conversions) || 0;
    by.set(k, cur);
  }
  return [...by.values()].map((o) => ({
    ...o, spend: r2(o.spend),
    ctr: o.impressions ? r2((o.clicks / o.impressions) * 100) : null,
    cpm: o.impressions ? r2((o.spend / o.impressions) * 1000) : null,
    cpc: o.clicks ? r2(o.spend / o.clicks) : null,
    cost_per_conversion: o.conversions ? r2(o.spend / o.conversions) : null,
  })).filter((o) => o.spend > 0 || o.impressions > 0).sort((a, b) => b.spend - a.spend);
}
