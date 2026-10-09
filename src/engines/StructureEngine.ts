import { v4 as uuid } from "uuid";
import type {
  Structure,
  StructureLeg,
  LegSide,
  Execution,
  AuditEvent,
  RealizedPnLEvent,
  UUID,
} from "../types/domain";
import { repository } from "../data";
import { PositionEngine } from "./PositionEngine";
import { RiskEngine } from "./RiskEngine";

export interface NewLegInput {
  // The tradeable unit this leg represents — an outright Contract or a
  // "Structure" quote Contract (see StructureQuoteEngine). Never further
  // decomposed; ratio is relative to 1 lot of the top-level structure.
  contract_id: UUID;
  ratio: number; // signed: e.g. +1, -2, +1 for a fly. Side is derived from the sign.
}

export interface NewStructureInput {
  instrument_id: UUID;
  structure_template_id?: UUID;
  name: string;
  structure_type: string;
  initial_dollar_risk: number;
  initial_stop_loss?: number;
  notes?: string;
  legs: NewLegInput[];
}

export interface NewEntryInput {
  structure_id: UUID;
  structure_leg_id: UUID;
  quantity: number; // always positive
  price: number;
  // This entry's own chosen direction (Long = 1, Short = -1) — combined
  // with the leg's fixed template ratio sign to get execution.side. A
  // structure has no direction of its own any more; every entry picks its
  // own (spec: "a structure is simply a structure").
  direction: 1 | -1;
  // Explicit Long/Short for THIS leg, overriding direction x leg ratio — used
  // when a leg's side is set individually (single-leg or custom entries).
  side?: LegSide;
  risk_allocated?: number;
  max_adverse_ticks?: number;
  notes?: string;
  // Shared across every leg's Execution created by the same Add Entry
  // submission — see Execution.entry_group_id / engines/EntryEngine.ts.
  entry_group_id: UUID;
}

export interface ExitInput {
  structure_leg_id: UUID;
  structure_id: UUID;
  quantity: number;
  price: number;
  execution_type?: "PartialExit" | "LegExit" | "FinalExit";
  notes?: string;
  // Which entry (its entry_group_id) this exit is closing — exits are
  // entry-scoped now, never a generic "close whatever's oldest on this leg."
  closes_entry_group_id: UUID;
  // Shared across every leg's Execution created by the same Exit submission
  // (distinct from closes_entry_group_id above — this is the EXIT's own
  // batch id, not the entry being closed).
  entry_group_id: UUID;
}

export interface EditExecutionInput {
  execution_id: UUID;
  structure_id: UUID;
  structure_leg_id?: UUID; // set to move the execution to a different leg ("wrong contract")
  quantity?: number;
  price?: number;
  risk_allocated?: number; // pass to change; omit to leave the original's value unchanged
  timestamp?: string;
  notes?: string;
  reason?: string;
}

export interface DeleteExecutionInput {
  execution_id: UUID;
  structure_id: UUID;
  reason?: string;
}

/** +1 = Long, -2 = Short 2, etc. — the single source of truth for direction. */
function sideFromRatio(ratio: number): "Long" | "Short" {
  return ratio >= 0 ? "Long" : "Short";
}

/**
 * StructureEngine: the orchestrator for the trading hierarchy
 * (Instrument -> Structure -> Legs -> Executions). It is the only engine
 * that writes Structures/Legs/Executions; PositionEngine and RiskEngine
 * are invoked from here to keep derived state in sync, and every
 * mutation writes an AuditEvent (spec section 13 — never overwrite
 * history).
 */
const ROMAN: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

/** 2 -> "II", 4 -> "IV", 14 -> "XIV". */
function toRoman(n: number): string {
  let out = "";
  let rest = n;
  for (const [value, symbol] of ROMAN) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

/** A copy number written as digits ("3") or as a canonical Roman numeral ("III"); undefined for anything else. */
function copyNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  let rest = text;
  let total = 0;
  for (const [value, symbol] of ROMAN) {
    while (rest.startsWith(symbol)) {
      total += value;
      rest = rest.slice(symbol.length);
    }
  }
  return rest === "" && total > 0 && toRoman(total) === text ? total : undefined;
}

export class StructureEngine {
  private static async audit(event: Omit<AuditEvent, "id" | "timestamp">) {
    const full: AuditEvent = { ...event, id: uuid(), timestamp: new Date().toISOString() };
    await repository.addAuditEvent(full);
  }

