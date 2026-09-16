import { useEffect, useMemo, useState } from "react";
import type { Contract, CorrelationWindow, Instrument, NewTradeCorrelationAnalysis, StructureSnapshot, StructureTemplate, UUID } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { CorrelationEngine } from "../engines/CorrelationEngine";
import { buildCandidateSeries, buildCorrelationContext, getCorrelationSettings, historyTradingDaysFor } from "../services/settlementData/correlationContext";

export interface NewTradeCorrelationState {
  loading: boolean;
  error?: string;
  analysesByWindow: Record<CorrelationWindow, NewTradeCorrelationAnalysis> | null;
  thresholds: { correlation: number; concentration: number };
}

/**
 * Live "how would this candidate interact with my existing book" preview —
 * driven from AddEntryModal (a specific entry being taken on an existing
 * structure) before the user submits. `excludeStructureId` leaves that same
 * structure's OTHER entries out of the comparison (a new entry never
 * correlates against itself). Same unstable-reference caution as
 * usePortfolioCorrelation: depends on string signatures of the candidate
 * legs and the open-structure book, not the raw array/prop references
 * (which get new identities on every background reload).
 */
export function useNewTradeCorrelation(
  candidateWeights: { contract_id: UUID; ratio: number }[],
  snapshots: StructureSnapshot[],
  contracts: Contract[],
  templates: StructureTemplate[],
  instruments: Instrument[],
  excludeStructureId?: UUID
): NewTradeCorrelationState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [analysesByWindow, setAnalysesByWindow] = useState<Record<CorrelationWindow, NewTradeCorrelationAnalysis> | null>(null);
  const [thresholds, setThresholds] = useState({ correlation: 0.7, concentration: 0.65 });

  const openStructures = useMemo(
    () => snapshots.filter((s) => s.structure.status !== "Fully Closed" && s.structure.id !== excludeStructureId),
    [snapshots, excludeStructureId]
  );
  // Includes each leg's CURRENT net_quantity (not just contract_id) — see
  // the matching comment in usePortfolioCorrelation.ts.
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
  const candidateSignature = useMemo(() => candidateWeights.map((w) => `${w.contract_id}=${w.ratio}`).sort().join(","), [candidateWeights]);

  useEffect(() => {
    if (candidateWeights.length === 0 || openStructures.length === 0) {
      setAnalysesByWindow(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const settings = await getCorrelationSettings();
        if (cancelled) return;
        setThresholds({ correlation: settings.correlation, concentration: settings.concentration });

        // Weight each existing leg by its ACTUAL signed open quantity, not
        // the structure's fixed template ratio — see CorrelationEngine's
        // file comment. The candidate side (candidateWeights, built in
        // AddEntryModal) is already scaled by this entry's own direction
        // and lots, so both sides of the comparison are real exposure.
        const withLegs = openStructures.map((s) => ({
          structure: s.structure,
          legs: s.legs.map((l) => ({ contract_id: l.leg.contract_id, ratio: l.position.net_quantity })),
        }));
        const context = await buildCorrelationContext(
          withLegs,
          contracts,
          templates,
          instruments,
          historyTradingDaysFor(settings.periods),
          candidateWeights
        );
        if (cancelled) return;

        const candidateSeries = buildCandidateSeries(context, candidateWeights);
        // Actual open lots per existing structure, not current_dollar_risk —
        // see CorrelationEngine.structureExposureLots.
        const exposureById = new Map(openStructures.map((s) => [s.structure.id, CorrelationEngine.structureExposureLots(s.legs)]));
        const byWindow = {} as Record<CorrelationWindow, NewTradeCorrelationAnalysis>;
        for (const window of CORRELATION_WINDOWS) {
          byWindow[window] = CorrelationEngine.analyzeNewTrade(
            candidateSeries,
            context.openStructures,
            window,
            settings.periods[window],
            settings.correlation,
            exposureById
          );
        }
        setAnalysesByWindow(byWindow);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to compute correlation preview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateSignature, structureSignature, contracts.length, templates.length, instruments.length]);

  return { loading, error, analysesByWindow, thresholds };
}
