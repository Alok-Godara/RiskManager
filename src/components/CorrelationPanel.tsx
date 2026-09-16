import { useMemo, useState } from "react";
import type { Contract, CorrelationWindow, Instrument, StructureSnapshot, StructureTemplate } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { CorrelationEngine } from "../engines/CorrelationEngine";
import { usePortfolioCorrelation } from "../hooks/usePortfolioCorrelation";
import { sortContractsChronologically } from "../utils/contractGen";

const ZERO_EXPOSURE_EPSILON = 1e-6;

function correlationClass(c: number | undefined, threshold: number): string {
  if (c === undefined) return "muted";
  if (Math.abs(c) >= threshold) return c > 0 ? "pnl-neg" : "pnl-pos";
  return "";
}

/** Tiny dependency-free sparkline for a rolling-correlation trend — no charting library for ~30 points. */
function Sparkline({ points }: { points: { correlation?: number }[] }) {
  const w = 90;
  const h = 22;
  const defined = points.map((p, i) => ({ i, v: p.correlation })).filter((p): p is { i: number; v: number } => p.v !== undefined);
  if (defined.length < 2) return <span className="muted">—</span>;
  const x = (i: number) => (points.length <= 1 ? 0 : (i / (points.length - 1)) * w);
  const y = (v: number) => h - ((v + 1) / 2) * h; // correlation -1..1 -> pixel space
  const path = defined.map((p) => `${x(p.i)},${y(p.v)}`).join(" ");
  const last = defined[defined.length - 1].v;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label="Rolling correlation trend">
      <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="var(--border)" strokeWidth={1} />
      <polyline points={path} fill="none" stroke={last >= 0 ? "var(--red)" : "var(--green, #3ecf8e)"} strokeWidth={1.5} />
    </svg>
  );
}

export function CorrelationPanel({
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
  const {
    loading,
    error,
    analysesByWindow,
    seriesByStructureId,
    thresholds,
    periods,
    rollingWindows,
    openStructureCount,
    netExposureByContract,
    touchedContractIds,
    refresh,
  } = usePortfolioCorrelation(snapshots, contracts, templates, instruments);

  const analysis = analysesByWindow?.[window];

  // Grouped by instrument (alphabetical), each instrument's own contracts
  // chronological — the direct "do these positions actually net out" view,
  // independent of correlation/settlement history (pure position math, so
  // it's available even with 1 open structure or zero settlement data).
  const exposureRows = useMemo(() => {
    const contractsById = new Map(contracts.map((c) => [c.id, c]));
    const instrumentsById = new Map(instruments.map((i) => [i.id, i]));
    const touched = touchedContractIds.map((id) => contractsById.get(id)).filter((c): c is Contract => Boolean(c));
    const byInstrument = new Map<string, Contract[]>();
    for (const c of touched) {
      const list = byInstrument.get(c.instrument_id) ?? [];
      list.push(c);
      byInstrument.set(c.instrument_id, list);
    }
    const instrumentGroups = Array.from(byInstrument.entries())
      .map(([instrumentId, group]) => ({
        instrument: instrumentsById.get(instrumentId),
        contracts: sortContractsChronologically(group),
      }))
      .sort((a, b) => (a.instrument?.symbol ?? "").localeCompare(b.instrument?.symbol ?? ""));
    return instrumentGroups.flatMap(({ instrument, contracts: group }) =>
      group.map((contract) => ({
        instrumentSymbol: instrument?.symbol ?? "—",
        contract,
        net: netExposureByContract[contract.id] ?? 0,
      }))
    );
  }, [touchedContractIds, netExposureByContract, contracts, instruments]);

  // Most-correlated pairs first, undefined last.
  const sortedPairs = analysis
    ? [...analysis.pairs].sort((a, b) => {
        const ca = a.windows.find((w) => w.window === window)?.correlation;
        const cb = b.windows.find((w) => w.window === window)?.correlation;
        if (ca === undefined && cb === undefined) return 0;
        if (ca === undefined) return 1;
        if (cb === undefined) return -1;
        return cb - ca;
      })
    : [];

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Correlation &amp; Concentration</h2>
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
      <p className="helper-text">
        {window}d column: period {periods[window]} trading day(s), rolling window {rollingWindows[window]} day(s) — configurable in
        Settings → Correlation &amp; Concentration.
      </p>

      {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

      {exposureRows.length > 0 && (
        <>
          <h4>Net Portfolio Exposure — Actual Lots Held, Aggregated Across All Open Structures</h4>
          <p className="helper-text">
            Every outright contract any open structure touches, netted (signed) across the whole book — the direct
            "do these positions actually offset" view. A contract at 0 here is fully hedged even if individual
            structures each carry nonzero exposure on it.
          </p>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Contract</th>
                <th>Net Lots</th>
              </tr>
            </thead>
            <tbody>
              {exposureRows.map(({ instrumentSymbol, contract, net }) => (
                <tr key={contract.id}>
                  <td>{instrumentSymbol}</td>
                  <td>{contract.month_label}</td>
                  <td className={Math.abs(net) < ZERO_EXPOSURE_EPSILON ? "muted" : net > 0 ? "pnl-pos" : "pnl-neg"}>
                    {Math.abs(net) < ZERO_EXPOSURE_EPSILON
                      ? "0 (hedged)"
                      : `${net > 0 ? "+" : ""}${net.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {openStructureCount < 2 && !loading && (
        <p className="helper-text">Open at least 2 structures to see pairwise correlation analysis.</p>
      )}

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
                Exposure-weighted (actual open lots, not dollar risk) fraction of pairwise correlation that's mutually reinforcing rather than offsetting. Warns at{" "}
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

          <h4>Pairwise Correlations ({window}d) — highest correlation first</h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Structure A</th>
                <th>Structure B</th>
                <th>5d</th>
                <th>15d</th>
                <th>30d</th>
                <th>Trend ({window}d)</th>
              </tr>
            </thead>
            <tbody>
              {sortedPairs.map((p) => {
                const seriesA = seriesByStructureId[p.structure_a_id];
                const seriesB = seriesByStructureId[p.structure_b_id];
                const trend =
                  seriesA && seriesB
                    ? CorrelationEngine.rollingCorrelationTrend(seriesA, seriesB, periods[window], rollingWindows[window])
                    : [];
                return (
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
                    <td>
                      <Sparkline points={trend} />
                    </td>
                  </tr>
                );
              })}
              {sortedPairs.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
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
