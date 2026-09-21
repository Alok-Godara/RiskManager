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
 * Live "how would this NEW ENTRY interact with my existing portfolio"
 * preview — driven from AddEntryModal before the user submits.
 * `candidateWeights` is ONLY the entry itself (its direction and lots as
 * signed outright weights); the "existing portfolio" is every open structure
 * INCLUDING the one being added to, so its current position counts too.
 * `candidateInstrumentId` supplies the tick economics to put the entry in
 * dollars. Same unstable-reference caution as usePortfolioCorrelation:
 * depends on string signatures, not raw array/prop references (which get new
 * identities on every background reload).
 */
export function useNewTradeCorrelation(
  candidateWeights: { contract_id: UUID; ratio: number }[],
  snapshots: StructureSnapshot[],
  contracts: Contract[],
  templates: StructureTemplate[],
  instruments: Instrument[],
  candidateInstrumentId: UUID
): NewTradeCorrelationState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [analysesByWindow, setAnalysesByWindow] = useState<Record<CorrelationWindow, NewTradeCorrelationAnalysis> | null>(null);
  const [thresholds, setThresholds] = useState({ correlation: 0.7, concentration: 0.65 });

  const openStructures = useMemo(() => snapshots.filter((s) => s.structure.status !== "Fully Closed"), [snapshots]);
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

        const withLegs = openStructures.map((s) => ({
          structure: s.structure,
          legs: s.legs.map((l) => ({ contract_id: l.leg.contract_id, ratio: l.leg.ratio, net_quantity: l.position.net_quantity })),
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

        // The new entry on its own, and the existing book's combined position
        // (every open structure's outright weights added up).
        const candidateSeries = buildCandidateSeries(context, candidateWeights);
        const bookWeights = CorrelationEngine.netExposureByContract(
          context.openStructures.map((s) => ({ legs: s.outrightWeights })),
          context.contractsById,
          context.templatesById,
          context.instrumentContractsByInstrument
        );
        const bookSeries = CorrelationEngine.buildSeries(
          Array.from(bookWeights.entries()).map(([contract_id, ratio]) => ({ contract_id, ratio })),
          context.tradingDates,
          context.settlements
        );

        const instrument = instruments.find((i) => i.id === candidateInstrumentId);
        const dollarPerPriceUnit = instrument ? instrument.tick_value / instrument.tick_size : 1;
        const candidateDollarSeries = candidateSeries.map((pt) => ({ ...pt, value: pt.value * dollarPerPriceUnit }));
        const bookDollarSeriesList = context.openStructures.map((s) => s.positionDollarSeries).filter((s) => s.length > 0);

        const byWindow = {} as Record<CorrelationWindow, NewTradeCorrelationAnalysis>;
        for (const window of CORRELATION_WINDOWS) {
          byWindow[window] = CorrelationEngine.analyzeEntryVsBook({
            candidateSeries,
            bookSeries,
            existing: context.openStructures,
            candidateDollarSeries,
            bookDollarSeriesList,
            window,
            actualDays: settings.periods[window],
            warningThreshold: settings.correlation,
          });
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
  }, [candidateSignature, structureSignature, contracts.length, templates.length, instruments.length, candidateInstrumentId]);

  return { loading, error, analysesByWindow, thresholds };
}
