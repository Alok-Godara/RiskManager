import type { PortfolioSummary } from "../types/domain";
import { fmtMoney, pnlClass } from "../utils/format";

export function PortfolioDashboard({ summary }: { summary: PortfolioSummary | null }) {
  if (!summary) return <div className="panel">Loading portfolio…</div>;

  const cards: { label: string; value: string; cls?: string }[] = [
    { label: "Realized P&L", value: fmtMoney(summary.total_realized_pnl), cls: pnlClass(summary.total_realized_pnl) },
    { label: "Unrealized P&L", value: fmtMoney(summary.total_unrealized_pnl), cls: pnlClass(summary.total_unrealized_pnl) },
    { label: "Net P&L", value: fmtMoney(summary.net_pnl), cls: pnlClass(summary.net_pnl) },
    { label: "Total Dollar Risk", value: fmtMoney(summary.total_dollar_risk) },
    { label: "Risk Utilized", value: fmtMoney(summary.risk_utilized) },
    { label: "Remaining Risk Capacity", value: fmtMoney(summary.remaining_risk_capacity) },
    { label: "Open Structures", value: String(summary.open_structures) },
    { label: "Closed Structures", value: String(summary.closed_structures) },
  ];

  return (
    <div className="panel">
      <h2>Portfolio Summary</h2>
      <div className="card-grid">
        {cards.map((c) => (
          <div className="stat-card" key={c.label}>
            <div className="stat-label">{c.label}</div>
            <div className={`stat-value ${c.cls ?? ""}`}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