  /** $ per 1 unit price move for a contract's instrument — same tick_value/tick_size conversion PnLEngine.unrealizedPnl uses, now also applied to realized P&L (see PositionEngine). Falls back to 1 (raw price difference) if the instrument can't be resolved, rather than throwing mid-recompute. */
  private static async dollarPerPriceUnitForContract(contractId: UUID): Promise<number> {
    const contract = await repository.getContract(contractId);
    const instrument = contract ? await repository.getInstrument(contract.instrument_id) : undefined;
    return instrument ? instrument.tick_value / instrument.tick_size : 1;
  }

  static async createStructure(input: NewStructureInput): Promise<Structure> {
    const structure: Structure = {
      id: uuid(),
      instrument_id: input.instrument_id,
      structure_template_id: input.structure_template_id,
      name: input.name,
      structure_type: input.structure_type,
      status: "Open",
      initial_dollar_risk: input.initial_dollar_risk,
      current_dollar_risk: input.initial_dollar_risk,
      initial_stop_loss: input.initial_stop_loss,
      current_stop_loss: input.initial_stop_loss,
      notes: input.notes,
      created_at: new Date().toISOString(),
    };
    await repository.upsertStructure(structure);

    for (const legInput of input.legs) {
      const leg: StructureLeg = {
        id: uuid(),
        structure_id: structure.id,
        contract_id: legInput.contract_id,
        ratio: legInput.ratio,
        side: sideFromRatio(legInput.ratio),
        is_active: true,
        created_at: new Date().toISOString(),
      };
      await repository.upsertLeg(leg);
    }

    await this.audit({
      event_type: "StructureCreated",
      structure_id: structure.id,
      description: `Structure "${structure.name}" created with ${input.legs.length} leg(s)`,
      payload: { structure_type: structure.structure_type, initial_dollar_risk: structure.initial_dollar_risk },
    });

    return structure;
  }

  /**
   * The name for the next copy of `baseName`: "Name-II", then "Name-III",
   * "Name-IV", ... — one more than the highest copy number already in use.
   * Copying "Name-II" counts as copying "Name" (only when a trade called "Name"
   * really exists, so a name that merely ends in a dash and a number, like
   * "Jan-27", is left alone). Older copies numbered with digits ("Name-2") are
   * recognised too, so numbering carries on from them.
   */
  static nextCloneName(baseName: string, existingNames: string[]): string {
    const names = new Set(existingNames);
    const suffixed = /^(.*)-(\d+|[IVXLCDM]+)$/.exec(baseName);
    const base = suffixed && names.has(suffixed[1]) && copyNumber(suffixed[2]) !== undefined ? suffixed[1] : baseName;
    let highest = 1;
    for (const n of names) {
      if (!n.startsWith(base + "-")) continue;
      const num = copyNumber(n.slice(base.length + 1));
      if (num !== undefined) highest = Math.max(highest, num);
    }
    return `${base}-${toRoman(highest + 1)}`;
  }

  /**
   * Copies a trade's DEFINITION (instrument, template, legs, initial risk,
   * stop-loss, notes) into a brand-new, empty, Open trade — no entries,
   * exits, P&L or risk allocations come along. Named "Name-2", "Name-3", ...
   */
  static async cloneStructure(structureId: UUID): Promise<Structure> {
    const source = await repository.getStructure(structureId);
    if (!source) throw new Error("Trade not found");
    const [legs, all] = await Promise.all([repository.getLegsByStructure(structureId), repository.getStructures()]);
    return this.createStructure({
      instrument_id: source.instrument_id,
      structure_template_id: source.structure_template_id,
      name: this.nextCloneName(source.name, all.map((s) => s.name)),
      structure_type: source.structure_type,
      initial_dollar_risk: source.initial_dollar_risk,
      initial_stop_loss: source.initial_stop_loss,
      notes: source.notes,
      legs: legs.map((l) => ({ contract_id: l.contract_id, ratio: l.ratio })),
    });
  }

  /** Rename a structure. A structure's shape/legs never change here — only its display name. */
  static async renameStructure(structureId: UUID, newName: string): Promise<Structure> {
    const structure = await repository.getStructure(structureId);
    if (!structure) throw new Error("Structure not found");
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("Name cannot be empty");
    if (trimmed === structure.name) return structure;

    const updated: Structure = { ...structure, name: trimmed };
    await repository.upsertStructure(updated);
    await this.audit({
      event_type: "StructureModified",
      structure_id: structureId,
      description: `Renamed from "${structure.name}" to "${trimmed}"`,
    });
    return updated;
  }

