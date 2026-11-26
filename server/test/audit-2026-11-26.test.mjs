// Regression tests for the bugs found in the 26 Nov 2026 audit. Run: npm test (builds, then node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReadOnly, hideColumns, mentionedIdentifiers, secretColumnsOf, utcJsonTimestamps } from '../dist/db.js';
import { inRoDays, isTestEmail, roDayEnd, roDayStart, santaTestOrderSql, TEST_EMAIL_PATTERN } from '../dist/rules.js';
import { aggregateFeed, brandOfSite, feedSiteOf, parseCampaignSites } from '../dist/tiktokFeed.js';
import { badAuth, BAD_AUTH_LIMIT, ipBlocked } from '../dist/auth.js';
import { isSecretKey } from '../dist/redact.js';

test('Romanian day bounds are computed in Europe/Bucharest, not UTC midnight', () => {
  assert.match(roDayStart('$1'), /AT TIME ZONE 'Europe\/Bucharest' AT TIME ZONE 'UTC'/);
  assert.match(roDayEnd('$2'), /\(\(\(\$2\)::date \+ 1\)\)::timestamp/);
  const p = inRoDays('o."paidAt"', '$1', '$2');
  assert.ok(p.startsWith('o."paidAt" >= ') && p.includes(' AND o."paidAt" < '));
  assert.ok(!/::date \+ 1\) AND|>= \$1::date/.test(p), 'no UTC-midnight bound left');
});

test('test / QA addresses are recognised (HQ rules), customers are not', () => {
  for (const e of ['qa+mc-ro@magic-chapter.com', 'QA+x@gmail.com', 'someone@magic-chapter.com', 'a@example.com', 'x+test@gmail.com', 'lucidlabsorg+1@gmail.com', 'render-test@foo.ro', 'probe-it@x.com', 'a.probe@x.com', 'z@foo.test', 'test@anything.ro'])
    assert.equal(isTestEmail(e), true, e);
  for (const e of ['maria.rossi@libero.it', 'questa@gmail.com', 'contest@yahoo.com', 'testa.mario@gmail.com', 'probert@gmail.com', '', null])
    assert.equal(isTestEmail(e), false, String(e));
  assert.ok(santaTestOrderSql('o').includes(`coalesce(o."stripeSessionId", '') = 'simulated'`));
  assert.ok(santaTestOrderSql('o').includes('o."leadEmail"'));
  assert.ok(!TEST_EMAIL_PATTERN.includes("'"), 'pattern is safe to inline in SQL');
});

test('sql: a renamed credential column is hidden (SELECT "accessToken" AS a)', () => {
  const names = new Map([['100:5', 'accessToken'], ['100:1', 'id'], ['200:3', 'shareToken']]);
  const fields = [{ name: 'id', tableID: 100, columnID: 1 }, { name: 'a', tableID: 100, columnID: 5 }, { name: 'b', tableID: 200, columnID: 3 }];
  assert.deepEqual(secretColumnsOf(fields, names, false), ['a', 'b']);
  const rows = hideColumns([{ id: 'cm1', a: 'tok_abc', b: null }], ['a', 'b']);
  assert.deepEqual(rows, [{ id: 'cm1', a: '[hidden]', b: null }]);
});

test('sql: computed columns of a query that mentions a credential column are hidden, counts stay', () => {
  const q = `SELECT substr("accessToken", 1, 40) AS x, count(*) FILTER (WHERE "accessToken" IS NULL) AS n FROM "Order" GROUP BY 1`;
  const ids = mentionedIdentifiers(q);
  assert.ok(ids.includes('accessToken'));
  const mentions = ids.some((i) => isSecretKey(i));
  assert.equal(mentions, true);
  const hidden = secretColumnsOf([{ name: 'x', tableID: 0, columnID: 0 }, { name: 'n', tableID: 0, columnID: 0 }], new Map(), mentions);
  assert.deepEqual(hideColumns([{ x: 'abcdef', n: 12 }], hidden), [{ x: '[hidden]', n: 12 }]);
  assert.deepEqual(hideColumns([{ x: { k: 'abc' }, n: 1 }], hidden), [{ x: '[hidden]', n: 1 }]);
  // a string literal or a comment is not a mention
  assert.equal(mentionedIdentifiers(`SELECT 'accessToken' AS label -- token\nFROM "Order"`).some((i) => isSecretKey(i)), false);
  // ordinary columns are not credentials
  for (const c of ['code', 'discountCode', 'promptTokens', 'email', 'paymentConfirmedAt']) assert.equal(isSecretKey(c), false, c);
});

