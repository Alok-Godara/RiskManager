import { useMemo, useState, type ReactNode } from "react";
import type { Contract, CorrelationWindow, Instrument, StructurePairCorrelation, StructureSnapshot, StructureTemplate } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { CorrelationEngine, type DailySeriesPoint } from "../engines/CorrelationEngine";
import { usePortfolioCorrelation } from "../hooks/usePortfolioCorrelation";
import { sortContractsChronologically } from "../utils/contractGen";
import { fmtMoney } from "../utils/format";
import { fmtQh } from "../utils/correlationFormat";
import { InfoTip } from "./InfoTip";
import { PortfolioRead } from "./PortfolioRead";

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
function MiniStat({ label, tip, tipAlign, children }: { label: string; tip?: ReactNode; tipAlign?: "left" | "right"; children: ReactNode }) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        {label}
        {tip && <InfoTip align={tipAlign}>{tip}</InfoTip>}
      </div>
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
  /** Correlation of the two structures' SHAPES (per-lot, direction-independent) — decides whether a hedge ratio is worth showing. */
  shapeCorr?: number;
}

function computePairDetail(
  p: StructurePairCorrelation,
  snapshotsById: Map<string, StructureSnapshot>,
  perLotDollarSeriesByStructureId: Record<string, DailySeriesPoint[]>,
  positionDollarSeriesByStructureId: Record<string, DailySeriesPoint[]>,
  actualDays: number,
  window: CorrelationWindow
): PairDetail {
  const snapA = snapshotsById.get(p.structure_a_id);
  const snapB = snapshotsById.get(p.structure_b_id);
  const perLotA = perLotDollarSeriesByStructureId[p.structure_a_id];
  const perLotB = perLotDollarSeriesByStructureId[p.structure_b_id];
  const posA = positionDollarSeriesByStructureId[p.structure_a_id];
  const posB = positionDollarSeriesByStructureId[p.structure_b_id];

  const betaAonB = perLotA && perLotB ? CorrelationEngine.regressionBeta(perLotA, perLotB, actualDays).beta : undefined;
  const betaBonA = perLotA && perLotB ? CorrelationEngine.regressionBeta(perLotB, perLotA, actualDays).beta : undefined;

  const shapeCorr = perLotA && perLotB ? CorrelationEngine.rollingCorrelation(perLotA, perLotB, actualDays, window).correlation : undefined;

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

  return { betaAonB, betaBonA, netA, netB, volA, volB, combinedVol, grossVol, riskImpact, shapeCorr };
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
  const [window, setWindow] = useState<CorrelationWindow>(60);
  const [showMore, setShowMore] = useState(false);
  const {
    loading,
    error,
    analysesByWindow,
    seriesByStructureId,
    perLotDollarSeriesByStructureId,
    positionDollarSeriesByStructureId,
    outrightWeightsByStructureId,
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
  const openSnapshots = useMemo(() => snapshots.filter((s) => s.structure.status !== "Fully Closed"), [snapshots]);
  const instrumentSymbolById = useMemo(() => new Map(instruments.map((i) => [i.id, i.symbol])), [instruments]);
  const contractsById = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts]);

  /** "Jun27 +2, Jul27 -6, Aug27 +6, Sep27 -2" — a structure's current position as outright weights, chronological (what to enter as a custom structure in QuantHub; only the signs and ratios matter, not the scale). */
  function fmtWeights(weights: { contract_id: string; ratio: number }[] | undefined): string {
    if (!weights || weights.length === 0) return "—";
    const cs = sortContractsChronologically(weights.map((w) => contractsById.get(w.contract_id)).filter((c): c is Contract => Boolean(c)));
    const byId = new Map(weights.map((w) => [w.contract_id, w.ratio]));
    return cs
      .filter((c) => Math.abs(byId.get(c.id) ?? 0) > 1e-9)
      .map((c) => {
        const r = byId.get(c.id) ?? 0;
        return c.month_label + " " + (r > 0 ? "+" : "") + String(Number(r.toFixed(2)));
      })
      .join(", ");
  }

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

  const firstPair = sortedPairs[0];
  const windowDates = (w: (typeof CORRELATION_WINDOWS)[number]) => {
    const wc = firstPair?.windows.find((x) => x.window === w);
    return wc?.start_date ? wc.start_date + " → " + wc.end_date + " (" + wc.observations + " trading days)" : "no data";
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>
          Correlation &amp; Concentration
          <InfoTip>
            Correlation here is measured like QuantHub's Correlation &amp; Hedging tool: Pearson correlation of the structures'
            settlement prices on the same dates, from −100 to 100, using your actual Long/Short lots. {window}d = the last{" "}
            {periods[window]} trading days; the trend line uses a sliding {rollingWindows[window]}-day sub-window. Windows are
            configurable in Settings → Correlation &amp; Concentration.
          </InfoTip>
        </h2>
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

      {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

      {exposureRows.length > 0 && (
        <>
          <h4>
            Net Portfolio Exposure
            <InfoTip>
              Every outright delivery month your open structures touch, with your positions added up across the whole book
              (Long +, Short −). A month at 0 is fully hedged, even if individual structures each hold something in it.
            </InfoTip>
          </h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Contract</th>
                <th>
                  Net Lots
                  <InfoTip>Total lots you hold in this delivery month across all structures. + = Long, − = Short.</InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {exposureRows.map(({ instrumentSymbol, contract, net }) => (
                <tr key={contract.id}>
                  <td>{instrumentSymbol}</td>
                  <td>{contract.month_label}</td>
                  <td className={Math.abs(net) < ZERO_EXPOSURE_EPSILON ? "muted" : net > 0 ? "pnl-pos" : "pnl-neg"}>
                    {Math.abs(net) < ZERO_EXPOSURE_EPSILON ? "0 (hedged)" : `${net > 0 ? "+" : ""}${net.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {openStructureCount < 2 && !loading && (
        <p className="helper-text">Open at least 2 structures to see pairwise correlation.</p>
      )}

      {loading && !analysis && <p className="helper-text">Computing correlations…</p>}

      {analysis && openStructureCount >= 2 && (
        <>
          <div className="card-grid">
            <div className="stat-card">
              <div className="stat-label">
                Same-Direction Risk ({window}d)
                <InfoTip>
                  The book's actual daily $ swing ÷ the sum of each position's own swing. 0% = fully hedged, 100% = no
                  benefit from holding them together. Careful: even completely unrelated positions read well above 0% (about
                  71–75% for two positions), so use the Portfolio Read below rather than treating the {(thresholds.concentration * 100).toFixed(0)}% warning line as a hard rule.
                </InfoTip>
              </div>
              <div
                className={`stat-value ${
                  analysis.isConcentrated ? "pnl-neg" : analysis.sameDirectionRiskFraction !== undefined ? "pnl-pos" : ""
                }`}
              >
                {analysis.sameDirectionRiskFraction !== undefined ? `${(analysis.sameDirectionRiskFraction * 100).toFixed(0)}%` : "—"}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                Status
                <InfoTip>
                  "Concentrated" appears when Same-Direction Risk is at or above the warning line in Settings — a quick flag
                  only. {analysis.pairs.length} pair(s) analyzed at this window.
                  {analysis.warnings.map((w, i) => (
                    <span key={i} style={{ display: "block", marginTop: 6, color: "var(--amber)" }}>
                      ⚠ {w}
                    </span>
                  ))}
                </InfoTip>
              </div>
              <div className={`stat-value ${analysis.isConcentrated ? "pnl-neg" : "pnl-pos"}`}>
                {analysis.isConcentrated ? "Concentrated" : "Diversified"}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                High-Correlation Pairs
                <InfoTip>
                  How many pairs of your structures have a correlation of at least {thresholds.correlation.toFixed(2)} in size
                  (either direction) at this window. Zero means none move strongly together or strongly opposite.
                </InfoTip>
              </div>
              <div className="stat-value">{analysis.highCorrelationPairs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                Gross $ Risk ({window}d)
                <InfoTip>
                  Each open position's own typical daily $ swing (at your current lots), simply added together — what the book
                  would swing if every position moved the same way at once.
                </InfoTip>
              </div>
              <div className="stat-value">{analysis.grossDollarRisk !== undefined ? fmtMoney(analysis.grossDollarRisk) : "—"}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                Net $ Risk ({window}d)
                <InfoTip align="right">
                  The book's ACTUAL typical daily $ swing with all positions held together. Lower than Gross means positions
                  partly offset or move independently.
                </InfoTip>
              </div>
              <div className="stat-value">{analysis.netDollarRisk !== undefined ? fmtMoney(analysis.netDollarRisk) : "—"}</div>
            </div>
          </div>

          <h4>
            Pairwise Correlations ({window}d)
            <InfoTip>
              The same number QuantHub shows: correlation of the two structures' settlement prices on the same dates, from −100
              to 100 (57 = 0.57), using your actual Long/Short lots — a Short flips the sign. +100 = your two positions win and
              lose together; −100 = one's gains exactly cancel the other's losses; near 0 = unrelated.
            </InfoTip>
          </h4>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Structure A</th>
                <th>Structure B</th>
                {CORRELATION_WINDOWS.map((w) => (
                  <th key={w}>
                    {w}d
                    <InfoTip>
                      Correlation over the last {periods[w]} trading days: {windowDates(w)}. Enter these as Start/End in QuantHub
                      to reproduce it. Shorter windows show the recent relationship, longer ones the steadier one.
                    </InfoTip>
                  </th>
                ))}
                <th>
                  Beta (A : B)
                  <InfoTip>
                    For 1 lot of A, buy this many lots of B to offset it (a negative number means sell B instead). Worked out from
                    how the two structures themselves move over the last {periods[window]} trading days, so it doesn't change with
                    your Long/Short choice. If the two barely move together (shown dimmed) it isn't a reliable hedge.
                  </InfoTip>
                </th>
                <th>
                  Trend
                  <InfoTip align="right">
                    The same correlation recalculated over a sliding {rollingWindows[window]}-day sub-window across the last{" "}
                    {periods[window]} days. Rising = the two positions are becoming more alike; falling = more opposite.
                  </InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPairs.map((p) => {
                const seriesA = seriesByStructureId[p.structure_a_id];
                const seriesB = seriesByStructureId[p.structure_b_id];
                const perLotA = perLotDollarSeriesByStructureId[p.structure_a_id];
                const perLotB = perLotDollarSeriesByStructureId[p.structure_b_id];
                const betaAonB = perLotA && perLotB ? CorrelationEngine.regressionBeta(perLotA, perLotB, periods[window]).beta : undefined;
                const shapeCorr = perLotA && perLotB ? CorrelationEngine.rollingCorrelation(perLotA, perLotB, periods[window], window).correlation : undefined;
                const lotsOfB = betaAonB !== undefined ? -betaAonB : undefined;
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
                          {fmtQh(wc?.correlation)}
                        </td>
                      );
                    })}
                    <td className={shapeCorr !== undefined && Math.abs(shapeCorr) >= 0.3 ? "" : "muted"}>
                      {lotsOfB !== undefined ? "1 : " + (Math.abs(lotsOfB) < 0.005 ? "0" : lotsOfB.toFixed(2)) : "—"}
                    </td>
                    <td>
                      <Sparkline points={trend} />
                    </td>
                  </tr>
                );
              })}
              {sortedPairs.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No structure pairs to compare yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ margin: "16px 0 8px" }}>
            <button
              type="button"
              className="secondary"
              style={{ marginBottom: 0 }}
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
            >
              {showMore ? "▾" : "▸"} More details
            </button>
          </div>

          {showMore && (
            <>
              <PortfolioRead
                window={window}
                actualDays={periods[window]}
                openSnapshots={openSnapshots}
                positionDollarSeriesByStructureId={positionDollarSeriesByStructureId}
                analysis={analysis}
                concentrationThreshold={thresholds.concentration}
                instrumentSymbolById={instrumentSymbolById}
              />

              {sortedPairs.length > 0 && (
                <>
                  <h4>
                    Pair Details ({window}d)
                    <InfoTip>
                      One card per pair, answering three separate questions: do they move together (correlation), how much does one
                      move for each move in the other (beta), and what lot ratio would hedge that. Correlation uses your actual
                      Long/Short lots; beta and hedge ratio look at the structures themselves, so they can have opposite signs when
                      one of them is held Short.
                    </InfoTip>
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, margin: "12px 0 18px" }}>
                    {sortedPairs.map((p) => {
                      const wc = p.windows.find((x) => x.window === window);
                      const d = computePairDetail(p, snapshotsById, perLotDollarSeriesByStructureId, positionDollarSeriesByStructureId, periods[window], window);
                      const hedgeMagnitude = d.betaAonB !== undefined ? Math.abs(d.betaAonB) : undefined;
                      const hedgeSameDirection = d.betaAonB !== undefined ? d.betaAonB < 0 : undefined;
                      const hedgeUseful = d.shapeCorr !== undefined && Math.abs(d.shapeCorr) >= 0.3;
                      return (
                        <div
                          key={`${p.structure_a_id}-${p.structure_b_id}-detail`}
                          style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 16 }}
                        >
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>
                            {p.structure_a_name} vs {p.structure_b_name}
                            <span className={correlationClass(wc?.correlation, thresholds.correlation)} style={{ marginLeft: 10, fontWeight: 700 }}>
                              {wc?.correlation !== undefined ? `correlation ${fmtQh(wc.correlation)}` : "insufficient data"}
                            </span>
                          </div>
                          <div className="card-grid" style={{ margin: "10px 0 0" }}>
                            <MiniStat label="Net Position" tip="Your current position in each structure, in structure lots: + = Long, − = Short.">
                              <div className={lotsClass(d.netA)}>
                                {p.structure_a_name}: {fmtLots(d.netA)}
                              </div>
                              <div className={lotsClass(d.netB)}>
                                {p.structure_b_name}: {fmtLots(d.netB)}
                              </div>
                            </MiniStat>
                            <MiniStat
                              label="Beta"
                              tip="How many units the first structure moves for each 1 unit move in the second (and the reverse), measured on the structures themselves, not on your Long/Short choice. Near 0 means one barely reacts to the other."
                            >
                              <div>A per 1 B: {d.betaAonB !== undefined ? d.betaAonB.toFixed(2) : "—"}</div>
                              <div>B per 1 A: {d.betaBonA !== undefined ? d.betaBonA.toFixed(2) : "—"}</div>
                            </MiniStat>
                            <MiniStat
                              label="Hedge Ratio"
                              tip={
                                "Roughly how many lots of B offset 1 lot of A, from the beta. Only meaningful when the two structures are clearly related" +
                                (d.shapeCorr !== undefined ? " (their shape correlation is " + fmtQh(d.shapeCorr) + "; a hedge is shown at 30 or more in size)" : "") +
                                "; otherwise there is nothing to hedge with."
                              }
                            >
                              {hedgeUseful ? (
                                <>
                                  <div>1 : {hedgeMagnitude !== undefined ? hedgeMagnitude.toFixed(2) : "—"} (A : B)</div>
                                  <div className="helper-text">
                                    {hedgeSameDirection === undefined ? "—" : hedgeSameDirection ? "B in the SAME direction as A" : "B OPPOSITE to A"}
                                  </div>
                                </>
                              ) : (
                                <div className="muted">No useful hedge</div>
                              )}
                            </MiniStat>
                            <MiniStat
                              label="Daily $ Swing"
                              tip="Typical daily dollar swing of each position at your current lots, and of the two held together. Combined below the sum means they partly offset or move independently."
                            >
                              <div>
                                {p.structure_a_name}: {d.volA !== undefined ? fmtMoney(d.volA) : "—"}
                              </div>
                              <div>
                                {p.structure_b_name}: {d.volB !== undefined ? fmtMoney(d.volB) : "—"}
                              </div>
                              <div style={{ fontWeight: 700 }}>Together: {d.combinedVol !== undefined ? fmtMoney(d.combinedVol) : "—"}</div>
                            </MiniStat>
                            <MiniStat
                              label="Risk Impact"
                              tip={
                                "Whether holding the two together swings less (Reducing), about the same (Neutral) or more (Increasing) than adding their separate swings (" +
                                fmtMoney(d.grossVol) +
                                "). Reducing can just mean two unrelated bets diversify, not that they hedge."
                              }
                            >
                              <div
                                className={d.riskImpact === "Reducing" ? "pnl-pos" : d.riskImpact === "Increasing" ? "pnl-neg" : "muted"}
                                style={{ fontWeight: 700 }}
                              >
                                {d.riskImpact ?? "—"}
                              </div>
                            </MiniStat>
                            <MiniStat
                              label="Check in QuantHub"
                              tipAlign="right"
                              tip="To reproduce this correlation in QuantHub's Correlation & Hedging tool: set Start/End to these dates, then enter Y and X as custom structures with these month weights (your current positions; only the signs and ratios matter, not the scale)."
                            >
                              <div>{wc?.start_date ? wc.start_date + " → " + wc.end_date : "—"}</div>
                              <div className="helper-text">Y: {fmtWeights(outrightWeightsByStructureId[p.structure_a_id])}</div>
                              <div className="helper-text">X: {fmtWeights(outrightWeightsByStructureId[p.structure_b_id])}</div>
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
        </>
      )}
    </div>
  );
}
