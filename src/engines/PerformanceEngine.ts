import type { StructureSnapshot } from "../types/domain";

/** Which trades the performance numbers are taken over. */
export type PerformanceScope = "closed" | "all";

export interface TradeResult {
  id: string;
  name: string;
  /** What the trade made or lost, after all transaction costs (net P&L — for an open trade, as if exited now). */
  net: number;
  /** net ÷ the initial risk given to the trade; undefined when no initial risk was set. */
  r_multiple?: number;
}

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** wins ÷ trades, 0..1 — undefined with no trades. */
  win_rate?: number;
  gross_profit: number; // sum of the winning trades
  gross_loss: number; // sum of the losing trades, as a positive number
  /** gross profit ÷ gross loss. Infinity when there are wins and no losses; undefined with neither. */
  profit_factor?: number;
  avg_win?: number;
  avg_loss?: number; // positive number
  /** avg win ÷ avg loss — how much a win is worth next to a loss. */
  payoff_ratio?: number;
  net_total: number;
  /** average net per trade, in $. */
  expectancy?: number;
  /** average R multiple per trade (trades that had an initial risk). */
  avg_r?: number;
  best?: TradeResult;
  worst?: TradeResult;
}

const CENT = 0.005;

/**
 * PerformanceEngine: win rate, profit factor and friends, over TRADES (the
 * rows on the Trades page) — each trade counts once, by its net P&L after
 * transaction costs.
 *
 *   "closed" — only trades you closed: the trades with a final, settled result.
 *   "all"    — every trade you have entered, open ones at their current net P&L
 *              (what they would be if exited now). Trades never entered are skipped.
 */
export class PerformanceEngine {
  static results(snapshots: StructureSnapshot[], scope: PerformanceScope): TradeResult[] {
    return snapshots
      .filter((s) => {
        if (s.entry_timestamps.length === 0) return false; // never entered — nothing happened
        return scope === "all" || s.structure.status === "Fully Closed";
      })
      .map((s) => {
        const risk = s.structure.initial_dollar_risk;
        return {
          id: s.structure.id,
          name: s.structure.name,
          net: s.net_pnl,
          r_multiple: risk > 0 ? s.net_pnl / risk : undefined,
        };
      });
  }

  static summarize(results: TradeResult[]): PerformanceStats {
    const wins = results.filter((r) => r.net > CENT);
    const losses = results.filter((r) => r.net < -CENT);
    const grossProfit = wins.reduce((sum, r) => sum + r.net, 0);
    const grossLoss = losses.reduce((sum, r) => sum - r.net, 0);
    const netTotal = results.reduce((sum, r) => sum + r.net, 0);
    const rs = results.filter((r) => r.r_multiple !== undefined).map((r) => r.r_multiple as number);

    const avgWin = wins.length > 0 ? grossProfit / wins.length : undefined;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : undefined;

    let profitFactor: number | undefined;
    if (grossLoss > 0) profitFactor = grossProfit / grossLoss;
    else if (grossProfit > 0) profitFactor = Infinity;

    const sorted = [...results].sort((a, b) => b.net - a.net);

    return {
      trades: results.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: results.length - wins.length - losses.length,
      win_rate: results.length > 0 ? wins.length / results.length : undefined,
      gross_profit: grossProfit,
      gross_loss: grossLoss,
      profit_factor: profitFactor,
      avg_win: avgWin,
      avg_loss: avgLoss,
      payoff_ratio: avgWin !== undefined && avgLoss !== undefined && avgLoss > 0 ? avgWin / avgLoss : undefined,
      net_total: netTotal,
      expectancy: results.length > 0 ? netTotal / results.length : undefined,
      avg_r: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : undefined,
      // Only a real win can be "best" and only a real loss "worst".
      best: sorted.length > 0 && sorted[0].net > CENT ? sorted[0] : undefined,
      worst: sorted.length > 0 && sorted[sorted.length - 1].net < -CENT ? sorted[sorted.length - 1] : undefined,
    };
  }
}
