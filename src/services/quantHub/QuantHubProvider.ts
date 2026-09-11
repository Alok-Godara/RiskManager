import type { Contract, Instrument, StructureTemplate, UUID } from "../../types/domain";
import { repository } from "../../data";
import { contractAtOffset } from "../../utils/templateExpansion";
import { sortContractsChronologically } from "../../utils/contractGen";
import type { MarketDataProvider, PriceQuote } from "../MarketDataService";
import { fetchOhlc, latestCandle, MAX_INSTRUMENTS_PER_REQUEST, QuantHubError } from "./client";
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
 * Each request is pinned with `end=<now, unix seconds>` and `count=1`, so
 * the single row returned is always the freshest bar; its close is the
 * current price (spec: "take the top OHLC row, use its close").
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

    try {
      const monthLabels = [...template.legs]
        .sort((a, b) => a.month_offset - b.month_offset)
        .map((leg) => contractAtOffset(chronological, contract.anchor_contract_id!, leg.month_offset).month_label);
      return buildCompositeQuantHubCode(quantHubProductCode(instrument), monthLabels);
    } catch {
      // Anchor/offset no longer resolvable (e.g. contract months trimmed) —
      // this quote just goes unpriced this tick rather than failing the refresh.
      return undefined;
    }
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

    const endSeconds = Math.floor(Date.now() / 1000);
    // One request per 50 codes, in parallel. A failed batch shouldn't sink
    // the others, but a wholesale failure (auth/network) must surface.
    const batches = await Promise.allSettled(
      chunk(codes, MAX_INSTRUMENTS_PER_REQUEST).map((batch) => fetchOhlc(batch, { count: 1, end: endSeconds }))
    );

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

    const quotes: Record<UUID, PriceQuote> = {};
    for (const contract of contracts) {
      const code = codeByContractId.get(contract.id);
      if (!code) continue;
      const mark = closeByCode[code.toUpperCase()];
      if (!mark) continue; // unknown/unquoted code or empty series — left unpriced this tick
      quotes[contract.id] = {
        price: mark.price,
        asOf: mark.asOf,
        source: isOutright(contract) ? this.name : `${this.name} (structure)`,
      };
    }

    return quotes;
  }
}