  /**
   * Change a structure's Initial Risk (the "possible/willing risk" budget
   * set at creation, per spec — see StructureDetail's Initial Risk /
   * Active Risk / Unallocated Risk breakdown). `current_dollar_risk` is
   * recomputed from the new initial risk + realized P&L to date, the same
   * formula recomputeLegFull/RiskEngine.syncStructureRisk already use, so
   * it never drifts out of sync with the field it's derived from.
   */
  static async updateInitialRisk(structureId: UUID, newInitialRisk: number): Promise<Structure> {
    const structure = await repository.getStructure(structureId);
    if (!structure) throw new Error("Structure not found");
    if (!Number.isFinite(newInitialRisk) || newInitialRisk < 0) throw new Error("Risk must be zero or greater");
    if (newInitialRisk === structure.initial_dollar_risk) return structure;

    const legs = await repository.getLegsByStructure(structureId);
    let totalRealized = 0;
    for (const l of legs) {
      const pos = await repository.getPositionByLeg(l.id);
      totalRealized += pos?.realized_pnl ?? 0;
    }

    const updated: Structure = {
      ...structure,
      initial_dollar_risk: newInitialRisk,
      current_dollar_risk: RiskEngine.computeAdjustedRisk(newInitialRisk, totalRealized),
    };
    await repository.upsertStructure(updated);
    await this.audit({
      event_type: "RiskModified",
      structure_id: structureId,
      description: `Initial risk changed from ${structure.initial_dollar_risk} to ${newInitialRisk}`,
    });
    return updated;
  }

  /**
   * Permanently delete a structure and everything under it (legs,
   * executions, positions, realized P&L, risk allocations, stop loss
   * history) — irreversible, unlike exit/delete-execution which keep full
   * history. The audit event is written BEFORE the delete so it's a real
   * row the repository can point at; the structure's own audit trail is
   * orphaned (structure_id cleared) rather than deleted, so "X was deleted"
   * stays in the log.
   */
  static async deleteStructure(structureId: UUID): Promise<void> {
    const structure = await repository.getStructure(structureId);
    if (!structure) throw new Error("Structure not found");

    await this.audit({
      event_type: "StructureDeleted",
      structure_id: structureId,
      description: `Structure "${structure.name}" deleted`,
    });
    await repository.deleteStructure(structureId);
  }

  /**
   * Fully recompute a leg's Position + Realized P&L events from its
   * `Active` execution history, then cascade structure-level risk and
   * status. This is the single source of truth used after ANY execution
   * change (add / exit / edit / delete) so position and realized P&L can
   * never drift out of sync with the execution audit trail.
   */
  private static async recomputeLegFull(structureId: UUID, legId: UUID, contractId: UUID) {
    const allExecutions = await repository.getExecutionsByLeg(legId);
    const activeExecutions = allExecutions.filter((e) => e.status === "Active");
    const dollarPerPriceUnit = await this.dollarPerPriceUnitForContract(contractId);
    const { position, realizedFromExits } = PositionEngine.computePosition(legId, contractId, activeExecutions, dollarPerPriceUnit);
    await repository.upsertPosition(position);

    await repository.deleteRealizedPnLEventsByLeg(legId);
    for (const r of realizedFromExits) {
      const pnlEvent: RealizedPnLEvent = {
        id: uuid(),
        structure_id: structureId,
        structure_leg_id: legId,
        execution_id: r.execution.id,
        quantity: r.quantity,
        entry_price: r.entryPrice,
        exit_price: r.exitPrice,
        realized_pnl: r.realizedPnl,
        timestamp: r.execution.timestamp,
      };
      await repository.addRealizedPnLEvent(pnlEvent);
    }

    const leg = await repository.getLeg(legId);
    if (leg) {
      const shouldBeActive = position.net_quantity !== 0;
      if (leg.is_active !== shouldBeActive) {
        await repository.upsertLeg({ ...leg, is_active: shouldBeActive });
      }
    }

    const structure = await repository.getStructure(structureId);
    if (structure) {
      const allLegs = await repository.getLegsByStructure(structureId);
      let totalRealized = 0;
      for (const l of allLegs) {
        const pos = await repository.getPositionByLeg(l.id);
        totalRealized += pos?.realized_pnl ?? 0;
      }
      await RiskEngine.syncStructureRisk(structure, totalRealized);
    }

    await this.refreshStructureStatus(structureId);
    return { position, realizedFromExits };
  }

