import { useEffect, useState } from "react";
import type { StructureSnapshot, Execution, EntrySnapshot } from "../types/domain";
import { RiskEngine } from "../engines/RiskEngine";
import { EntryEngine } from "../engines/EntryEngine";
import { repository } from "../data";
import { fmtMoney, fmtPrice, pnlClass } from "../utils/format";
import { IconChevronLeft } from "./icons";
import { AddEntryModal } from "./AddEntryModal";
import { ExitModal } from "./ExitModal";
import { EditEntryModal } from "./EditEntryModal";
import { EditExecutionModal } from "./EditExecutionModal";

export function StructureDetail({
  snapshot,
  onBack,
  onChanged,
}: {
  snapshot: StructureSnapshot;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { structure, legs } = snapshot;

  const [allocatedRisk, setAllocatedRisk] = useState(0);
  const [entries, setEntries] = useState<EntrySnapshot[]>([]);
  const [otherExecutions, setOtherExecutions] = useState<Execution[]>([]);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [showExit, setShowExit] = useState(false);
  const [editingEntry, setEditingEntry] = useState<EntrySnapshot | null>(null);
  const [editingExecution, setEditingExecution] = useState<Execution | null>(null);

  useEffect(() => {
    RiskEngine.totalAllocatedRisk(structure.id).then(setAllocatedRisk);
    EntryEngine.buildEntrySnapshots(snapshot).then(setEntries);
    Promise.all(legs.map((l) => repository.getExecutionsByLeg(l.leg.id))).then((lists) => {
      // Entry-type executions get their own aggregated "Entries" table above
      // (see EntryEngine) — this table is exits + any non-Active history.
      const merged = lists
        .flat()
        .filter((e) => e.execution_type !== "Entry")
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setOtherExecutions(merged);
    });
  }, [structure.id, snapshot, legs]);

  const contractLabelByLeg = Object.fromEntries(legs.map((l) => [l.leg.id, l.contract.month_label]));
  const hasOpenLegs = legs.some((l) => l.leg.is_active && l.position.net_quantity !== 0);

  function handleChanged() {
    onChanged();
  }

  return (
    <div className="panel">
      <button className="secondary back-button" onClick={onBack}>
        <IconChevronLeft size={14} /> Back to structures
      </button>
      <div className="panel-header">
        <h2>
          {structure.name}{" "}
          <span className={`badge badge-${structure.status.replace(/\s/g, "").toLowerCase()}`}>{structure.status}</span>
        </h2>
        <div className="button-row">
          <button onClick={() => setShowAddEntry(true)}>+ Add Entry</button>
          <button className="secondary" style={{ marginBottom: 0 }} onClick={() => setShowExit(true)} disabled={!hasOpenLegs}>
            Exit / Reduce
          </button>
        </div>
      </div>

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Realized P&amp;L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_realized_pnl)}`}>{fmtMoney(snapshot.total_realized_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unrealized P&amp;L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_unrealized_pnl)}`}>{fmtMoney(snapshot.total_unrealized_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total P&amp;L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_pnl)}`}>{fmtMoney(snapshot.total_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Initial Risk / SL</div>
          <div className="stat-value">{fmtMoney(structure.initial_dollar_risk)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Adjusted Current Risk / SL</div>
          <div className="stat-value">{fmtMoney(structure.current_dollar_risk)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Entry-Level Risk Allocated</div>
          <div className="stat-value">{fmtMoney(allocatedRisk)}</div>
        </div>
      </div>

      <h3>Legs</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Leg (traded product)</th>
            <th>Ratio</th>
            <th>Net Qty</th>
            <th>Avg Price</th>
            <th>Live Price</th>
            <th>Unrealized</th>
            <th>Realized</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.leg.id}>
              <td>{l.contract.month_label}</td>
              <td className={l.leg.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>{l.leg.ratio >= 0 ? `+${l.leg.ratio}` : l.leg.ratio}</td>
              <td>{l.position.net_quantity}</td>
              <td>{fmtPrice(l.position.average_price)}</td>
              <td>{fmtPrice(l.current_price)}</td>
              <td className={pnlClass(l.unrealized_pnl)}>{fmtMoney(l.unrealized_pnl)}</td>
              <td className={pnlClass(l.position.realized_pnl)}>{fmtMoney(l.position.realized_pnl)}</td>
              <td>{l.leg.is_active ? "Active" : "Closed"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Entries</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Avg Entry Price</th>
            <th>Risk Allocated</th>
            <th>Stop Loss (Price)</th>
            <th>Unrealized P&amp;L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((en) => (
            <tr key={en.entry_group_id}>
              <td>{new Date(en.timestamp).toLocaleString()}</td>
              <td>{fmtPrice(en.avg_price)}</td>
              <td>{en.risk_allocated ? fmtMoney(en.risk_allocated) : "—"}</td>
              <td>{en.stop_loss_price !== undefined ? fmtPrice(en.stop_loss_price) : "—"}</td>
              <td className={pnlClass(en.unrealized_pnl)}>{fmtMoney(en.unrealized_pnl)}</td>
              <td>
                <div className="inline-actions">
                  <button type="button" onClick={() => setEditingEntry(en)}>
                    Edit
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No entries yet — click Add Entry above.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {otherExecutions.length > 0 && (
        <>
          <h3>Exits &amp; Corrections</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Contract</th>
                <th>Type</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {otherExecutions.map((ex) => (
                <tr key={ex.id} className={ex.status === "Edited" ? "execution-edited" : ex.status === "Deleted" ? "execution-deleted" : ""}>
                  <td>{new Date(ex.timestamp).toLocaleString()}</td>
                  <td>{contractLabelByLeg[ex.structure_leg_id] ?? "—"}</td>
                  <td>{ex.execution_type}</td>
                  <td className={ex.side === "Long" ? "pnl-pos" : "pnl-neg"}>{ex.side}</td>
                  <td>{ex.quantity}</td>
                  <td>{fmtPrice(ex.price)}</td>
                  <td>{ex.status}</td>
                  <td>
                    {ex.status === "Active" && (
                      <div className="inline-actions">
                        <button type="button" onClick={() => setEditingExecution(ex)}>
                          Edit
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {showAddEntry && (
        <AddEntryModal snapshot={snapshot} onClose={() => setShowAddEntry(false)} onSaved={handleChanged} />
      )}
      {showExit && <ExitModal snapshot={snapshot} onClose={() => setShowExit(false)} onSaved={handleChanged} />}
      {editingEntry && (
        <EditEntryModal
          entry={editingEntry}
          structureId={structure.id}
          onClose={() => setEditingEntry(null)}
          onSaved={handleChanged}
        />
      )}
      {editingExecution && (
        <EditExecutionModal
          execution={editingExecution}
          structureId={structure.id}
          legs={legs}
          onClose={() => setEditingExecution(null)}
          onSaved={handleChanged}
        />
      )}
    </div>
  );
}
