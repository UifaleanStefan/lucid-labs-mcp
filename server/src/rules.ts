/**
 * Business rules the tools share, written once so every tool answers the same way (audit 26 Nov 2026).
 *
 * 1. Days are ROMANIAN days (Europe/Bucharest: 22:00 UTC in winter, 21:00 UTC in summer), like HQ. DB timestamps are
 *    `timestamp without time zone` holding UTC, so a Romanian day D is [roDayStart(D), roDayStart(D + 1)).
 * 2. Test orders never count: Magic Chapter's simulated payments (stripeSessionId = 'simulated', 84 rows, 1–12 Nov 2026)
 *    and our own test / QA addresses (the union of HQ's rules: consumables.ts SANTA_TEST_MAIL, leadTier.ts
 *    TEST_ADDRESS_REGEX, healthChecks.ts TEST).
 */
export const RO_TZ = 'Europe/Bucharest';

/** SQL: the UTC instant (naive timestamp) at which Romanian day `dateExpr` (a date / 'YYYY-MM-DD' parameter) starts. */
export const roDayStart = (dateExpr: string): string => `((${dateExpr})::date::timestamp AT TIME ZONE '${RO_TZ}' AT TIME ZONE 'UTC')`;
/** SQL: the UTC instant at which the Romanian day AFTER `dateExpr` starts (exclusive end of an inclusive day range). */
export const roDayEnd = (dateExpr: string): string => `((((${dateExpr})::date + 1))::timestamp AT TIME ZONE '${RO_TZ}' AT TIME ZONE 'UTC')`;
/** SQL predicate: column `col` falls inside the Romanian days [$from, $to] (both inclusive). */
export const inRoDays = (col: string, fromParam: string, toParam: string): string => `${col} >= ${roDayStart(fromParam)} AND ${col} < ${roDayEnd(toParam)}`;

/** Our own test / QA / internal addresses (lower-case POSIX regex, also valid in JS). */
export const TEST_EMAIL_PATTERN =
  '(^qa\\+|^test@|\\+(qa|test)[^@]*@|lucidlabsorg|uifaleanst|render-test|^probe([-_.+0-9][^@]*)?@|[+._-]probe[^@]*@' +
  '|@([^@]*\\.)?(example\\.(com|org|net)|magic-chapter\\.com)$|(\\.(test|invalid|localhost|example)|@localhost|@mock)$)';
const TEST_EMAIL_RE = new RegExp(TEST_EMAIL_PATTERN);
export const isTestEmail = (email: string | null | undefined): boolean => TEST_EMAIL_RE.test(String(email || '').toLowerCase());
/** SQL predicate: the address column is one of ours (NULL / empty = not a test address). */
export const testEmailSql = (col: string): string => `(lower(coalesce(${col}, '')) ~ '${TEST_EMAIL_PATTERN}')`;
/** SQL predicate on a Magic Chapter "Order" alias: a test order (simulated payment or one of our addresses). */
export const santaTestOrderSql = (o: string): string =>
  `(coalesce(${o}."stripeSessionId", '') = 'simulated' OR ${testEmailSql(`${o}.email`)} OR ${testEmailSql(`${o}."leadEmail"`)})`;