  /** Add an entry (initial or scale-in) to a specific leg. Side combines the leg's fixed template ratio with this entry's own chosen direction. */
  static async addEntry(input: NewEntryInput): Promise<Execution> {
    const leg = await repository.getLeg(input.structure_leg_id);
    if (!leg) throw new Error("Leg not found");

    const execution: Execution = {
      id: uuid(),
      structure_leg_id: input.structure_leg_id,
      execution_type: "Entry",
      side: input.side ?? sideFromRatio(leg.ratio * input.direction),
      quantity: input.quantity,
      price: input.price,
      risk_allocated: input.risk_allocated,
      max_adverse_ticks: input.max_adverse_ticks,
      timestamp: new Date().toISOString(),
      notes: input.notes,
      entry_group_id: input.entry_group_id,
      status: "Active",
    };
    await repository.addExecution(execution);

    if (input.risk_allocated) {
      await RiskEngine.addRiskAllocation(
        input.structure_id,
        input.risk_allocated,
        "Entry-level risk allocation",
        execution.id
      );
    }

    await this.audit({
      event_type: "EntryAdded",
      structure_id: input.structure_id,
      structure_leg_id: input.structure_leg_id,
      execution_id: execution.id,
      description: `Entry: ${execution.side} ${input.quantity} lots @ ${input.price}`,
    });
    await this.audit({
      event_type: "PositionIncreased",
      structure_id: input.structure_id,
      structure_leg_id: input.structure_leg_id,
      execution_id: execution.id,
      description: `Position increased on leg`,
    });

    await this.recomputeLegFull(input.structure_id, leg.id, leg.contract_id);
    return execution;
  }

  /**
   * Exit some/all quantity from ONE SPECIFIC ENTRY on a leg (never a
   * generic "close whatever's oldest") — handles partial exits, full entry
   * exits, and (if it's the last open exposure) final leg/structure exit —
   * WITHOUT ever creating a new unrelated trade (spec section 7). The
   * original structure persists; only its legs/status update.
   */
  static async exitLeg(input: ExitInput): Promise<Execution> {
    const leg = await repository.getLeg(input.structure_leg_id);
    if (!leg) throw new Error("Leg not found");
    const allExecutions = await repository.getExecutionsByLeg(leg.id);
    const activeExecutions = allExecutions.filter((e) => e.status === "Active");
    // Read-only lookup of this entry's own remaining exposure — the 1 here
    // is a throwaway $ multiplier (we only need lotsByEntry, not realizedPnl,
    // at this stage; the real conversion happens in recomputeLegFull below).
    const { lotsByEntry } = PositionEngine.computePosition(leg.id, leg.contract_id, activeExecutions, 1);
    const targetLot = lotsByEntry[input.closes_entry_group_id];
    if (!targetLot || targetLot.quantity === 0) throw new Error("No open quantity on this entry to exit");

    // An exit trades in the opposite direction of the entry it's closing.
    const exitSide = targetLot.quantity > 0 ? "Short" : "Long";
    const closingQty = Math.min(input.quantity, Math.abs(targetLot.quantity));

    const executionType = input.execution_type ?? (closingQty === Math.abs(targetLot.quantity) ? "LegExit" : "PartialExit");

    const execution: Execution = {
      id: uuid(),
      structure_leg_id: leg.id,
      execution_type: executionType,
      side: exitSide,
      quantity: closingQty,
      price: input.price,
      timestamp: new Date().toISOString(),
      notes: input.notes,
      entry_group_id: input.entry_group_id,
      closes_entry_group_id: input.closes_entry_group_id,
      status: "Active",
    };
    await repository.addExecution(execution);

    const { position, realizedFromExits } = await this.recomputeLegFull(input.structure_id, leg.id, leg.contract_id);

    const realizedThisExit = realizedFromExits
      .filter((r) => r.execution.id === execution.id)
      .reduce((sum, r) => sum + r.realizedPnl, 0);

    if (position.net_quantity === 0) {
      await this.audit({
        event_type: "LegClosed",
        structure_id: input.structure_id,
        structure_leg_id: leg.id,
        execution_id: execution.id,
        description: `Leg fully closed`,
      });
      const siblingLegs = (await repository.getLegsByStructure(input.structure_id)).filter((l) => l.id !== leg.id);
      const anySiblingOpen = siblingLegs.some((l) => l.is_active);
      if (anySiblingOpen) {
        await this.audit({
          event_type: "SpreadClosed",
          structure_id: input.structure_id,
          structure_leg_id: leg.id,
          execution_id: execution.id,
          description: `One component closed; remaining structure legs stay open`,
        });
      }
    } else {
      await this.audit({
        event_type: "PositionReduced",
        structure_id: input.structure_id,
        structure_leg_id: leg.id,
        execution_id: execution.id,
        description: `Position reduced by ${closingQty} lots`,
      });
    }

    if (realizedThisExit !== 0) {
      await this.audit({
        event_type: "RealizedProfitBooked",
        structure_id: input.structure_id,
        structure_leg_id: leg.id,
        execution_id: execution.id,
        description: `Realized ${realizedThisExit >= 0 ? "+" : ""}${realizedThisExit.toFixed(2)}`,
      });
    }

    return execution;
  }

