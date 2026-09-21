import type { CorrelationWindow, PortfolioConcentrationAnalysis, StructureSnapshot, UUID } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { CorrelationEngine, type DailySeriesPoint } from "../engines/CorrelationEngine";
import { fmtMoney } from "../utils/format";
import { correlationStrength, fmtQh } from "../utils/correlationFormat";
import { InfoTip } from "./InfoTip";

type Tone = "good" | "warn" | "bad" | "neutral";
const TONE_COLOR: Record<Tone, string> = {
  good: "var(--green)",
  warn: "var(--amber)",
  bad: "var(--red)",
  neutral: "var(--text-dim)",
};

interface Row {
  id: UUID;
  name: string;
  instrumentSymbol: string;
  netLots: number;
  vol: number;
  share: number;
}

/**
 * Short read of the whole book: who carries the risk, how related the
 * structures are (QuantHub's -100..100 scale, your actual lots) and whether
 * the combination really spreads risk. One line each on the page; the fuller
 * explanation lives behind each line's "i". All $ figures are typical daily
 * dollar swings over the selected window.
 */
export function PortfolioRead({
  window,
  actualDays,
  openSnapshots,
  positionDollarSeriesByStructureId,
  analysis,
  concentrationThreshold,
  instrumentSymbolById,
}: {
  window: CorrelationWindow;
  actualDays: number;
  openSnapshots: StructureSnapshot[];
  positionDollarSeriesByStructureId: Record<UUID, DailySeriesPoint[]>;
  analysis: PortfolioConcentrationAnalysis;
  concentrationThreshold: number;
  instrumentSymbolById: Map<UUID, string>;
}) {
  const vols = openSnapshots.map((s) => {
    const series = positionDollarSeriesByStructureId[s.structure.id];
    return series ? CorrelationEngine.dollarVolatility(series, actualDays) ?? 0 : 0;
  });
  const gross = vols.reduce((a, b) => a + b, 0);
  const rows: Row[] = openSnapshots
    .map((s, i) => ({
      id: s.structure.id,
      name: s.structure.name,
      instrumentSymbol: instrumentSymbolById.get(s.structure.instrument_id) ?? "—",
      netLots: CorrelationEngine.structureNetLotsSigned(s.legs),
      vol: vols[i],
      share: gross > 0 ? vols[i] / gross : 0,
    }))
    .sort((a, b) => b.vol - a.vol);

  const net = analysis.netDollarRisk;
  // What the book would swing if every position were completely unrelated
  // to the others (risks add in quadrature) — the fair "no relationship"
  // reference point, which is neither 0 nor the plain sum.
  const independent = Math.sqrt(vols.reduce((s, v) => s + v * v, 0));

  const bullets: { tone: Tone; text: string; more?: string }[] = [];

  if (rows.length > 1 && rows[0].share >= 0.6) {
    bullets.push({
      tone: "warn",
      text: `Risk leans on ${rows[0].name} (${(rows[0].share * 100).toFixed(0)}% of the total).`,
    });
  }

  for (const p of analysis.pairs) {
    const at = (w: CorrelationWindow) => p.windows.find((x) => x.window === w)?.correlation;
    const c = at(window);
    if (c === undefined) {
      bullets.push({ tone: "neutral", text: `${p.structure_a_name} vs ${p.structure_b_name}: not enough data yet.` });
      continue;
    }
    const first = CORRELATION_WINDOWS[0];
    const last = CORRELATION_WINDOWS[CORRELATION_WINDOWS.length - 1];
    const shortTerm = at(first);
    const longTerm = at(last);
    const regimeShift = shortTerm !== undefined && longTerm !== undefined && Math.abs(shortTerm - longTerm) >= 0.4;
    const direction =
      Math.abs(c) < 0.2
        ? ""
        : c > 0
          ? "Your two positions tend to win and lose together."
          : "One position's gains tend to cancel the other's losses.";
    bullets.push({
      tone: c >= 0.4 ? "warn" : c <= -0.4 ? "good" : "neutral",
      text: `${p.structure_a_name} vs ${p.structure_b_name}: ${CORRELATION_WINDOWS.map((w) => `${w}d ${fmtQh(at(w))}`).join(" · ")} — ${correlationStrength(c)} at ${window}d.`,
      more: [
        "QuantHub scale, using your actual lots.",
        direction,
        regimeShift
          ? `The ${first}d value (${fmtQh(shortTerm)}) is far from the ${last}d value (${fmtQh(longTerm)}), so the relationship has changed recently. Don't rely on the long-run number alone.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  let verdict: { tone: Tone; label: string } = { tone: "neutral", label: "Not enough data" };
  if (net !== undefined && gross > 0 && independent > 0) {
    const r = net / independent;
    let short: string;
    if (r < 0.95) {
      short = "partly hedged";
      verdict = { tone: "good", label: "Diversified" };
    } else if (r <= 1.05) {
      short = "independent bets, not hedged";
      verdict = { tone: "neutral", label: "Independent bets" };
    } else {
      short = "moving the same way day to day";
      verdict = { tone: "bad", label: "Concentrated" };
    }
    bullets.push({
      tone: verdict.tone,
      text: `Together they swing ${fmtMoney(net)}/day vs ${fmtMoney(gross)} added up — ${short}.`,
      more: `Adding each position's daily swing gives ${fmtMoney(gross)}. Completely unrelated positions would swing ${fmtMoney(independent)}. Yours swing ${fmtMoney(net)}, which is ${((1 - net / gross) * 100).toFixed(0)}% less than adding them up. Even unrelated positions read about ${((independent / gross) * 100).toFixed(0)}% on the Same-Direction Risk card; yours reads ${((net / gross) * 100).toFixed(0)}% against its ${(concentrationThreshold * 100).toFixed(0)}% warning line. This check uses day-to-day moves, while the QuantHub-scale correlation compares price levels, so the two can differ.`,
    });
  }

  const symbols = Array.from(new Set(rows.map((r) => r.instrumentSymbol)));
  if (symbols.length === 1 && rows.length > 1) {
    bullets.push({
      tone: "warn",
      text: `All in ${symbols[0]} — one underlying market.`,
      more: "Low correlation here means the curve shapes move independently of each other, not that your risk is spread across different markets.",
    });
  }

  return (
    <>
      <h4>
        Portfolio Read ({window}d) — <span style={{ color: TONE_COLOR[verdict.tone] }}>{verdict.label}</span>
        <InfoTip>
          A short summary of your open book: who carries the risk, how related your structures are, and whether holding them
          together really spreads risk. "Independent bets" is the fair middle: not hedged, not stacked.
        </InfoTip>
      </h4>

      <table className="data-table compact">
        <thead>
          <tr>
            <th>Structure</th>
            <th>Held</th>
            <th>
              Net lots
              <InfoTip>Your current net position in this structure: + is Long, − is Short.</InfoTip>
            </th>
            <th>
              Daily $ swing
              <InfoTip>
                How many dollars this position typically moves in one day at your current lots (standard deviation of its daily
                P&L over the {actualDays}-day window).
              </InfoTip>
            </th>
            <th>
              Share of risk
              <InfoTip align="right">
                This position's daily $ swing as a % of all positions' swings added together. A very high share means the book
                leans on that one structure.
              </InfoTip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className={r.netLots > 0 ? "pnl-pos" : r.netLots < 0 ? "pnl-neg" : "muted"}>
                {r.netLots > 0 ? "Long" : r.netLots < 0 ? "Short" : "Flat"}
              </td>
              <td>{`${r.netLots > 0 ? "+" : ""}${r.netLots.toFixed(2)}`}</td>
              <td>{fmtMoney(r.vol)}</td>
              <td>{(r.share * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul style={{ margin: "10px 0 16px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ fontSize: "0.8rem", lineHeight: 1.5, color: "var(--text)", listStyle: "none", marginLeft: -18 }}>
            <span style={{ color: TONE_COLOR[b.tone], fontWeight: 700, marginRight: 6 }}>●</span>
            {b.text}
            {b.more && <InfoTip>{b.more}</InfoTip>}
          </li>
        ))}
      </ul>
    </>
  );
}
