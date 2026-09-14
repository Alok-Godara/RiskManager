/**
 * Thin HTTP client for the reference-data settlement API.
 *
 * GET {base}/Catalog/Instrument/SettlementPrice?date=YYYY-MM-DD
 *
 * `refdataapi` is a bare internal hostname (no public DNS), so this ALWAYS
 * goes through a same-origin `/refdata-api` path that something server-side
 * forwards — the Vite dev server locally (vite.config.ts), a Netlify Edge
 * Function when deployed (netlify/edge-functions/refdata-api-proxy.ts) —
 * exactly the same shape as services/quantHub/client.ts, for the same two
 * reasons: it avoids CORS, and if this endpoint ever needs a token, that
 * token stays server-side.
 *
 * IMPORTANT: no sample response was available while building this, so
 * normalizeSettlementResponse below is deliberately tolerant of several
 * plausible shapes rather than committing to one. If settlement prices
 * don't come through, capture one real response and fix the parsing here —
 * this is the one file that should need it (same recovery path the
 * QuantHub integration went through).
 */

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

const PRICE_KEYS = ["settlementprice", "settlement_price", "settle", "settleprice", "price", "close", "value"];
const CODE_KEYS = [
  "instrument",
  "instrumentcode",
  "instrument_code",
  "code",
  "symbol",
  "ticker",
  "product",
  "contractcode",
  "name",
];
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

function addCode(out: Record<string, number>, code: string, price: number) {
  if (!code) return;
  out[code.toUpperCase()] = price;
}

/**
 * Normalizes the response into { INSTRUMENT_CODE: settlementPrice },
 * tolerating:
 *   [{ instrumentCode: "COX26", settlementPrice: 61.42, date: "..." }, ...]
 *   { "COX26": 61.42, ... }
 *   { "COX26": { settlementPrice: 61.42 }, ... }
 *   { data: [...] } / { results: [...] } (any wrapper in SERIES_KEYS)
 */
export function normalizeSettlementResponse(json: Json): Record<string, number> {
  const out: Record<string, number> = {};

  const visit = (node: Json, depth = 0) => {
    if (node === null || node === undefined || depth > 4) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (!isRecord(item)) continue;
        const code = pick(item, CODE_KEYS);
        const price = toNumber(pick(item, PRICE_KEYS));
        if (typeof code === "string" && price !== undefined) addCode(out, code, price);
      }
      return;
    }

    if (!isRecord(node)) return;

    // A wrapper object like { data: [...] } / { results: [...] }.
    for (const wrapperKey of SERIES_KEYS) {
      const inner = pick(node, [wrapperKey]);
      if (inner !== undefined) visit(inner, depth + 1);
    }

    // Root-level { CODE: price } or { CODE: { settlementPrice: price } } map.
    for (const [key, value] of Object.entries(node)) {
      if (SERIES_KEYS.includes(key.toLowerCase())) continue;
      const direct = toNumber(value);
      if (direct !== undefined) {
        addCode(out, key, direct);
        continue;
      }
      if (isRecord(value)) {
        const nested = toNumber(pick(value, PRICE_KEYS));
        if (nested !== undefined) addCode(out, key, nested);
      }
    }
  };

  visit(json);
  return out;
}

/**
 * Fetch every instrument's settlement price for one date.
 * Throws SettlementDataError with a `kind` the caller can react to.
 */
export async function fetchSettlementPrices(date: string): Promise<Record<string, number>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/Catalog/Instrument/SettlementPrice?date=${encodeURIComponent(date)}`, {
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

  return normalizeSettlementResponse(json);
}
