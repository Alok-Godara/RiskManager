import type { Contract, Instrument, StructureTemplate, UUID } from "../../types/domain";
import { repository } from "../../data";
import { contractAtOffset } from "../../utils/templateExpansion";
import { monthLabelAtOffset, sortContractsChronologically } from "../../utils/contractGen";
import type { MarketDataProvider, PriceQuote } from "../MarketDataService";
import {
  bidAskVwap,
  fetchLatestTaqQuotes,
  fetchOhlc,
  latestCandle,
  MAX_INSTRUMENTS_PER_REQUEST,
  QUANTHUB_MIN_REQUEST_SPACING_MS,
  QuantHubError,
  type OhlcCandle,
} from "./client";
import { isStaleCandle, londonToday, wallDate } from "./staleness";
import { buildCompositeQuantHubCode, quantHubProductCode, toQuantHubCode } from "./symbols";

/**
 * Reference data (instruments, templates, an instrument's full contract
 * list) changes rarely but would otherwise be re-read on every poll. Cache
 * it briefly so a 1s price loop doesn't hammer Supabase.
 */
const REF_DATA_TTL_MS = 60_000;

interface RefData {
  instruments: Map<UUID, Instrument>;
  templates: Map<UUID, StructureTemplate>;
  contractsByInstrument: Map<UUID, Contract[]>;
}

let refDataCache: { at: number; data: RefData } | null = null;

async function loadRefData(): Promise<RefData> {
  if (refDataCache && Date.now() - refDataCache.at < REF_DATA_TTL_MS) return refDataCache.data;

  const [instruments, templates, contracts] = await Promise.all([
    repository.getInstruments(),
    repository.getStructureTemplates(),
    repository.getContracts(),
  ]);

  const contractsByInstrument = new Map<UUID, Contract[]>();
  for (const contract of contracts) {
    const list = contractsByInstrument.get(contract.instrument_id) ?? [];
    list.push(contract);
    contractsByInstrument.set(contract.instrument_id, list);
  }

  const data: RefData = {
    instruments: new Map(instruments.map((i) => [i.id, i])),
    templates: new Map(templates.map((t) => [t.id, t])),
    contractsByInstrument,
  };
  refDataCache = { at: Date.now(), data };
  return data;
}

