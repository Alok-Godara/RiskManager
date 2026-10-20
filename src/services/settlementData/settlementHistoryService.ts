import type { Contract, Instrument, SettlementPrice, UUID } from "../../types/domain";
import { repository } from "../../data";
import { formatDateParam, previousTradingDay, tradingDaysIncluding } from "../../utils/tradingDays";
import { fetchSettlementPrices, settlementKey } from "./client";

/** The settlement API's product symbol for an instrument — `refdata_symbol` when set (Settings -> Instruments), else `symbol`. Same override pattern as quantHub/symbols.ts's exchange_code, for the same reason: not every instrument's own symbol matches the vendor's. */
function refdataSymbolFor(instrument: Instrument): string {
  return (instrument.refdata_symbol?.trim() || instrument.symbol).trim().toUpperCase();
}

/**
 * A spread product the settlement feed does not carry can be defined from two
 * products that it does: a refdata symbol written "A-B" (e.g. "CL-BRN" for the
 * WTI-Brent spread) means settlement = A's price minus B's price for the same
 * delivery month. Undefined for an ordinary symbol.
 */
export function parseSpreadFormula(refdataSymbol: string): { minuend: string; subtrahend: string } | undefined {
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(refdataSymbol.trim().toUpperCase());
  return match ? { minuend: match[1], subtrahend: match[2] } : undefined;
}

/**
 * SettlementHistoryService: keeps `settlement_prices` topped up with
 * however many trading days of history the correlation engine needs, for
 * whatever outright contracts are currently in use. Idempotent and
 * incremental — only fetches when at least one (contract, date) pair is
 * actually missing, so re-running this after the first time is cheap:
 * typically just "is today's settlement out yet." Also prunes rows older
 * than the window on every call, so the table stays bounded to what
 * correlation actually uses instead of growing by a day's worth of rows
 * forever.
 *
 * ONE request covers the whole gap: `date` on the settlement API is a range
 * start, not an exact-day filter — requesting the EARLIEST missing trading
 * day returns every trading day from there through the most recent one
 * available in a single response (confirmed live, see client.ts's header
 * comment). So a cold cache needing all HISTORY_TRADING_DAYS (31) days back
 * is one HTTP round trip, not 31 — each returned row is stamped with its
 * own trade date, which is what gets written, never the date that was
 * requested (an earlier version of this file assumed one day per request
 * and stamped every row with the requested date, silently duplicating the
 * same handful of prices across every date it asked for).
 *
 * The endpoint returns the ENTIRE market (every exchange, every product,
 * tens of thousands of rows for a full range) — `fetchSettlementPrices` is
 * given the exact set of product symbols this call needs (`refdataSymbolFor`
 * per instrument) so everything else is dropped while parsing rather than
 * held onto for nothing.
 *
 * Matches settlements by `${date}::${symbol}::${month_label}` (see
 * client.ts's settlementKey) — confirmed against a real response to be a
 * DIFFERENT product-code convention than QuantHub's (Brent is "CO" on
 * QuantHub but "BRN" here), so this never reuses services/quantHub/symbols.ts.
 */
/**
 * Settlement prices are published once a day, yet every correlation/VaR
 * computation used to download the whole stored history (~1 MB) twice — once to
 * see what was missing, once to use it — each time any open page recomputed.
 * That is pure waste against the free database's egress limit, so both are
 * cached for this long; a new day's settlement is picked up within it.
 */
const SETTLEMENT_CACHE_MS = 30 * 60_000;

export class SettlementHistoryService {
  private static cache = new Map<string, { at: number; rows: SettlementPrice[] }>();
  private static lastEnsured = new Map<string, number>();

  private static key(ids: UUID[]): string {
    return [...ids].sort().join(",");
  }