  /**
   * Correct a mistaken execution (wrong price/quantity/time/contract).
   * The original row is kept and marked `Edited` (never destroyed); a new
   * `Active` row replaces it. Optionally moves the execution to a
   * different leg of the same structure to fix a wrong-contract entry.
   */
  static async editExecution(input: EditExecutionInput): Promise<Execution> {
    const original = await this.getActiveExecution(input.execution_id);
    if (!original) throw new Error("Execution not found or not editable");

    const targetLegId = input.structure_leg_id ?? original.structure_leg_id;
    const targetLeg = await repository.getLeg(targetLegId);
    if (!targetLeg) throw new Error("Target leg not found");

    // Side is only ever recomputed when actually moving an Entry to a
    // different leg (a "wrong contract" fix) — preserving that entry's own
    // chosen direction relative to the leg's ratio, not resetting it to
    // whatever the leg's raw ratio sign says (that would silently flip a
    // Short entry back to Long on every unrelated price/qty correction).
    // Exits and same-leg edits always keep the original side unchanged.
    let side = original.side;
    if (original.execution_type === "Entry" && targetLegId !== original.structure_leg_id) {
      const originalLeg = await repository.getLeg(original.structure_leg_id);
      const originalDirection = originalLeg && sideFromRatio(originalLeg.ratio) === original.side ? 1 : -1;
      side = sideFromRatio(targetLeg.ratio * originalDirection);
    }

    const replacement: Execution = {
      ...original,
      id: uuid(),
      structure_leg_id: targetLegId,
      side,
      quantity: input.quantity ?? original.quantity,
      price: input.price ?? original.price,
      risk_allocated: input.risk_allocated !== undefined ? input.risk_allocated : original.risk_allocated,
      timestamp: input.timestamp ?? original.timestamp,
      notes: input.notes ?? original.notes,
      // Always carried forward — a correction stays part of the same entry.
      entry_group_id: original.entry_group_id,
      status: "Active",
      edited_from_execution_id: original.id,
      edited_to_execution_id: undefined,
    };
    await repository.addExecution(replacement);

    const supersededOriginal: Execution = {
      ...original,
      status: "Edited",
      edited_to_execution_id: replacement.id,
      edit_reason: input.reason,
    };
    await repository.addExecution(supersededOriginal);

    // Re-point any entry-level risk allocation to the replacement execution.
    await repository.deleteRiskAllocationsByExecution(original.id);
    if (replacement.risk_allocated) {
      await RiskEngine.addRiskAllocation(
        input.structure_id,
        replacement.risk_allocated,
        "Entry-level risk allocation (corrected)",
        replacement.id
      );
    }

    await this.audit({
      event_type: "EntryEdited",
      structure_id: input.structure_id,
      structure_leg_id: targetLegId,
      execution_id: replacement.id,
      description: `Entry corrected: ${replacement.side} ${replacement.quantity} lots @ ${replacement.price}${input.reason ? ` (${input.reason})` : ""}`,
    });

    const originalLegContract = (await repository.getLeg(original.structure_leg_id))?.contract_id;
    if (originalLegContract) {
      await this.recomputeLegFull(input.structure_id, original.structure_leg_id, originalLegContract);
    }
    if (targetLegId !== original.structure_leg_id) {
      await this.recomputeLegFull(input.structure_id, targetLegId, targetLeg.contract_id);
    }

    return replacement;
  }

