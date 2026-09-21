import { useState } from "react";
import type { Contract, CorrelationWindow, Instrument, StructureSnapshot, StructureTemplate, UUID } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { useNewTradeCorrelation } from "../hooks/useNewTradeCorrelation";
import { fmtMoney } from "../utils/format";
import { fmtQh } from "../utils/correlationFormat";
import { InfoTip } from "./InfoTip";

const VERDICT_CLASS: Record<string, string> = {
  Diversifying: "pnl-pos",
  Concentrating: "pnl-neg",
  Neutral: "",
  "Insufficient data": "muted",
};

/**
 * "Before taking this entry, how does it interact with what I already hold?"
 * Shown live in AddEntryModal. `candidateWeights` is ONLY the new entry
 * (its direction and lots); it is compared with the whole existing
 * portfolio — every open structure, including the one being added to.
 * Renders nothing until there's an entry to evaluate and at least one open
 * structure.
 */
export function NewTradeCorrelationPreview({
  candidateWeights,
  snapshots,
  contracts,
  templates,
  instruments,
  instrumentId,
}: {
  candidateWeights: { contract_id: UUID; ratio: number }[];
  snapshots: StructureSnapshot[];
  contracts: Contract[];
  templates: StructureTemplate[];
  instruments: Instrument[];
  instrumentId: UUID;
}) {
  const [window, setWindow] = useState<CorrelationWindow>(60);
  const { loading, error, analysesByWindow, thresholds } = useNewTradeCorrelation(
    candidateWeights,
    snapshots,
    contracts,
    templates,
    instruments,
    instrumentId
  );

  const hasOpenBook = snapshots.some((s) => s.structure.status !== "Fully Closed");
  if (candidateWeights.length === 0 || !hasOpenBook) return null;

  const analysis = analysesByWindow?.[window];
  // Most-correlated structures first — |correlation| descending, undefined last.
  const sortedPerStructure = analysis
    ? [...analysis.perStructure].sort((a, b) => {
        if (a.correlation === undefined && b.correlation === undefined) return 0;
        if (a.correlation === undefined) return 1;
        if (b.correlation === undefined) return -1;
        return Math.abs(b.correlation) - Math.abs(a.correlation);
      })
    : [];

  return (
    <div className="form-row">
      <div className="panel-header" style={{ marginBottom: 8 }}>
        <label style={{ margin: 0 }}>
          This New Entry vs. Your Portfolio
          <InfoTip>
            Only the entry you are typing (its direction and lots) is compared with your existing portfolio, meaning every open
            structure's current position added up, including this structure's own position. Correlation is on QuantHub's −100 to
            100 scale, using price levels over the last {window} trading days.
          </InfoTip>
        </label>
        <div className="segmented">
          {CORRELATION_WINDOWS.map((w) => (
            <button key={w} type="button" className={window === w ? "active" : ""} onClick={() => setWindow(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}
      {loading && !analysis && <p className="helper-text">Comparing with your portfolio…</p>}

      {analysis && (
        <>
          <p className="helper-text">
            Correlation with your portfolio ({window}d):{" "}
            <span className={VERDICT_CLASS[analysis.verdict]}>{fmtQh(analysis.portfolioCorrelation)}</span> —{" "}
            <strong className={VERDICT_CLASS[analysis.verdict]}>{analysis.verdict}</strong>
            <InfoTip>
              +100 = this entry would win and lose exactly when your portfolio does; −100 = it would gain when the portfolio
              loses; near 0 = unrelated. The verdict looks at the dollars, not just correlation: it compares the book's daily
              swing after adding this entry with what a completely unrelated entry of the same size would give.
            </InfoTip>
          </p>
          <p className="helper-text">
            Book's daily $ swing: {analysis.bookRiskBefore !== undefined ? fmtMoney(analysis.bookRiskBefore) : "—"} →{" "}
            {analysis.bookRiskAfter !== undefined ? fmtMoney(analysis.bookRiskAfter) : "—"}
            <InfoTip>
              How much your whole portfolio typically moves in a day, before and after adding this entry at the size and
              direction typed above.{" "}
              {analysis.entryStandaloneRisk !== undefined
                ? "This entry on its own would swing " + fmtMoney(analysis.entryStandaloneRisk) + " a day. "
                : ""}
              Unlike correlation, this changes when you change the lots.
            </InfoTip>
          </p>

          <table className="data-table compact">
            <thead>
              <tr>
                <th>Open Structure</th>
                <th>
                  Correlation with this entry
                  <InfoTip align="right">
                    The new entry against each open structure on its own ({window}d, QuantHub scale). Highlighted when it is{" "}
                    {Math.round(thresholds.correlation * 100)} or more in size.
                  </InfoTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedPerStructure.map((p) => (
                <tr key={p.structure_id}>
                  <td>{p.structure_name}</td>
                  <td className={p.correlation !== undefined && Math.abs(p.correlation) >= thresholds.correlation ? (p.correlation > 0 ? "pnl-neg" : "pnl-pos") : ""}>
                    {fmtQh(p.correlation)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
