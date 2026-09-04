import { useEffect, useState } from "react";
import type { Instrument, InstrumentNetPositionRow, StructureSnapshot } from "../types/domain";
import { InstrumentEngine } from "../engines/InstrumentEngine";
import { fmtMoney } from "../utils/format";

export function InstrumentDashboard({
  instruments,
  snapshots,
}: {
  instruments: Instrument[];
  snapshots: StructureSnapshot[];
}) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [rows, setRows] = useState<InstrumentNetPositionRow[]>([]);
  const [showAllMonths, setShowAllMonths] = useState(false);

  useEffect(() => {
    if (!selectedId && instruments.length > 0) setSelectedId(instruments[0].id);
  }, [instruments, selectedId]);

  // Collapse the full month list only when the user actually switches
  // instrument — NOT on `snapshots`, which gets a new reference on every
  // background reload (e.g. the 4s market-data poll) and would otherwise
  // silently collapse an expanded panel out from under the user.
  useEffect(() => {
    setShowAllMonths(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    InstrumentEngine.netPositionByInstrument(selectedId).then(setRows);
  }, [selectedId, snapshots]);

  const relevantSnapshots = snapshots.filter(
    (s) => s.structure.instrument_id === selectedId && s.structure.status !== "Fully Closed"
  );

  const exposedRows = rows.filter((r) => r.long_lots !== 0 || r.short_lots !== 0);

  function row(r: InstrumentNetPositionRow) {
    return (
      <tr key={r.contract_id}>
        <td>{r.contract_label}</td>
        <td>{r.long_lots || "—"}</td>
        <td>{r.short_lots || "—"}</td>
        <td className={r.net_lots > 0 ? "pnl-pos" : r.net_lots < 0 ? "pnl-neg" : "pnl-flat"}>
          {r.net_lots > 0 ? `+${r.net_lots}` : r.net_lots}
        </td>
      </tr>
    );
  }

  return (
    <div className="panel">
      <h2>Instrument Net Position</h2>
      <div className="row">
        <label>Instrument:&nbsp;</label>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.symbol})
            </option>
          ))}
        </select>
      </div>

      <h4>Net Exposure</h4>
      <table className="data-table">
        <thead>
          <tr>
            <th>Contract</th>
            <th>Long Lots</th>
            <th>Short Lots</th>
            <th>Net Lots</th>
          </tr>
        </thead>
        <tbody>
          {exposedRows.map(row)}
          {exposedRows.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No open exposure for this instrument.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <button type="button" className="secondary" onClick={() => setShowAllMonths((v) => !v)}>
        {showAllMonths ? "Hide all contract months" : `Show all contract months (${rows.length})`}
      </button>

      {showAllMonths && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Contract</th>
              <th>Long Lots</th>
              <th>Short Lots</th>
              <th>Net Lots</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row)}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No contracts for this instrument.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <h3>Structures contributing to this instrument</h3>
      <ul className="structure-list">
        {relevantSnapshots.map((s) => (
          <li key={s.structure.id}>
            <strong>{s.structure.name}</strong> — {s.structure.status} — Total P&L:{" "}
            <span className={s.total_pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{fmtMoney(s.total_pnl)}</span>
          </li>
        ))}
        {relevantSnapshots.length === 0 && <li className="muted">No open structures for this instrument.</li>}
      </ul>
    </div>
  );
}
