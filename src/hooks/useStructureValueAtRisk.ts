import { useEffect, useMemo, useState } from "react";
import type { Contract, Instrument, StructureSnapshot, StructureTemplate, UUID, ValueAtRiskResult } from "../types/domain";
import { CorrelationEngine, VAR_LOOKBACK_DAYS } from "../engines/CorrelationEngine";
import { buildCorrelationContext } from "../services/settlementData/correlationContext";

export interface StructureValueAtRiskState {
  loading: boolean;
  /** undefined when the structure holds nothing, or there isn't enough settlement history yet. */
  valueAtRisk: ValueAtRiskResult | undefined;
}

/**
 * Value at Risk / daily swing of ONE structure, on its OWN currently open
 * lots only (not the whole book — that is the Correlation tab's net figure).
 * Same method as CorrelationEngine.valueAtRisk: the structure's position is
 * decomposed to signed outright-month lots, so a calendar spread or fly's
 * months offset each other exactly as they do in the market.
 *
 * Like usePortfolioCorrelation it keys its effect on a small signature (the
 * structure's legs and net quantities), not on the array props, which get
 * new references on every background price poll.
 */
export function useStructureValueAtRisk(
  snapshot: StructureSnapshot,
  contracts: Contract[],
  templates: StructureTemplate[],
  instruments: Instrument[]
): StructureValueAtRiskState {
  const [loading, setLoading] = useState(true);
  const [valueAtRisk, setValueAtRisk] = useState<ValueAtRiskResult | undefined>();

  const signature = useMemo(
    () => `${snapshot.structure.id}:${snapshot.legs.map((l) => `${l.leg.contract_id}=${l.position.net_quantity}`).join(",")}`,
    [snapshot]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const legs = snapshot.legs.map((l) => ({ contract_id: l.leg.contract_id, ratio: l.leg.ratio, net_quantity: l.position.net_quantity }));
        const context = await buildCorrelationContext([{ structure: snapshot.structure, legs }], contracts, templates, instruments, VAR_LOOKBACK_DAYS + 1, [], false);
        if (cancelled) return;

        const instrumentsById = new Map(instruments.map((i) => [i.id, i]));
        const dollarPerUnitByContract = new Map<UUID, number>();
        for (const id of context.netExposureByContract.keys()) {
          const instrument = instrumentsById.get(context.contractsById.get(id)?.instrument_id ?? "");
          dollarPerUnitByContract.set(id, instrument ? instrument.tick_value / instrument.tick_size : 1);
        }
        setValueAtRisk(
          CorrelationEngine.valueAtRisk({
            lotsByContract: context.netExposureByContract,
            dollarPerUnitByContract,
            tradingDates: context.tradingDates,
            settlements: context.settlements,
          })
        );
      } catch {
        if (!cancelled) setValueAtRisk(undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, contracts.length, templates.length, instruments.length]);

  return { loading, valueAtRisk };
}
