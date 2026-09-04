import type { PortfolioSummary } from "../types/domain";
import { fmtMoney, pnlClass } from "../utils/format";

export function PortfolioDashboard({ summary }: { summary: PortfolioSummary | null }) {
  if (!summary) return <div className="panel">Loading portfolio…</div>;

  const utilizationPct =
    summary.total_dollar_risk > 0
      ? Math.min(100, Math.max(0, (summary.risk_utilized / summary.total_dollar_risk) * 100))
      : 0;

  return (
    <div className="panel">
      <h2>Portfolio Summary</h2>

      <div className="section-label">Profit &amp; Loss</div>
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Realized P&amp;L</div>
          <div className={`stat-value ${pnlClass(summary.total_realized_pnl)}`}>
            {fmtMoney(summary.total_realized_pnl)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unrealized P&amp;L</div>
          <div className={`stat-value ${pnlClass(summary.total_unrealized_pnl)}`}>
            {fmtMoney(summary.total_unrealized_pnl)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net P&amp;L</div>
          <div className={`stat-value ${pnlClass(summary.net_pnl)}`}>{fmtMoney(summary.net_pnl)}</div>
        </div>
      </div>

      <div className="section-label">Risk</div>
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Total Dollar Risk</div>
          <div className="stat-value">{fmtMoney(summary.total_dollar_risk)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Risk Utilized</div>
          <div className="stat-value">{fmtMoney(summary.risk_utilized)}</div>
          <div className="risk-bar-track">
            <div
              className={`risk-bar-fill ${utilizationPct > 75 ? "risk-high" : ""}`}
              style={{ width: `${utilizationPct}%` }}
            />
          </div>
          <div className="stat-sub">{utilizationPct.toFixed(0)}% of total risk allocated</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Remaining Risk Capacity</div>
          <div className={`stat-value ${pnlClass(summary.remaining_risk_capacity)}`}>
            {fmtMoney(summary.remaining_risk_capacity)}
          </div>
        </div>
      </div>

      <div className="section-label">Structures</div>
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Open Structures</div>
          <div className="stat-value">{summary.open_structures}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Closed Structures</div>
          <div className="stat-value">{summary.closed_structures}</div>
        </div>
      </div>
    </div>
  );
}
