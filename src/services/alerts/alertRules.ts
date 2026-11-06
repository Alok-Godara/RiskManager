import type { PortfolioConcentrationAnalysis, StructureSnapshot } from "../../types/domain";
import { fmtMoney } from "../../utils/format";

/** An open entry is "near its stop" once its loss has used this share of the risk allocated to it (1 = stop hit). */
export const NEAR_STOP_FRACTION = 0.8;
/** A trade is flagged once its net profit reaches this multiple of its initial risk. */
export const PROFIT_TARGET_MULTIPLE = 1.5;
/** The correlation window the Dashboard's diversified/concentrated read is taken from. */
export const CORRELATION_STATUS_WINDOW = 60;

export type AlertKind = "stop-hit" | "stop-near" | "profit-target" | "concentration" | "correlation";

export interface AlertEvent {
  /** Stable identity of the condition (kind + trade/pair), used to send each condition once, not on every check. */
  key: string;
  kind: AlertKind;
  title: string;
  detail: string;
}

/** Which family of keys a rule produces — lets the dispatcher clear only the families that were actually re-checked. */
export const STOP_PROFIT_KEY_PREFIXES = ["stop-hit:", "stop-near:", "profit:"];
export const CORRELATION_KEY_PREFIXES = ["concentration", "corr:"];

const EPS = 1e-9;

/** Open entries at/near their stop loss (the Dashboard's "near stop" alerts). */
export function stopAlerts(snapshots: StructureSnapshot[]): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const s of snapshots) {
    if (s.structure.status === "Fully Closed" || s.stop_usage === undefined) continue;
    const u = s.stop_usage;
    if (u.usage < NEAR_STOP_FRACTION - EPS) continue;
    const pct = `${(u.usage * 100).toFixed(0)}%`;
    const numbers = `loss ${fmtMoney(u.loss)} of ${fmtMoney(u.risk)} risk`;
    if (u.usage >= 1) {
      events.push({ key: `stop-hit:${s.structure.id}`, kind: "stop-hit", title: `Stop loss hit — ${s.structure.name}`, detail: `At or past its stop loss: ${pct} of the way (${numbers}).` });
    } else {
      events.push({ key: `stop-near:${s.structure.id}`, kind: "stop-near", title: `Near stop loss — ${s.structure.name}`, detail: `${pct} of the way to its stop loss (${numbers}).` });
    }
  }
  return events;
}

/** Trades whose net P&L has reached PROFIT_TARGET_MULTIPLE x their initial risk (the Dashboard's profit-target alerts). */
export function profitAlerts(snapshots: StructureSnapshot[]): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const s of snapshots) {
    if (s.structure.status === "Fully Closed") continue;
    const initial = s.structure.initial_dollar_risk;
    if (!(initial > 0) || s.net_pnl < PROFIT_TARGET_MULTIPLE * initial - EPS) continue;
    events.push({
      key: `profit:${s.structure.id}`,
      kind: "profit-target",
      title: `Profit target reached — ${s.structure.name}`,
      detail: `Net profit ${fmtMoney(s.net_pnl)} is ${(s.net_pnl / initial).toFixed(1)}x its initial risk (${fmtMoney(initial)}).`,
    });
  }
  return events;
}

/** The Dashboard's "Concentrated" verdict plus every highly-correlated pair, read from the 60-day window. */
export function correlationAlerts(analysis: PortfolioConcentrationAnalysis | undefined): AlertEvent[] {
  if (!analysis) return [];
  const events: AlertEvent[] = [];
  const window = CORRELATION_STATUS_WINDOW;
  if (analysis.isConcentrated) {
    const share = analysis.sameDirectionRiskFraction === undefined ? "" : ` Same-direction risk ${(analysis.sameDirectionRiskFraction * 100).toFixed(0)}% (${window}d).`;
    events.push({
      key: "concentration",
      kind: "concentration",
      title: "Portfolio is concentrated",
      detail: `The open trades mostly move together.${share}`,
    });
  }
  for (const p of analysis.highCorrelationPairs) {
    const c = p.windows.find((w) => w.window === window)?.correlation;
    events.push({
      key: `corr:${[p.structure_a_id, p.structure_b_id].sort().join(":")}`,
      kind: "correlation",
      title: `High correlation — ${p.structure_a_name} & ${p.structure_b_name}`,
      detail: `Correlation ${c === undefined ? "n/a" : c.toFixed(2)} over ${window} trading days.`,
    });
  }
  return events;
}
