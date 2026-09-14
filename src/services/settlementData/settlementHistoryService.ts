import type { Contract, Instrument, SettlementPrice, UUID } from "../../types/domain";
import { repository } from "../../data";
import { quantHubProductCode, toQuantHubCode } from "../quantHub/symbols";
import { formatDateParam, previousTradingDay, tradingDaysIncluding } from "../../utils/tradingDays";
import { fetchSettlementPrices } from "./client";

/**
 * SettlementHistoryService: keeps `settlement_prices` topped up with
 * however many trading days of history the correlation engine needs, for
 * whatever outright contracts are currently in use. Idempotent and
 * incremental — only fetches (contract, date) pairs actually missing, one
 * API call per missing DATE (the endpoint returns every instrument's
 * settlement for one date in a single response), so re-running this after
 * the first time is cheap: typically just "is today's settlement out yet."
 *
 * Reuses the same product-code convention as QuantHub
 * (services/quantHub/symbols.ts) to build the instrument codes requested —
 * an assumption, not a confirmed fact about this endpoint (see
 * client.ts's header comment). If settlements come back empty, this is the
 * first thing to check against a real response.
 */
export class SettlementHistoryService {
  /**
   * Ensures at least `days` trading days of settlement history exist for
   * `contracts` (outrights only — callers should already have decomposed
   * any structure-quote legs). Best-effort per date: a date that fails to
   * fetch is skipped rather than aborting the whole backfill, so a
   * temporarily-unavailable API degrades to "fewer observations," not "no
   * correlation data at all."
   */
  static async ensureHistory(contracts: Contract[], instruments: Map<UUID, Instrument>, days: number): Promise<void> {
    const outrights = contracts.filter((c) => !c.kind || c.kind === "Outright");
    if (outrights.length === 0) return;

    const mostRecent = previousTradingDay(new Date());
    const dates = tradingDaysIncluding(mostRecent, days);
    const dateStrs = dates.map(formatDateParam);

    const existing = await repository.getSettlementPricesByContracts(outrights.map((c) => c.id));
    const haveKey = new Set(existing.map((s) => `${s.contract_id}::${s.date}`));

    const missingDates = dateStrs.filter((dateStr) => outrights.some((c) => !haveKey.has(`${c.id}::${dateStr}`)));
    if (missingDates.length === 0) return;

    for (const dateStr of missingDates) {
      let settlementsByCode: Record<string, number>;
      try {
        settlementsByCode = await fetchSettlementPrices(dateStr);
      } catch (err) {
        console.warn(`SettlementHistoryService: fetch failed for ${dateStr}:`, err);
        continue;
      }
      if (Object.keys(settlementsByCode).length === 0) continue;

      const now = new Date().toISOString();
      for (const contract of outrights) {
        if (haveKey.has(`${contract.id}::${dateStr}`)) continue;
        const instrument = instruments.get(contract.instrument_id);
        if (!instrument) continue;
        const code = toQuantHubCode(quantHubProductCode(instrument), contract.month_label);
        if (!code) continue;
        const price = settlementsByCode[code.toUpperCase()];
        if (price === undefined) continue;

        const record: SettlementPrice = {
          id: `${contract.id}::${dateStr}`,
          contract_id: contract.id,
          date: dateStr,
          price,
          source: "RefDataAPI",
          created_at: now,
        };
        await repository.upsertSettlementPrice(record);
        haveKey.add(record.id);
      }
    }
  }
}
