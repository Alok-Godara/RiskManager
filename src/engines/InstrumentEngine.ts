import type { InstrumentNetPositionRow, StructureTemplate, UUID } from "../types/domain";
import { repository } from "../data";
import { expandToOutrights } from "../utils/templateExpansion";

/**
 * InstrumentEngine: aggregates true contract-level exposure across every
 * open structure for a given instrument (spec section 5). Positions are
 * tracked at whatever level was actually traded (an outright, or a
 * structure-level quote like "Jan26 Fly" — see StructureQuoteEngine), so
 * this is the ONE place that decomposes structure-quote legs back down to
 * outright months, purely for this "true exposure" view — never for
 * pricing or P&L, which stay at the traded level.
 */
export class InstrumentEngine {
  static async netPositionByInstrument(instrumentId: UUID): Promise<InstrumentNetPositionRow[]> {
    const contracts = await repository.getContractsByInstrument(instrumentId);
    const outrightContracts = contracts.filter((c) => !c.kind || c.kind === "Outright");
    const legs = await repository.getAllLegs();
    const structures = await repository.getStructures();
    const openStructureIds = new Set(structures.filter((s) => s.status !== "Fully Closed").map((s) => s.id));

    const rows = new Map<UUID, InstrumentNetPositionRow>();
    for (const contract of outrightContracts) {
      rows.set(contract.id, {
        contract_id: contract.id,
        contract_label: contract.month_label,
        long_lots: 0,
        short_lots: 0,
        net_lots: 0,
      });
    }

    let templatesById: Map<UUID, StructureTemplate> | null = null;

    function addExposure(contractId: UUID, qty: number) {
      const row = rows.get(contractId);
      if (!row || qty === 0) return;
      if (qty > 0) row.long_lots += qty;
      else row.short_lots += Math.abs(qty);
      row.net_lots = row.long_lots - row.short_lots;
    }

    for (const leg of legs) {
      if (!leg.is_active) continue;
      if (!openStructureIds.has(leg.structure_id)) continue;
      const contract = contracts.find((c) => c.id === leg.contract_id);
      if (!contract || contract.instrument_id !== instrumentId) continue;

      const position = await repository.getPositionByLeg(leg.id);
      const qty = position?.net_quantity ?? 0;
      if (qty === 0) continue;

      if (!contract.kind || contract.kind === "Outright") {
        addExposure(contract.id, qty);
        continue;
      }

      // Structure-quote leg: decompose to outrights for exposure purposes only.
      if (!contract.quote_template_id || !contract.anchor_contract_id) continue;
      if (!templatesById) {
        const templates = await repository.getStructureTemplates();
        templatesById = new Map(templates.map((t) => [t.id, t]));
      }
      const template = templatesById.get(contract.quote_template_id);
      if (!template) continue;
      try {
        const decomposed = expandToOutrights(template, contract.anchor_contract_id, contracts);
        for (const o of decomposed) addExposure(o.contract_id, o.ratio * qty);
      } catch {
        // Anchor's contract window no longer covers this quote's span — skip rather than crash the dashboard.
      }
    }

    return Array.from(rows.values()).sort((a, b) => a.contract_label.localeCompare(b.contract_label));
  }
}
