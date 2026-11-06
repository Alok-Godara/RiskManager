import type { AlertEvent } from "./alertRules";

/**
 * What has already been sent, per condition key. A condition is sent once when it
 * starts firing; it is re-armed when it stops (e.g. the trade recovers) and can be
 * sent again after that, but never more often than the cooldown.
 */
export type AlertState = Record<string, { active: boolean; lastSentAt: number }>;

/** Same condition is never re-sent within this long, even if it flaps off and on around its threshold. */
export const ALERT_COOLDOWN_MS = 60 * 60_000;
/** Cleared conditions are forgotten after this long. */
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface AlertPlan {
  /** New conditions to send now. */
  toSend: AlertEvent[];
  /** The state to keep if they were sent. */
  next: AlertState;
}

/**
 * Pure planning step. `events` are the conditions firing right now for the rule
 * families being re-checked (`checkedPrefixes`); state of other families (e.g. the
 * correlation alerts while only SL/TP were re-checked) is left untouched.
 */
export function planAlerts(events: AlertEvent[], state: AlertState, checkedPrefixes: string[], now: number, cooldownMs = ALERT_COOLDOWN_MS): AlertPlan {
  const next: AlertState = {};
  const firing = new Set(events.map((e) => e.key));
  const inChecked = (key: string) => checkedPrefixes.some((p) => key.startsWith(p));

  for (const [key, entry] of Object.entries(state)) {
    if (!inChecked(key)) next[key] = entry; // not re-checked this round
    else if (firing.has(key)) next[key] = entry; // handled below
    else if (entry.active) next[key] = { active: false, lastSentAt: entry.lastSentAt }; // condition cleared -> re-arm
    else if (now - entry.lastSentAt < FORGET_AFTER_MS) next[key] = entry;
  }

  const toSend: AlertEvent[] = [];
  for (const e of events) {
    const prev = state[e.key];
    if (prev?.active) continue; // already sent, still firing
    const coolingDown = prev !== undefined && now - prev.lastSentAt < cooldownMs;
    if (coolingDown) {
      next[e.key] = { active: true, lastSentAt: prev.lastSentAt }; // sent recently; don't repeat
      continue;
    }
    toSend.push(e);
    next[e.key] = { active: true, lastSentAt: now };
  }
  return { toSend, next };
}

/** After a failed send, put the not-sent conditions back as they were, so the next check retries them. */
export function revertUnsent(plan: AlertPlan, previous: AlertState): AlertState {
  const next = { ...plan.next };
  for (const e of plan.toSend) {
    if (previous[e.key]) next[e.key] = previous[e.key];
    else delete next[e.key];
  }
  return next;
}
