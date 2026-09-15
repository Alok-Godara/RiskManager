import type { Execution, Position, UUID } from "../types/domain";
import { repository } from "../data";

/**
 * PositionEngine: turns the immutable Execution audit trail into a
 * current Position (net quantity + weighted average price + realized P&L
 * accumulated from exits on this leg).
 *
 * Executions are NEVER mutated or deleted — this engine only reads them
 * and derives/persists the materialized Position.
 *
 * Positions are tracked as INDEPENDENT lots per entry (entry_group_id), not
 * one FIFO queue across the whole leg. An exit names which entry it's
 * closing (`Execution.closes_entry_group_id`) — entry #2 always realizes
 * P&L against entry #2's own fill price, never entry #1's, regardless of
 * order (a deliberate choice over simpler FIFO reuse, since a structure's
 * entries can now each carry their own direction — see
 * StructureEngine.addEntry). An exit with no target (pre-migration data,
 * before exits were entry-scoped) falls back to the engine's original
 * FIFO-oldest-open-entry behavior so historical positions don't silently
 * change.
 */
export class PositionEngine {
  /**
   * Recompute the position for a single leg from its full execution
   * history. `dollarPerPriceUnit` (instrument.tick_value / tick_size, same
   * source PnLEngine.unrealizedPnl uses) converts realized P&L from raw
   * price difference into actual $ — previously missing here, which made
   * realized P&L read like raw ticks instead of money.
   */
  static computePosition(
    legId: UUID,
    contractId: UUID,
    executions: Execution[],
    dollarPerPriceUnit: number
  ): {
    position: Position;
    realizedFromExits: { execution: Execution; quantity: number; entryPrice: number; exitPrice: number; realizedPnl: number }[];
    /** Remaining signed quantity + entry price per entry_group_id, after every execution — lets callers (e.g. StructureEngine.exitLeg) look up one entry's own open exposure without re-deriving the lot math. */
    lotsByEntry: Record<UUID, { quantity: number; price: number }>;
  } {
    // entry_group_id -> remaining signed quantity + that entry's own price.
    // Map preserves insertion order, which is chronological (see `sorted`
    // below) — used by the legacy FIFO fallback.
    const lots = new Map<UUID, { quantity: number; price: number }>();
    let realizedPnl = 0;
    const realizedFromExits: {
      execution: Execution;
      quantity: number;
      entryPrice: number;
      exitPrice: number;
      realizedPnl: number;
    }[] = [];

    const sorted = [...executions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const realize = (exec: Execution, lot: { quantity: number; price: number }, closeQty: number) => {
      const wasLong = lot.quantity > 0;
      const pnlPerUnit = wasLong ? exec.price - lot.price : lot.price - exec.price;
      const pnl = pnlPerUnit * closeQty * dollarPerPriceUnit;
      realizedPnl += pnl;
      realizedFromExits.push({ execution: exec, quantity: closeQty, entryPrice: lot.price, exitPrice: exec.price, realizedPnl: pnl });
      lot.quantity = wasLong ? lot.quantity - closeQty : lot.quantity + closeQty;
    };

    for (const exec of sorted) {
      if (exec.execution_type === "Entry") {
        const signedQty = exec.side === "Long" ? exec.quantity : -exec.quantity;
        const existing = lots.get(exec.entry_group_id);
        if (existing) {
          // Scale-in to the same entry group — shouldn't normally happen
          // (Add Entry always mints a fresh entry_group_id) but merge
          // safely, weighted-average the price, if it does.
          const totalAbs = Math.abs(existing.quantity) + Math.abs(signedQty);
          const price =
            totalAbs > 0 ? (Math.abs(existing.quantity) * existing.price + Math.abs(signedQty) * exec.price) / totalAbs : exec.price;
          lots.set(exec.entry_group_id, { quantity: existing.quantity + signedQty, price });
        } else {
          lots.set(exec.entry_group_id, { quantity: signedQty, price: exec.price });
        }
        continue;
      }

      // Exit-type execution.
      if (exec.closes_entry_group_id) {
        const lot = lots.get(exec.closes_entry_group_id);
        if (lot && lot.quantity !== 0) {
          const closeQty = Math.min(Math.abs(lot.quantity), exec.quantity);
          realize(exec, lot, closeQty);
        }
        continue;
      }

      // Legacy fallback: no recorded target (pre-migration data) — FIFO
      // across whichever entries this exit's side would reduce, oldest
      // first, matching this engine's original behavior before exits
      // became entry-scoped.
      let remaining = exec.quantity;
      for (const lot of lots.values()) {
        if (remaining <= 0) break;
        if (lot.quantity === 0) continue;
        const wasLong = lot.quantity > 0;
        const reduces = (wasLong && exec.side === "Short") || (!wasLong && exec.side === "Long");
        if (!reduces) continue;
        const closeQty = Math.min(Math.abs(lot.quantity), remaining);
        realize(exec, lot, closeQty);
        remaining -= closeQty;
      }
      if (remaining > 0) {
        // Reversed past flat — open a new lot in the exit's own direction,
        // keyed under the exit's own entry_group_id so it stays trackable.
        const newSigned = exec.side === "Long" ? remaining : -remaining;
        const existing = lots.get(exec.entry_group_id);
        lots.set(exec.entry_group_id, { quantity: (existing?.quantity ?? 0) + newSigned, price: exec.price });
      }
    }

    const openLots = Array.from(lots.values()).filter((l) => l.quantity !== 0);
    const netQuantity = openLots.reduce((sum, l) => sum + l.quantity, 0);
    const totalAbsQty = openLots.reduce((sum, l) => sum + Math.abs(l.quantity), 0);
    const averagePrice = totalAbsQty > 0 ? openLots.reduce((sum, l) => sum + Math.abs(l.quantity) * l.price, 0) / totalAbsQty : 0;

    const position: Position = {
      structure_leg_id: legId,
      contract_id: contractId,
      net_quantity: netQuantity,
      average_price: averagePrice,
      realized_pnl: realizedPnl,
      last_updated: new Date().toISOString(),
    };

    return { position, realizedFromExits, lotsByEntry: Object.fromEntries(lots) };
  }

  /** Recompute and persist the position for a leg, given its contract id. */
  static async recomputeAndPersist(legId: UUID, contractId: UUID, dollarPerPriceUnit: number): Promise<Position> {
    const executions = await repository.getExecutionsByLeg(legId);
    const { position } = this.computePosition(legId, contractId, executions, dollarPerPriceUnit);
    await repository.upsertPosition(position);
    return position;
  }
}
