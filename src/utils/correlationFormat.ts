/** Correlation on QuantHub's scale: an integer from -100 to 100 (0.57 -> "57"). */
export function fmtQh(c: number | undefined): string {
  if (c === undefined || !Number.isFinite(c)) return "—";
  const n = Math.round(c * 100);
  return String(Object.is(n, -0) ? 0 : n);
}

/** Plain-words strength of a correlation, ignoring sign. */
export function correlationStrength(c: number): "essentially unrelated" | "weakly related" | "moderately related" | "strongly related" {
  const a = Math.abs(c);
  if (a < 0.2) return "essentially unrelated";
  if (a < 0.4) return "weakly related";
  if (a < 0.7) return "moderately related";
  return "strongly related";
}
