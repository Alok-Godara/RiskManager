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

  useEffect(() => {
    if (!selectedId && instruments.length > 0) setSelectedId(instruments[0].id);
  }, [instruments, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    InstrumentEngine.netPositionByInstrument(selectedId).then(setRows);
  }, [selectedId, snapshots]);

  const relevantSnapshots = snapshots.filter(
    (s) => s.structure.instrument_id === selectedId && s.structure.status !== "Fully Closed"
  );

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
          {rows.map((r) => (
            <tr key={r.contract_id}>
              <td>{r.contract_label}</td>
              <td>{r.long_lots || "—"}</td>
              <td>{r.short_lots || "—"}</td>
              <td className={r.net_lots > 0 ? "pnl-pos" : r.net_lots < 0 ? "pnl-neg" : "pnl-flat"}>
                {r.net_lots > 0 ? `+${r.net_lots}` : r.net_lots}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No contracts / no open exposure for this instrument.
              </td>
            </tr>
          )}
        </tbody>
      </table>

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
