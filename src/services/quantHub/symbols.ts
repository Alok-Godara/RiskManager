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
 * Build a QuantHub instrument code from a product code and one of our
 * month labels: ("CO", "Nov26") -> "COX26". Returns undefined for a label
 * that doesn't parse, so callers can skip it instead of requesting garbage.
 */
export function toQuantHubCode(productCode: string, monthLabel: string): string | undefined {
  const date = parseMonthLabel(monthLabel);
  if (!date || !productCode) return undefined;
  const monthCode = FUTURES_MONTH_CODES[date.getMonth()];
  const twoDigitYear = String(date.getFullYear() % 100).padStart(2, "0");
  return `${productCode}${monthCode}${twoDigitYear}`;
}
