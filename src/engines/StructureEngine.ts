import { v4 as uuid } from "uuid";
import type {
  Structure,
  StructureLeg,
  Execution,
  LegSide,
  StructureType,
  AuditEvent,
  RealizedPnLEvent,
  UUID,
} from "../types/domain";
import { repository } from "../data";
import { PositionEngine } from "./PositionEngine";
import { RiskEngine } from "./RiskEngine";

export interface NewLegInput {
  contract_id: UUID;
  ratio: number; // e.g. +1, -2, +1 for a fly
  side: LegSide;
}

export interface NewStructureInput {
  instrument_id: UUID;
  name: string;
  structure_type: StructureType;
  initial_dollar_risk: number;
  initial_stop_loss?: number;
  notes?: string;
  legs: NewLegInput[];
}

export interface NewEntryInput {
  structure_id: UUID;
  structure_leg_id: UUID;
  side: LegSide;
  quantity: number;
  price: number;
  risk_allocated?: number;
  max_adverse_ticks?: number;
  notes?: string;
}

export interface ExitInput {
  structure_leg_id: UUID;
  structure_id: UUID;
  quantity: number;
  price: number;
  execution_type?: "PartialExit" | "LegExit" | "FinalExit";
  notes?: string;
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
        side: legInput.side,
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

  /** Add an entry (initial or scale-in) to a specific leg. */
  static async addEntry(input: NewEntryInput): Promise<Execution> {
    const execution: Execution = {
      id: uuid(),
      structure_leg_id: input.structure_leg_id,
      execution_type: "Entry",
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      risk_allocated: input.risk_allocated,
      max_adverse_ticks: input.max_adverse_ticks,
      timestamp: new Date().toISOString(),
      notes: input.notes,
    };
    await repository.addExecution(execution);

    const leg = await repository.getLeg(input.structure_leg_id);
    if (leg) {
      await PositionEngine.recomputeAndPersist(leg.id, leg.contract_id);
    }

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
      description: `Entry: ${input.side} ${input.quantity} lots @ ${input.price}`,
    });
    await this.audit({
      event_type: "PositionIncreased",
      structure_id: input.structure_id,
      structure_leg_id: input.structure_leg_id,
      execution_id: execution.id,
      description: `Position increased on leg`,
    });

    await this.refreshStructureStatus(input.structure_id);
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
    const exitSide: LegSide = netBefore > 0 ? "Short" : "Long";
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
    };
    await repository.addExecution(execution);

    const { position, realizedFromExits } = PositionEngine.computePosition(
      leg.id,
      leg.contract_id,
      await repository.getExecutionsByLeg(leg.id)
    );
    await repository.upsertPosition(position);

    // Persist realized P&L events (permanent, spec section 9)
    let realizedThisExit = 0;
    for (const r of realizedFromExits.filter((r) => r.execution.id === execution.id)) {
      realizedThisExit += r.realizedPnl;
      const pnlEvent: RealizedPnLEvent = {
        id: uuid(),
        structure_id: input.structure_id,
        structure_leg_id: leg.id,
        execution_id: execution.id,
        quantity: r.quantity,
        entry_price: r.entryPrice,
        exit_price: r.exitPrice,
        realized_pnl: r.realizedPnl,
        timestamp: execution.timestamp,
      };
      await repository.addRealizedPnLEvent(pnlEvent);
    }

    // Deactivate leg if fully closed
    if (position.net_quantity === 0) {
      await repository.upsertLeg({ ...leg, is_active: false });
      await this.audit({
        event_type: "LegClosed",
        structure_id: input.structure_id,
        structure_leg_id: leg.id,
        execution_id: execution.id,
        description: `Leg fully closed`,
      });
      // Spread-close semantics: if exactly this leg's contract closes while
      // sibling legs remain open, log a SpreadClosed event too (section 7).
      const siblingLegs = (await repository.getLegsByStructure(input.structure_id)).filter(
        (l) => l.id !== leg.id
      );
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

    // Recalculate structure-level risk given cumulative realized P&L across ALL legs
    const structure = await repository.getStructure(input.structure_id);
    if (structure) {
      const allLegs = await repository.getLegsByStructure(structure.id);
      let totalRealized = 0;
      for (const l of allLegs) {
        const pos = await repository.getPositionByLeg(l.id);
        totalRealized += pos?.realized_pnl ?? 0;
      }
      await RiskEngine.syncStructureRisk(structure, totalRealized);
    }

    await this.refreshStructureStatus(input.structure_id);
    return execution;
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
