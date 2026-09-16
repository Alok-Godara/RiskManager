import type {
  Contract,
  CorrelationWindow,
  NewTradeCorrelationAnalysis,
  PortfolioConcentrationAnalysis,
  Structure,
  StructureLeg,
  StructurePairCorrelation,
  StructureTemplate,
  SettlementPrice,
  UUID,
  WindowCorrelation,
} from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { expandToOutrights } from "../utils/templateExpansion";

export interface LegWeight {
  contract_id: UUID;
  ratio: number;
}

export interface DailySeriesPoint {
  date: string; // YYYY-MM-DD
  value: number; // composite structure price on that date: sum(ratio_i * settle_i)
}

export interface StructureWithLegs {
  structure: Structure;
  legs: StructureLeg[];
}

/**
 * CorrelationEngine: builds each structure's historical daily EXPOSURE value
 * series from settlement prices (never live/intraday quotes — this is a
 * day-over-day co-movement read), and computes rolling Pearson correlations
 * between them.
 *
 * A structure's "value" on a given day is sum(weight_i * outright_settle_i),
 * where `weight_i` is that leg's ACTUAL SIGNED OPEN QUANTITY (Position.net_
 * quantity) — never the structure's fixed template ratio. This is the
 * critical distinction: two structures can share an identical template
 * shape (e.g. both a "Fly") yet be held in OPPOSITE real directions (one
 * entered Long, the other Short — direction is chosen per Entry, not baked
 * into the template, see StructureEngine.addEntry), or at different lot
 * sizes, or partially exited on some legs but not others. Weighting by
 * net_quantity means the series — and therefore any correlation computed
 * from it — reflects what's ACTUALLY held right now: two opposite-direction
 * positions in the same shape correctly correlate toward -1 (they hedge, a
 * market move in either direction roughly cancels), not +1 (which is what
 * you'd get from comparing their template shapes alone, ignoring direction
 * entirely — the bug this replaced).
 *
 * Any leg that's itself a "Structure"-kind quote (e.g. built from Flies) is
 * decomposed to its outright legs first, purely for this historical
 * reconstruction — exactly how InstrumentEngine does it for the
 * true-exposure view, and for the same reason: settlements exist per
 * outright contract, not per user-defined structure shape. Because the
 * weights are now real signed exposure, correlating these day-over-day
 * diffs is directly a "do these two positions' P&L move together" read:
 * positive = gain/lose together (concentrating), negative = offsetting
 * (diversifying) — see netExposureByContract below for the complementary,
 * correlation-free view of the same thing (net lots actually held per
 * contract, aggregated across the whole book).
 *
 * Callers build the `legs` input passed to legsToOutrightWeights /
 * netExposureByContract as `{ contract_id: leg.contract_id, ratio: position.
 * net_quantity }` for any EXISTING open structure (see
 * services/settlementData/correlationContext.ts) — "ratio" here is really
 * "signed weight," reused as the field name since the math (this class) is
 * agnostic to what the number represents. A not-yet-created CANDIDATE trade
 * (AddEntryModal) instead passes its own about-to-be-submitted signed
 * quantity (leg.ratio * direction * lots), which is what net_quantity WOULD
 * become the instant that entry is saved.
 */
