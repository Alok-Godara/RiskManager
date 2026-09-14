import { useState } from "react";
import type { Contract, CorrelationWindow, Instrument, StructureSnapshot, StructureTemplate } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { usePortfolioCorrelation } from "../hooks/usePortfolioCorrelation";

function correlationClass(c: number | undefined, threshold: number): string {
  if (c === undefined) return "muted";
  if (Math.abs(c) >= threshold) return c > 0 ? "pnl-neg" : "pnl-pos";
  return "";
}

export function PortfolioCorrelationPanel({
  snapshots,
  contracts,
  templates,
  instruments,
}: {
  snapshots: StructureSnapshot[];
  contracts: Contract[];
  templates: StructureTemplate[];
  instruments: Instrument[];
}) {
  const [window, setWindow] = useState<CorrelationWindow>(15);
  const { loading, error, analysesByWindow, thresholds, openStructureCount, refresh } = usePortfolioCorrelation(
    snapshots,
    contracts,
    templates,
    instruments
  );

  const analysis = analysesByWindow?.[window];

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Portfolio Correlation &amp; Concentration</h2>
        <div className="button-row">
          <div className="segmented">
            {CORRELATION_WINDOWS.map((w) => (
              <button key={w} type="button" className={window === w ? "active" : ""} onClick={() => setWindow(w)}>
                {w}d
              </button>
            ))}
          </div>
          <button type="button" className="secondary" style={{ marginBottom: 0 }} onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {openStructureCount < 2 && !loading && (
        <p className="helper-text">Open at least 2 structures to see correlation analysis.</p>
      )}

      {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

      {loading && !analysis && <p className="helper-text">Fetching settlement history and computing correlations…</p>}

      {analysis && openStructureCount >= 2 && (
        <>
          <div className="card-grid">
            <div className="stat-card">
              <div className="stat-label">Same-Direction Risk ({window}d)</div>
              <div
                className={`stat-value ${
                  analysis.isConcentrated ? "pnl-neg" : analysis.sameDirectionRiskFraction !== undefined ? "pnl-pos" : ""
                }`}
              >
                {analysis.sameDirectionRiskFraction !== undefined ? `${(analysis.sameDirectionRiskFraction * 100).toFixed(0)}%` : "—"}
              </div>
              <div className="stat-sub">
                Risk-weighted fraction of pairwise exposure that's mutually reinforcing rather than offsetting. Warns at{" "}
                {(thresholds.concentration * 100).toFixed(0)}%.
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Status</div>
              <div className={`stat-value ${analysis.isConcentrated ? "pnl-neg" : "pnl-pos"}`}>
                {analysis.isConcentrated ? "Concentrated" : "Diversified"}
              </div>
              <div className="stat-sub">{analysis.pairs.length} structure pair(s) analyzed at this window</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">High-Correlation Pairs</div>
              <div className="stat-value">{analysis.highCorrelationPairs.length}</div>
              <div className="stat-sub">|correlation| ≥ {thresholds.correlation.toFixed(2)}</div>
            </div>
          </div>

          {analysis.warnings.length > 0 && (
            <div className="card-grid" style={{ gridTemplateColumns: "1fr" }}>
              {analysis.warnings.map((w, i) => (
                <p key={i} className="helper-text" style={{ color: "var(--amber)" }}>
                  ⚠ {w}
                </p>
              ))}
            </div>
          )}

          <h4>Pairwise Correlations ({window}d)</h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Structure A</th>
                <th>Structure B</th>
                <th>5d</th>
                <th>15d</th>
                <th>30d</th>
              </tr>
            </thead>
            <tbody>
              {analysis.pairs.map((p) => (
                <tr key={`${p.structure_a_id}-${p.structure_b_id}`}>
                  <td>{p.structure_a_name}</td>
                  <td>{p.structure_b_name}</td>
                  {CORRELATION_WINDOWS.map((w) => {
                    const wc = p.windows.find((x) => x.window === w);
                    return (
                      <td key={w} className={correlationClass(wc?.correlation, thresholds.correlation)}>
                        {wc?.correlation !== undefined ? wc.correlation.toFixed(2) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {analysis.pairs.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No structure pairs to compare yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