/** Drop the cache — call after instruments/contracts change (e.g. Settings edits). */
export function invalidateQuantHubRefData() {
  refDataCache = null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * TAQ fallback bookkeeping. TAQ is limited to 7 requests/minute and can be
 * heavy, so results are cached per product and the calls are spaced out — a
 * stale price is by definition not changing quickly.
 */
const TAQ_CACHE_MS = 5 * 60_000;
const TAQ_RETRY_MS = 60_000;
const TAQ_MIN_CALL_SPACING_MS = 10_000;
const TAQ_MAX_PRODUCTS_PER_CALL = 5;
const TAQ_MAX_LOOKBACK_DAYS = 7;
const taqCache = new Map<string, { at: number; price?: number; asOf?: number }>();
let lastTaqCallAt = 0;

/** YYYY-MM-DD for every day from `fromDate` to `toDate` inclusive (capped to the last TAQ_MAX_LOOKBACK_DAYS). */
function dateRange(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const end = new Date(`${toDate}T00:00:00Z`).getTime();
  const start = Math.max(new Date(`${fromDate}T00:00:00Z`).getTime(), end - (TAQ_MAX_LOOKBACK_DAYS - 1) * 86_400_000);
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function isOutright(contract: Contract): boolean {
  return !contract.kind || contract.kind === "Outright";
}

/**
 * QuantHubProvider: the authoritative market-price source.
 *
 * Every contract maps to exactly one QuantHub instrument code:
 *   - Outright month: product code (`exchange_code`, e.g. Brent = "CO")
 *     plus the standard futures month/year code — "Brent Nov26" -> "COX26".
 *   - Directly-traded structure quote (e.g. "Jan26 Fly", "Double Fly"): the
 *     exchange's own composite code for that shape — product code once,
 *     then each leg's month/year suffix in leg order, joined by "-", e.g.
 *     "COX26-Z26-F27" for a Brent Nov26 Fly (Nov/Dec/Jan). QuantHub quotes
 *     these as one tradeable product, so the price is requested directly —
 *     never synthesized by summing outright legs (see buildCompositeCode).
 *
 * Each request asks for `count=1` and omits `end` — confirmed live that
 * QuantHub then returns just the single freshest bar, same as an unbounded
 * request's top row; its close is the current price (spec: "take the top
 * OHLC row, use its close"). `end` is deliberately not sent: it must be
 * unix milliseconds, but the API doesn't reject the wrong unit (seconds) —
 * it silently answers with a stale candle instead, which is a sharp edge
 * not worth taking on when omitting it entirely works.
 */
export class QuantHubProvider implements MarketDataProvider {
  name = "QuantHub";

  /** The exchange's composite code for a "Structure"-kind contract, e.g. a Fly. */
  private quoteCodeFor(contract: Contract, ref: RefData): string | undefined {
    if (!contract.quote_template_id || !contract.anchor_contract_id) return undefined;
    const template = ref.templates.get(contract.quote_template_id);
    const instrument = ref.instruments.get(contract.instrument_id);
    if (!template || !instrument) return undefined;

    const instrumentContracts = ref.contractsByInstrument.get(contract.instrument_id) ?? [];
    const chronological = sortContractsChronologically(instrumentContracts.filter(isOutright));
    const anchorLabel = instrumentContracts.find((c) => c.id === contract.anchor_contract_id)?.month_label;

    // Each leg's month: from our contract list when it covers it, otherwise by
    // calendar arithmetic from the anchor. The list is a rolling 24-month
    // window, so a spread anchored on its LAST month (e.g. Nov28 calendar
    // spread = Nov28 - Dec28 when the list ends at Nov28) has a second month
    // that isn't in it — the exchange code only needs the month and year, so
    // there is no reason to leave such a quote unpriced.
    const monthLabels: string[] = [];
    for (const leg of [...template.legs].sort((a, b) => a.month_offset - b.month_offset)) {
      let label: string | undefined;
      try {
        label = contractAtOffset(chronological, contract.anchor_contract_id, leg.month_offset).month_label;
      } catch {
        label = anchorLabel ? monthLabelAtOffset(anchorLabel, leg.month_offset) : undefined;
      }
      // Still unresolvable (anchor gone entirely): this quote just goes unpriced this tick rather than failing the refresh.
      if (!label) return undefined;
      monthLabels.push(label);
    }
    return buildCompositeQuantHubCode(quantHubProductCode(instrument), monthLabels);
  }

  /**
   * Latest two-sided TAQ quote -> size-weighted bid/ask price, for products whose
   * OHLC candle is stale. Cached per product (success 5 min, miss/failure 1 min),
   * batched into one request and spaced out to respect TAQ's 7/min limit. Any
   * failure just means "no fallback this time" — the OHLC price still stands.
   */
  private async taqFallback(
    stale: { code: string; candleTime: number }[],
    now: number
  ): Promise<Record<string, { price: number; asOf: number }>> {
    const out: Record<string, { price: number; asOf: number }> = {};
    const toFetch: { code: string; dates: string[] }[] = [];
    const today = londonToday(now);

    for (const { code, candleTime } of stale) {
      const cached = taqCache.get(code);
      if (cached) {
        const ttl = cached.price !== undefined ? TAQ_CACHE_MS : TAQ_RETRY_MS;
        if (now - cached.at < ttl) {
          if (cached.price !== undefined && cached.asOf !== undefined) out[code] = { price: cached.price, asOf: cached.asOf };
          continue;
        }
      }
      if (toFetch.length < TAQ_MAX_PRODUCTS_PER_CALL) toFetch.push({ code, dates: dateRange(wallDate(candleTime), today) });
    }
    if (toFetch.length === 0 || now - lastTaqCallAt < TAQ_MIN_CALL_SPACING_MS) return out;

    lastTaqCallAt = now;
    try {
      const quotes = await fetchLatestTaqQuotes(toFetch);
      for (const { code } of toFetch) {
        const q = quotes[code];
        if (q) {
          const price = Math.round(bidAskVwap(q) * 10_000) / 10_000;
          taqCache.set(code, { at: now, price, asOf: q.timestampMs });
          out[code] = { price, asOf: q.timestampMs };
        } else {
          taqCache.set(code, { at: now });
        }
      }
    } catch (err) {
      console.warn("QuantHub TAQ fallback failed:", err instanceof Error ? err.message : err);
      for (const { code } of toFetch) taqCache.set(code, { at: now });
    }
    return out;
  }

  private codeFor(contract: Contract, ref: RefData): string | undefined {
    const instrument = ref.instruments.get(contract.instrument_id);
    if (!instrument) return undefined;
    return isOutright(contract)
      ? toQuantHubCode(quantHubProductCode(instrument), contract.month_label)
      : this.quoteCodeFor(contract, ref);
  }

  async fetchPrices(contracts: Contract[]): Promise<Record<UUID, PriceQuote>> {
    if (contracts.length === 0) return {};

    let ref = await loadRefData();
    // A contract we've never seen (e.g. a structure quote created moments
    // ago) means the cache predates it — refresh once so it gets priced now
    // rather than after the TTL expires.
    const knowsAll = contracts.every((c) => ref.contractsByInstrument.get(c.instrument_id)?.some((x) => x.id === c.id));
    if (!knowsAll) {
      invalidateQuantHubRefData();
      ref = await loadRefData();
    }

    const codeByContractId = new Map<UUID, string>();
    const contractIdsByCode = new Map<string, UUID[]>();
    for (const contract of contracts) {
      const code = this.codeFor(contract, ref);
      if (!code) continue;
      codeByContractId.set(contract.id, code);
      contractIdsByCode.set(code, [...(contractIdsByCode.get(code) ?? []), contract.id]);
    }

    const codes = Array.from(contractIdsByCode.keys());
    if (codes.length === 0) return {};

    // One request per 50 codes, SEQUENTIALLY and spaced at least
    // QUANTHUB_MIN_REQUEST_SPACING_MS apart — firing several batches at
    // once would burn the per-minute allowance (30/min) in a single burst. In the common case
    // of <=50 required contracts this is exactly one request, same as
    // before. A failed batch shouldn't sink the others, but a wholesale
    // failure (auth/network) must surface.
    const codeBatches = chunk(codes, MAX_INSTRUMENTS_PER_REQUEST);
    const batches: PromiseSettledResult<Record<string, OhlcCandle[]>>[] = [];
    for (let i = 0; i < codeBatches.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, QUANTHUB_MIN_REQUEST_SPACING_MS));
      try {
        batches.push({ status: "fulfilled", value: await fetchOhlc(codeBatches[i], { count: 1 }) });
      } catch (err) {
        batches.push({ status: "rejected", reason: err });
      }
    }

    const closeByCode: Record<string, { price: number; asOf?: number }> = {};
    let firstError: unknown;
    let succeeded = 0;
    for (const result of batches) {
      if (result.status === "rejected") {
        firstError ??= result.reason;
        continue;
      }
      succeeded++;
      for (const [code, candles] of Object.entries(result.value)) {
        const candle = latestCandle(candles);
        if (candle?.close === undefined) continue;
        closeByCode[code.toUpperCase()] = { price: candle.close, asOf: candle.timestamp };
      }
    }
    if (succeeded === 0 && firstError) {
      throw firstError instanceof QuantHubError
        ? firstError
        : new QuantHubError("network", firstError instanceof Error ? firstError.message : "QuantHub request failed");
    }

    // Stale OHLC prices (older than 4 hours, or not from today) aren't a useful
    // live price. For those, ask TAQ for the latest best bid/ask and use their
    // size-weighted average. Only while the market is evidently open — if EVERY
    // candle in this batch is stale it's a weekend/holiday, nothing is trading,
    // and the last price is simply the last price.
    const now = Date.now();
    const staleCodes = Object.entries(closeByCode)
      .filter(([, m]) => m.asOf !== undefined && isStaleCandle(m.asOf, now))
      .map(([code, m]) => ({ code, candleTime: m.asOf as number }));
    const marketOpen = staleCodes.length < Object.keys(closeByCode).length;
    const taqPrices = marketOpen && staleCodes.length > 0 ? await this.taqFallback(staleCodes, now) : {};
    const staleSet = new Set(staleCodes.map((s) => s.code));

    const quotes: Record<UUID, PriceQuote> = {};
    for (const contract of contracts) {
      const code = codeByContractId.get(contract.id);
      if (!code) continue;
      const key = code.toUpperCase();
      const mark = closeByCode[key];
      if (!mark) continue; // unknown/unquoted code or empty series — left unpriced this tick
      const base = isOutright(contract) ? this.name : `${this.name} (structure)`;
      const taq = taqPrices[key];
      quotes[contract.id] = taq
        ? { price: taq.price, asOf: taq.asOf, source: `${base} TAQ bid/ask VWAP` }
        : { price: mark.price, asOf: mark.asOf, source: staleSet.has(key) ? `${base} (stale)` : base };
    }

    return quotes;
  }
}
