import type { StructureSnapshot } from "../types/domain";
import { fmtMoney, pnlClass } from "../utils/format";

export function StructureList({
  snapshots,
  onSelect,
  onNewStructure,
}: {
  snapshots: StructureSnapshot[];
  onSelect: (id: string) => void;
  onNewStructure: () => void;
}) {
  const sorted = [...snapshots].sort((a, b) => (a.structure.status === "Fully Closed" ? 1 : 0) - (b.structure.status === "Fully Closed" ? 1 : 0));

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Structures</h2>
        <button onClick={onNewStructure}>+ New Structure</button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>Realized</th>
            <th>Unrealized</th>
            <th>Total P&L</th>
            <th>Current Risk</th>
            <th>Risk Headroom</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.structure.id} className="clickable" onClick={() => onSelect(s.structure.id)}>
              <td>{s.structure.name}</td>
              <td>{s.structure.structure_type}</td>
              <td>
                <span className={`badge badge-${s.structure.status.replace(/\s/g, "").toLowerCase()}`}>
                  {s.structure.status}
                </span>
              </td>
              <td className={pnlClass(s.total_realized_pnl)}>{fmtMoney(s.total_realized_pnl)}</td>
              <td className={pnlClass(s.total_unrealized_pnl)}>{fmtMoney(s.total_unrealized_pnl)}</td>
              <td className={pnlClass(s.total_pnl)}>{fmtMoney(s.total_pnl)}</td>
              <td>{fmtMoney(s.structure.current_dollar_risk)}</td>
              <td className={pnlClass(s.remaining_risk_capacity)}>{fmtMoney(s.remaining_risk_capacity)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No structures yet — click + New Structure above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
