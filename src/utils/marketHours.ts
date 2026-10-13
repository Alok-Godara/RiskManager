import { londonOffsetMs } from "../services/quantHub/staleness";

/**
 * Weekend pause. The oil futures this app trades are closed over the weekend,
 * so prices cannot change and polling would only burn requests (and the free
 * database's data allowance) for nothing.
 *
 * Paused: from Saturday 00:00 until Sunday 22:00, London time. The pause ends
 * an hour BEFORE the Sunday-evening open (NYMEX WTI reopens at 23:00 London;
 * ICE Brent a little later) so the first quotes of the week are caught. Friday
 * is NOT paused — both markets trade until late Friday, and the stale-price
 * logic covers the quiet hours after the close.
 *
 * It uses London's clock, with daylight saving, so it is right in both summer
 * and winter. Exchange holidays are not modelled.
 */
const PAUSE_ENDS_SUNDAY_MINUTE = 22 * 60;

export function isWeekendPause(now: number = Date.now()): boolean {
  const wall = new Date(now + londonOffsetMs(now)); // London wall clock, read via UTC fields
  const day = wall.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const minuteOfDay = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return day === 6 || (day === 0 && minuteOfDay < PAUSE_ENDS_SUNDAY_MINUTE);
}
