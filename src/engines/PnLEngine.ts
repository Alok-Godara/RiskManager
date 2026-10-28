import type {
  Contract,
  Position,
  Instrument,
  Structure,
  StructureLeg,
  LegSnapshot,
  StructureSnapshot,
  Execution,
  MarketPrice,
  StructureTemplate,
  UUID,
} from "../types/domain";
import { repository } from "../data";
import { TransactionCostEngine } from "./TransactionCostEngine";
import { EntryEngine } from "./EntryEngine";

/**
 * Everything a snapshot pass needs, fetched ONCE in bulk. Static data (all but
 * `prices`) changes only when you act on a trade, so the app keeps it and
 * rebuilds snapshots from fresh prices alone on every price tick — see
 * hooks/useRiskManagerData.ts. (It used to re-query per structure and per leg
 * on every tick, ~100 requests and a few hundred KB each time.)
 */
export interface SnapshotData {
  structures: Structure[];
  legs: StructureLeg[];
  contracts: Contract[];
  instruments: Instrument[];
  templates: StructureTemplate[];
  positions: Position[];
  executions: Execution[];
  prices: MarketPrice[];
}

/** The part of SnapshotData that does not change with prices. */
export type StaticSnapshotData = Omit<SnapshotData, "prices">;

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

  // The contract list is by far the biggest table (every month of every instrument,
  // years ahead) and almost never changes, so timed refreshes reuse it.
  private static contractsCache: { at: number; contracts: Contract[] } | null = null;
  private static readonly CONTRACTS_TTL_MS = 60 * 60_000;

  /**
   * One bulk read of everything snapshots are built from (a handful of requests, not
   * one per leg). With `cachedContracts` (the timed background refreshes) the contract
   * list is reused for up to an hour — unless a leg points at a contract it does not
   * contain, which means a new one was created and it is re-read straight away. Anything
   * you do yourself re-reads it (the default).
   */
  static async loadStaticData(opts?: { cachedContracts?: boolean }): Promise<StaticSnapshotData> {
    const cache = this.contractsCache;
    const useCache = Boolean(opts?.cachedContracts && cache && Date.now() - cache.at < this.CONTRACTS_TTL_MS);
    const [structures, legs, fetchedContracts, instruments, templates, positions, executions] = await Promise.all([
      repository.getStructures(),
      repository.getAllLegs(),
      useCache ? Promise.resolve(cache!.contracts) : repository.getContracts(),
      repository.getInstruments(),
      repository.getStructureTemplates(),
      repository.getPositions(),
      repository.getAllExecutions(),
    ]);
    let contracts = fetchedContracts;
    if (useCache) {
      const known = new Set(contracts.map((c) => c.id));
      if (legs.some((l) => !known.has(l.contract_id))) contracts = await repository.getContracts();
    }
    if (contracts !== cache?.contracts) this.contractsCache = { at: Date.now(), contracts };
    return { structures, legs, contracts, instruments, templates, positions, executions };
  }

  /**
   * Builds every structure's snapshot — legs, positions, live P&L, costs,
   * risk — from already-loaded data. Pure and synchronous: calling it again
   * with new prices is free (no I/O), which is what the live price ticks do.
   */
  static buildSnapshots(data: SnapshotData): StructureSnapshot[] {
    const contractsById = new Map(data.contracts.map((c) => [c.id, c]));
    const instrumentsById = new Map(data.instruments.map((i) => [i.id, i]));
    const templatesById = new Map(data.templates.map((t) => [t.id, t]));
    const positionByLeg = new Map(data.positions.map((p) => [p.structure_leg_id, p]));
    const priceByContract = new Map(data.prices.map((p) => [p.contract_id, p]));

    const legsByStructure = new Map<UUID, StructureLeg[]>();
    for (const leg of data.legs) {
      const list = legsByStructure.get(leg.structure_id) ?? [];
      list.push(leg);
      legsByStructure.set(leg.structure_id, list);
    }
    const executionsByLeg = new Map<UUID, Execution[]>();
    for (const e of data.executions) {
      const list = executionsByLeg.get(e.structure_leg_id) ?? [];
      list.push(e);
      executionsByLeg.set(e.structure_leg_id, list);
    }

    return data.structures.map((structure) => {
      const legs = legsByStructure.get(structure.id) ?? [];
      const instrument = instrumentsById.get(structure.instrument_id);

      const legSnapshots: LegSnapshot[] = [];
      const entryTimestamps: string[] = [];
      const structureExecutions: Execution[] = [];
      for (const leg of legs) {
        const contract = contractsById.get(leg.contract_id);
        if (!contract) continue;
        const position: Position =
          positionByLeg.get(leg.id) ?? {
            structure_leg_id: leg.id,
            contract_id: leg.contract_id,
            net_quantity: 0,
            average_price: 0,
            realized_pnl: 0,
            last_updated: new Date().toISOString(),
          };
        const marketPrice = priceByContract.get(leg.contract_id);

        // Transaction cost: half the round-turn rate on every active fill (entry
        // and exit). The rate comes from the LEG's own contract's instrument.
        const legExecutions = executionsByLeg.get(leg.id) ?? [];
        const legInstrument = instrumentsById.get(contract.instrument_id);
        const transactionCost = TransactionCostEngine.legCost(legExecutions, contract, legInstrument, templatesById);
        structureExecutions.push(...legExecutions);
        for (const e of legExecutions) {
          if (e.execution_type === "Entry" && (e.status ?? "Active") === "Active") entryTimestamps.push(e.timestamp);
        }

        const unrealized = instrument ? this.unrealizedPnl(position, marketPrice?.price, instrument) : 0;

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
        net_pnl: totalRealized - totalTransactionCost + totalUnrealized,
        entry_timestamps: entryTimestamps,
        active_risk: entryStats.activeRisk,
        open_entry_count: entryStats.openEntries,
        stop_usage: stopUsage,
      };
    });
  }

  /** Convenience for one-off callers: load everything (static + prices) and build. */
  static async buildAllStructureSnapshots(): Promise<StructureSnapshot[]> {
    const [staticData, prices] = await Promise.all([this.loadStaticData(), repository.getMarketPrices()]);
    return this.buildSnapshots({ ...staticData, prices });
  }
}
