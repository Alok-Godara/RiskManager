import { useEffect, useMemo, useState } from "react";
import type { Contract, CorrelationWindow, Instrument, PortfolioConcentrationAnalysis, StructureSnapshot, StructureTemplate, UUID } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { CorrelationEngine, type DailySeriesPoint } from "../engines/CorrelationEngine";
import { buildCorrelationContext, getCorrelationSettings, historyTradingDaysFor } from "../services/settlementData/correlationContext";

/** Settlements publish once/day — this just picks up a newly-published one without a manual reload. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export interface PortfolioCorrelationState {
  loading: boolean;
  error?: string;
  analysesByWindow: Record<CorrelationWindow, PortfolioConcentrationAnalysis> | null;
  /** Each open structure's daily value series — for computing a rolling trend (CorrelationEngine.rollingCorrelationTrend) per pair in the panel, without re-fetching. */
  seriesByStructureId: Record<UUID, DailySeriesPoint[]>;
  thresholds: { correlation: number; concentration: number };
  periods: Record<CorrelationWindow, number>;
  rollingWindows: Record<CorrelationWindow, number>;
  openStructureCount: number;
  /** Net (signed) lots per outright contract, aggregated across every open structure — see CorrelationEngine.netExposureByContract. */
  netExposureByContract: Record<UUID, number>;
  /** Contracts touched by any open structure, including ones that net to exactly zero (fully hedged). */
  touchedContractIds: UUID[];
  refresh: () => void;
}

/**
 * Drives the portfolio-wide correlation & concentration analysis (the
 * top-level Correlation tab). Deliberately does NOT depend on the raw
 * `snapshots`/`contracts`/`templates`/`instruments` array references in its
 * effect — those get new references on every background reload (the
 * market-data poll), which would otherwise re-run the settlement
 * fetch/correlation computation every ~1.3s for no reason (the same
 * unstable-reference pitfall found twice before in this codebase, see
 * NewStructureForm/InstrumentDashboard). Instead it depends on a small
 * signature of what actually matters here: which structures are open, their
 * risk, and their legs.
 */
export function usePortfolioCorrelation(
  snapshots: StructureSnapshot[],
  contracts: Contract[],
  templates: StructureTemplate[],
  instruments: Instrument[]
): PortfolioCorrelationState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [analysesByWindow, setAnalysesByWindow] = useState<Record<CorrelationWindow, PortfolioConcentrationAnalysis> | null>(null);
  const [seriesByStructureId, setSeriesByStructureId] = useState<Record<UUID, DailySeriesPoint[]>>({});
  const [thresholds, setThresholds] = useState({ correlation: 0.7, concentration: 0.65 });
  const [periods, setPeriods] = useState<Record<CorrelationWindow, number>>({ 5: 5, 15: 15, 30: 30 });
  const [rollingWindows, setRollingWindows] = useState<Record<CorrelationWindow, number>>({ 5: 5, 15: 5, 30: 7 });
  const [netExposureByContract, setNetExposureByContract] = useState<Record<UUID, number>>({});
  const [touchedContractIds, setTouchedContractIds] = useState<UUID[]>([]);
  const [nonce, setNonce] = useState(0);

  const openStructures = useMemo(() => snapshots.filter((s) => s.structure.status !== "Fully Closed"), [snapshots]);

  // Includes each leg's CURRENT net_quantity, not just its fixed contract_id
  // — position size/direction changes (a new entry, a partial exit) must
  // re-trigger the correlation recompute below even though the structure's
  // own id/legs/dollar-risk haven't changed.
  const structureSignature = useMemo(
    () =>
      openStructures
        .map(
          (s) =>
            `${s.structure.id}:${s.structure.current_dollar_risk}:${s.legs
              .map((l) => `${l.leg.contract_id}=${l.position.net_quantity}`)
              .join(",")}`
        )
        .sort()
        .join("|"),
    [openStructures]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const settings = await getCorrelationSettings();
        if (cancelled) return;
        setThresholds({ correlation: settings.correlation, concentration: settings.concentration });
        setPeriods(settings.periods);
        setRollingWindows(settings.rollingWindows);

        // Weight each leg by its ACTUAL signed open quantity, not the
        // structure's fixed template ratio — see CorrelationEngine's file
        // comment. This is what makes two opposite-direction positions in
        // the same shape correctly read as hedging (negative correlation)
        // instead of concentrating (positive) just because their template
        // shapes move together.
        const withLegs = openStructures.map((s) => ({
          structure: s.structure,
          legs: s.legs.map((l) => ({ contract_id: l.leg.contract_id, ratio: l.position.net_quantity })),
        }));
        const context = await buildCorrelationContext(withLegs, contracts, templates, instruments, historyTradingDaysFor(settings.periods));
        if (cancelled) return;

        // Actual open lots per structure, not current_dollar_risk — see
        // CorrelationEngine.structureExposureLots.
        const exposureById = new Map(openStructures.map((s) => [s.structure.id, CorrelationEngine.structureExposureLots(s.legs)]));

        const byWindow = {} as Record<CorrelationWindow, PortfolioConcentrationAnalysis>;
        for (const window of CORRELATION_WINDOWS) {
          byWindow[window] = CorrelationEngine.analyzePortfolioConcentration(
            context.openStructures,
            window,
            settings.periods,
            settings.correlation,
            settings.concentration,
            exposureById
          );
        }
        setAnalysesByWindow(byWindow);
        setSeriesByStructureId(Object.fromEntries(context.openStructures.map((s) => [s.structure.id, s.series])));
        setNetExposureByContract(Object.fromEntries(context.netExposureByContract));
        setTouchedContractIds(Array.from(context.touchedContractIds));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to compute correlation analysis");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureSignature, contracts.length, templates.length, instruments.length, nonce]);

  useEffect(() => {
    const id = window.setInterval(() => setNonce((n) => n + 1), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return {
    loading,
    error,
    analysesByWindow,
    seriesByStructureId,
    thresholds,
    periods,
    rollingWindows,
    openStructureCount: openStructures.length,
    netExposureByContract,
    touchedContractIds,
    refresh: () => setNonce((n) => n + 1),
  };
}
