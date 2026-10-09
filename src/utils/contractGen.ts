import { v5 as uuidv5 } from "uuid";
import type { Contract, Instrument } from "../types/domain";
import { frontMonth, lastTradingDay } from "./contractExpiry";

/** Fixed namespace for deterministic contract ids — never change, ids are derived from it. */
const CONTRACT_ID_NAMESPACE = "6f1d3c9e-5b0a-4c7e-9a52-2d8f4b7c1e30";

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
      // Deterministic (instrument + month), not random: two overlapping runs
      // of the rolling-contract top-up (two tabs, a double-rendered effect)
      // now upsert the SAME row instead of each inserting its own copy —
      // which is how duplicate "Dec26 / Dec26 / Jan27 / Jan27" months got in.
      id: uuidv5(`${instrument.id}:${code}`, CONTRACT_ID_NAMESPACE),
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

function isOutrightContract(c: Contract): boolean {
  return !c.kind || c.kind === "Outright";
}

/**
 * For databases that already hold duplicate outright rows for the same month
 * (same instrument + month label): maps EVERY outright id to the one
 * canonical id for that month (the earliest-created, ties by id), so lookups
 * by month behave as if there were one contract per month. Non-outright
 * contracts are not included. The real fix is merging the rows in the
 * database (supabase/migrations/008_dedupe_contracts.sql); this just keeps
 * the app correct in the meantime.
 */
export function canonicalContractIdMap(contracts: Contract[]): Map<string, string> {
  const best = new Map<string, Contract>();
  for (const c of contracts) {
    if (!isOutrightContract(c)) continue;
    const key = `${c.instrument_id}|${c.month_label}`;
    const current = best.get(key);
    if (!current || c.created_at < current.created_at || (c.created_at === current.created_at && c.id < current.id)) best.set(key, c);
  }
  const out = new Map<string, string>();
  for (const c of contracts) {
    if (isOutrightContract(c)) out.set(c.id, best.get(`${c.instrument_id}|${c.month_label}`)!.id);
  }
  return out;
}

/** Drops duplicate outright rows for the same month, keeping the canonical one; everything else passes through, order preserved. */
export function dedupeContractsByMonth(contracts: Contract[]): Contract[] {
  const canon = canonicalContractIdMap(contracts);
  return contracts.filter((c) => !isOutrightContract(c) || canon.get(c.id) === c.id);
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
