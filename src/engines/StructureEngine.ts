import { v4 as uuid } from "uuid";
import type {
  Structure,
  StructureLeg,
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
  quantity: number; // always positive; side is derived from the leg's ratio
  price: number;
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
  // Shared across every leg's Execution created by the same Exit submission.
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
export class StructureEngine {
  private static async audit(event: Omit<AuditEvent, "id" | "timestamp">) {
    const full: AuditEvent = { ...event, id: uuid(), timestamp: new Date().toISOString() };
    await repository.addAuditEvent(full);
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
   * Fully recompute a leg's Position + Realized P&L events from its
   * `Active` execution history, then cascade structure-level risk and
   * status. This is the single source of truth used after ANY execution
   * change (add / exit / edit / delete) so position and realized P&L can
   * never drift out of sync with the execution audit trail.
   */
  private static async recomputeLegFull(structureId: UUID, legId: UUID, contractId: UUID) {
    const allExecutions = await repository.getExecutionsByLeg(legId);
    const activeExecutions = allExecutions.filter((e) => e.status === "Active");
    const { position, realizedFromExits } = PositionEngine.computePosition(legId, contractId, activeExecutions);
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

  /** Add an entry (initial or scale-in) to a specific leg. Direction is derived from the leg's ratio. */
  static async addEntry(input: NewEntryInput): Promise<Execution> {
    const leg = await repository.getLeg(input.structure_leg_id);
    if (!leg) throw new Error("Leg not found");

    const execution: Execution = {
      id: uuid(),
      structure_leg_id: input.structure_leg_id,
      execution_type: "Entry",
      side: sideFromRatio(leg.ratio),
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
   * Exit some/all quantity on a leg. Handles partial exits, full leg
   * exits, and (if it's the last active leg) final structure exit —
   * WITHOUT ever creating a new unrelated trade (spec section 7). The
   * original structure persists; only its legs/status update.
   */
  static async exitLeg(input: ExitInput): Promise<Execution> {
    const leg = await repository.getLeg(input.structure_leg_id);
    if (!leg) throw new Error("Leg not found");
    const priorPosition = await repository.getPositionByLeg(leg.id);
    const netBefore = priorPosition?.net_quantity ?? 0;
    if (netBefore === 0) throw new Error("No open position on this leg to exit");

    // An exit trades in the opposite direction of the current net position.
    const exitSide = netBefore > 0 ? "Short" : "Long";
    const closingQty = Math.min(input.quantity, Math.abs(netBefore));

    const executionType = input.execution_type ?? (closingQty === Math.abs(netBefore) ? "LegExit" : "PartialExit");

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

    const replacement: Execution = {
      ...original,
      id: uuid(),
      structure_leg_id: targetLegId,
      side: sideFromRatio(targetLeg.ratio),
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

  /** Recompute and persist a structure's overall status based on its legs. */
  static async refreshStructureStatus(structureId: UUID): Promise<Structure | undefined> {
    const structure = await repository.getStructure(structureId);
    if (!structure) return undefined;
    const legs = await repository.getLegsByStructure(structureId);

    const positions = await Promise.all(legs.map((l) => repository.getPositionByLeg(l.id)));
    const anyOpen = positions.some((p) => (p?.net_quantity ?? 0) !== 0);
    const allClosed = legs.length > 0 && positions.every((p) => (p?.net_quantity ?? 0) === 0);
    const someClosed = positions.some((p) => (p?.net_quantity ?? 0) === 0) && anyOpen;

    let status = structure.status;
    if (allClosed) status = "Fully Closed";
    else if (someClosed) status = "Partially Closed";
    else if (anyOpen) status = structure.status === "Modified" ? "Modified" : "Open";

    if (status !== structure.status) {
      const updated: Structure = {
        ...structure,
        status,
        closed_at: status === "Fully Closed" ? new Date().toISOString() : structure.closed_at,
      };
      await repository.upsertStructure(updated);
      await this.audit({
        event_type: "StructureModified",
        structure_id: structureId,
        description: `Status changed to ${status}`,
      });
      return updated;
    }
    return structure;
  }
}
