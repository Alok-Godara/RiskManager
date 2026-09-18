import { useMemo, useState, type ReactNode } from "react";
import type { Contract, CorrelationWindow, Instrument, StructurePairCorrelation, StructureSnapshot, StructureTemplate } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { CorrelationEngine, type DailySeriesPoint } from "../engines/CorrelationEngine";
import { usePortfolioCorrelation } from "../hooks/usePortfolioCorrelation";
import { sortContractsChronologically } from "../utils/contractGen";
import { fmtMoney } from "../utils/format";

const ZERO_EXPOSURE_EPSILON = 1e-6;
/** Combined vol within +/-5% of the naive gross sum reads as "Neutral" rather than flip-flopping between Reducing/Increasing on noise. */
const RISK_IMPACT_TOLERANCE = 0.05;

function correlationClass(c: number | undefined, threshold: number): string {
  if (c === undefined) return "muted";
  if (Math.abs(c) >= threshold) return c > 0 ? "pnl-neg" : "pnl-pos";
  return "";
}

function fmtLots(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
}

function lotsClass(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || Math.abs(n) < ZERO_EXPOSURE_EPSILON) return "muted";
  return n > 0 ? "pnl-pos" : "pnl-neg";
}

/** A single labeled metric block, styled like a compact stat-card but tolerant of multi-line content. */
function MiniStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div style={{ fontSize: "0.85rem", lineHeight: 1.6, fontVariantNumeric: "tabular-nums" }}>{children}</div>
    </div>
  );
}

interface PairDetail {
  betaAonB?: number;
  betaBonA?: number;
  netA?: number;
  netB?: number;
  volA?: number;
  volB?: number;
  combinedVol?: number;
  grossVol: number;
  riskImpact?: "Reducing" | "Increasing" | "Neutral";
}

