import type { StructureSnapshot } from "../types/domain";

const EPS = 1e-9;

/**
 * A trade that currently HOLDS lots: not closed, and at least one leg with a non-zero
 * net position. Correlation, hedging and VaR are about positions, so a trade that is
 * open but flat (everything exited, not yet closed) has nothing to say there.
 */
export function holdsPosition(s: StructureSnapshot): boolean {
  return s.structure.status !== "Fully Closed" && s.legs.some((l) => Math.abs(l.position.net_quantity) > EPS);
}

export type TradeDirection = "long" | "short" | "flat";

/**
 * The trade's open quantity in structure lots, signed (+ long, - short): the net position of
 * the leg with the largest ratio divided by that ratio, falling back to the leg with the most
 * open lots if that anchor leg is itself flat (e.g. a single-leg entry on a multi-leg structure).
 * Lots of several entries add up; opposite entries cancel.
 */
export function netStructureLots(s: StructureSnapshot): number {
  const open = s.legs.filter((l) => Math.abs(l.position.net_quantity) > EPS && Math.abs(l.leg.ratio) > EPS);
  if (open.length === 0) return 0;

  const anchor = s.legs.reduce((a, b) => (Math.abs(b.leg.ratio) > Math.abs(a.leg.ratio) ? b : a));
  const lotsOf = (l: { leg: { ratio: number }; position: { net_quantity: number } }) => l.position.net_quantity / l.leg.ratio;

  if (Math.abs(anchor.position.net_quantity) > EPS) return lotsOf(anchor);
  return lotsOf(open.reduce((a, b) => (Math.abs(lotsOf(b)) > Math.abs(lotsOf(a)) ? b : a)));
}

/**
 * Which way the trade is positioned right now, for the status colour:
 *   "flat"  — no open lots at all, or lots that net to nothing (long and short
 *             entries of equal size cancel out);
 *   "long" / "short" — the sign of the net position in structure lots, taken
 *             from the leg with the largest ratio (the same anchor convention
 *             as CorrelationEngine.structureNetLotsSigned), falling back to the
 *             leg with the most open lots if that anchor leg itself is flat
 *             (e.g. a single-leg entry on a multi-leg structure).
 */
export function tradeDirection(s: StructureSnapshot): TradeDirection {
  const signedLots = netStructureLots(s);
  if (Math.abs(signedLots) <= EPS) return "flat";
  return signedLots > 0 ? "long" : "short";
}

/**
 * Badge style for a trade's status: grey when closed; otherwise a dull blue
 * for long, dull red for short, dull amber for flat.
 */
export function tradeStatusBadgeClass(s: StructureSnapshot): string {
  if (s.structure.status === "Fully Closed") return "badge-fullyclosed";
  const direction = tradeDirection(s);
  return direction === "long" ? "badge-long" : direction === "short" ? "badge-short" : "badge-flat";
}
