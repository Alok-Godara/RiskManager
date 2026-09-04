import type { PortfolioSummary } from "../types/domain";
import { repository } from "../data";
import { PnLEngine } from "./PnLEngine";

/**
 * PortfolioEngine: top-level roll-up across every structure (spec section 12).
 */
export class PortfolioEngine {
  static async buildSummary(): Promise<PortfolioSummary> {
    const structures = await repository.getStructures();
    const snapshots = await PnLEngine.buildAllStructureSnapshots();

    const totalRealized = snapshots.reduce((s, snap) => s + snap.total_realized_pnl, 0);
    const totalUnrealized = snapshots.reduce((s, snap) => s + snap.total_unrealized_pnl, 0);
    const netPnl = totalRealized + totalUnrealized;

    const openStructures = structures.filter((s) => s.status !== "Fully Closed");
    const closedStructures = structures.filter((s) => s.status === "Fully Closed");

    const totalDollarRisk = openStructures.reduce((s, st) => s + st.current_dollar_risk, 0);
    const riskUtilized = snapshots
      .filter((snap) => snap.structure.status !== "Fully Closed")
      .reduce((s, snap) => s + Math.max(0, -snap.total_pnl), 0);
    const remainingRiskCapacity = totalDollarRisk - riskUtilized;

    return {
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      net_pnl: netPnl,
      total_dollar_risk: totalDollarRisk,
      risk_utilized: riskUtilized,
      remaining_risk_capacity: remainingRiskCapacity,
      open_structures: openStructures.length,
      closed_structures: closedStructures.length,
    };
  }
}
