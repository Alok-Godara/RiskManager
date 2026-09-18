import type { Contract, CorrelationWindow, Instrument, SettlementPrice, Structure, StructureTemplate, UUID } from "../../types/domain";
import { CORRELATION_WINDOWS } from "../../types/domain";
import { repository } from "../../data";
import { CorrelationEngine, type DailySeriesPoint } from "../../engines/CorrelationEngine";
import { formatDateParam, previousTradingDay, tradingDaysIncluding } from "../../utils/tradingDays";
import { SettlementHistoryService } from "./settlementHistoryService";

/** Default trading-day lookback per label — used until the user configures their own in Settings -> Correlation & Concentration. */
const DEFAULT_PERIODS: Record<CorrelationWindow, number> = { 5: 5, 15: 15, 30: 30 };
/**
 * Default rolling sub-window size per label, for the TREND (see
 * CorrelationEngine.rollingCorrelationTrend) — a 5-day period only fits one
 * 5-day window (same single-number behavior as before this existed); 15d
 * and 30d get an actual trend. 30d's default of 7 matches a "hold for about
 * a week" horizon, a reasonable middle ground absent a stated preference.
 */
const DEFAULT_ROLLING_WINDOWS: Record<CorrelationWindow, number> = { 5: 5, 15: 5, 30: 7 };

/** N+1 settlement observations are needed for an N-day rolling correlation (N diffs) — the fallback before any period config exists. */
export const HISTORY_TRADING_DAYS = Math.max(...CORRELATION_WINDOWS) + 1;

/** How many trading days of settlement history to fetch/keep, given the configured periods — the longest period, plus one (see HISTORY_TRADING_DAYS). */
export function historyTradingDaysFor(periods: Record<CorrelationWindow, number>): number {
  return Math.max(...Object.values(periods)) + 1;
}

export interface CorrelationContext {
  openStructures: {
    structure: Structure;
    /** Position-weighted (net_quantity) series — the basis for correlation and for portfolio-level exposure, since it reflects what's actually held. */
    series: DailySeriesPoint[];
    /** Same position-weighted series, converted to $ via the structure's own instrument's tick_value/tick_size — for $ volatility/risk-impact math (CorrelationEngine.dollarVolatility / combinedDollarVolatility). */
    positionDollarSeries: DailySeriesPoint[];
    /** Template-ratio-weighted series (independent of how many lots are currently held), converted to $ — the basis for Beta/regression and Hedge Ratio, which are properties of the structures' shapes, not of current position size. */
    perLotDollarSeries: DailySeriesPoint[];
  }[];
  tradingDates: string[]; // YYYY-MM-DD, oldest..newest
  contractsById: Map<UUID, Contract>;
  templatesById: Map<UUID, StructureTemplate>;
  instrumentContractsByInstrument: Map<UUID, Contract[]>;
  settlements: SettlementPrice[];
  /** Net (signed) lots per outright contract, aggregated across every open structure passed in — see CorrelationEngine.netExposureByContract. */
  netExposureByContract: Map<UUID, number>;
  /** Every outright contract touched by ANY open structure's decomposition, even ones that net to zero — lets the UI show "0 (hedged)" instead of the contract silently disappearing. */
  touchedContractIds: Set<UUID>;
}

/**
 * The one place that combines settlement fetching (I/O) with
 * CorrelationEngine's pure math: ensures history exists for every outright
 * contract ANY configured instrument has (not just ones an open structure
 * or candidate currently touches — see the loop below buildCorrelationContext
 * uses to widen `neededOutrights`), then builds each open structure's daily
 * value series ready for CorrelationEngine.analyzeNewTrade /
 * analyzePortfolioConcentration.
 *
 * `extraLegs` (e.g. a candidate being previewed in NewStructureForm) only
 * widens which contracts' settlement history gets fetched — it does not
 * appear in the returned `openStructures`; build its series separately with
 * CorrelationEngine.legsToOutrightWeights + buildSeries against this same
 * context, so both calls share one fetch pass instead of two.
 *
 * `openStructuresWithLegs[].legs` carry BOTH the structure's fixed template
 * ratio (`ratio`) and its actual current signed open quantity
 * (`net_quantity`, from `position.net_quantity`) — two different series get
 * built from these (see CorrelationContext's field docs): the POSITION
 * series (from `net_quantity`) for correlation/exposure, and the PER-LOT
 * series (from `ratio`) for Beta/Hedge Ratio, which must stay independent
 * of how many lots are currently held (see CorrelationEngine's file
 * comment). Callers build this from `StructureSnapshot.legs` as
 * `{ contract_id: l.leg.contract_id, ratio: l.leg.ratio, net_quantity: l.position.net_quantity }`.
 */