  /** Stored settlement rows for these contracts, served from memory for SETTLEMENT_CACHE_MS. */
  static async getSettlements(contractIds: UUID[]): Promise<SettlementPrice[]> {
    if (contractIds.length === 0) return [];
    const key = this.key(contractIds);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SETTLEMENT_CACHE_MS) return hit.rows;
    const rows = await repository.getSettlementPricesByContracts(contractIds);
    this.cache.set(key, { at: Date.now(), rows });
    return rows;
  }

  /**
   * Ensures at least `days` trading days of settlement history exist for
   * `contracts` (outrights only — callers should already have decomposed
   * any structure-quote legs). Best-effort: if the single range fetch
   * fails, this is skipped for now rather than throwing, so a temporarily
   * unavailable API degrades to "fewer observations," not "no correlation
   * data at all."
   */
  static async ensureHistory(contracts: Contract[], instruments: Map<UUID, Instrument>, days: number): Promise<void> {
    const outrights = contracts.filter((c) => !c.kind || c.kind === "Outright");
    if (outrights.length === 0) return;

    // Checked recently for this exact set of contracts? Then nothing new can
    // have been published — skip the read, the fetch and the prune entirely.
    const ensureKey = `${days}:${this.key(outrights.map((c) => c.id))}`;
    const lastEnsured = this.lastEnsured.get(ensureKey);
    if (lastEnsured !== undefined && Date.now() - lastEnsured < SETTLEMENT_CACHE_MS) return;

    const mostRecent = previousTradingDay(new Date());
    const dates = tradingDaysIncluding(mostRecent, days); // oldest..newest
    const dateStrs = dates.map(formatDateParam);
    const oldestNeeded = dateStrs[0];

    const existing = await this.getSettlements(outrights.map((c) => c.id));
    const haveKey = new Set(existing.map((s) => `${s.contract_id}::${s.date}`));

    const missingDates = dateStrs.filter((dateStr) => outrights.some((c) => !haveKey.has(`${c.id}::${dateStr}`)));
    if (missingDates.length > 0) {
      // A spread formula ("CL-BRN") needs both of its products fetched, not itself.
      const allowedSymbols = new Set<string>();
      for (const instrument of outrights.map((c) => instruments.get(c.instrument_id))) {
        if (!instrument) continue;
        const symbol = refdataSymbolFor(instrument);
        const formula = parseSpreadFormula(symbol);
        if (formula) {
          allowedSymbols.add(formula.minuend);
          allowedSymbols.add(formula.subtrahend);
        } else {
          allowedSymbols.add(symbol);
        }
      }

      let settlementsByKey: Record<string, number>;
      try {
        settlementsByKey = await fetchSettlementPrices(missingDates[0], allowedSymbols);
      } catch (err) {
        console.warn("SettlementHistoryService: range fetch failed:", err);
        settlementsByKey = {};
      }

      if (Object.keys(settlementsByKey).length > 0) {
        const now = new Date().toISOString();
        const records: SettlementPrice[] = [];
        for (const dateStr of missingDates) {
          for (const contract of outrights) {
            if (haveKey.has(`${contract.id}::${dateStr}`)) continue;
            const instrument = instruments.get(contract.instrument_id);
            if (!instrument) continue;
            const symbol = refdataSymbolFor(instrument);
            const formula = parseSpreadFormula(symbol);
            let price: number | undefined;
            if (formula) {
              const a = settlementsByKey[settlementKey(dateStr, formula.minuend, contract.month_label)];
              const b = settlementsByKey[settlementKey(dateStr, formula.subtrahend, contract.month_label)];
              if (a !== undefined && b !== undefined) price = a - b;
            } else {
              price = settlementsByKey[settlementKey(dateStr, symbol, contract.month_label)];
            }
            if (price === undefined) continue;

            records.push({
              id: `${contract.id}::${dateStr}`,
              contract_id: contract.id,
              date: dateStr,
              price,
              source: "RefDataAPI",
              created_at: now,
            });
          }
        }
        if (records.length > 0) {
          await repository.upsertSettlementPrices(records);
          this.cache.clear(); // new rows stored — the next read must see them
        }
      }
    }
    this.lastEnsured.set(ensureKey, Date.now());

    try {
      await repository.deleteSettlementPricesBefore(oldestNeeded);
    } catch (err) {
      console.warn("SettlementHistoryService: prune failed:", err);
    }
  }
}
