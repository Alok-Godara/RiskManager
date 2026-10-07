import type { Contract, Execution, Instrument, StructureTemplate, UUID } from "../types/domain";

/**
 * Default exchange transaction cost, $ per OUTRIGHT lot per ROUND TURN, by
 * instrument symbol — taken from the TC & Rebate schedule's "Outrights" row
 * (its Spread / Fly / D-Fly rows are exactly 2x / 4x / 8x of this, because the
 * exchange charges per outright). Rebates are deliberately NOT modelled.
 * Used only when an instrument has no `tc_per_outright_rt` of its own; edit
 * the live value in Settings -> Instruments.
 */
export const DEFAULT_TC_PER_OUTRIGHT_RT: Record<string, number> = {
  CL: 1.78,
  BZ: 1.78,
  BRN: 1.9,
  WBS: 2.04,
  GO: 2.1,
};

/**
 * TransactionCostEngine: exchange transaction costs for executions.
 *
 * Rule: a fill costs  quantity x outrights-per-lot x (round-turn rate / 2).
 * Every active execution (entry OR exit) is one side, so a lot pays half the
 * round-turn rate when it is entered and the other half when it is exited —
 * a position still open has paid its entry half already.
 *
 * "Outrights per lot" for a leg is how many outright contract-lots one lot of
 * it trades: 1 for an outright month; for a Structure-kind quote (e.g. a
 * Spread / Fly contract traded as one product) the sum of |ratio| of its
 * template's legs (Spread 2, Fly 1+2+1 = 4, D-Fly 1+3+3+1 = 8). Legs are NOT
 * netted against each other, since each outright is charged separately.
 */
export class TransactionCostEngine {
  /** $ per outright lot per round turn for this instrument (0 = no rate known). */
  static ratePerOutrightRT(instrument: Instrument | undefined): number {
    if (!instrument) return 0;
    if (instrument.tc_per_outright_rt !== undefined && instrument.tc_per_outright_rt !== null) {
      return instrument.tc_per_outright_rt;
    }
    return DEFAULT_TC_PER_OUTRIGHT_RT[instrument.symbol.trim().toUpperCase()] ?? 0;
  }

  /** How many outright lots one lot of this contract trades. */
  static outrightsPerLot(contract: Contract | undefined, templatesById: Map<UUID, StructureTemplate>): number {
    if (!contract || !contract.kind || contract.kind === "Outright") return 1;
    const template = contract.quote_template_id ? templatesById.get(contract.quote_template_id) : undefined;
    if (!template) return 1;
    const total = template.legs.reduce((sum, l) => sum + Math.abs(l.ratio), 0);
    return total > 0 ? total : 1;
  }

  /** TC for one execution (one side): qty x outrights/lot x half the RT rate, in $. */
  static executionCost(
    execution: Execution,
    contract: Contract | undefined,
    instrument: Instrument | undefined,
    templatesById: Map<UUID, StructureTemplate>
  ): number {
    if ((execution.status ?? "Active") !== "Active") return 0;
    const halfRate = this.ratePerOutrightRT(instrument) / 2;
    return execution.quantity * this.outrightsPerLot(contract, templatesById) * halfRate;
  }

  /** Total TC for a leg's executions. The leg's own contract's instrument sets the rate (so inter-product legs each pay their own product's rate). */
  static legCost(
    executions: Execution[],
    contract: Contract | undefined,
    instrument: Instrument | undefined,
    templatesById: Map<UUID, StructureTemplate>
  ): number {
    return executions.reduce((sum, e) => sum + this.executionCost(e, contract, instrument, templatesById), 0);
  }
}
