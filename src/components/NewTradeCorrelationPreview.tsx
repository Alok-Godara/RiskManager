import { useState } from "react";
import type { Contract, CorrelationWindow, Instrument, StructureSnapshot, StructureTemplate, UUID } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { useNewTradeCorrelation } from "../hooks/useNewTradeCorrelation";

const VERDICT_CLASS: Record<string, string> = {
  Diversifying: "pnl-pos",
  Concentrating: "pnl-neg",
  Neutral: "",
  "Insufficient data": "muted",
};

/**
 * "Before taking a new position, understand how it interacts with the
 * existing portfolio" — shown live in NewStructureForm once a candidate's
 * outright exposure (`candidateWeights`) is resolvable, against every
 * currently open structure. Renders nothing if there's no candidate yet or
 * no existing book to compare against.
 */
export function NewTradeCorrelationPreview({
  candidateWeights,
  snapshots,
  contracts,
  templates,
  instruments,
}: {
  candidateWeights: { contract_id: UUID; ratio: number }[];
  snapshots: StructureSnapshot[];
  contracts: Contract[];
  templates: StructureTemplate[];
  instruments: Instrument[];
}) {
  const [window, setWindow] = useState<CorrelationWindow>(15);
  const { loading, error, analysesByWindow, thresholds } = useNewTradeCorrelation(candidateWeights, snapshots, contracts, templates, instruments);

  const hasOpenBook = snapshots.some((s) => s.structure.status !== "Fully Closed");
  if (candidateWeights.length === 0 || !hasOpenBook) return null;

  const analysis = analysesByWindow?.[window];

  return (
    <div className="form-row">
      <div className="panel-header" style={{ marginBottom: 8 }}>
        <label style={{ margin: 0 }}>Portfolio Impact</label>
        <div className="segmented">
          {CORRELATION_WINDOWS.map((w) => (
            <button key={w} type="button" className={window === w ? "active" : ""} onClick={() => setWindow(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}
      {loading && !analysis && <p className="helper-text">Comparing against your open structures…</p>}

      {analysis && (
        <>
          <p className="helper-text">
            Risk-weighted correlation vs. your open book at {window}d:{" "}
            <span className={VERDICT_CLASS[analysis.verdict]}>
              {analysis.portfolioCorrelation !== undefined ? analysis.portfolioCorrelation.toFixed(2) : "—"}
            </span>{" "}
            — <strong className={VERDICT_CLASS[analysis.verdict]}>{analysis.verdict}</strong>
          </p>

          {analysis.warnings.map((w, i) => (
            <p key={i} className="helper-text" style={{ color: "var(--amber)" }}>
              ⚠ {w}
            </p>
          ))}

          <table className="data-table compact">
            <thead>
              <tr>
                <th>Existing Structure</th>
                <th>Correlation ({window}d)</th>
              </tr>
            </thead>
            <tbody>
              {analysis.perStructure.map((p) => (
                <tr key={p.structure_id}>
                  <td>{p.structure_name}</td>
                  <td className={p.correlation !== undefined && Math.abs(p.correlation) >= thresholds.correlation ? (p.correlation > 0 ? "pnl-neg" : "pnl-pos") : ""}>
                    {p.correlation !== undefined ? p.correlation.toFixed(2) : "—"}
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
