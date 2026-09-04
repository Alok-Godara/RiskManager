import type {
  Position,
  Instrument,
  Structure,
  LegSnapshot,
  StructureSnapshot,
} from "../types/domain";
import { repository } from "../data";

/**
 * PnLEngine: computes realized, unrealized, and total P&L at the entry,
 * leg, structure, instrument, and portfolio levels. Depends only on
 * Position + MarketPrice + Instrument tick economics — no UI coupling.
 */
export class PnLEngine {
  static unrealizedPnl(
    position: Position,
    currentPrice: number | undefined,
    instrument: Instrument
  ): number {
    if (currentPrice === undefined || position.net_quantity === 0) return 0;
    const priceDiff = currentPrice - position.average_price;
    // priceDiff is in price units; convert to $ via tick economics:
    // $ per unit move = tick_value / tick_size, scaled by lot_size baked
    // into tick_value already (tick_value assumed to already be $/lot/tick).
    const dollarPerPriceUnit = instrument.tick_value / instrument.tick_size;
    return priceDiff * dollarPerPriceUnit * position.net_quantity;
  }

  static marketValue(position: Position, currentPrice: number | undefined): number {
    if (currentPrice === undefined) return 0;
    return position.net_quantity * currentPrice;
  }

  /** Build a full snapshot for one structure: legs, positions, live P&L, risk headroom. */
  static async buildStructureSnapshot(structure: Structure): Promise<StructureSnapshot> {
    const legs = await repository.getLegsByStructure(structure.id);
    const instrument = await repository.getInstrument(structure.instrument_id);

    const legSnapshots: LegSnapshot[] = [];
    for (const leg of legs) {
      const contract = await repository.getContract(leg.contract_id);
      if (!contract) continue;
      const position =
        (await repository.getPositionByLeg(leg.id)) ??
        ({
          structure_leg_id: leg.id,
          contract_id: leg.contract_id,
          net_quantity: 0,
          average_price: 0,
          realized_pnl: 0,
          last_updated: new Date().toISOString(),
        } as Position);
      const marketPrice = await repository.getMarketPrice(leg.contract_id);

      const unrealized = instrument
        ? this.unrealizedPnl(position, marketPrice?.price, instrument)
        : 0;

      legSnapshots.push({
        leg,
        contract,
        position,
        current_price: marketPrice?.price,
        unrealized_pnl: unrealized,
        market_value: this.marketValue(position, marketPrice?.price),
      });
    }

    const totalRealized = legSnapshots.reduce((s, l) => s + l.position.realized_pnl, 0);
    const totalUnrealized = legSnapshots.reduce((s, l) => s + l.unrealized_pnl, 0);
    const totalPnl = totalRealized + totalUnrealized;

    const remainingRiskCapacity = structure.current_dollar_risk + totalPnl;

    return {
      structure,
      legs: legSnapshots,
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      total_pnl: totalPnl,
      remaining_risk_capacity: remainingRiskCapacity,
    };
  }

  static async buildAllStructureSnapshots(): Promise<StructureSnapshot[]> {
    const structures = await repository.getStructures();
    const snapshots: StructureSnapshot[] = [];
    for (const s of structures) {
      snapshots.push(await this.buildStructureSnapshot(s));
    }
    return snapshots;
  }
}