export async function buildCorrelationContext(
  openStructuresWithLegs: { structure: Structure; legs: { contract_id: UUID; ratio: number; net_quantity: number }[] }[],
  contracts: Contract[],
  templates: StructureTemplate[],
  instruments: Instrument[],
  historyTradingDays: number,
  extraLegs: { contract_id: UUID; ratio: number }[] = []
): Promise<CorrelationContext> {
  const contractsById = new Map(contracts.map((c) => [c.id, c]));
  const templatesById = new Map(templates.map((t) => [t.id, t]));
  const instrumentsById = new Map(instruments.map((i) => [i.id, i]));
  const instrumentContractsByInstrument = new Map<UUID, Contract[]>();
  for (const c of contracts) {
    const list = instrumentContractsByInstrument.get(c.instrument_id) ?? [];
    list.push(c);
    instrumentContractsByInstrument.set(c.instrument_id, list);
  }

  const neededOutrights = new Map<UUID, Contract>();
  const collect = (legs: { contract_id: UUID; ratio: number }[]) => {
    for (const c of CorrelationEngine.outrightContractsForLegs(legs, contractsById, templatesById, instrumentContractsByInstrument)) {
      neededOutrights.set(c.id, c);
    }
  };
  for (const { legs } of openStructuresWithLegs) {
    // Both weightings can touch different contracts in edge cases (e.g. a
    // partially-exited leg whose net_quantity is 0 but whose template ratio
    // isn't) — collect for both so settlement history is never missing for
    // either series.
    collect(legs.map((l) => ({ contract_id: l.contract_id, ratio: l.ratio })));
    collect(legs.map((l) => ({ contract_id: l.contract_id, ratio: l.net_quantity })));
  }
  collect(extraLegs);

  // Also warm every OTHER configured instrument's outright contracts, not
  // just the ones today's open structures/candidate happen to touch — the
  // settlement endpoint always returns the whole market in one response
  // regardless of how few symbols we ask for (see client.ts), so backfilling
  // every instrument here costs nothing extra over the network. This means
  // history is already cached by the time a structure gets created in an
  // instrument that's configured but not yet traded (e.g. WTI, Gasoil),
  // instead of showing "insufficient data" on day one for it.
  for (const c of contracts) {
    if ((!c.kind || c.kind === "Outright") && instrumentsById.has(c.instrument_id)) {
      neededOutrights.set(c.id, c);
    }
  }

  await SettlementHistoryService.ensureHistory(Array.from(neededOutrights.values()), instrumentsById, historyTradingDays);

  const mostRecent = previousTradingDay(new Date());
  const tradingDates = tradingDaysIncluding(mostRecent, historyTradingDays).map(formatDateParam);
  const settlements = await repository.getSettlementPricesByContracts(Array.from(neededOutrights.keys()));

  const touchedContractIds = new Set<UUID>();
  const openStructures = openStructuresWithLegs.map(({ structure, legs }) => {
    const positionWeights = CorrelationEngine.legsToOutrightWeights(
      legs.map((l) => ({ contract_id: l.contract_id, ratio: l.net_quantity })),
      contractsById,
      templatesById,
      instrumentContractsByInstrument
    );
    const templateWeights = CorrelationEngine.legsToOutrightWeights(
      legs.map((l) => ({ contract_id: l.contract_id, ratio: l.ratio })),
      contractsById,
      templatesById,
      instrumentContractsByInstrument
    );
    for (const w of positionWeights) touchedContractIds.add(w.contract_id);
    for (const w of templateWeights) touchedContractIds.add(w.contract_id);

    const series = CorrelationEngine.buildSeries(positionWeights, tradingDates, settlements);
    const perLotSeries = CorrelationEngine.buildSeries(templateWeights, tradingDates, settlements);

    const instrument = instrumentsById.get(structure.instrument_id);
    const dollarPerPriceUnit = instrument ? instrument.tick_value / instrument.tick_size : 1;
    const positionDollarSeries = series.map((pt) => ({ ...pt, value: pt.value * dollarPerPriceUnit }));
    const perLotDollarSeries = perLotSeries.map((pt) => ({ ...pt, value: pt.value * dollarPerPriceUnit }));

    return { structure, series, positionDollarSeries, perLotDollarSeries };
  });
  const netExposureByContract = CorrelationEngine.netExposureByContract(
    openStructuresWithLegs.map(({ legs }) => ({ legs: legs.map((l) => ({ contract_id: l.contract_id, ratio: l.net_quantity })) })),
    contractsById,
    templatesById,
    instrumentContractsByInstrument
  );

  return {
    openStructures,
    tradingDates,
    contractsById,
    templatesById,
    instrumentContractsByInstrument,
    settlements,
    netExposureByContract,
    touchedContractIds,
  };
}

/** Build a candidate's (not-yet-created structure's) daily series from an already-built context — see `extraLegs` above. */
export function buildCandidateSeries(context: CorrelationContext, legs: { contract_id: UUID; ratio: number }[]): DailySeriesPoint[] {
  const weights = CorrelationEngine.legsToOutrightWeights(legs, context.contractsById, context.templatesById, context.instrumentContractsByInstrument);
  return CorrelationEngine.buildSeries(weights, context.tradingDates, context.settlements);
}

const DEFAULT_APP_SETTINGS = { correlation_warning_threshold: 0.7, concentration_risk_threshold: 0.65 };

export interface CorrelationSettings {
  correlation: number;
  concentration: number;
  periods: Record<CorrelationWindow, number>;
  rollingWindows: Record<CorrelationWindow, number>;
}

/** Current thresholds + per-label period/rolling-window config, falling back to sensible defaults if nothing's been saved yet (Settings -> Correlation & Concentration). One read, reused by both the portfolio panel and the entry-screen preview. */
export async function getCorrelationSettings(): Promise<CorrelationSettings> {
  const settings = await repository.getAppSettings();
  return {
    correlation: settings?.correlation_warning_threshold ?? DEFAULT_APP_SETTINGS.correlation_warning_threshold,
    concentration: settings?.concentration_risk_threshold ?? DEFAULT_APP_SETTINGS.concentration_risk_threshold,
    periods: settings?.correlation_periods ?? DEFAULT_PERIODS,
    rollingWindows: settings?.correlation_rolling_windows ?? DEFAULT_ROLLING_WINDOWS,
  };
}