  /** Soft-delete a mistaken execution — kept for audit, excluded from recomputation. */
  static async deleteExecution(input: DeleteExecutionInput): Promise<void> {
    const original = await this.getActiveExecution(input.execution_id);
    if (!original) throw new Error("Execution not found or not deletable");

    const deleted: Execution = {
      ...original,
      status: "Deleted",
      edit_reason: input.reason,
    };
    await repository.addExecution(deleted);
    await repository.deleteRiskAllocationsByExecution(original.id);

    await this.audit({
      event_type: "EntryDeleted",
      structure_id: input.structure_id,
      structure_leg_id: original.structure_leg_id,
      execution_id: original.id,
      description: `Entry deleted: ${original.side} ${original.quantity} lots @ ${original.price}${input.reason ? ` (${input.reason})` : ""}`,
    });

    const leg = await repository.getLeg(original.structure_leg_id);
    if (leg) {
      await this.recomputeLegFull(input.structure_id, leg.id, leg.contract_id);
    }
  }

  private static async getActiveExecution(executionId: UUID): Promise<Execution | undefined> {
    // Executions aren't individually addressable by id in the repository
    // interface (only by leg), so scan the owning leg's history. Structures
    // typically have few legs and executions, so this stays cheap.
    const allLegs = await repository.getAllLegs();
    for (const leg of allLegs) {
      const executions = await repository.getExecutionsByLeg(leg.id);
      const match = executions.find((e) => e.id === executionId && e.status === "Active");
      if (match) return match;
    }
    return undefined;
  }

  /**
   * Keeps a trade's stored status consistent after its lots change. A trade
   * is only ever CLOSED by the user (closeTrade) — exiting every lot no longer
   * closes it, it just leaves the trade open and flat so more can be added or
   * the trade closed deliberately. Older "Partially Closed"/"Modified"
   * statuses are normalised to "Open". A closed trade is never touched here.
   */
  static async refreshStructureStatus(structureId: UUID): Promise<Structure | undefined> {
    const structure = await repository.getStructure(structureId);
    if (!structure) return undefined;
    if (structure.status === "Fully Closed" || structure.status === "Open") return structure;

    const updated: Structure = { ...structure, status: "Open" };
    await repository.upsertStructure(updated);
    return updated;
  }

  /**
   * The user's explicit "Close Trade". Refuses while any leg still holds lots
   * — exit everything first, so a closed trade never carries a live position
   * (no price polling, no risk counted, no exposure). Recorded in the audit log.
   */
  static async closeTrade(structureId: UUID): Promise<Structure> {
    const structure = await repository.getStructure(structureId);
    if (!structure) throw new Error("Trade not found");
    if (structure.status === "Fully Closed") return structure;

    const legs = await repository.getLegsByStructure(structureId);
    const positions = await Promise.all(legs.map((l) => repository.getPositionByLeg(l.id)));
    const stillOpen = positions.filter((p) => Math.abs(p?.net_quantity ?? 0) > 1e-9).length;
    if (stillOpen > 0) {
      throw new Error(`Exit all remaining lots first — ${stillOpen} leg${stillOpen === 1 ? "" : "s"} still hold open lots.`);
    }

    const updated: Structure = { ...structure, status: "Fully Closed", closed_at: new Date().toISOString() };
    await repository.upsertStructure(updated);
    await this.audit({ event_type: "TradeClosed", structure_id: structureId, description: `Trade "${structure.name}" closed` });
    return updated;
  }

  /** Puts a closed trade back to Open (e.g. closed by mistake). Recorded in the audit log. */
  static async reopenTrade(structureId: UUID): Promise<Structure> {
    const structure = await repository.getStructure(structureId);
    if (!structure) throw new Error("Trade not found");
    if (structure.status !== "Fully Closed") return structure;

    const updated: Structure = { ...structure, status: "Open", closed_at: undefined };
    await repository.upsertStructure(updated);
    await this.audit({ event_type: "TradeReopened", structure_id: structureId, description: `Trade "${structure.name}" reopened` });
    return updated;
  }
}
