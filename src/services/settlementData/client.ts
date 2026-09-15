/**
 * Thin HTTP client for the reference-data settlement API.
 *
 * GET {base}/Catalog/Instrument/SettlementPrice?date=YYYY-MM-DD
 *
 * Confirmed against real responses (captured 2026-09-15): `date` is NOT
 * "give me this one day" — it's a lower bound. The response is every
 * trading day from `date` through the most recent settlement available
 * (yesterday, since today's isn't published yet), all in one payload, e.g.
 * requesting `date=2026-08-01` returned 31 distinct TradeDates (2026-08-03
 * .. 2026-09-14) in a single ~12MB response. Requesting the most recent
 * available date back returns just that one day (nothing newer exists yet
 * to include). Each row carries its OWN `TradeDate`:
 *   { "TradeDate": "2026-09-14", "Contract": "BCO", "ContractType": "FUT",
 *     "Delivery": "DEC-26", "StrikePrice": null, "ClosePrice": 100.99,
 *     "NextDaySettlementPrice": null, "HGProductID": 137,
 *     "HGProductKey": "ICE:BRN" }
 *
 * This means one request with the EARLIEST date still needed backfills
 * every missing date at once — see settlementHistoryService.ts, which used
 * to (wrongly) call this once per date and stamp every returned row with
 * the date it asked for rather than each row's own TradeDate, silently
 * writing the same handful of prices under every requested date.
 *
 * Three assumptions from before any of this was confirmed turned out
 * wrong, all fixed here:
 *  - `date` is a range start, not an exact match (above).
 *  - The product identity that matches this app's Instrument.symbol is the
 *    segment of HGProductKey AFTER the exchange prefix ("ICE:BRN" -> "BRN",
 *    "CME:CL" -> "CL", "ICE:WBS" -> "WBS", "ICE:G" -> "G") — NOT `Contract`
 *    (the exchange's own dealing code, e.g. "BCO" for Brent), and NOT this
 *    app's QuantHub exchange_code (Brent is "CO" on QuantHub, "BRN" here) —
 *    refdataapi and QuantHub use different product-code conventions, so
 *    settlement lookups key off Instrument.symbol directly, never through
 *    quantHub/symbols.ts.
 *  - `Delivery` is "MMM-YY" (e.g. "DEC-26"), one hyphen off from this app's
 *    own month_label ("Dec26"). `ContractType` distinguishes futures ("FUT")
 *    from options on the same product ("ICE:BRN:OPT" rows also exist) —
 *    only FUT rows are outright settlement prices.
 *
 * `refdataapi` is a bare internal hostname (no public DNS), so this ALWAYS
 * goes through a same-origin `/refdata-api` path that something server-side
 * forwards — the Vite dev server locally (vite.config.ts), a Netlify Edge
 * Function when deployed (netlify/edge-functions/refdata-api-proxy.ts) —
 * same shape as services/quantHub/client.ts and for the same reasons: it
 * avoids CORS, and if this endpoint ever needs a token, that token stays
 * server-side (it didn't need one when this was captured).
 */

import { MONTH_NAMES } from "../../utils/contractGen";

export type SettlementDataErrorKind = "http" | "network" | "parse";

export class SettlementDataError extends Error {
  readonly kind: SettlementDataErrorKind;
  readonly status?: number;
  constructor(kind: SettlementDataErrorKind, message: string, status?: number) {
    super(message);
    this.name = "SettlementDataError";
    this.kind = kind;
    this.status = status;
  }
}

const API_BASE = (import.meta.env?.VITE_REFDATA_API_BASE ?? "/refdata-api").replace(/\/+$/, "");

// Field name candidates, case-insensitive. The first in each list is the
// confirmed real field; the rest are kept as a fallback in case the API's
// shape ever shifts, so a rename degrades to "still parses" not "silent
// zero prices" (the failure mode this replaced).
const PRODUCT_KEY_KEYS = ["hgproductkey", "productkey", "instrument", "symbol"];
const CONTRACT_TYPE_KEYS = ["contracttype", "type"];
const DELIVERY_KEYS = ["delivery", "deliverymonth", "month"];
const PRICE_KEYS = ["closeprice", "settlementprice", "settlement_price", "settle", "settleprice", "price", "close", "value"];
const TRADE_DATE_KEYS = ["tradedate", "date", "settlementdate"];
const SERIES_KEYS = ["data", "results", "settlements", "prices", "instruments", "items"];

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(obj: Record<string, Json>, keys: readonly string[]): Json | undefined {
  const lowered = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const actual = lowered.get(key);
    if (actual !== undefined) return obj[actual];
  }
  return undefined;
}