test('timestamps inside JSON get the UTC Z; top-level text columns are left alone', () => {
  const [r] = utcJsonTimestamps([{ o: { paymentConfirmedAt: '2026-11-24T19:00:13.346', note: 'hello', n: 3, list: ['2026-11-24T19:00:13'] }, local: '2026-11-24T21:00:13' }]);
  assert.equal(r.o.paymentConfirmedAt, '2026-11-24T19:00:13.346Z');
  assert.equal(r.o.list[0], '2026-11-24T19:00:13Z');
  assert.equal(r.o.note, 'hello');
  assert.equal(r.local, '2026-11-24T21:00:13');
  assert.equal(r.o.n, 3);
});

test('read-only pre-flight still rejects writes and second statements', () => {
  assert.throws(() => checkReadOnly('DELETE FROM "Order"'));
  assert.throws(() => checkReadOnly('SELECT 1; DELETE FROM x'));
  assert.throws(() => checkReadOnly('EXPLAIN ANALYZE SELECT 1'));
  assert.throws(() => checkReadOnly('SELECT pg_sleep(10)'));
  assert.equal(checkReadOnly("SELECT ';' AS x;"), "SELECT ';' AS x");
});

test('TikTok feed: campaigns map to brands like HQ (id, shortened id, MC market name, song name)', () => {
  const map = parseCampaignSites(JSON.stringify({ melodie: ['1881806581065985'], santa_de: ['1881900000017714'], cadeau: '1881822296295649' }));
  assert.equal(feedSiteOf('1881806581065985', 'whatever', map), 'melodie');
  assert.equal(feedSiteOf('017714', 'DE thing', map), 'santa_de');
  assert.equal(feedSiteOf('999', 'PL Magic Chapter TT Purchase nov26', new Map()), 'santa_pl');
  assert.equal(feedSiteOf('999', 'RO abroad Magic Chapter TT Purchase nov26', new Map()), 'santa');
  assert.equal(feedSiteOf('999', 'FR cadeau TT Purchase nov26', new Map()), 'cadeau');
  assert.equal(feedSiteOf('999', 'UK Magic Chapter test', new Map()), 'santa');
  assert.equal(feedSiteOf('104114', '104114', new Map()), '');
  assert.equal(brandOfSite('santa_pl'), 'santa');
  assert.equal(brandOfSite('regalo'), 'regalo');
});

test('TikTok feed: one level only, summed per campaign, ratios from summed counts', () => {
  const base = { level: 'campaign', campaignName: 'IT regalo TT Purchase nov26', entityId: 'c1', adName: '', adgroupId: '', currency: 'RON', conversions: 1, advertiserId: '7705919739184529414' };
  const rows = [
    { ...base, day: '2026-11-20', campaignId: 'c1', spend: 10, impressions: 1000, clicks: 10 },
    { ...base, day: '2026-11-21', campaignId: 'c1', spend: 30, impressions: 3000, clicks: 50 },
    { ...base, level: 'ad', day: '2026-11-21', campaignId: 'c1', entityId: 'ad9', spend: 30, impressions: 3000, clicks: 50 },
  ];
  const out = aggregateFeed(rows, 'campaign', false, new Map());
  assert.equal(out.length, 1, 'the ad-level copy of the same spend is not added (no double count)');
  assert.equal(out[0].spend, 40);
  assert.equal(out[0].brand, 'regalo');
  assert.equal(out[0].ctr, 1.5);
  assert.equal(out[0].cpm, 10);
  assert.equal(out[0].source, 'feed');
  assert.equal(aggregateFeed(rows, 'campaign', true, new Map()).length, 2);
  assert.equal(aggregateFeed(rows, 'ad', false, new Map())[0].ad_id, 'ad9');
});

test('failed-auth IP block trips after the limit and only for that IP', () => {
  const ip = '203.0.113.250';
  for (let i = 0; i < BAD_AUTH_LIMIT; i++) badAuth(ip);
  assert.equal(ipBlocked(ip), false);
  badAuth(ip);
  assert.equal(ipBlocked(ip), true);
  assert.equal(ipBlocked('203.0.113.251'), false);
});
