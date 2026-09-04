import type { Execution, Position, UUID } from "../types/domain";
import { repository } from "../data";

/**
 * PositionEngine: turns the immutable Execution audit trail into a
 * current Position (net quantity + weighted average price + realized P&L
 * accumulated from exits on this leg).
 *
 * Executions are NEVER mutated or deleted — this engine only reads them
 * and derives/persists the materialized Position.
 */
export class PositionEngine {
  /**
   * Recompute the position for a single leg from its full execution
   * history. This is the weighted-average-price / FIFO realized-P&L
   * calculation described in spec section 8.
   */
  static computePosition(legId: UUID, contractId: UUID, executions: Execution[]): {
    position: Position;
    realizedFromExits: { execution: Execution; quantity: number; entryPrice: number; exitPrice: number; realizedPnl: number }[];
  } {
    // FIFO lot queue of (quantity, price) for entries, signed by side.
    const lots: { quantity: number; price: number }[] = [];
    let realizedPnl = 0;
    const realizedFromExits: {
      execution: Execution;
      quantity: number;
      entryPrice: number;
      exitPrice: number;
      realizedPnl: number;
    }[] = [];

    const sorted = [...executions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const exec of sorted) {
      const signedQty = exec.side === "Long" ? exec.quantity : -exec.quantity;

      const currentNet = lots.reduce((sum, l) => sum + l.quantity, 0);
      const isSameDirection = currentNet === 0 || Math.sign(currentNet) === Math.sign(signedQty);

      if (isSameDirection) {
        // Adding to position
        lots.push({ quantity: signedQty, price: exec.price });
      } else {
        // Reducing / reversing position — realize P&L FIFO
        let remaining = Math.abs(signedQty);
        const exitSide = exec.side; // side of this closing execution
        while (remaining > 0 && lots.length > 0) {
          const lot = lots[0];
          const lotAbs = Math.abs(lot.quantity);
          const closeQty = Math.min(lotAbs, remaining);

          // If lot was Long (positive), closing with a Short exec realizes
          // (exitPrice - entryPrice) * qty. If lot was Short, realizes
          // (entryPrice - exitPrice) * qty.
          const wasLong = lot.quantity > 0;
          const pnlPerUnit = wasLong ? exec.price - lot.price : lot.price - exec.price;
          const pnl = pnlPerUnit * closeQty;
          realizedPnl += pnl;
          realizedFromExits.push({
            execution: exec,
            quantity: closeQty,
            entryPrice: lot.price,
            exitPrice: exec.price,
            realizedPnl: pnl,
          });

          if (closeQty === lotAbs) {
            lots.shift();
          } else {
            lot.quantity = wasLong ? lot.quantity - closeQty : lot.quantity + closeQty;
          }
          remaining -= closeQty;
        }
        if (remaining > 0) {
          // Reversed past flat — open a new lot in the exec's direction
          const newSigned = exitSide === "Long" ? remaining : -remaining;
          lots.push({ quantity: newSigned, price: exec.price });
        }
      }
    }

    const netQuantity = lots.reduce((sum, l) => sum + l.quantity, 0);
    const totalAbsQty = lots.reduce((sum, l) => sum + Math.abs(l.quantity), 0);
    const averagePrice =
      totalAbsQty > 0
        ? lots.reduce((sum, l) => sum + Math.abs(l.quantity) * l.price, 0) / totalAbsQty
        : 0;

    const position: Position = {
      structure_leg_id: legId,
      contract_id: contractId,
      net_quantity: netQuantity,
      average_price: averagePrice,
      realized_pnl: realizedPnl,
      last_updated: new Date().toISOString(),
    };

    return { position, realizedFromExits };
  }

  /** Recompute and persist the position for a leg, given its contract id. */
  static async recomputeAndPersist(legId: UUID, contractId: UUID): Promise<Position> {
    const executions = await repository.getExecutionsByLeg(legId);
    const { position } = this.computePosition(legId, contractId, executions);
    await repository.upsertPosition(position);
    return position;
  }
}
