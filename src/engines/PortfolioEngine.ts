import type { PortfolioSummary, StructureSnapshot } from "../types/domain";
import { PnLEngine } from "./PnLEngine";

/**
 * PortfolioEngine: top-level roll-up across every trade (spec section 12).
 */
export class PortfolioEngine {
  /**
   * Rolls the per-trade snapshots up into the Dashboard's figures:
   *   - Net realized  = realized gross - every transaction cost paid so far.
   *   - Unrealized    = gross, on the lots still open at live prices.
   *   - Net P&L       = net realized + unrealized.
   *   - Risk budget   = the initial dollar risk given to each OPEN trade, added up.
   *   - Active risk   = the risk allocated to entries that still have open lots.
   *   - Remaining     = budget - active risk.
   * "Open" means not closed by the user (a flat but unclosed trade still holds
   * its budget until it is closed).
   */
  static summarize(snapshots: StructureSnapshot[]): PortfolioSummary {
    const totalRealized = snapshots.reduce((s, snap) => s + snap.total_realized_pnl, 0);
    const totalTransactionCost = snapshots.reduce((s, snap) => s + snap.total_transaction_cost, 0);
    const netRealized = totalRealized - totalTransactionCost;
    const totalUnrealized = snapshots.reduce((s, snap) => s + snap.total_unrealized_pnl, 0);

    const open = snapshots.filter((snap) => snap.structure.status !== "Fully Closed");
    const totalDollarRisk = open.reduce((s, snap) => s + snap.structure.initial_dollar_risk, 0);
    const riskUtilized = open.reduce((s, snap) => s + snap.active_risk, 0);

    return {
      total_realized_pnl: totalRealized,
      total_transaction_cost: totalTransactionCost,
      net_realized_pnl: netRealized,
      total_unrealized_pnl: totalUnrealized,
      net_pnl: netRealized + totalUnrealized,
      total_dollar_risk: totalDollarRisk,
      risk_utilized: riskUtilized,
      remaining_risk_capacity: totalDollarRisk - riskUtilized,
      open_structures: open.length,
      closed_structures: snapshots.length - open.length,
    };
  }

  static async buildSummary(): Promise<PortfolioSummary> {
    return this.summarize(await PnLEngine.buildAllStructureSnapshots());
  }
}
