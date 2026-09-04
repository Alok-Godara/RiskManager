import type { InstrumentNetPositionRow, UUID } from "../types/domain";
import { repository } from "../data";

/**
 * InstrumentEngine: aggregates true contract-level exposure across every
 * open structure for a given instrument (spec section 5). This is what
 * lets the user see "my real Brent Feb exposure" even though trades are
 * managed as structures/spreads/flies.
 */
export class InstrumentEngine {
  static async netPositionByInstrument(instrumentId: UUID): Promise<InstrumentNetPositionRow[]> {
    const contracts = await repository.getContractsByInstrument(instrumentId);
    const legs = await repository.getAllLegs();
    const structures = await repository.getStructures();
    const openStructureIds = new Set(
      structures.filter((s) => s.status !== "Fully Closed").map((s) => s.id)
    );

    const rows = new Map<UUID, InstrumentNetPositionRow>();
    for (const contract of contracts) {
      rows.set(contract.id, {
        contract_id: contract.id,
        contract_label: contract.month_label,
        long_lots: 0,
        short_lots: 0,
        net_lots: 0,
      });
    }

    for (const leg of legs) {
      if (!leg.is_active) continue;
      if (!openStructureIds.has(leg.structure_id)) continue;
      const row = rows.get(leg.contract_id);
      if (!row) continue;
      const position = await repository.getPositionByLeg(leg.id);
      const qty = position?.net_quantity ?? 0;
      if (qty > 0) row.long_lots += qty;
      else if (qty < 0) row.short_lots += Math.abs(qty);
      row.net_lots = row.long_lots - row.short_lots;
    }

    return Array.from(rows.values()).sort((a, b) => a.contract_label.localeCompare(b.contract_label));
  }
}
