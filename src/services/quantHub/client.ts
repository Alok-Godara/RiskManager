/**
 * Thin HTTP client for the QuantHub OHLC API.
 *
 * GET {base}/apis/ohlc/?instruments=COX26&interval=1M&extraFields=buyvolume,sellvolume
 *
 * The path is `/apis/ohlc/` (plural, no version segment) — QuantHub retired
 * the old `/api/v2/ohlc/` path this endpoint used to live at, which is why
 * that one started returning nothing. Same base host, same auth/proxy setup.
 *
 * Auth: the Bearer token is NEVER handled here or shipped in the browser
 * bundle. Requests go to a same-origin path (`/qh-api` by default) which the
 * Vite dev/preview server proxies to QuantHub, injecting
 * `Authorization: Bearer $QH_API_TOKEN` server-side (see vite.config.ts).
 * That also sidesteps CORS. Point VITE_QH_API_BASE at an equivalent proxy
 * when deploying.
 */

export type QuantHubErrorKind = "auth" | "rate_limit" | "http" | "network" | "parse";

export class QuantHubError extends Error {
  readonly kind: QuantHubErrorKind;
  readonly status?: number;
  /**
   * Duck-typed rate-limit signal MarketDataService recognizes without
   * importing this (provider-specific) class — see asRateLimitSignal there.
   */
  readonly rateLimited: boolean;
  /** For kind "rate_limit": ms to wait before retrying, from Retry-After if the server sent one. */
  readonly retryAfterMs?: number;
  constructor(kind: QuantHubErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "QuantHubError";
    this.kind = kind;
    this.status = status;
    this.rateLimited = kind === "rate_limit";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface OhlcCandle {
  /** Epoch ms — the candle's own "as of" time, used for ordering and staleness. */
  timestamp?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  buyVolume?: number;
  sellVolume?: number;
}

export interface FetchOhlcOptions {
  interval?: string; // 1M / 5M / 1H / 1D
  count?: number; // candles per instrument
  extraFields?: string;
  /**
   * End timestamp. The current swagger documents `start`/`end` as unix
   * SECONDS (the retired /api/v2 endpoint took milliseconds and silently
   * returned a stale candle for the wrong unit). Nothing passes this today:
   * omitting it returns the freshest bars, which is all price polling needs.
   */
  end?: number;
  signal?: AbortSignal;
}

/** Max instruments per request, per the API docs ("upto: 50"). */
export const MAX_INSTRUMENTS_PER_REQUEST = 50;

/**
 * QuantHub's published rate limit for `/apis/ohlc/`, per token: 30/minute,
 * 1,800/hour, 43,200/day — straight from the live swagger
 * (https://qh-api.corp.hertshtengroup.com/apis/swagger/, "ohlc_list"). It was
 * 10/minute until the API's rate limits were raised; re-check the swagger if
 * 429s start appearing. The response also carries X-RateLimit-Limit /
 * -Remaining / -Reset headers.
 */
export const QUANTHUB_RATE_LIMIT_PER_MINUTE = 30;

/**
 * How much of that budget each kind of poller aims to use. The token is
 * shared (this worker, any open dashboard tab, deployed viewers), so nobody
 * sits at the ceiling: the background worker takes 20/min (1,200/hour,
 * 28,800/day — inside the hourly AND daily caps with a third to spare), and
 * a browser tab 10/min (each of its ticks also reloads the whole UI, so a
 * slower cadence keeps that cheap — and a tab skips QuantHub entirely while
 * the worker is alive, see MarketDataService.setDeferToWorker).
 */
export const QUANTHUB_WORKER_REQUESTS_PER_MINUTE = 20;
export const QUANTHUB_BROWSER_REQUESTS_PER_MINUTE = 4;

/** Poll interval for a given requests-per-minute target, plus a small margin for timer jitter. */
export function quantHubPollIntervalMs(requestsPerMinute: number): number {
  return Math.ceil(60_000 / requestsPerMinute) + 100;
}

/** Minimum spacing between sequential batch requests implied by the rate limit above, with headroom. */
export const QUANTHUB_MIN_REQUEST_SPACING_MS = Math.ceil(60_000 / QUANTHUB_RATE_LIMIT_PER_MINUTE) + 500;

let apiBase = (import.meta.env?.VITE_QH_API_BASE ?? "/qh-api").replace(/\/+$/, "");
let extraHeaders: Record<string, string> = {};

/**
 * For SERVER-SIDE callers only (the background price worker): there is no
 * same-origin proxy outside the browser, so point the client at QuantHub
 * directly and send the Bearer token ourselves. The browser never calls
 * this — its token stays in the dev/edge proxy.
 */
export function configureQuantHubClient({ baseUrl, bearerToken }: { baseUrl: string; bearerToken?: string }) {
  apiBase = baseUrl.replace(/\/+$/, "");
  extraHeaders = bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}

// The live API returns a flat, newest-first array of candles, each tagged
// with `product`:
//   [{ product: "COX26", time: 1789065360000, open, high, low, close, volume }, ...]
// The other shapes below are tolerated too, so a change in wrapper/field
// naming degrades into "still parses" rather than "silently no prices".
// Keys are matched case-insensitively.
const CLOSE_KEYS = ["close", "c", "last", "lastprice", "price", "settle"];
const OPEN_KEYS = ["open", "o"];
const HIGH_KEYS = ["high", "h"];
const LOW_KEYS = ["low", "l"];
const VOLUME_KEYS = ["volume", "v", "totalvolume"];
const BUY_VOLUME_KEYS = ["buyvolume", "buy_volume", "bv"];
const SELL_VOLUME_KEYS = ["sellvolume", "sell_volume", "sv"];
const TIME_KEYS = ["time", "timestamp", "t", "ts", "datetime", "date", "starttime", "start_time"];
const INSTRUMENT_KEYS = [
  "product", // what the live API uses
  "instrument",
  "instrument_code",
  "instrumentcode",
  "symbol",
  "code",
  "qh_code",
  "ticker",
  "name",
];
const SERIES_KEYS = ["candles", "ohlc", "data", "bars", "values", "results"];

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Case-insensitive lookup of the first matching key. */
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

function pickNumber(obj: Record<string, Json>, keys: readonly string[]): number | undefined {
  return toNumber(pick(obj, keys));
}

/** Accepts epoch seconds, epoch ms, or an ISO string; returns epoch ms. */
function toTimestamp(value: Json): number | undefined {
  const asNumber = toNumber(value);
  if (asNumber !== undefined) {
    // Seconds-since-epoch values are ~1e9; ms are ~1e12.
    return asNumber < 1e11 ? asNumber * 1000 : asNumber;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function toCandle(value: Json): OhlcCandle | undefined {
  // Array form: [time, open, high, low, close, volume...]
  if (Array.isArray(value)) {
    const close = toNumber(value[4]);
    if (close === undefined) return undefined;
    return {
      timestamp: toTimestamp(value[0]),
      open: toNumber(value[1]),
      high: toNumber(value[2]),
      low: toNumber(value[3]),
      close,
    };
  }
  if (!isRecord(value)) return undefined;
  const close = pickNumber(value, CLOSE_KEYS);
  if (close === undefined) return undefined;
  return {
    timestamp: toTimestamp(pick(value, TIME_KEYS)),
    open: pickNumber(value, OPEN_KEYS),
    high: pickNumber(value, HIGH_KEYS),
    low: pickNumber(value, LOW_KEYS),
    close,
    volume: pickNumber(value, VOLUME_KEYS),
    buyVolume: pickNumber(value, BUY_VOLUME_KEYS),
    sellVolume: pickNumber(value, SELL_VOLUME_KEYS),
  };
}

function toCandles(value: Json): OhlcCandle[] {
  if (!Array.isArray(value)) {
    const single = toCandle(value);
    return single ? [single] : [];
  }
  return value.map(toCandle).filter((c): c is OhlcCandle => c !== undefined);
}

function addSeries(out: Record<string, OhlcCandle[]>, code: string, candles: OhlcCandle[]) {
  if (!code || candles.length === 0) return;
  const key = code.toUpperCase();
  out[key] = [...(out[key] ?? []), ...candles];
}

/**
 * Normalizes the response into { INSTRUMENT_CODE: candles[] }, tolerating:
 *   { "COX26": [...] }                          keyed at the root
 *   { data: { "COX26": [...] } }                keyed under a wrapper
 *   [{ instrument: "COX26", candles: [...] }]   array of per-instrument objects
 *   [{ instrument: "COX26", c: 61.2, ... }]     flat candles tagged with a code
 */
export function normalizeOhlcResponse(json: Json): Record<string, OhlcCandle[]> {
  const out: Record<string, OhlcCandle[]> = {};

  const visit = (node: Json, depth = 0) => {
    if (node === null || node === undefined || depth > 4) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (!isRecord(item)) continue;
        const code = pick(item, INSTRUMENT_KEYS);
        if (typeof code !== "string") continue;
        const series = pick(item, SERIES_KEYS);
        addSeries(out, code, series !== undefined ? toCandles(series) : toCandles(item));
      }
      return;
    }

    if (!isRecord(node)) return;

    // A wrapper object like { data: ... } / { results: ... }.
    for (const wrapperKey of SERIES_KEYS) {
      const inner = pick(node, [wrapperKey]);
      if (inner !== undefined) visit(inner, depth + 1);
    }

    // Root-level { CODE: candles } map.
    for (const [key, value] of Object.entries(node)) {
      if (SERIES_KEYS.includes(key.toLowerCase())) continue;
      const candles = toCandles(value);
      if (candles.length > 0) addSeries(out, key, candles);
    }
  };

  visit(json);
  return out;
}

/** Most recent candle carrying a usable close, or undefined. */
export function latestCandle(candles: OhlcCandle[] | undefined): OhlcCandle | undefined {
  if (!candles || candles.length === 0) return undefined;
  const usable = candles.filter((c) => typeof c.close === "number" && Number.isFinite(c.close));
  if (usable.length === 0) return undefined;
  const timed = usable.filter((c) => c.timestamp !== undefined);
  if (timed.length > 0) {
    return timed.reduce((latest, c) => ((c.timestamp ?? 0) > (latest.timestamp ?? 0) ? c : latest));
  }
  // Nothing to order by. The live API returns newest-first, so prefer the
  // head; every real response carries `time`, making this a safety net only.
  return usable[0];
}

/** Convenience wrapper — the close of `latestCandle`. */
export function latestClose(candles: OhlcCandle[] | undefined): number | undefined {
  return latestCandle(candles)?.close;
}

/**
 * Fetch OHLC candles for up to MAX_INSTRUMENTS_PER_REQUEST codes.
 * Throws QuantHubError with a `kind` the caller can react to.
 */
export async function fetchOhlc(
  instruments: string[],
  { interval = "1M", count = 1, extraFields = "buyvolume,sellvolume", end, signal }: FetchOhlcOptions = {}
): Promise<Record<string, OhlcCandle[]>> {
  if (instruments.length === 0) return {};

  const params = new URLSearchParams({
    instruments: instruments.join(","),
    interval,
    count: String(count),
    extraFields,
  });
  if (end !== undefined) params.set("end", String(Math.floor(end)));

  let response: Response;
  try {
    response = await fetch(`${apiBase}/apis/ohlc/?${params.toString()}`, {
      headers: { accept: "application/json", ...extraHeaders },
      signal,
    });
  } catch (err) {
    throw new QuantHubError("network", err instanceof Error ? err.message : "Network request failed");
  }

  if (response.status === 401 || response.status === 403) {
    throw new QuantHubError(
      "auth",
      "QuantHub rejected the credentials — check QH_API_TOKEN in .env (and restart the dev server).",
      response.status
    );
  }
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    throw new QuantHubError(
      "rate_limit",
      "QuantHub is rate-limiting this token — backing off automatically.",
      429,
      retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new QuantHubError("http", `QuantHub returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`, response.status);
  }

  let json: Json;
  try {
    json = await response.json();
  } catch {
    throw new QuantHubError("parse", "QuantHub returned a response that isn't valid JSON");
  }

  return normalizeOhlcResponse(json);
}

// ---------------------------------------------------------------------------
// TAQ (Trade and Quote) — used only as a fallback price source when the OHLC
// candle for a product is stale (see staleness.ts / QuantHubProvider).
//
//   POST {base}/apis/taq/   { products: [{ id: "COX28-Z28", dates: ["2026-10-09", ...], start, end }] }
//
// Each row is one book/trade update with the best bid/ask and their sizes;
// `timestamp` is epoch MICROseconds in real UTC (unlike OHLC candle times).
// Rate limit is 7/minute, so callers cache and batch.
// ---------------------------------------------------------------------------

export interface TaqQuote {
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  /** Epoch ms, real UTC, of the book update this quote comes from. */
  timestampMs: number;
}

interface TaqRow {
  timestamp?: number;
  instrument?: string;
  best_bid?: number | null;
  best_ask?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
}

interface TaqPage {
  total_pages?: number;
  data?: TaqRow[];
}

/**
 * The most recent two-sided quote (a real best bid AND best ask) per product,
 * across the given dates. Products with no quote in those dates are omitted.
 * Uses the last page when the response is paginated (rows are time-ordered).
 */
export async function fetchLatestTaqQuotes(
  products: { code: string; dates: string[] }[],
  signal?: AbortSignal
): Promise<Record<string, TaqQuote>> {
  if (products.length === 0) return {};
  const body = JSON.stringify({
    products: products.map((p) => ({ id: p.code, dates: p.dates, start: "00:00:00", end: "23:59:59" })),
  });

  const post = async (page?: number): Promise<TaqPage> => {
    let response: Response;
    try {
      response = await fetch(`${apiBase}/apis/taq/${page ? `?page=${page}` : ""}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...extraHeaders },
        body,
        signal,
      });
    } catch (err) {
      throw new QuantHubError("network", err instanceof Error ? err.message : "Network request failed");
    }
    if (response.status === 401 || response.status === 403) {
      throw new QuantHubError("auth", "QuantHub rejected the credentials — check QH_API_TOKEN in .env (and restart the dev server).", response.status);
    }
    if (response.status === 429) throw new QuantHubError("rate_limit", "QuantHub is rate-limiting TAQ requests.", 429);
    if (!response.ok) throw new QuantHubError("http", `QuantHub TAQ returned ${response.status}`, response.status);
    try {
      return (await response.json()) as TaqPage;
    } catch {
      throw new QuantHubError("parse", "QuantHub TAQ returned a response that isn't valid JSON");
    }
  };

  const first = await post();
  let rows = first.data ?? [];
  if ((first.total_pages ?? 1) > 1) {
    try {
      rows = (await post(first.total_pages)).data ?? rows;
    } catch {
      // keep the first page — still a valid (if older) quote
    }
  }

  const latest: Record<string, TaqQuote> = {};
  for (const row of rows) {
    if (typeof row.best_bid !== "number" || typeof row.best_ask !== "number" || typeof row.timestamp !== "number" || !row.instrument) continue;
    if (!Number.isFinite(row.best_bid) || !Number.isFinite(row.best_ask)) continue;
    const key = row.instrument.toUpperCase();
    const timestampMs = row.timestamp / 1000;
    if (latest[key] && latest[key].timestampMs >= timestampMs) continue;
    latest[key] = {
      bid: row.best_bid,
      ask: row.best_ask,
      bidSize: typeof row.bid_size === "number" ? row.bid_size : undefined,
      askSize: typeof row.ask_size === "number" ? row.ask_size : undefined,
      timestampMs,
    };
  }
  return latest;
}

/**
 * Volume-weighted average of the best bid and best ask: each side's price
 * weighted by the size resting there — (bid x bidSize + ask x askSize) /
 * (bidSize + askSize). Falls back to the plain midpoint when sizes are missing.
 */
export function bidAskVwap(q: TaqQuote): number {
  const bs = q.bidSize ?? 0;
  const as = q.askSize ?? 0;
  if (bs + as > 0) return (q.bid * bs + q.ask * as) / (bs + as);
  return (q.bid + q.ask) / 2;
}
