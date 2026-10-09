import type {
  Position,
  Instrument,
  Structure,
  LegSnapshot,
  StructureSnapshot,
  Execution,
  StructureTemplate,
  UUID,
} from "../types/domain";
import { repository } from "../data";
import { TransactionCostEngine } from "./TransactionCostEngine";
import { EntryEngine } from "./EntryEngine";

/** Reference data shared across every structure in one snapshot pass, fetched once instead of per structure/leg. */
interface TcContext {
  instrumentsById: Map<UUID, Instrument>;
  templatesById: Map<UUID, StructureTemplate>;
  executionsByLeg: Map<UUID, Execution[]>;
}

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
  static async buildStructureSnapshot(structure: Structure, tcContext?: TcContext): Promise<StructureSnapshot> {
    const legs = await repository.getLegsByStructure(structure.id);
    const instrument = await repository.getInstrument(structure.instrument_id);

    const legSnapshots: LegSnapshot[] = [];
    const entryTimestamps: string[] = [];
    const structureExecutions: Execution[] = [];
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

      // Transaction cost: half the round-turn rate on every active fill (entry
      // and exit). The rate comes from the LEG's own contract's instrument.
      const legExecutions = tcContext ? (tcContext.executionsByLeg.get(leg.id) ?? []) : await repository.getExecutionsByLeg(leg.id);
      const legInstrument = tcContext?.instrumentsById.get(contract.instrument_id) ?? (await repository.getInstrument(contract.instrument_id));
      const templatesById = tcContext?.templatesById ?? new Map((await repository.getStructureTemplates()).map((t) => [t.id, t]));
      const transactionCost = TransactionCostEngine.legCost(legExecutions, contract, legInstrument, templatesById);
      structureExecutions.push(...legExecutions);
      for (const e of legExecutions) {
        if (e.execution_type === "Entry" && (e.status ?? "Active") === "Active") entryTimestamps.push(e.timestamp);
      }

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
        transaction_cost: transactionCost,
      });
    }

    const totalRealized = legSnapshots.reduce((s, l) => s + l.position.realized_pnl, 0);
    const totalUnrealized = legSnapshots.reduce((s, l) => s + l.unrealized_pnl, 0);
    const totalPnl = totalRealized + totalUnrealized;
    const entryStats = EntryEngine.activeEntryStats(structureExecutions);
    const stopUsage = EntryEngine.worstStopUsage(
      structureExecutions,
      new Map(legSnapshots.map((l) => [l.leg.id, l.current_price])),
      instrument ? instrument.tick_value / instrument.tick_size : 0
    );
    const totalTransactionCost = legSnapshots.reduce((s, l) => s + l.transaction_cost, 0);

    const remainingRiskCapacity = structure.current_dollar_risk + totalPnl;

    return {
      structure,
      legs: legSnapshots,
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      total_pnl: totalPnl,
      remaining_risk_capacity: remainingRiskCapacity,
      total_transaction_cost: totalTransactionCost,
      net_realized_pnl: totalRealized - totalTransactionCost,
      entry_timestamps: entryTimestamps,
      active_risk: entryStats.activeRisk,
      open_entry_count: entryStats.openEntries,
      stop_usage: stopUsage,
    };
  }

  static async buildAllStructureSnapshots(): Promise<StructureSnapshot[]> {
    const [structures, instruments, templates, executions] = await Promise.all([
      repository.getStructures(),
      repository.getInstruments(),
      repository.getStructureTemplates(),
      repository.getAllExecutions(),
    ]);
    const executionsByLeg = new Map<UUID, Execution[]>();
    for (const e of executions) {
      const list = executionsByLeg.get(e.structure_leg_id) ?? [];
      list.push(e);
      executionsByLeg.set(e.structure_leg_id, list);
    }
    const tcContext: TcContext = {
      instrumentsById: new Map(instruments.map((i) => [i.id, i])),
      templatesById: new Map(templates.map((t) => [t.id, t])),
      executionsByLeg,
    };
    const snapshots: StructureSnapshot[] = [];
    for (const s of structures) {
      snapshots.push(await this.buildStructureSnapshot(s, tcContext));
    }
    return snapshots;
  }
}
