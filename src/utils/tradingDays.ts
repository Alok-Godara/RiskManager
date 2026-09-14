import { addDays, businessDayOnOrBefore, isWeekday } from "./contractExpiry";

// ---------------------------------------------------------------------------
// "Which calendar day is the settlement feed's data actually for" — distinct
// from utils/contractExpiry.ts, which answers "when does a specific
// contract month stop trading." Weekends-only (no exchange holiday
// calendar), same deliberate simplification and for the same reason: it
// places the boundary within a day, which only matters when "now" lands
// exactly on a holiday.
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD", the format the settlement API's `date` query param takes. */
export function formatDateParam(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The most recent COMPLETE trading day as of `now` — settlements for
 * today's own session aren't published until after close (often the next
 * morning), so this is always strictly before today: yesterday if that was
 * a weekday, otherwise the Friday before a Sat/Sun/Mon "now".
 */
export function previousTradingDay(now: Date = new Date()): Date {
  return businessDayOnOrBefore(addDays(now, -1));
}

/**
 * `count` consecutive trading days ending at (and including) `mostRecent`,
 * oldest first — the window buildStructureDailySeries / rolling
 * correlations are computed over.
 */
export function tradingDaysIncluding(mostRecent: Date, count: number): Date[] {
  const days: Date[] = [];
  let cur = mostRecent;
  while (days.length < count) {
    if (isWeekday(cur)) days.push(cur);
    cur = addDays(cur, -1);
  }
  return days.reverse();
}
