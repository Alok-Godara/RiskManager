import type { Contract, Instrument, StructureTemplate, UUID } from "../../types/domain";
import { repository } from "../../data";
import { expandToOutrights } from "../../utils/templateExpansion";
import type { MarketDataProvider, PriceQuote } from "../MarketDataService";
import { fetchOhlc, latestCandle, MAX_INSTRUMENTS_PER_REQUEST, QuantHubError } from "./client";
import { quantHubProductCode, toQuantHubCode } from "./symbols";

/**
 * Reference data (instruments, templates, an instrument's full contract
 * list) changes rarely but would otherwise be re-read on every poll. Cache
 * it briefly so a 15s price loop doesn't hammer Supabase.
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
 * Outright months map straight onto a QuantHub instrument code — product
 * code from the instrument (`exchange_code`, e.g. Brent = "CO") plus the
 * standard futures month/year code, so "Brent Nov26" -> "COX26". The latest
 * 1-minute candle's close is the current price.
 *
 * "Structure"-kind contracts (a directly-traded quote such as "Jan26 Fly")
 * have no outright-style code, so their mark is computed from the same
 * authoritative outright closes as sum(ratio x close) over the legs the
 * quote represents — reported with a "(derived)" source so it's visible in
 * the data. Nothing about how P&L is *tracked* changes: the leg is still
 * one unit priced off this single number (spec V4/V5). If QuantHub exposes
 * codes for quoted spreads/flies, only `quoteCodeFor` below needs to change.
 */
export class QuantHubProvider implements MarketDataProvider {
  name = "QuantHub";

  /** Hook for a future vendor code convention for quoted spreads/flies. */
  private quoteCodeFor(_contract: Contract): string | undefined {
    return undefined;
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

    // Every outright contract we need a close for: the requested outrights,
    // plus the legs underlying any requested structure quote.
    const neededOutrights = new Map<UUID, Contract>();
    const derived: { contract: Contract; legs: { contract_id: UUID; ratio: number }[] }[] = [];

    for (const contract of contracts) {
      if (isOutright(contract)) {
        neededOutrights.set(contract.id, contract);
        continue;
      }
      if (this.quoteCodeFor(contract)) {
        neededOutrights.set(contract.id, contract);
        continue;
      }

      const template = contract.quote_template_id ? ref.templates.get(contract.quote_template_id) : undefined;
      const instrumentContracts = ref.contractsByInstrument.get(contract.instrument_id) ?? [];
      if (!template || !contract.anchor_contract_id) continue;

      try {
        const legs = expandToOutrights(template, contract.anchor_contract_id, instrumentContracts.filter(isOutright));
        derived.push({ contract, legs });
        for (const leg of legs) {
          const legContract = instrumentContracts.find((c) => c.id === leg.contract_id);
          if (legContract) neededOutrights.set(legContract.id, legContract);
        }
      } catch {
        // Anchor/offset no longer resolvable (e.g. contract months trimmed) —
        // skip this quote rather than failing the whole refresh.
        continue;
      }
    }

    // Map each outright to its QuantHub code. Several contracts can share a
    // code only if data is duplicated, so keep a list per code.
    const contractIdsByCode = new Map<string, UUID[]>();
    for (const contract of neededOutrights.values()) {
      const instrument = ref.instruments.get(contract.instrument_id);
      if (!instrument) continue;
      const code = isOutright(contract)
        ? toQuantHubCode(quantHubProductCode(instrument), contract.month_label)
        : this.quoteCodeFor(contract);
      if (!code) continue;
      contractIdsByCode.set(code, [...(contractIdsByCode.get(code) ?? []), contract.id]);
    }

    const codes = Array.from(contractIdsByCode.keys());
    if (codes.length === 0) return {};

    // One request per 50 codes, in parallel. A failed batch shouldn't sink
    // the others, but a wholesale failure (auth/network) must surface.
    const batches = await Promise.allSettled(chunk(codes, MAX_INSTRUMENTS_PER_REQUEST).map((batch) => fetchOhlc(batch)));

    const series: Record<string, { price: number; asOf?: number }> = {};
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
        series[code.toUpperCase()] = { price: candle.close, asOf: candle.timestamp };
      }
    }
    if (succeeded === 0 && firstError) {
      throw firstError instanceof QuantHubError
        ? firstError
        : new QuantHubError("network", firstError instanceof Error ? firstError.message : "QuantHub request failed");
    }

    const quotes: Record<UUID, PriceQuote> = {};
    const markByContractId = new Map<UUID, { price: number; asOf?: number }>();
    for (const [code, contractIds] of contractIdsByCode) {
      const mark = series[code.toUpperCase()];
      if (mark === undefined) continue; // unknown instrument or empty series
      for (const id of contractIds) {
        markByContractId.set(id, mark);
        quotes[id] = { price: mark.price, asOf: mark.asOf, source: this.name };
      }
    }

    // Structure quotes: sum(ratio x leg close). Only priced when every leg
    // resolved, so a partial response never produces a misleading mark. The
    // derived mark is only as fresh as its stalest leg.
    for (const { contract, legs } of derived) {
      let value = 0;
      let oldestAsOf: number | undefined;
      let complete = true;
      for (const leg of legs) {
        const mark = markByContractId.get(leg.contract_id);
        if (mark === undefined) {
          complete = false;
          break;
        }
        value += leg.ratio * mark.price;
        if (mark.asOf !== undefined && (oldestAsOf === undefined || mark.asOf < oldestAsOf)) oldestAsOf = mark.asOf;
      }
      if (!complete) continue;
      quotes[contract.id] = {
        price: Math.round(value * 1e6) / 1e6,
        asOf: oldestAsOf,
        source: `${this.name} (derived)`,
      };
    }

    return quotes;
  }
}