export class CorrelationEngine {
  /**
   * Expands a structure's (or a not-yet-created candidate's) legs down to
   * outright weights. Contracts whose anchor window no longer covers the
   * needed offset are silently skipped (matches InstrumentEngine) rather
   * than failing the whole analysis. Duplicate outrights (two legs
   * decomposing to the same contract) are merged.
   */
  static legsToOutrightWeights(
    legs: { contract_id: UUID; ratio: number }[],
    contractsById: Map<UUID, Contract>,
    templatesById: Map<UUID, StructureTemplate>,
    instrumentContractsByInstrument: Map<UUID, Contract[]>
  ): LegWeight[] {
    const raw: LegWeight[] = [];
    for (const leg of legs) {
      const contract = contractsById.get(leg.contract_id);
      if (!contract) continue;
      if (!contract.kind || contract.kind === "Outright") {
        raw.push({ contract_id: contract.id, ratio: leg.ratio });
        continue;
      }
      if (!contract.quote_template_id || !contract.anchor_contract_id) continue;
      const template = templatesById.get(contract.quote_template_id);
      if (!template) continue;
      // Outrights only: expandToOutrights walks N months forward from the
      // anchor by array position in a chronologically-sorted list, and a
      // "Structure"-kind contract (e.g. a Calendar Spread quote) shares its
      // anchor's own expiry_date — mixed into an unfiltered list, that tie
      // makes sort order (and therefore which contract offset N lands on)
      // effectively arbitrary, silently resolving to another quote contract
      // instead of the intended outright month. Same filter QuantHubProvider
      // and templateExpansion.previewLegs already apply before this call.
      const instrumentContracts = (instrumentContractsByInstrument.get(contract.instrument_id) ?? []).filter(
        (c) => !c.kind || c.kind === "Outright"
      );
      try {
        const decomposed = expandToOutrights(template, contract.anchor_contract_id, instrumentContracts);
        for (const d of decomposed) raw.push({ contract_id: d.contract_id, ratio: d.ratio * leg.ratio });
      } catch {
        // Anchor's contract window no longer covers this quote's span — skip.
      }
    }
    const merged = new Map<UUID, number>();
    for (const w of raw) merged.set(w.contract_id, (merged.get(w.contract_id) ?? 0) + w.ratio);
    return Array.from(merged.entries()).map(([contract_id, ratio]) => ({ contract_id, ratio }));
  }

  /**
   * A structure's current net open size, in "structure lots" — the anchor
   * leg's (largest |ratio|, same convention EntryEngine uses per-entry)
   * |net_quantity| / |ratio|. Used to weight how much a structure's
   * correlation contributes to a portfolio-level read by its ACTUAL
   * exposure, not by `current_dollar_risk` (a risk/stop-loss budget that
   * can diverge from real position size — e.g. three small structures with
   * a combined 10 lots vs. one 10-lot hedge shouldn't read as "1 structure
   * vs. 3" if dollar risk happens to be allocated unevenly).
   */
  static structureExposureLots(legs: { leg: { ratio: number }; position: { net_quantity: number } }[]): number {
    if (legs.length === 0) return 0;
    const anchor = legs.reduce((a, b) => (Math.abs(b.leg.ratio) > Math.abs(a.leg.ratio) ? b : a));
    const ratioAbs = Math.abs(anchor.leg.ratio);
    return ratioAbs > 0 ? Math.abs(anchor.position.net_quantity) / ratioAbs : 0;
  }

  /** The outright Contract objects `legs` ultimately touch — what to fetch/ensure settlement history for. */
  static outrightContractsForLegs(
    legs: { contract_id: UUID; ratio: number }[],
    contractsById: Map<UUID, Contract>,
    templatesById: Map<UUID, StructureTemplate>,
    instrumentContractsByInstrument: Map<UUID, Contract[]>
  ): Contract[] {
    const weights = this.legsToOutrightWeights(legs, contractsById, templatesById, instrumentContractsByInstrument);
    return weights.map((w) => contractsById.get(w.contract_id)).filter((c): c is Contract => Boolean(c));
  }

  /**
   * The book's NET aggregated exposure per outright contract, summed
   * (signed) across every open structure — the direct answer to "if two
   * positions hedge each other, what does that look like." Two structures
   * built from the same shape but held in opposite directions decompose to
   * the same outright contracts with opposite-signed weights, so they net
   * toward zero here even though each one individually has nonzero
   * exposure — e.g. a Long Fly (via Fly legs) and an equal-sized Short Fly
   * (via Spread legs) both touch the same 3 outright months and cancel
   * exactly. Contracts with exactly zero net weight are omitted; the caller
   * decides whether to also show "touched but net zero" contracts by
   * cross-referencing which contracts appear in any individual structure's
   * own decomposition.
   */
  static netExposureByContract(
    structuresWithLegs: { legs: { contract_id: UUID; ratio: number }[] }[],
    contractsById: Map<UUID, Contract>,
    templatesById: Map<UUID, StructureTemplate>,
    instrumentContractsByInstrument: Map<UUID, Contract[]>
  ): Map<UUID, number> {
    const net = new Map<UUID, number>();
    for (const { legs } of structuresWithLegs) {
      const weights = this.legsToOutrightWeights(legs, contractsById, templatesById, instrumentContractsByInstrument);
      for (const w of weights) net.set(w.contract_id, (net.get(w.contract_id) ?? 0) + w.ratio);
    }
    return net;
  }

