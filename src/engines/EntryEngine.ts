import type { Execution, EntrySnapshot, LegSide, LegSnapshot, StructureSnapshot, UUID } from "../types/domain";
import { repository } from "../data";

/**
 * EntryEngine: groups the flat, per-leg Execution audit trail back into
 * "Entries" — one row per Add Entry submission, spanning every leg it
 * touched (see Execution.entry_group_id) — for the StructureDetail Entries
 * table. Read-only / derived; StructureEngine remains the only writer.
 *
 * Exits are entry-scoped (Execution.closes_entry_group_id — see
 * PositionEngine), so each entry's own closed/open quantity, average exit
 * price, and realized P&L can be derived directly by filtering exits that
 * named THIS entry, rather than guessing from FIFO order.
 */
export class EntryEngine {
  static async buildEntrySnapshots(snapshot: StructureSnapshot): Promise<EntrySnapshot[]> {
    const instrument = await repository.getInstrument(snapshot.structure.instrument_id);
    const dollarPerPriceUnit = instrument ? instrument.tick_value / instrument.tick_size : 0;

    const legById = new Map(snapshot.legs.map((l) => [l.leg.id, l]));
    const executionLists = await Promise.all(snapshot.legs.map((l) => repository.getExecutionsByLeg(l.leg.id)));
    const allActive = executionLists.flat().filter((e) => e.status === "Active");
    const entryExecutions = allActive.filter((e) => e.execution_type === "Entry");
    const exitExecutions = allActive.filter((e) => e.execution_type !== "Entry");

    const realizedEventLists = await Promise.all(snapshot.legs.map((l) => repository.getRealizedPnLEventsByLeg(l.leg.id)));
    const allRealizedEvents = realizedEventLists.flat();

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

      // Every leg's quantity = |ratio| * structure lots by construction
      // (AddEntryModal / EditEntryModal) — recover it from whichever leg has
      // the largest ratio magnitude, for numerical stability.
      const anchor = rows.reduce((a, b) => (Math.abs(b.legSnap.leg.ratio) > Math.abs(a.legSnap.leg.ratio) ? b : a));
      const anchorRatioAbs = Math.abs(anchor.legSnap.leg.ratio);
      const structureLots = anchorRatioAbs > 0 ? anchor.execution.quantity / anchorRatioAbs : 0;

      // This entry's own chosen direction (StructureEngine.addEntry's
      // `direction`) — NOT simply the anchor leg's own execution.side,
      // which flips with that leg's ratio sign (e.g. a Fly's middle leg is
      // ratio -2, so its own side reads "Short" even on a Long entry).
      // side = sideFromRatio(leg.ratio * direction), so recovering
      // direction just compares whether the leg's ratio sign and its
      // recorded side agree.
      const anchorRatioNonNegative = anchor.legSnap.leg.ratio >= 0;
      const anchorSideIsLong = anchor.execution.side === "Long";
      const side: LegSide = anchorRatioNonNegative === anchorSideIsLong ? "Long" : "Short";

      // This entry's own exits, entry-scoped (closes_entry_group_id), never
      // FIFO-guessed — see PositionEngine's per-entry lot tracking.
      const closingExecutions = exitExecutions.filter((e) => e.closes_entry_group_id === entryGroupId);
      const anchorCloses = closingExecutions.filter((e) => e.structure_leg_id === anchor.legSnap.leg.id);
      const closedQtyOnAnchor = anchorCloses.reduce((sum, e) => sum + e.quantity, 0);
      const closedQuantity = anchorRatioAbs > 0 ? closedQtyOnAnchor / anchorRatioAbs : 0;
      const openQuantity = Math.max(structureLots - closedQuantity, 0);

      // Composite exit price (same sum(ratio_i * price_i) convention as
      // avgPrice), qty-weighted per leg across possibly-multiple partial
      // exits — only defined once every leg has at least one exit recorded
      // against this entry.
      let avgExitPrice: number | undefined;
      if (closedQuantity > 0) {
        let complete = true;
        let composite = 0;
        for (const r of rows) {
          const legCloses = closingExecutions.filter((e) => e.structure_leg_id === r.legSnap.leg.id);
          const qty = legCloses.reduce((sum, e) => sum + e.quantity, 0);
          if (qty === 0) {
            complete = false;
            break;
          }
          const weightedPrice = legCloses.reduce((sum, e) => sum + e.quantity * e.price, 0) / qty;
          composite += r.legSnap.leg.ratio * weightedPrice;
        }
        if (complete) avgExitPrice = composite;
      }

      // Realized P&L for this entry: RealizedPnLEvent rows produced by
      // exits that closed it, cross-referenced by execution_id — already in
      // $ (PositionEngine applies the tick-value conversion before these
      // events are recorded), so no re-derivation needed here.
      const closingExecutionIds = new Set(closingExecutions.map((e) => e.id));
      const realizedPnl = allRealizedEvents
        .filter((ev) => closingExecutionIds.has(ev.execution_id))
        .reduce((sum, ev) => sum + ev.realized_pnl, 0);

      // Unrealized P&L reflects only what's still open on this entry, not
      // its original full size — a partially-exited entry's unrealized P&L
      // shrinks accordingly.
      const unrealizedPnl = rows.reduce((sum, r) => {
        const currentPrice = r.legSnap.current_price;
        if (currentPrice === undefined) return sum;
        const legOpenQty = Math.abs(r.legSnap.leg.ratio) * openQuantity;
        const signedQty = r.execution.side === "Long" ? legOpenQty : -legOpenQty;
        return sum + (currentPrice - r.execution.price) * dollarPerPriceUnit * signedQty;
      }, 0);

      // Stop-loss level is fixed at entry time against the ORIGINAL entry
      // size, not scaled down as it's partially exited.
      const slope = dollarPerPriceUnit * structureLots; // $ per 1 unit move in the composite price
      const stopLossPrice = riskAllocated > 0 && slope > 0 ? avgPrice - riskAllocated / slope : undefined;

      results.push({
        entry_group_id: entryGroupId,
        structure_id: snapshot.structure.id,
        timestamp,
        structure_lots: structureLots,
        side,
        avg_price: avgPrice,
        risk_allocated: riskAllocated,
        open_quantity: openQuantity,
        closed_quantity: closedQuantity,
        avg_exit_price: avgExitPrice,
        unrealized_pnl: unrealizedPnl,
        realized_pnl: realizedPnl,
        stop_loss_price: stopLossPrice,
        legs: rows.map((r) => ({ leg: r.legSnap.leg, contract: r.legSnap.contract, execution: r.execution })),
      });
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}
