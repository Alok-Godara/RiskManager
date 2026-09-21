import type { Execution, EntrySnapshot, LegSnapshot, StructureSnapshot, UUID } from "../types/domain";
import { repository } from "../data";

const EPS = 1e-9;

/**
 * EntryEngine: groups the flat, per-leg Execution audit trail back into
 * "Entries" — one row per Add Entry submission, spanning every leg it
 * touched (see Execution.entry_group_id) — for the StructureDetail Entries
 * table. Read-only / derived; StructureEngine remains the only writer.
 *
 * An entry can be a normal STRUCTURE entry (every leg, quantities
 * proportional to the leg ratios, one common direction) or a CUSTOM one
 * (only some legs, or per-leg lots/sides edited). Structure-level figures —
 * composite average price, structure lots, a single Long/Short side, the
 * composite stop level — only make sense for the first kind; for custom
 * entries they're left undefined/"Mixed" and the per-leg rows carry the
 * detail.
 *
 * Exits are entry-scoped (Execution.closes_entry_group_id — see
 * PositionEngine), so each leg's closed/open quantity is derived directly
 * by filtering exits that named THIS entry, rather than guessing from FIFO.
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
      const baseRows = executions
        .map((execution) => {
          const legSnap = legById.get(execution.structure_leg_id);
          return legSnap ? { execution, legSnap } : undefined;
        })
        .filter((r): r is { execution: Execution; legSnap: LegSnapshot } => Boolean(r));
      if (baseRows.length === 0) continue;

      const closingExecutions = exitExecutions.filter((e) => e.closes_entry_group_id === entryGroupId);

      // Per-leg entered / closed / open lots for THIS entry.
      const rows = baseRows.map((r) => {
        const closedQty = closingExecutions
          .filter((e) => e.structure_leg_id === r.legSnap.leg.id)
          .reduce((sum, e) => sum + e.quantity, 0);
        const enteredQty = r.execution.quantity;
        return { ...r, enteredQty, closedQty, openQty: Math.max(enteredQty - closedQty, 0) };
      });

      const timestamp = rows.reduce((min, r) => (r.execution.timestamp < min ? r.execution.timestamp : min), rows[0].execution.timestamp);
      const riskAllocated = rows.reduce((sum, r) => sum + (r.execution.risk_allocated ?? 0), 0);

      // Is this a normal structure entry? Every leg present, lots proportional
      // to |ratio|, and one common direction (side = sideFromRatio(ratio * d)).
      const anchor = rows.reduce((a, b) => (Math.abs(b.legSnap.leg.ratio) > Math.abs(a.legSnap.leg.ratio) ? b : a));
      const anchorRatioAbs = Math.abs(anchor.legSnap.leg.ratio);
      const structureLots = anchorRatioAbs > 0 ? anchor.enteredQty / anchorRatioAbs : 0;
      const direction: 1 | -1 = anchor.legSnap.leg.ratio >= 0 === (anchor.execution.side === "Long") ? 1 : -1;
      const sidesFollowDirection = rows.every((r) => r.execution.side === (r.legSnap.leg.ratio * direction >= 0 ? "Long" : "Short"));
      const isStructureEntry =
        rows.length === snapshot.legs.length &&
        structureLots > 0 &&
        sidesFollowDirection &&
        rows.every((r) => {
          const ratioAbs = Math.abs(r.legSnap.leg.ratio);
          return Math.abs(r.enteredQty - ratioAbs * structureLots) <= EPS * Math.max(1, r.enteredQty);
        });

      let side: EntrySnapshot["side"];
      if (isStructureEntry || (rows.length > 1 && sidesFollowDirection)) side = direction === 1 ? "Long" : "Short";
      else if (rows.length === 1) side = rows[0].execution.side;
      else side = rows.every((r) => r.execution.side === rows[0].execution.side) ? rows[0].execution.side : "Mixed";

      // Entry-level lots: structure lots for a structure entry (however many
      // are still open on the most-open leg), plain total leg lots otherwise.
      let entryLots: number;
      let openLots: number;
      if (isStructureEntry) {
        entryLots = structureLots;
        openLots = Math.max(...rows.map((r) => r.openQty / Math.abs(r.legSnap.leg.ratio || 1)));
      } else {
        entryLots = rows.reduce((s, r) => s + r.enteredQty, 0);
        openLots = rows.reduce((s, r) => s + r.openQty, 0);
      }
      const closedLots = Math.max(entryLots - openLots, 0);

      // Composite (sum ratio_i * price_i) prices only exist for a structure entry.
      const avgPrice = isStructureEntry ? rows.reduce((sum, r) => sum + r.legSnap.leg.ratio * r.execution.price, 0) : undefined;

      let avgExitPrice: number | undefined;
      if (isStructureEntry && closedLots > 0) {
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

      const closingExecutionIds = new Set(closingExecutions.map((e) => e.id));
      const realizedPnl = allRealizedEvents
        .filter((ev) => closingExecutionIds.has(ev.execution_id))
        .reduce((sum, ev) => sum + ev.realized_pnl, 0);

      // Unrealized P&L reflects only what's still open on each leg.
      const unrealizedPnl = rows.reduce((sum, r) => {
        const currentPrice = r.legSnap.current_price;
        if (currentPrice === undefined) return sum;
        const signedQty = r.execution.side === "Long" ? r.openQty : -r.openQty;
        return sum + (currentPrice - r.execution.price) * dollarPerPriceUnit * signedQty;
      }, 0);

      // Stop level, fixed at entry time against the ORIGINAL size. A Long
      // loses as price falls (stop BELOW entry), a Short as it rises (ABOVE).
      // Composite level for a structure entry; the leg's own price level for
      // a single-leg entry; undefined for other custom entries.
      let stopLossPrice: number | undefined;
      if (riskAllocated > 0 && dollarPerPriceUnit > 0) {
        if (isStructureEntry && avgPrice !== undefined) {
          const distance = riskAllocated / (dollarPerPriceUnit * structureLots);
          stopLossPrice = side === "Long" ? avgPrice - distance : avgPrice + distance;
        } else if (rows.length === 1 && rows[0].enteredQty > 0) {
          const distance = riskAllocated / (dollarPerPriceUnit * rows[0].enteredQty);
          stopLossPrice = rows[0].execution.side === "Long" ? rows[0].execution.price - distance : rows[0].execution.price + distance;
        }
      }

      results.push({
        entry_group_id: entryGroupId,
        structure_id: snapshot.structure.id,
        timestamp,
        kind: isStructureEntry ? "structure" : "custom",
        structure_lots: entryLots,
        side,
        avg_price: avgPrice,
        risk_allocated: riskAllocated,
        open_quantity: openLots,
        closed_quantity: closedLots,
        avg_exit_price: avgExitPrice,
        unrealized_pnl: unrealizedPnl,
        realized_pnl: realizedPnl,
        stop_loss_price: stopLossPrice,
        legs: rows.map((r) => ({
          leg: r.legSnap.leg,
          contract: r.legSnap.contract,
          execution: r.execution,
          entered_qty: r.enteredQty,
          closed_qty: r.closedQty,
          open_qty: r.openQty,
        })),
      });
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}
