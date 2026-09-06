import type { Execution, EntrySnapshot, LegSnapshot, StructureSnapshot, UUID } from "../types/domain";
import { repository } from "../data";

/**
 * EntryEngine: groups the flat, per-leg Execution audit trail back into
 * "Entries" — one row per Add Entry submission, spanning every leg it
 * touched (see Execution.entry_group_id) — for the StructureDetail Entries
 * table. Read-only / derived; StructureEngine remains the only writer.
 */
export class EntryEngine {
  static async buildEntrySnapshots(snapshot: StructureSnapshot): Promise<EntrySnapshot[]> {
    const instrument = await repository.getInstrument(snapshot.structure.instrument_id);
    const dollarPerPriceUnit = instrument ? instrument.tick_value / instrument.tick_size : 0;

    const legById = new Map(snapshot.legs.map((l) => [l.leg.id, l]));
    const executionLists = await Promise.all(snapshot.legs.map((l) => repository.getExecutionsByLeg(l.leg.id)));
    const entryExecutions = executionLists
      .flat()
      .filter((e) => e.execution_type === "Entry" && e.status === "Active");

    const groups = new Map<UUID, Execution[]>();
    for (const ex of entryExecutions) {
      const group = groups.get(ex.entry_group_id) ?? [];
      group.push(ex);
      groups.set(ex.entry_group_id, group);
    }

    const results: EntrySnapshot[] = [];
    for (const [entryGroupId, executions] of groups) {
      const rows = executions
        .map((execution) => {
          const legSnap = legById.get(execution.structure_leg_id);
          return legSnap ? { execution, legSnap } : undefined;
        })
        .filter((r): r is { execution: Execution; legSnap: LegSnapshot } => Boolean(r));
      if (rows.length === 0) continue;

      const timestamp = rows.reduce(
        (min, r) => (r.execution.timestamp < min ? r.execution.timestamp : min),
        rows[0].execution.timestamp
      );

      // Composite structure price for this entry: sum(ratio_i * price_i) —
      // the same convention a quoted spread/fly's own price follows (see
      // supabase/schema.sql / StructureQuoteEngine), so it's directly
      // comparable across entries and to a live "Structure"-kind quote.
      const avgPrice = rows.reduce((sum, r) => sum + r.legSnap.leg.ratio * r.execution.price, 0);
      const riskAllocated = rows.reduce((sum, r) => sum + (r.execution.risk_allocated ?? 0), 0);

      const unrealizedPnl = rows.reduce((sum, r) => {
        const currentPrice = r.legSnap.current_price;
        if (currentPrice === undefined) return sum;
        const signedQty = r.execution.side === "Long" ? r.execution.quantity : -r.execution.quantity;
        return sum + (currentPrice - r.execution.price) * dollarPerPriceUnit * signedQty;
      }, 0);

      // Every leg's quantity = |ratio| * structure lots by construction
      // (AddEntryModal / EditEntryModal) — recover it from whichever leg has
      // the largest ratio magnitude, for numerical stability.
      const anchor = rows.reduce((a, b) => (Math.abs(b.legSnap.leg.ratio) > Math.abs(a.legSnap.leg.ratio) ? b : a));
      const structureLots =
        Math.abs(anchor.legSnap.leg.ratio) > 0 ? anchor.execution.quantity / Math.abs(anchor.legSnap.leg.ratio) : 0;

      const slope = dollarPerPriceUnit * structureLots; // $ per 1 unit move in the composite price
      const stopLossPrice = riskAllocated > 0 && slope > 0 ? avgPrice - riskAllocated / slope : undefined;

      results.push({
        entry_group_id: entryGroupId,
        structure_id: snapshot.structure.id,
        timestamp,
        structure_lots: structureLots,
        avg_price: avgPrice,
        risk_allocated: riskAllocated,
        unrealized_pnl: unrealizedPnl,
        stop_loss_price: stopLossPrice,
        legs: rows.map((r) => ({ leg: r.legSnap.leg, contract: r.legSnap.contract, execution: r.execution })),
      });
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}
