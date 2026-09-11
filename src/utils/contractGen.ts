import { v4 as uuid } from "uuid";
import type { Contract, Instrument } from "../types/domain";
import { frontMonth, lastTradingDay } from "./contractExpiry";

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** e.g. "Apr26" -> Date(2026, 3, 1). Returns undefined if it doesn't parse. */
export function parseMonthLabel(label: string): Date | undefined {
  const match = /^([A-Za-z]{3})(\d{2})$/.exec(label);
  if (!match) return undefined;
  const monthIdx = MONTH_NAMES.findIndex((m) => m.toLowerCase() === match[1].toLowerCase());
  if (monthIdx === -1) return undefined;
  const twoDigitYear = Number(match[2]);
  const year = 2000 + twoDigitYear;
  return new Date(year, monthIdx, 1);
}

function monthLabelFor(date: Date): { label: string; code: string } {
  const monthName = MONTH_NAMES[date.getMonth()];
  const twoDigitYear = date.getFullYear() % 100;
  const suffix = `${monthName}${twoDigitYear}`;
  return { label: suffix, code: monthName.toUpperCase() + twoDigitYear };
}

/**
 * Build a rolling run of monthly contracts, starting at the instrument's
 * actual tradeable FRONT month (see utils/contractExpiry.ts) — not simply
 * `from`'s own calendar month. Brent's front month, for example, runs
 * 2-3 months ahead of today because its last-trading-day is that far
 * before its delivery month; generating from "today" would create months
 * that are already expired by real exchange rules.
 */
export function buildRollingContracts(instrument: Instrument, monthCount = 24, from: Date = new Date()): Contract[] {
  const now = new Date().toISOString();
  const start = frontMonth(instrument, from);
  const out: Contract[] = [];
  for (let i = 0; i < monthCount; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const { label, code } = monthLabelFor(d);
    out.push({
      id: uuid(),
      instrument_id: instrument.id,
      code: `${instrument.symbol}-${code}`,
      month_label: label,
      // The contract's real last-trading-day (utils/contractExpiry.ts) —
      // used both to sort contracts chronologically and to derive whether
      // it's Active / Near Expiry / Expired (always computed against "now",
      // never stored as a separate flag).
      expiry_date: lastTradingDay(instrument, d).toISOString(),
      market_data_symbol: `${instrument.symbol}-${code}`,
      created_at: now,
    });
  }
  return out;
}

/** Sort an instrument's contracts chronologically, oldest first. */
export function sortContractsChronologically(contracts: Contract[]): Contract[] {
  return [...contracts].sort((a, b) => {
    const da = a.expiry_date ? new Date(a.expiry_date).getTime() : parseMonthLabel(a.month_label)?.getTime();
    const db = b.expiry_date ? new Date(b.expiry_date).getTime() : parseMonthLabel(b.month_label)?.getTime();
    if (da === undefined && db === undefined) return a.month_label.localeCompare(b.month_label);
    if (da === undefined) return 1;
    if (db === undefined) return -1;
    return da - db;
  });
}
