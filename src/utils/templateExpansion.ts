import type { Contract, StructureTemplate, UUID } from "../types/domain";
import { sortContractsChronologically } from "./contractGen";
import { deconvolve } from "./decompose";

export interface OutrightLeg {
  contract_id: UUID;
  ratio: number; // per 1 unit of the template passed in
}

/** Find the contract `offset` months from `anchorId` in a chronologically-sorted list. */
export function contractAtOffset(chronological: Contract[], anchorId: UUID, offset: number): Contract {
  const anchorIdx = chronological.findIndex((c) => c.id === anchorId);
  if (anchorIdx === -1) throw new Error("Anchor contract not found among this instrument's contracts");
  const contract = chronological[anchorIdx + offset];
  if (!contract) {
    throw new Error(
      `No contract ${offset} month(s) from the anchor — extend this instrument's contract months in Settings.`
    );
  }
  return contract;
}

/**
 * Expands a template's own (fixed) outright ratio pattern into concrete
 * contracts, given an anchor. Templates no longer nest, so this is a
 * direct 1:1 mapping — used for the true contract-exposure view
 * (InstrumentEngine) to decompose a structure-level quote (e.g. "Jan26
 * Fly") back to its outright months, and NOT for pricing/P&L, which track
 * whatever level was actually traded (spec V4/V5).
 *
 * Filters `allContracts` down to outrights before sorting/walking offsets,
 * regardless of what the caller passes — a "Structure"-kind contract (e.g.
 * a Calendar Spread quote) shares its anchor's own expiry_date, so mixed
 * into the list, that tie makes chronological sort order (and therefore
 * which contract an offset lands on) effectively arbitrary, silently
 * resolving to another quote contract instead of the intended outright
 * month. This exact bug hit two different call sites (CorrelationEngine,
 * InstrumentEngine) before both pre-filtered defensively; filtering here
 * too means a future caller can't reintroduce it by forgetting to.
 */
export function expandToOutrights(template: StructureTemplate, anchorContractId: UUID, allContracts: Contract[]): OutrightLeg[] {
  const outrightsOnly = allContracts.filter((c) => !c.kind || c.kind === "Outright");
  const chronological = sortContractsChronologically(outrightsOnly);
  return template.legs.map((leg) => {
    const contract = contractAtOffset(chronological, anchorContractId, leg.month_offset);
    return { contract_id: contract.id, ratio: leg.ratio };
  });
}

/** Human-readable preview of a template's leg ratios, e.g. "+1 / -2 / +1". */
export function templateRatioString(template: StructureTemplate): string {
  return template.legs.map((l) => (l.ratio >= 0 ? `+${l.ratio}` : `${l.ratio}`)).join(" / ");
}

function isTrivialOutright(template: StructureTemplate): boolean {
  return template.legs.length === 1 && template.legs[0].ratio === 1 && template.legs[0].month_offset === 0;
}

export interface PreviewLeg {
  label: string;
  ratio: number;
  willCreateQuote: boolean; // true if no matching "Structure" Contract exists yet
}

/**
 * Pure, read-only preview of how `targetTemplate` (e.g. Double Fly) would
 * be constructed from `baseTemplate` (e.g. Fly, Spread, or Outright)
 * anchored at `anchorContractId` — deconvolving the target pattern into
 * shifted, weighted copies of the base pattern (spec V5). One entry per
 * nonzero weight. Throws (surfaced by the caller) if the base structure
 * can't exactly construct the target.
 */
export function previewLegs(
  targetTemplate: StructureTemplate,
  baseTemplate: StructureTemplate,
  anchorContractId: UUID,
  contracts: Contract[],
  direction: 1 | -1 = 1
): PreviewLeg[] {
  const chronological = sortContractsChronologically(contracts.filter((c) => !c.kind || c.kind === "Outright"));
  const units = deconvolve(targetTemplate.legs, baseTemplate.legs, baseTemplate.name);

  return units.map(({ weight, offset }) => {
    const legAnchor = contractAtOffset(chronological, anchorContractId, offset);
    if (isTrivialOutright(baseTemplate)) {
      return { label: legAnchor.month_label, ratio: weight * direction, willCreateQuote: false };
    }
    const existing = contracts.find(
      (c) => c.kind === "Structure" && c.quote_template_id === baseTemplate.id && c.anchor_contract_id === legAnchor.id
    );
    if (existing) return { label: existing.month_label, ratio: weight * direction, willCreateQuote: false };
    return { label: `${legAnchor.month_label} ${baseTemplate.name}`, ratio: weight * direction, willCreateQuote: true };
  });
}
