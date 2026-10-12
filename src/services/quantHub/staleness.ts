/**
 * Is a QuantHub OHLC candle too old to be a useful live price?
 *
 * Rule: stale when the candle is older than 4 hours, OR is not from today.
 *
 * Quirk handled here: QuantHub stamps OHLC candles with LONDON WALL-CLOCK time
 * as if it were UTC (observed live: a candle that closed 5 minutes ago carried
 * a time one hour ahead during British Summer Time). So "today" is today's
 * date in London, and a candle's real age is corrected by London's current UTC
 * offset before comparing to 4 hours.
 */
export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** London's offset from UTC at `at` (epoch ms), in ms: 0 in winter, +1h in summer. */
export function londonOffsetMs(at: number): number {
  const parts = LONDON.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(at / 1000) * 1000;
}

/** YYYY-MM-DD of a London-wall-clock-as-UTC timestamp (what a QuantHub candle time encodes). */
export function wallDate(candleTimeMs: number): string {
  return new Date(candleTimeMs).toISOString().slice(0, 10);
}

/** Today's date in London, YYYY-MM-DD. */
export function londonToday(now: number): string {
  return new Date(now + londonOffsetMs(now)).toISOString().slice(0, 10);
}

export function isStaleCandle(candleTimeMs: number, now: number = Date.now()): boolean {
  const realCandleTime = candleTimeMs - londonOffsetMs(now);
  const ageMs = now - realCandleTime;
  return ageMs > STALE_AFTER_MS || wallDate(candleTimeMs) !== londonToday(now);
}
