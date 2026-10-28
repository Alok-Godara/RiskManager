/**
 * A trade's price: sum of each leg's ratio x its price — the same composite convention
 * used for entry prices and for exchange-quoted structures. `priceOf` picks which price
 * to use per leg (default: its live price). Undefined if any leg has no price.
 */
export function structurePrice<L extends { leg: { id: string; ratio: number } }>(
  legs: L[],
  priceOf: (l: L) => number | undefined
): number | undefined {
  if (legs.length === 0) return undefined;
  let total = 0;
  for (const l of legs) {
    const price = priceOf(l);
    if (price === undefined || !Number.isFinite(price)) return undefined;
    total += l.leg.ratio * price;
  }
  return total;
}
