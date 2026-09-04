import { v4 as uuid } from "uuid";
import type { Contract, Instrument, StructureTemplate, UUID } from "../types/domain";
import { repository } from "../data";
import { contractAtOffset } from "../utils/templateExpansion";
import { deconvolve } from "../utils/decompose";
import { sortContractsChronologically } from "../utils/contractGen";

export interface ResolvedLeg {
  contract_id: UUID;
  ratio: number;
}

function isTrivialOutright(template: StructureTemplate): boolean {
  return template.legs.length === 1 && template.legs[0].ratio === 1 && template.legs[0].month_offset === 0;
}

function buildQuoteCode(instrument: Instrument, template: StructureTemplate, anchor: Contract): string {
  const suffix = (template.code ?? template.name).toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return `${instrument.symbol}-${suffix}-${anchor.month_label.toUpperCase()}`;
}

/**
 * StructureQuoteEngine: resolves what a structure's legs actually ARE at
 * creation time. A structure template (e.g. Double Fly = +1/-3/+3/-1) is a
 * FIXED target ratio pattern; the trader separately chooses a "base
 * structure" (Outright / Spread / Fly / ...) at creation time — how it's
 * actually constructed and traded (spec V5). The target pattern is
 * deconvolved into shifted, weighted copies of the base structure's own
 * pattern (utils/decompose.ts); each copy becomes one leg, priced off its
 * own live quote — tracking the trade at the level actually executed,
 * never auto-decomposed to outrights (spec V4).
 *
 * A "Structure"-kind Contract (e.g. "Jan26 Fly") is auto-created the first
 * time a given base-template+anchor combination trades, and reused after —
 * two different structures both trading "the Feb26 Fly" share the same
 * live-priced quote.
 */
export class StructureQuoteEngine {
  /** Find or create the single quoted Contract representing 1 unit of `template` anchored at `anchorContractId`. */
  static async resolveAsOneUnit(
    template: StructureTemplate,
    anchorContractId: UUID,
    instrument: Instrument,
    instrumentContracts: Contract[]
  ): Promise<Contract> {
    const chronological = sortContractsChronologically(instrumentContracts.filter((c) => !c.kind || c.kind === "Outright"));

    if (isTrivialOutright(template)) {
      return contractAtOffset(chronological, anchorContractId, 0);
    }

    const existing = instrumentContracts.find(
      (c) => c.kind === "Structure" && c.quote_template_id === template.id && c.anchor_contract_id === anchorContractId
    );
    if (existing) return existing;

    const anchor = contractAtOffset(chronological, anchorContractId, 0);
    const code = buildQuoteCode(instrument, template, anchor);
    const created: Contract = {
      id: uuid(),
      instrument_id: instrument.id,
      code,
      month_label: `${anchor.month_label} ${template.name}`,
      expiry_date: anchor.expiry_date,
      market_data_symbol: code,
      created_at: new Date().toISOString(),
      kind: "Structure",
      quote_template_id: template.id,
      anchor_contract_id: anchorContractId,
    };
    await repository.upsertContract(created);
    return created;
  }

  /**
   * Resolves the legs for a structure being created: `targetTemplate`
   * (the desired shape, e.g. Double Fly) constructed from `baseTemplate`
   * (e.g. Fly), anchored at `anchorContractId`, in the given `direction`
   * (+1 Long, -1 Short — flips every leg's sign).
   */
  static async buildLegsForStructure(
    targetTemplate: StructureTemplate,
    baseTemplate: StructureTemplate,
    anchorContractId: UUID,
    instrument: Instrument,
    direction: 1 | -1 = 1
  ): Promise<ResolvedLeg[]> {
    const units = deconvolve(targetTemplate.legs, baseTemplate.legs, baseTemplate.name);
    let contracts = await repository.getContractsByInstrument(instrument.id);
    const chronological = sortContractsChronologically(contracts.filter((c) => !c.kind || c.kind === "Outright"));

    const legs: ResolvedLeg[] = [];
    for (const unit of units) {
      const unitAnchor = contractAtOffset(chronological, anchorContractId, unit.offset);
      const quote = await this.resolveAsOneUnit(baseTemplate, unitAnchor.id, instrument, contracts);
      if (!contracts.some((c) => c.id === quote.id)) contracts = [...contracts, quote];
      legs.push({ contract_id: quote.id, ratio: unit.weight * direction });
    }
    return legs;
  }
}