function computePairDetail(
  p: StructurePairCorrelation,
  snapshotsById: Map<string, StructureSnapshot>,
  perLotDollarSeriesByStructureId: Record<string, DailySeriesPoint[]>,
  positionDollarSeriesByStructureId: Record<string, DailySeriesPoint[]>,
  actualDays: number
): PairDetail {
  const snapA = snapshotsById.get(p.structure_a_id);
  const snapB = snapshotsById.get(p.structure_b_id);
  const perLotA = perLotDollarSeriesByStructureId[p.structure_a_id];
  const perLotB = perLotDollarSeriesByStructureId[p.structure_b_id];
  const posA = positionDollarSeriesByStructureId[p.structure_a_id];
  const posB = positionDollarSeriesByStructureId[p.structure_b_id];

  const betaAonB = perLotA && perLotB ? CorrelationEngine.regressionBeta(perLotA, perLotB, actualDays).beta : undefined;
  const betaBonA = perLotA && perLotB ? CorrelationEngine.regressionBeta(perLotB, perLotA, actualDays).beta : undefined;

  const netA = snapA ? CorrelationEngine.structureNetLotsSigned(snapA.legs) : undefined;
  const netB = snapB ? CorrelationEngine.structureNetLotsSigned(snapB.legs) : undefined;

  const volA = posA ? CorrelationEngine.dollarVolatility(posA, actualDays) : undefined;
  const volB = posB ? CorrelationEngine.dollarVolatility(posB, actualDays) : undefined;
  const combinedVol = posA && posB ? CorrelationEngine.combinedDollarVolatility([posA, posB], actualDays) : undefined;
  const grossVol = (volA ?? 0) + (volB ?? 0);

  let riskImpact: PairDetail["riskImpact"];
  if (combinedVol !== undefined && grossVol > 0) {
    const ratio = combinedVol / grossVol;
    riskImpact = ratio < 1 - RISK_IMPACT_TOLERANCE ? "Reducing" : ratio > 1 + RISK_IMPACT_TOLERANCE ? "Increasing" : "Neutral";
  }

  return { betaAonB, betaBonA, netA, netB, volA, volB, combinedVol, grossVol, riskImpact };
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
    perLotDollarSeriesByStructureId,
    positionDollarSeriesByStructureId,
    thresholds,
    periods,
    rollingWindows,
    openStructureCount,
    netExposureByContract,
    touchedContractIds,
    refresh,
  } = usePortfolioCorrelation(snapshots, contracts, templates, instruments);

  const analysis = analysesByWindow?.[window];
  const snapshotsById = useMemo(() => new Map(snapshots.map((s) => [s.structure.id, s])), [snapshots]);

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
                Net $ volatility of the whole book ÷ gross (undiversified) $ volatility if nothing offset anything — 0% = fully
                hedged, 100% = no diversification benefit. Warns at {(thresholds.concentration * 100).toFixed(0)}%.
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
            <div className="stat-card">
              <div className="stat-label">Gross $ Risk ({window}d)</div>
              <div className="stat-value">{analysis.grossDollarRisk !== undefined ? fmtMoney(analysis.grossDollarRisk) : "—"}</div>
              <div className="stat-sub">Sum of each open position's own $ volatility, as if nothing offset anything</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Net $ Risk ({window}d)</div>
              <div className="stat-value">{analysis.netDollarRisk !== undefined ? fmtMoney(analysis.netDollarRisk) : "—"}</div>
              <div className="stat-sub">The whole book's ACTUAL combined $ volatility, held together right now</div>
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
          <p className="helper-text">
            Direction-aware: reflects your ACTUAL current Long/Short positions, so two structures with the same shape can show
            opposite-signed correlation depending on which way each is currently held.
          </p>
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

          {sortedPairs.length > 0 && (
            <>
              <h4>Pair Details ({window}d)</h4>
              <p className="helper-text">
                Three separate questions per pair: do they move together (correlation, above — direction-aware, YOUR current
                positions), how much does one move relative to the other (regression/beta — shape-only, independent of which
                way you're currently holding either one), and what lot ratio would actually hedge that (hedge ratio). Beta and
                correlation can legitimately have opposite signs when one leg is held Short: correlation tells you how your
                actual positions behave together; beta tells you how the structures themselves behave, regardless of
                direction — exactly the "4th front vs. 8th front" kind of structural fact that shouldn't change just because
                you flipped from Long to Short.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, margin: "12px 0 18px" }}>
                {sortedPairs.map((p) => {
                  const wc = p.windows.find((x) => x.window === window);
                  const d = computePairDetail(p, snapshotsById, perLotDollarSeriesByStructureId, positionDollarSeriesByStructureId, periods[window]);
                  const hedgeMagnitude = d.betaAonB !== undefined ? Math.abs(d.betaAonB) : undefined;
                  const hedgeSameDirection = d.betaAonB !== undefined ? d.betaAonB < 0 : undefined;
                  return (
                    <div
                      key={`${p.structure_a_id}-${p.structure_b_id}-detail`}
                      style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 16 }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        {p.structure_a_name} vs {p.structure_b_name}
                        <span className={`${correlationClass(wc?.correlation, thresholds.correlation)}`} style={{ marginLeft: 10, fontWeight: 700 }}>
                          {wc?.correlation !== undefined ? `${wc.correlation.toFixed(2)} correlation (${window}d)` : "insufficient data"}
                        </span>
                      </div>
                      <div className="card-grid" style={{ margin: "10px 0 0" }}>
                        <MiniStat label="Net Position">
                          <div className={lotsClass(d.netA)}>
                            {p.structure_a_name}: {fmtLots(d.netA)} lots
                          </div>
                          <div className={lotsClass(d.netB)}>
                            {p.structure_b_name}: {fmtLots(d.netB)} lots
                          </div>
                        </MiniStat>
                        <MiniStat label="Regression / Beta (shape-based)">
                          <div>A per 1 B: {d.betaAonB !== undefined ? d.betaAonB.toFixed(2) : "—"}</div>
                          <div>B per 1 A: {d.betaBonA !== undefined ? d.betaBonA.toFixed(2) : "—"}</div>
                        </MiniStat>
                        <MiniStat label="Hedge Ratio (shape-based)">
                          <div>
                            1 : {hedgeMagnitude !== undefined ? hedgeMagnitude.toFixed(2) : "—"} (A : B)
                          </div>
                          <div className="helper-text" style={{ marginTop: 2 }}>
                            {hedgeSameDirection === undefined
                              ? "—"
                              : hedgeSameDirection
                                ? "hold B in the SAME direction as A"
                                : "hold B OPPOSITE to A"}
                          </div>
                        </MiniStat>
                        <MiniStat label="Position-Adjusted Exposure">
                          <div>
                            {p.structure_a_name}: {d.volA !== undefined ? fmtMoney(d.volA) : "—"}
                          </div>
                          <div>
                            {p.structure_b_name}: {d.volB !== undefined ? fmtMoney(d.volB) : "—"}
                          </div>
                          <div style={{ fontWeight: 700, marginTop: 2 }}>
                            Combined (actual): {d.combinedVol !== undefined ? fmtMoney(d.combinedVol) : "—"}
                          </div>
                        </MiniStat>
                        <MiniStat label="Risk Impact">
                          <div
                            className={
                              d.riskImpact === "Reducing" ? "pnl-pos" : d.riskImpact === "Increasing" ? "pnl-neg" : "muted"
                            }
                            style={{ fontWeight: 700 }}
                          >
                            {d.riskImpact ?? "—"}
                          </div>
                          <div className="helper-text" style={{ marginTop: 2 }}>
                            vs. {fmtMoney(d.grossVol)} gross if held independently
                          </div>
                        </MiniStat>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
