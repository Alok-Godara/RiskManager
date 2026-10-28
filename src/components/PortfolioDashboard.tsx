import type { Contract, Instrument, PortfolioSummary, StructureSnapshot, StructureTemplate } from "../types/domain";
import { usePortfolioCorrelation, type PortfolioCorrelationState } from "../hooks/usePortfolioCorrelation";
import { fmtMoney, pnlClass } from "../utils/format";
import { fmtQh } from "../utils/correlationFormat";
import { InfoTip } from "./InfoTip";
import { ExecutionErrorCard } from "./ExecutionErrorCard";
import { PerformanceSection } from "./PerformanceSection";

/** The correlation window the Dashboard's diversified/concentrated read is taken from. */
const STATUS_WINDOW = 60;
/** An open entry is "near its stop" once its loss has used this share of the risk allocated to it (1 = stop hit). */
const NEAR_STOP_FRACTION = 0.8;
/** A trade is flagged once its net profit reaches this multiple of its initial risk. */
const PROFIT_TARGET_MULTIPLE = 1.5;

/**
 * Portfolio-level "diversified or concentrated" verdict, from the same
 * correlation analysis as the Correlation tab (60-day window). When it is
 * concentrated, says why: the highly-correlated pairs and the warnings.
 */
function DiversificationCard({ correlation }: { correlation: PortfolioCorrelationState }) {
  const { loading, error, analysesByWindow, openStructureCount, thresholds } = correlation;
  const analysis = analysesByWindow?.[STATUS_WINDOW];

  let value = "—";
  let className = "";
  let sub = "";
  if (error) {
    sub = "Could not load correlation data";
  } else if (openStructureCount < 2) {
    sub = "Needs at least 2 open trades";
  } else if (!analysis) {
    value = loading ? "…" : "—";
    sub = loading ? "Calculating…" : "Not enough settlement history yet";
  } else if (analysis.isConcentrated) {
    value = "Concentrated";
    className = "pnl-neg";
  } else if (analysis.sameDirectionRiskFraction === undefined) {
    sub = "Not enough settlement history yet";
  } else {
    value = "Diversified";
    className = "pnl-pos";
  }
  if (analysis && analysis.sameDirectionRiskFraction !== undefined && !sub) {
    sub = `Same-direction risk ${(analysis.sameDirectionRiskFraction * 100).toFixed(0)}% (${STATUS_WINDOW}d)`;
  }

  return (
    <div className="stat-card">
      <div className="stat-label">
        Portfolio
        <InfoTip align="right">
          Whether your open trades mostly move together (Concentrated) or spread the risk (Diversified), judged from the
          correlation analysis over the last {STATUS_WINDOW} trading days — the same read as the Status on the Correlation tab,
          with the warning line set in Settings ({(thresholds.concentration * 100).toFixed(0)}% same-direction risk). Open the
          Correlation tab for the full breakdown.
        </InfoTip>
      </div>
      <div className={`stat-value ${className}`}>{value}</div>
      <div className="stat-sub">{sub}</div>
      {analysis?.isConcentrated && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: "0.74rem", color: "var(--amber)" }}>
          {analysis.highCorrelationPairs.slice(0, 3).map((p) => {
            const c = p.windows.find((w) => w.window === STATUS_WINDOW)?.correlation;
            return (
              <li key={`${p.structure_a_id}-${p.structure_b_id}`}>
                {p.structure_a_name} &amp; {p.structure_b_name}: {fmtQh(c)}
              </li>
            );
          })}
          {analysis.warnings.slice(0, 2).map((w, i) => (
            <li key={`w${i}`}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Net Value at Risk of the whole book — the same figure as the Correlation tab:
 * from the NET lots held in each delivery month (hedged months drop out) and the
 * covariance of their last 90 days of settlement price changes. See
 * CorrelationEngine.valueAtRisk.
 */
function ValueAtRiskCard({ correlation }: { correlation: PortfolioCorrelationState }) {
  const { loading, error, valueAtRisk, openStructureCount } = correlation;

  let value = "—";
  let sub = "";
  if (error) sub = "Could not load correlation data";
  else if (openStructureCount === 0) sub = "No open trades";
  else if (valueAtRisk) {
    value = `±${fmtMoney(valueAtRisk.value_at_risk)}`;
    const left = valueAtRisk.excluded_contract_ids?.length ?? 0;
    sub = `Daily swing (1 std dev) ${fmtMoney(valueAtRisk.daily_std_dev)}${left > 0 ? ` · ${left} month${left > 1 ? "s" : ""} not included (no price history)` : ""}`;
  } else if (loading) {
    value = "…";
    sub = "Calculating…";
  } else sub = "Not enough settlement history yet";

  return (
    <div className="stat-card">
      <div className="stat-label">
        Net Value at Risk
        <InfoTip align="right">
          The most your whole portfolio is likely to lose OR make in one day
          {valueAtRisk ? ` (${(valueAtRisk.confidence * 100).toFixed(0)}% confidence)` : ""}, taken from your NET position: lots that
          offset each other across trades cancel out, and the correlation between delivery months (from the last{" "}
          {valueAtRisk?.lookback_days ?? 90} trading days of settlement prices) decides how much of the rest adds up or hedges. It
          is a typical-move number from recent history, not a worst case. Full breakdown by month on the Correlation tab.
        </InfoTip>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

/**
 * Trades that need a look: an open entry close to its stop loss, or a trade
 * whose net profit has reached 1.5x the initial risk given to it.
 */
function AlertsSection({ snapshots, onOpenTrade }: { snapshots: StructureSnapshot[]; onOpenTrade?: (id: string) => void }) {
  const open = snapshots.filter((s) => s.structure.status !== "Fully Closed");

  const nearStop = open
    .filter((s) => s.stop_usage !== undefined && s.stop_usage.usage >= NEAR_STOP_FRACTION - 1e-9)
    .sort((a, b) => (b.stop_usage?.usage ?? 0) - (a.stop_usage?.usage ?? 0));

  const bigProfit = open
    .map((s) => ({ s, net: s.net_pnl, initial: s.structure.initial_dollar_risk }))
    .filter((x) => x.initial > 0 && x.net >= PROFIT_TARGET_MULTIPLE * x.initial - 1e-9)
    .sort((a, b) => b.net / b.initial - a.net / a.initial);

  const link = (s: StructureSnapshot) =>
    onOpenTrade ? (
      <a href="#trade" onClick={(e) => { e.preventDefault(); onOpenTrade(s.structure.id); }}>
        {s.structure.name}
      </a>
    ) : (
      <>{s.structure.name}</>
    );

  return (
    <>
      <div className="section-label">
        Alerts
        <InfoTip>
          Near stop: an open entry whose loss has used {(NEAR_STOP_FRACTION * 100).toFixed(0)}% or more of the risk you allocated to
          it (100% = its stop loss is hit). Profit target: a trade whose net P&amp;L (realized after costs + unrealized) has
          reached {PROFIT_TARGET_MULTIPLE}× the initial risk you gave that trade (after the cost of exiting it).
        </InfoTip>
      </div>
      {nearStop.length === 0 && bigProfit.length === 0 && (
        <p className="helper-text">Nothing close to a stop loss, and no trade past {PROFIT_TARGET_MULTIPLE}× its initial risk.</p>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {nearStop.map((s) => {
          const u = s.stop_usage!;
          const hit = u.usage >= 1;
          return (
            <li key={`stop-${s.structure.id}`} className="pnl-neg">
              ⚠ {link(s)} — {hit ? "at or past its stop loss" : "near its stop loss"}: {(u.usage * 100).toFixed(0)}% of the way (loss{" "}
              {fmtMoney(u.loss)} of {fmtMoney(u.risk)} risk)
            </li>
          );
        })}
        {bigProfit.map(({ s, net, initial }) => (
          <li key={`profit-${s.structure.id}`} className="pnl-pos">
            ★ {link(s)} — net profit {fmtMoney(net)} is {(net / initial).toFixed(1)}× its initial risk ({fmtMoney(initial)})
          </li>
        ))}
      </ul>
    </>
  );
}

export function PortfolioDashboard({
  summary,
  snapshots,
  contracts,
  templates,
  instruments,
  onOpenTrade,
}: {
  summary: PortfolioSummary | null;
  snapshots: StructureSnapshot[];
  contracts: Contract[];
  templates: StructureTemplate[];
  instruments: Instrument[];
  onOpenTrade?: (id: string) => void;
}) {
  // One correlation analysis, shared by the Portfolio and Net Value at Risk cards.
  const correlation = usePortfolioCorrelation(snapshots, contracts, templates, instruments);

  if (!summary) return <div className="panel">Loading portfolio…</div>;

  const utilizationPct =
    summary.total_dollar_risk > 0 ? Math.min(100, Math.max(0, (summary.risk_utilized / summary.total_dollar_risk) * 100)) : 0;

  return (
    <div className="panel">
      <h2>Portfolio Summary</h2>

      <div className="section-label">Profit &amp; Loss</div>
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">
            Net Realized P&amp;L
            <InfoTip>
              Profit or loss booked on exited lots (gross), minus every transaction cost paid across all trades — entry and exit
              sides, including the entry half already paid on lots still open. Rates: Settings → Instruments.
            </InfoTip>
          </div>
          <div className={`stat-value ${pnlClass(summary.net_realized_pnl)}`}>{fmtMoney(summary.net_realized_pnl)}</div>
          <div className="stat-sub">
            Gross {fmtMoney(summary.total_realized_pnl)} − TC {fmtMoney(summary.total_transaction_cost)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Unrealized P&amp;L (Gross)
            <InfoTip>Gross profit or loss on the lots still open across all trades, at current live prices. No costs taken off.</InfoTip>
          </div>
          <div className={`stat-value ${pnlClass(summary.total_unrealized_pnl)}`}>{fmtMoney(summary.total_unrealized_pnl)}</div>
          <div className="stat-sub">Open lots at live prices</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Net P&amp;L
            <InfoTip>
              Net Realized P&amp;L plus the gross Unrealized P&amp;L of the open lots. The transaction costs already paid are inside
              Net Realized; no cost for exiting the open lots is deducted — it is only charged when you actually exit (and not at
              all if you mark that exit "without transaction cost").
            </InfoTip>
          </div>
          <div className={`stat-value ${pnlClass(summary.net_pnl)}`}>{fmtMoney(summary.net_pnl)}</div>
          <div className="stat-sub">Net realized + unrealized</div>
        </div>
      </div>

      <div className="section-label">Risk</div>
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Open Trades</div>
          <div className="stat-value">{summary.open_structures}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Active Risk
            <InfoTip>
              The risk you have placed on positions that are open right now (the risk allocated to every entry that still has open
              lots), out of the total risk budget — the initial risk you gave each of your open trades, added up. Remaining is
              what is left of that budget.
            </InfoTip>
          </div>
          <div className="stat-value">
            {fmtMoney(summary.risk_utilized)} <span className="muted">of {fmtMoney(summary.total_dollar_risk)}</span>
          </div>
          <div className="risk-bar-track">
            <div className={`risk-bar-fill ${utilizationPct > 75 ? "risk-high" : ""}`} style={{ width: `${utilizationPct}%` }} />
          </div>
          <div className="stat-sub">
            {utilizationPct.toFixed(0)}% used · {fmtMoney(summary.remaining_risk_capacity)} remaining
          </div>
        </div>
        <DiversificationCard correlation={correlation} />
        <ValueAtRiskCard correlation={correlation} />
      </div>

      <PerformanceSection snapshots={snapshots} />

      <div className="card-grid">
        <ExecutionErrorCard />
      </div>

      <AlertsSection snapshots={snapshots} onOpenTrade={onOpenTrade} />
    </div>
  );
}
