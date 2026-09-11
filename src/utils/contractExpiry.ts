import type { Instrument } from "../types/domain";

// ---------------------------------------------------------------------------
// Real exchange last-trading-day (LTD) rules, used to determine which
// contract month is actually the tradeable "front" month as of any given
// date — NOT simply "the current calendar month". Brent, for example,
// stops trading its own delivery month's contract roughly six weeks before
// that month even starts, so on any given day the tradeable front month is
// 2-3 calendar months AHEAD of today.
//
// Rules below were checked against exchange documentation (ICE Brent Crude
// Futures contract rules; CME/NYMEX Light Sweet Crude Oil rulebook chapter
// 200; CME WTI Midland/Houston (Argus) Trade Month contract specs;
// CME/NYMEX NY Harbor ULSD and RBOB Gasoline rulebooks, chapters 150/191).
//
// Deliberately weekends-only, not a full exchange holiday calendar — good
// enough to place the front-month boundary within a day or two, which only
// matters in the rare case "today" lands exactly on a holiday right at a
// roll date. Documented here rather than silently assumed.
// ---------------------------------------------------------------------------

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Walks backward from `d` (inclusive) to the nearest Mon-Fri. */
function businessDayOnOrBefore(d: Date): Date {
  let cur = d;
  while (!isWeekday(cur)) cur = addDays(cur, -1);
  return cur;
}

/** Walks back `n` further weekdays from `d` (which must already be a weekday). */
function subtractBusinessDays(d: Date, n: number): Date {
  let cur = d;
  let remaining = n;
  while (remaining > 0) {
    cur = addDays(cur, -1);
    if (isWeekday(cur)) remaining--;
  }
  return cur;
}

/** The Nth-from-last business day of a given month (1 = last, 2 = penultimate, ...). */
function nthFromEndBusinessDayOfMonth(year: number, monthIndex: number, n: number): Date {
  const lastCalendarDay = new Date(year, monthIndex + 1, 0);
  let cur = businessDayOnOrBefore(lastCalendarDay);
  for (let i = 1; i < n; i++) cur = subtractBusinessDays(cur, 1);
  return cur;
}

/** Computes the last trading day for a contract whose delivery month is `deliveryMonth` (year/month read only). */
export type ExpiryRule = (deliveryMonth: Date) => Date;

/** ICE Brent Crude: last business day of the SECOND month preceding the delivery month. */
const BRENT_RULE: ExpiryRule = (deliveryMonth) => {
  const refMonth = new Date(deliveryMonth.getFullYear(), deliveryMonth.getMonth() - 2, 1);
  return nthFromEndBusinessDayOfMonth(refMonth.getFullYear(), refMonth.getMonth(), 1);
};

/** CME/NYMEX Light Sweet Crude (CL): 3rd business day before the last business day on/before the 25th of the prior month. */
const WTI_RULE: ExpiryRule = (deliveryMonth) => {
  const priorMonth25th = new Date(deliveryMonth.getFullYear(), deliveryMonth.getMonth() - 1, 25);
  const ref = businessDayOnOrBefore(priorMonth25th);
  return subtractBusinessDays(ref, 3);
};

/** CME WTI Midland/Houston (Argus) Trade Month: last business day on/before the 25th of the prior month. */
const WTI_MIDLAND_RULE: ExpiryRule = (deliveryMonth) => {
  const priorMonth25th = new Date(deliveryMonth.getFullYear(), deliveryMonth.getMonth() - 1, 25);
  return businessDayOnOrBefore(priorMonth25th);
};

/** CME/NYMEX NY Harbor ULSD / RBOB Gasoline: 2nd-to-last (penultimate) business day of the prior month. */
const PENULTIMATE_BUSINESS_DAY_RULE: ExpiryRule = (deliveryMonth) => {
  const priorMonth = new Date(deliveryMonth.getFullYear(), deliveryMonth.getMonth() - 1, 1);
  return nthFromEndBusinessDayOfMonth(priorMonth.getFullYear(), priorMonth.getMonth(), 2);
};

/** Generic fallback for an instrument with no specific rule below: last business day of the month preceding delivery. */
const DEFAULT_RULE: ExpiryRule = (deliveryMonth) => {
  const priorMonth = new Date(deliveryMonth.getFullYear(), deliveryMonth.getMonth() - 1, 1);
  return nthFromEndBusinessDayOfMonth(priorMonth.getFullYear(), priorMonth.getMonth(), 1);
};

const RULES_BY_KEY: Record<string, ExpiryRule> = {
  BZ: BRENT_RULE,
  CO: BRENT_RULE, // QuantHub/ICE product code for Brent
  CL: WTI_RULE,
  WBS: WTI_MIDLAND_RULE,
  HCL: WTI_MIDLAND_RULE, // CME WTI Houston (Argus) ticker
  HO: PENULTIMATE_BUSINESS_DAY_RULE,
  RB: PENULTIMATE_BUSINESS_DAY_RULE,
};

/** Resolves the LTD rule for an instrument by its symbol, then exchange_code, then a generic default. */
export function resolveExpiryRule(instrument: Instrument): ExpiryRule {
  return (
    RULES_BY_KEY[instrument.symbol.trim().toUpperCase()] ??
    (instrument.exchange_code ? RULES_BY_KEY[instrument.exchange_code.trim().toUpperCase()] : undefined) ??
    DEFAULT_RULE
  );
}

/** Real last trading day for the contract whose delivery month is `deliveryMonth`. */
export function lastTradingDay(instrument: Instrument, deliveryMonth: Date): Date {
  return resolveExpiryRule(instrument)(deliveryMonth);
}

/**
 * The earliest delivery month whose last trading day has not yet passed as
 * of `now` — the actual tradeable "front month" today, which can be one to
 * three calendar months ahead of `now`'s own month depending on the
 * product's LTD rule above.
 */
export function frontMonth(instrument: Instrument, now: Date = new Date()): Date {
  const rule = resolveExpiryRule(instrument);
  const today = startOfDay(now);
  let candidate = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < 8; i++) {
    if (rule(candidate) >= today) return candidate;
    candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1);
  }
  // Unreachable for any real rule above — safety net rather than a throw.
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Whole days remaining until `expiryDate` (0 = expires today, negative = already passed), or undefined if unparseable. */
export function daysUntilExpiry(expiryDate: string | undefined, now: Date = new Date()): number | undefined {
  if (!expiryDate) return undefined;
  const expiry = new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return undefined;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(expiry).getTime() - startOfDay(now).getTime()) / msPerDay);
}

/** A contract is flagged this many days out from its last trading day. */
export const NEAR_EXPIRY_DAYS = 7;

export type ContractLifecycleStatus = "Active" | "Near Expiry" | "Expired";

/**
 * Active / Near Expiry / Expired — purely derived from `expiry_date` vs
 * `now`, never stored (same "recompute from source of truth" pattern as
 * Structure.status — see StructureEngine.refreshStructureStatus). A
 * contract with no expiry_date is treated as Active rather than blocked.
 */
export function contractLifecycleStatus(expiryDate: string | undefined, now: Date = new Date()): ContractLifecycleStatus {
  const days = daysUntilExpiry(expiryDate, now);
  if (days === undefined) return "Active";
  if (days < 0) return "Expired";
  if (days <= NEAR_EXPIRY_DAYS) return "Near Expiry";
  return "Active";
}