  /** sum(ratio_i * settle_i) per trading day; a day is included only if EVERY weighted outright has a settlement for it. */
  static buildSeries(weights: LegWeight[], tradingDates: string[], settlements: SettlementPrice[]): DailySeriesPoint[] {
    if (weights.length === 0) return [];
    const priceByKey = new Map(settlements.map((s) => [`${s.contract_id}::${s.date}`, s.price]));
    const series: DailySeriesPoint[] = [];
    for (const date of tradingDates) {
      let value = 0;
      let complete = true;
      for (const w of weights) {
        const price = priceByKey.get(`${w.contract_id}::${date}`);
        if (price === undefined) {
          complete = false;
          break;
        }
        value += w.ratio * price;
      }
      if (complete) series.push({ date, value });
    }
    return series;
  }

  /** Day-over-day changes, keyed by the LATER date of each pair. */
  private static seriesDiffs(series: DailySeriesPoint[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 1; i < series.length; i++) {
      out.set(series[i].date, series[i].value - series[i - 1].value);
    }
    return out;
  }

  /**
   * Pearson correlation coefficient. Undefined (not 0) when there's too
   * little data or either series has zero variance — 0 would misleadingly
   * read as "confirmed no relationship" rather than "can't tell."
   */
  static pearsonCorrelation(a: number[], b: number[]): number | undefined {
    if (a.length !== b.length || a.length < 2) return undefined;
    const n = a.length;
    const meanA = a.reduce((s, x) => s + x, 0) / n;
    const meanB = b.reduce((s, x) => s + x, 0) / n;
    let cov = 0;
    let varA = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      cov += da * db;
      varA += da * da;
      varB += db * db;
    }
    if (varA === 0 || varB === 0) return undefined;
    return cov / Math.sqrt(varA * varB);
  }

  /**
   * Correlate two series' daily diffs over the most recent `actualDays`
   * observations common to both (aligned by date) — the CURRENT snapshot
   * (today's value), used for verdicts/warnings/thresholds. `label` is the
   * 5d/15d/30d column this result is filed under for display; `actualDays`
   * is the real day-count behind that label (Settings -> Correlation &
   * Concentration lets it differ from the label, e.g. a "15d" column
   * configured to actually use 20 days).
   */
  static rollingCorrelation(
    seriesA: DailySeriesPoint[],
    seriesB: DailySeriesPoint[],
    actualDays: number,
    label: CorrelationWindow
  ): WindowCorrelation {
    const diffsA = this.seriesDiffs(seriesA);
    const diffsB = this.seriesDiffs(seriesB);
    const commonDates = Array.from(diffsA.keys())
      .filter((d) => diffsB.has(d))
      .sort()
      .slice(-actualDays);
    const a = commonDates.map((d) => diffsA.get(d)!);
    const b = commonDates.map((d) => diffsB.get(d)!);
    return {
      window: label,
      correlation: this.pearsonCorrelation(a, b),
      observations: commonDates.length,
    };
  }

  /**
   * A TREND of correlation values, not one number: slides a `windowDays`
   * sub-window of diffs one day at a time across the trailing `periodDays`
   * of history, computing one Pearson correlation per position — e.g.
   * period=30/window=7 -> correlation over days 1-7, then 2-8, ... 24-30
   * (24 points), so a strengthening/fading relationship is visible instead
   * of a single static snapshot. `windowDays` is clamped to what's actually
   * available (>= 2, since Pearson needs at least 2 diffs, and <= the
   * period's own diff count).
   */
  static rollingCorrelationTrend(
    seriesA: DailySeriesPoint[],
    seriesB: DailySeriesPoint[],
    periodDays: number,
    windowDays: number
  ): { endDate: string; correlation?: number; observations: number }[] {
    const diffsA = this.seriesDiffs(seriesA);
    const diffsB = this.seriesDiffs(seriesB);
    const commonDates = Array.from(diffsA.keys())
      .filter((d) => diffsB.has(d))
      .sort()
      .slice(-periodDays);
    if (commonDates.length < 2) return [];
    const win = Math.max(2, Math.min(windowDays, commonDates.length));

    const points: { endDate: string; correlation?: number; observations: number }[] = [];
    for (let end = win; end <= commonDates.length; end++) {
      const slice = commonDates.slice(end - win, end);
      const a = slice.map((d) => diffsA.get(d)!);
      const b = slice.map((d) => diffsB.get(d)!);
      points.push({ endDate: slice[slice.length - 1], correlation: this.pearsonCorrelation(a, b), observations: slice.length });
    }
    return points;
  }

  /** Every configured window's CURRENT correlation between two already-built series, using each label's actual configured day-count. */
  static correlateAllWindows(
    seriesA: DailySeriesPoint[],
    seriesB: DailySeriesPoint[],
    windowConfig: Record<CorrelationWindow, number>
  ): WindowCorrelation[] {
    return CORRELATION_WINDOWS.map((label) => this.rollingCorrelation(seriesA, seriesB, windowConfig[label], label));
  }

  /**
   * How a not-yet-created candidate structure would interact with the
   * existing open book, excluding nothing else (the candidate isn't in
   * `existing` since it hasn't been created). Exposure-weighted by each
   * existing structure's actual open lots (`exposureById`, from
   * structureExposureLots — NOT current_dollar_risk, a risk/stop-loss
   * budget that can diverge from real position size), so a large position's
   * correlation matters more than a tiny one's, based on what's actually
   * held rather than how much risk happens to be allocated to it.
   */
  static analyzeNewTrade(
    candidateSeries: DailySeriesPoint[],
    existing: { structure: Structure; series: DailySeriesPoint[] }[],
    window: CorrelationWindow,
    actualDays: number,
    warningThreshold: number,
    exposureById: Map<UUID, number>
  ): NewTradeCorrelationAnalysis {
    const perStructure = existing.map(({ structure, series }) => {
      const wc = this.rollingCorrelation(candidateSeries, series, actualDays, window);
      return {
        structure_id: structure.id,
        structure_name: structure.name,
        correlation: wc.correlation,
        observations: wc.observations,
        exposure: exposureById.get(structure.id) ?? 0,
      };
    });

    const withCorrelation = perStructure.filter((p) => p.correlation !== undefined);
    const totalExposure = withCorrelation.reduce((s, p) => s + Math.max(p.exposure, 0), 0);
    const portfolioCorrelation =
      totalExposure > 0
        ? withCorrelation.reduce((s, p) => s + p.correlation! * Math.max(p.exposure, 0), 0) / totalExposure
        : withCorrelation.length > 0
          ? withCorrelation.reduce((s, p) => s + p.correlation!, 0) / withCorrelation.length
          : undefined;

    const warnings: string[] = [];
    let verdict: NewTradeCorrelationAnalysis["verdict"] = "Insufficient data";

    if (portfolioCorrelation !== undefined) {
      verdict = portfolioCorrelation >= 0.3 ? "Concentrating" : portfolioCorrelation <= -0.2 ? "Diversifying" : "Neutral";
    }

    for (const p of withCorrelation) {
      if (Math.abs(p.correlation!) >= warningThreshold) {
        const direction = p.correlation! > 0 ? "adds to" : "hedges against";
        warnings.push(
          `Highly correlated with "${p.structure_name}" (${p.correlation!.toFixed(2)}, ${window}d) — this ${direction} that exposure rather than sitting independently.`
        );
      }
    }

    return {
      window,
      perStructure: perStructure.map(({ structure_id, structure_name, correlation, observations }) => ({
        structure_id,
        structure_name,
        correlation,
        observations,
      })),
      portfolioCorrelation,
      verdict,
      warnings,
    };
  }

  /**
   * Portfolio-level concentration: are the currently open structures, taken
   * together, behaving like one big directional bet rather than a
   * diversified book? Built purely from the pairwise correlation matrix
   * (no synthetic "market index" — see CorrelationEngine's file comment),
   * weighted by each structure's actual open exposure (`exposureById`, from
   * structureExposureLots) so large POSITIONS dominate the read more than
   * small ones — deliberately NOT current_dollar_risk (a stop-loss budget
   * that can diverge from real position size, e.g. three small structures
   * with a combined 10 lots vs. one 10-lot hedge shouldn't read as
   * "1 structure vs. 3" just because dollar risk happens to be allocated
   * unevenly):
   *
   *   sameDirectionRiskFraction =
   *     sum over positively-correlated pairs of [correlation * min(exposure_i, exposure_j)]
   *     ─────────────────────────────────────────────────────────────────────
   *     sum over ALL pairs of [min(exposure_i, exposure_j)]
   *
   * A portfolio whose pairs are mostly strongly positively correlated
   * scores close to 1 (one-directional); one whose pairs offset (negative
   * correlation) or are unrelated scores low.
   */
  static analyzePortfolioConcentration(
    structuresWithSeries: { structure: Structure; series: DailySeriesPoint[] }[],
    window: CorrelationWindow,
    windowConfig: Record<CorrelationWindow, number>,
    correlationWarningThreshold: number,
    concentrationRiskThreshold: number,
    exposureById: Map<UUID, number>
  ): PortfolioConcentrationAnalysis {
    const pairs: StructurePairCorrelation[] = [];

    for (let i = 0; i < structuresWithSeries.length; i++) {
      for (let j = i + 1; j < structuresWithSeries.length; j++) {
        const a = structuresWithSeries[i];
        const b = structuresWithSeries[j];
        pairs.push({
          structure_a_id: a.structure.id,
          structure_a_name: a.structure.name,
          structure_b_id: b.structure.id,
          structure_b_name: b.structure.name,
          windows: this.correlateAllWindows(a.series, b.series, windowConfig),
        });
      }
    }

    const windowOf = (p: StructurePairCorrelation) => p.windows.find((w) => w.window === window);
    const highCorrelationPairs = pairs.filter((p) => {
      const c = windowOf(p)?.correlation;
      return c !== undefined && Math.abs(c) >= correlationWarningThreshold;
    });

    let weightedPositive = 0;
    let totalWeight = 0;
    const contributions: { pair: StructurePairCorrelation; contribution: number }[] = [];

    for (const pair of pairs) {
      const correlation = windowOf(pair)?.correlation;
      if (correlation === undefined) continue;
      const weight = Math.min(exposureById.get(pair.structure_a_id) ?? 0, exposureById.get(pair.structure_b_id) ?? 0);
      if (weight <= 0) continue;
      totalWeight += weight;
      if (correlation > 0) {
        const contribution = correlation * weight;
        weightedPositive += contribution;
        contributions.push({ pair, contribution });
      }
    }

    const sameDirectionRiskFraction = totalWeight > 0 ? weightedPositive / totalWeight : undefined;
    const isConcentrated = sameDirectionRiskFraction !== undefined && sameDirectionRiskFraction >= concentrationRiskThreshold;

    const drivingPairs = contributions
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 5)
      .map((c) => c.pair);

    const warnings: string[] = [];
    if (isConcentrated) {
      const names = drivingPairs.map((p) => `"${p.structure_a_name}" / "${p.structure_b_name}"`).join(", ");
      warnings.push(
        `Portfolio is becoming one-directional: ${((sameDirectionRiskFraction ?? 0) * 100).toFixed(0)}% of exposure-weighted (lot-based, not dollar-risk) pairwise correlation at ${window}d is mutually reinforcing rather than offsetting. Driven by: ${names}.`
      );
    }
    for (const p of highCorrelationPairs) {
      const c = windowOf(p)?.correlation ?? 0;
      warnings.push(`"${p.structure_a_name}" and "${p.structure_b_name}" are highly correlated (${c.toFixed(2)}, ${window}d).`);
    }

    return { window, pairs, highCorrelationPairs, sameDirectionRiskFraction, isConcentrated, drivingPairs, warnings };
  }
}
