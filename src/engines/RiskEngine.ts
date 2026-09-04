import type { Structure, RiskAllocation, StopLossRecord, UUID } from "../types/domain";
import { repository } from "../data";
import { v4 as uuid } from "uuid";

/**
 * RiskEngine: manages dollar risk at structure and entry level, and
 * dynamic stop-loss recalculation as realized profit is booked
 * (spec section 11).
 */
export class RiskEngine {
  /** Sum of all entry-level risk allocations for a structure. */
  static async totalAllocatedRisk(structureId: UUID): Promise<number> {
    const allocations = await repository.getRiskAllocationsByStructure(structureId);
    return allocations.reduce((sum, a) => sum + a.dollar_risk, 0);
  }

  /**
   * Recalculate a structure's *current* dollar risk given profit booked
   * so far. Adjusted Risk = Initial Risk + Realized P&L (profit reduces
   * the amount still at risk; losses increase remaining exposure need).
   * Both Initial and Adjusted values are kept visible per spec.
   */
  static computeAdjustedRisk(initialRisk: number, realizedPnl: number): number {
    return initialRisk + realizedPnl;
  }

  /**
   * Recalculate a structure's stop loss given adjusted risk, average
   * entry, quantity and tick economics. Returns a $ risk basis; how it
   * maps to a specific price level is instrument/structure-composition
   * dependent, so we store the $ basis and let the UI/leg-level detail
   * show the equivalent price where a single-leg mapping is meaningful.
   */
  static async recordStopLoss(
    structure: Structure,
    adjustedDollarRisk: number,
    reason: string
  ): Promise<StopLossRecord> {
    const record: StopLossRecord = {
      id: uuid(),
      structure_id: structure.id,
      dollar_risk_basis: adjustedDollarRisk,
      reason,
      timestamp: new Date().toISOString(),
    };
    await repository.addStopLossRecord(record);
    return record;
  }

  static async addRiskAllocation(
    structureId: UUID,
    dollarRisk: number,
    reason?: string,
    executionId?: UUID
  ): Promise<RiskAllocation> {
    const allocation: RiskAllocation = {
      id: uuid(),
      structure_id: structureId,
      execution_id: executionId,
      dollar_risk: dollarRisk,
      reason,
      timestamp: new Date().toISOString(),
    };
    await repository.addRiskAllocation(allocation);
    return allocation;
  }

  /**
   * Recalculate and persist current_dollar_risk / current_stop_loss on the
   * Structure record itself, after realized P&L changes (called by
   * StructureEngine after any exit).
   */
  static async syncStructureRisk(structure: Structure, realizedPnl: number): Promise<Structure> {
    const adjusted = this.computeAdjustedRisk(structure.initial_dollar_risk, realizedPnl);
    const updated: Structure = {
      ...structure,
      current_dollar_risk: adjusted,
    };
    await repository.upsertStructure(updated);
    if (realizedPnl !== 0) {
      await this.recordStopLoss(
        updated,
        adjusted,
        realizedPnl > 0
          ? `Adjusted after +${realizedPnl.toFixed(2)} realized profit`
          : `Adjusted after ${realizedPnl.toFixed(2)} realized loss`
      );
    }
    return updated;
  }
}
