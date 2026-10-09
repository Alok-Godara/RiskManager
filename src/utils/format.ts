export function fmtMoney(n: number): string {
  // Judge the sign on the rounded cents, so -0.001 reads "$0.00", not "-$0.00".
  const sign = Math.round(n * 100) < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPrice(n: number | undefined): string {
  if (n === undefined) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function pnlClass(n: number): string {
  const cents = Math.round(n * 100);
  if (cents > 0) return "pnl-pos";
  if (cents < 0) return "pnl-neg";
  return "pnl-flat";
}

/**
 * A trade is either Open or Closed — Closed only when the user closes it (see
 * StructureEngine.closeTrade). The stored status string stays "Fully Closed"
 * for compatibility; older "Partially Closed" / "Modified" values read as Open.
 */
export function statusLabel(status: string): "Open" | "Closed" {
  return status === "Fully Closed" ? "Closed" : "Open";
}

export function statusBadgeClass(status: string): string {
  return status === "Fully Closed" ? "badge-fullyclosed" : "badge-open";
}
