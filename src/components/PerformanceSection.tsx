import { useMemo, useState } from "react";
import type { StructureSnapshot } from "../types/domain";
import { PerformanceEngine, type PerformanceScope } from "../engines/PerformanceEngine";
import { fmtMoney, pnlClass } from "../utils/format";
import { InfoTip } from "./InfoTip";

const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;
const fmtRatio = (n: number) => (n === Infinity ? "∞" : n.toFixed(2));
const fmtR = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}R`;

/**
 * Dashboard "Performance": win rate, profit factor and the other numbers that
 * say whether the trading is working — over trades (the rows on the Trades
 * page), each by its net P&L after transaction costs. See PerformanceEngine.
 */
export function PerformanceSection({ snapshots }: { snapshots: StructureSnapshot[] }) {
  const [scope, setScope] = useState<PerformanceScope>("closed");
  const stats = useMemo(() => PerformanceEngine.summarize(PerformanceEngine.results(snapshots, scope)), [snapshots, scope]);
  const empty = stats.trades === 0;

  return (
    <>
      <div className="section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span>
          Performance
          <InfoTip>
            Every number here counts each trade once, by its net P&amp;L (after all transaction costs). "Closed trades" uses only
            trades you have closed — their final result. "All trades" also includes trades still open, at what they would make if
            you exited now. Trades you never entered are left out.
          </InfoTip>
        </span>
        <span className="button-row" style={{ margin: 0, gap: 6 }}>
          <button type="button" className={scope === "closed" ? "" : "secondary"} onClick={() => setScope("closed")}>
            Closed trades
          </button>
          <button type="button" className={scope === "all" ? "" : "secondary"} onClick={() => setScope("all")}>
            All trades
          </button>
        </span>
      </div>

      {empty ? (
        <p className="helper-text">
          {scope === "closed"
            ? "No closed trades yet — close a trade to see its result here, or switch to All trades."
            : "No trades with entries yet."}
        </p>
      ) : (
        <div className="card-grid">
          <div className="stat-card">
            <div className="stat-label">
              Win Rate
              <InfoTip>The share of trades that made money: winning trades ÷ all trades counted. A break-even trade (within a cent of zero) is neither a win nor a loss.</InfoTip>
            </div>
            <div className="stat-value">{stats.win_rate !== undefined ? fmtPct(stats.win_rate) : "—"}</div>
            <div className="stat-sub">
              {stats.wins} won · {stats.losses} lost{stats.breakeven > 0 ? ` · ${stats.breakeven} flat` : ""} (of {stats.trades})
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-label">
              Profit Factor
              <InfoTip>
                Total profit from winning trades ÷ total loss from losing trades. Above 1.00 the trading makes money overall; 2.00 means
                it makes $2 for every $1 lost. ∞ means there are wins and no losses yet.
              </InfoTip>
            </div>
            <div className={`stat-value ${stats.profit_factor === undefined ? "" : stats.profit_factor >= 1 ? "pnl-pos" : "pnl-neg"}`}>
              {stats.profit_factor !== undefined ? fmtRatio(stats.profit_factor) : "—"}
            </div>
            <div className="stat-sub">
              {fmtMoney(stats.gross_profit)} won ÷ {fmtMoney(stats.gross_loss)} lost
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-label">
              Expectancy
              <InfoTip>
                What an average trade makes: total net P&amp;L ÷ number of trades. The R figure is the same thing measured in units of the
                initial risk you gave each trade (+0.50R = on average half of the risk amount is made per trade).
              </InfoTip>
            </div>
            <div className={`stat-value ${stats.expectancy === undefined ? "" : pnlClass(stats.expectancy)}`}>
              {stats.expectancy !== undefined ? fmtMoney(stats.expectancy) : "—"}
            </div>
            <div className="stat-sub">
              per trade{stats.avg_r !== undefined ? ` · avg ${fmtR(stats.avg_r)}` : ""} · total {fmtMoney(stats.net_total)}
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-label">
              Avg Win / Avg Loss
              <InfoTip>
                The average winning trade and the average losing trade. The payoff ratio is avg win ÷ avg loss — how many losses one win
                pays for. A low win rate can still be profitable with a high payoff ratio, and the other way round.
              </InfoTip>
            </div>
            <div className="stat-value">
              <span className="pnl-pos">{stats.avg_win !== undefined ? fmtMoney(stats.avg_win) : "—"}</span>
              <span className="muted"> / </span>
              <span className="pnl-neg">{stats.avg_loss !== undefined ? fmtMoney(-stats.avg_loss) : "—"}</span>
            </div>
            <div className="stat-sub">{stats.payoff_ratio !== undefined ? `Payoff ratio ${stats.payoff_ratio.toFixed(2)}` : "Needs a win and a loss"}</div>
          </div>

          <div className="stat-card">
            <div className="stat-label">Best Trade</div>
            <div className={`stat-value ${stats.best ? "pnl-pos" : ""}`}>{stats.best ? fmtMoney(stats.best.net) : "—"}</div>
            <div className="stat-sub">{stats.best ? stats.best.name : "No winning trade yet"}</div>
          </div>

          <div className="stat-card">
            <div className="stat-label">Worst Trade</div>
            <div className={`stat-value ${stats.worst ? "pnl-neg" : ""}`}>{stats.worst ? fmtMoney(stats.worst.net) : "—"}</div>
            <div className="stat-sub">{stats.worst ? stats.worst.name : "No losing trade yet"}</div>
          </div>
        </div>
      )}
    </>
  );
}