function toNumber(value: Json): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** "ICE:BRN" -> "BRN", "CME:CL" -> "CL". A bare code with no ":" (fallback field) passes through unchanged. */
function productSymbolFrom(productKey: string): string | undefined {
  const parts = productKey.split(":");
  const symbol = (parts.length > 1 ? parts[1] : parts[0])?.trim().toUpperCase();
  return symbol || undefined;
}

/** "DEC-26" -> "Dec26" — this app's Contract.month_label format (see utils/contractGen.ts). Undefined if it doesn't parse. */
function monthLabelFromDelivery(delivery: string): string | undefined {
  const match = /^([A-Za-z]{3})-(\d{2})$/.exec(delivery.trim());
  if (!match) return undefined;
  const monthIdx = MONTH_NAMES.findIndex((m) => m.toUpperCase() === match[1].toUpperCase());
  if (monthIdx === -1) return undefined;
  return `${MONTH_NAMES[monthIdx]}${match[2]}`;
}

/** Build the lookup key this module and SettlementHistoryService share: `${date}::${SYMBOL}::${monthLabel}`, e.g. "2026-09-14::BRN::Dec26". */
export function settlementKey(date: string, symbol: string, monthLabel: string): string {
  return `${date}::${symbol.trim().toUpperCase()}::${monthLabel}`;
}

/** "2026-09-14" as-is; rejects anything that doesn't already look like YYYY-MM-DD rather than guess at a different date format. */
function normalizeTradeDate(value: string): string | undefined {
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Normalizes the response into { "date::SYMBOL::MonthLabel": closePrice },
 * futures rows only (ContractType "FUT" — options on the same product are
 * excluded), spanning however many distinct TradeDates the response
 * actually contains (see this file's header — usually more than one).
 * Tolerates the response being wrapped under a common key (SERIES_KEYS)
 * instead of a bare top-level array.
 *
 * `allowedSymbols`, when given, drops every row whose product symbol isn't
 * in the set before it's ever added to `out` — the endpoint always returns
 * the whole market (every exchange, every product, tens of thousands of
 * rows), but a given portfolio only ever needs a handful of symbols, so
 * this keeps the parsed result (and the memory/lookups it costs) down to
 * just what's actually used instead of carrying every other product along
 * for no reason.
 */
export function normalizeSettlementResponse(json: Json, allowedSymbols?: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};

  const visitArray = (arr: Json[]) => {
    for (const item of arr) {
      if (!isRecord(item)) continue;

      const contractType = pick(item, CONTRACT_TYPE_KEYS);
      if (typeof contractType === "string" && contractType.trim().toUpperCase() !== "FUT") continue;

      const productKey = pick(item, PRODUCT_KEY_KEYS);
      if (typeof productKey !== "string") continue;
      const symbol = productSymbolFrom(productKey);
      if (!symbol || (allowedSymbols && !allowedSymbols.has(symbol))) continue;

      const delivery = pick(item, DELIVERY_KEYS);
      const tradeDate = pick(item, TRADE_DATE_KEYS);
      const price = toNumber(pick(item, PRICE_KEYS));
      if (typeof delivery !== "string" || typeof tradeDate !== "string" || price === undefined) continue;

      const monthLabel = monthLabelFromDelivery(delivery);
      const date = normalizeTradeDate(tradeDate);
      if (!monthLabel || !date) continue;

      out[settlementKey(date, symbol, monthLabel)] = price;
    }
  };

  if (Array.isArray(json)) {
    visitArray(json);
    return out;
  }
  if (isRecord(json)) {
    for (const wrapperKey of SERIES_KEYS) {
      const inner = pick(json, [wrapperKey]);
      if (Array.isArray(inner)) {
        visitArray(inner);
        return out;
      }
    }
  }
  return out;
}

/**
 * Fetch every instrument's settlement price for every trading day from
 * `sinceDate` through the most recent one available — see this file's
 * header comment: `date` is a range start, not an exact match, so ONE call
 * with the earliest date you need backfills everything after it too.
 * Pass `allowedSymbols` (product symbols, e.g. "BRN") to discard every
 * other product's rows while parsing — see normalizeSettlementResponse.
 * Throws SettlementDataError with a `kind` the caller can react to.
 */
export async function fetchSettlementPrices(sinceDate: string, allowedSymbols?: ReadonlySet<string>): Promise<Record<string, number>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/Catalog/Instrument/SettlementPrice?date=${encodeURIComponent(sinceDate)}`, {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    throw new SettlementDataError("network", err instanceof Error ? err.message : "Network request failed");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SettlementDataError(
      "http",
      `Settlement API returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      response.status
    );
  }

  let json: Json;
  try {
    json = await response.json();
  } catch {
    throw new SettlementDataError("parse", "Settlement API returned a response that isn't valid JSON");
  }

  return normalizeSettlementResponse(json, allowedSymbols);
}
