import type { Instrument } from "../../types/domain";
import { parseMonthLabel } from "../../utils/contractGen";

/**
 * Standard futures month codes, indexed by JS month (0 = January).
 * F=Jan G=Feb H=Mar J=Apr K=May M=Jun N=Jul Q=Aug U=Sep V=Oct X=Nov Z=Dec
 */
export const FUTURES_MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"] as const;

/**
 * The QuantHub product code for an instrument — its `exchange_code` when
 * set (Settings → Instruments → "QuantHub / exchange code"), else its own
 * symbol. Brent, for example, is "BZ" internally but "CO" on QuantHub, so
 * that mapping lives in the instrument record rather than in code.
 */
export function quantHubProductCode(instrument: Instrument): string {
  return (instrument.exchange_code?.trim() || instrument.symbol).trim().toUpperCase();
}

/**
 * Products whose quoted Spread / Fly structures are listed under a different
 * product code than their outrights. CLBZ (WTI-Brent): outrights are "WTCLCO<month>",
 * but the CME-quoted calendar spread ("spread box") is "CLBZZX<m1>-<m2>" — e.g.
 * CLBZZXQ27-U27. Used when the instrument has no structure code of its own.
 */
const DEFAULT_STRUCTURE_PRODUCT_CODE: Record<string, string> = {
  WTCLCO: "CLBZZX",
};

/**
 * The QuantHub product code for an instrument's quoted structures (Spread, Fly, ...):
 * its `structure_exchange_code` when set, else the built-in default for its outright
 * code, else the outright code itself (Brent: "CO" -> "COQ27-U27").
 */
export function quantHubStructureCode(instrument: Instrument): string {
  const own = instrument.structure_exchange_code?.trim();
  if (own) return own.toUpperCase();
  const outright = quantHubProductCode(instrument);
  return DEFAULT_STRUCTURE_PRODUCT_CODE[outright] ?? outright;
}

/** Just the month+year suffix of a QuantHub code, e.g. "Nov26" -> "X26". */
function monthYearSuffix(monthLabel: string): string | undefined {
  const date = parseMonthLabel(monthLabel);
  if (!date) return undefined;
  const monthCode = FUTURES_MONTH_CODES[date.getMonth()];
  const twoDigitYear = String(date.getFullYear() % 100).padStart(2, "0");
  return `${monthCode}${twoDigitYear}`;
}

/**
 * Build a QuantHub instrument code from a product code and one of our
 * month labels: ("CO", "Nov26") -> "COX26". Returns undefined for a label
 * that doesn't parse, so callers can skip it instead of requesting garbage.
 */
export function toQuantHubCode(productCode: string, monthLabel: string): string | undefined {
  const suffix = monthYearSuffix(monthLabel);
  if (!suffix || !productCode) return undefined;
  return `${productCode}${suffix}`;
}

/**
 * Build the exchange's own composite code for a directly-quoted structure
 * (Fly, Calendar Spread, Double Fly, ...): the product code once, then each
 * leg's month/year suffix in order, joined by "-" — e.g.
 * ("CO", ["Nov26", "Dec26", "Jan27"]) -> "COX26-Z26-F27", a Brent Nov26 Fly.
 * QuantHub quotes these shapes as one product, so this is requested
 * directly instead of deriving a price from the individual outright legs.
 * Returns undefined if any leg's month doesn't parse or the list is empty.
 */
export function buildCompositeQuantHubCode(productCode: string, monthLabels: string[]): string | undefined {
  if (!productCode || monthLabels.length === 0) return undefined;
  const suffixes = monthLabels.map(monthYearSuffix);
  if (suffixes.some((s) => s === undefined)) return undefined;
  const [first, ...rest] = suffixes as string[];
  return `${productCode}${first}${rest.map((s) => `-${s}`).join("")}`;
}
