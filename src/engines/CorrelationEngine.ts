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
 * CorrelationEngine: builds each structure's historical daily value series
 * from settlement prices (never live/intraday quotes — this is a
 * day-over-day co-movement read), and computes rolling Pearson correlations
 * between them.
 *
 * A structure's "value" on a given day is sum(ratio_i * outright_settle_i)
 * — the SAME composite-structure-price convention used everywhere else in
 * this app (EntryEngine's avg_price, QuantHubProvider's derived structure
 * quotes). Any leg that's itself a "Structure"-kind quote (e.g. built from
 * Flies) is decomposed to its outright legs first, purely for this
 * historical reconstruction — exactly how InstrumentEngine does it for the
 * true-exposure view, and for the same reason: settlements exist per
 * outright contract, not per user-defined structure shape. Because ratio
 * signs already encode Long/Short, correlating these day-over-day diffs is
 * directly a "do these two positions' P&L move together" read: positive =
 * gain/lose together (concentrating), negative = offsetting (diversifying).
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
      const instrumentContracts = instrumentContractsByInstrument.get(contract.instrument_id) ?? [];
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

  /** Correlate two series' daily diffs over the most recent `windowDays` observations common to both (aligned by date). */
  static rollingCorrelation(seriesA: DailySeriesPoint[], seriesB: DailySeriesPoint[], windowDays: number): WindowCorrelation {
    const diffsA = this.seriesDiffs(seriesA);
    const diffsB = this.seriesDiffs(seriesB);
    const commonDates = Array.from(diffsA.keys())
      .filter((d) => diffsB.has(d))
      .sort()
      .slice(-windowDays);
    const a = commonDates.map((d) => diffsA.get(d)!);
    const b = commonDates.map((d) => diffsB.get(d)!);
    return {
      window: windowDays as CorrelationWindow,
      correlation: this.pearsonCorrelation(a, b),
      observations: commonDates.length,
    };
  }

  /** Every configured window's correlation between two already-built series. */
  static correlateAllWindows(seriesA: DailySeriesPoint[], seriesB: DailySeriesPoint[]): WindowCorrelation[] {
    return CORRELATION_WINDOWS.map((w) => this.rollingCorrelation(seriesA, seriesB, w));
  }

  /**
   * How a not-yet-created candidate structure would interact with the
   * existing open book, excluding nothing else (the candidate isn't in
   * `existing` since it hasn't been created). Risk-weighted by each
   * existing structure's current_dollar_risk, so a large position's
   * correlation matters more than a tiny one's.
   */
  static analyzeNewTrade(
    candidateSeries: DailySeriesPoint[],
    existing: { structure: Structure; series: DailySeriesPoint[] }[],
    window: CorrelationWindow,
    warningThreshold: number
  ): NewTradeCorrelationAnalysis {
    const perStructure = existing.map(({ structure, series }) => {
      const wc = this.rollingCorrelation(candidateSeries, series, window);
      return {
        structure_id: structure.id,
        structure_name: structure.name,
        correlation: wc.correlation,
        observations: wc.observations,
        risk: structure.current_dollar_risk,
      };
    });

    const withCorrelation = perStructure.filter((p) => p.correlation !== undefined);
    const totalRisk = withCorrelation.reduce((s, p) => s + Math.max(p.risk, 0), 0);
    const portfolioCorrelation =
      totalRisk > 0
        ? withCorrelation.reduce((s, p) => s + p.correlation! * Math.max(p.risk, 0), 0) / totalRisk
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
   * risk-weighted so large positions dominate the read more than small
   * ones:
   *
   *   sameDirectionRiskFraction =
   *     sum over positively-correlated pairs of [correlation * min(risk_i, risk_j)]
   *     ─────────────────────────────────────────────────────────────────────
   *     sum over ALL pairs of [min(risk_i, risk_j)]
   *
   * A portfolio whose pairs are mostly strongly positively correlated
   * scores close to 1 (one-directional); one whose pairs offset (negative
   * correlation) or are unrelated scores low.
   */
  static analyzePortfolioConcentration(
    structuresWithSeries: { structure: Structure; series: DailySeriesPoint[] }[],
    window: CorrelationWindow,
    correlationWarningThreshold: number,
    concentrationRiskThreshold: number
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
          windows: this.correlateAllWindows(a.series, b.series),
        });
      }
    }

    const windowOf = (p: StructurePairCorrelation) => p.windows.find((w) => w.window === window);
    const highCorrelationPairs = pairs.filter((p) => {
      const c = windowOf(p)?.correlation;
      return c !== undefined && Math.abs(c) >= correlationWarningThreshold;
    });

    const riskById = new Map(structuresWithSeries.map((s) => [s.structure.id, Math.max(s.structure.current_dollar_risk, 0)]));
    let weightedPositive = 0;
    let totalWeight = 0;
    const contributions: { pair: StructurePairCorrelation; contribution: number }[] = [];

    for (const pair of pairs) {
      const correlation = windowOf(pair)?.correlation;
      if (correlation === undefined) continue;
      const weight = Math.min(riskById.get(pair.structure_a_id) ?? 0, riskById.get(pair.structure_b_id) ?? 0);
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
        `Portfolio is becoming one-directional: ${((sameDirectionRiskFraction ?? 0) * 100).toFixed(0)}% of risk-weighted pairwise exposure at ${window}d is mutually reinforcing rather than offsetting. Driven by: ${names}.`
      );
    }
    for (const p of highCorrelationPairs) {
      const c = windowOf(p)?.correlation ?? 0;
      warnings.push(`"${p.structure_a_name}" and "${p.structure_b_name}" are highly correlated (${c.toFixed(2)}, ${window}d).`);
    }

    return { window, pairs, highCorrelationPairs, sameDirectionRiskFraction, isConcentrated, drivingPairs, warnings };
  }
}
