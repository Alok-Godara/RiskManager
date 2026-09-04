export function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPrice(n: number | undefined): string {
  if (n === undefined) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function pnlClass(n: number): string {
  if (n > 0) return "pnl-pos";
  if (n < 0) return "pnl-neg";
  return "pnl-flat";
}
