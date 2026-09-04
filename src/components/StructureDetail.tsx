import { useEffect, useState } from "react";
import type { StructureSnapshot, LegSide } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { RiskEngine } from "../engines/RiskEngine";
import { repository } from "../data";
import { fmtMoney, fmtPrice, pnlClass } from "../utils/format";

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
  const [entryLegId, setEntryLegId] = useState(legs[0]?.leg.id ?? "");
  const [entrySide, setEntrySide] = useState<LegSide>("Long");
  const [entryQty, setEntryQty] = useState(1);
  const [entryPrice, setEntryPrice] = useState(0);
  const [entryRisk, setEntryRisk] = useState<number | "">("");

  const [exitLegId, setExitLegId] = useState(legs[0]?.leg.id ?? "");
  const [exitQty, setExitQty] = useState(1);
  const [exitPrice, setExitPrice] = useState(0);

  const [allocatedRisk, setAllocatedRisk] = useState(0);
  const [structureAudit, setStructureAudit] = useState<Awaited<ReturnType<typeof repository.getAuditEvents>>>([]);

  useEffect(() => {
    RiskEngine.totalAllocatedRisk(structure.id).then(setAllocatedRisk);
    repository.getAuditEvents().then((all) =>
      setStructureAudit(all.filter((a) => a.structure_id === structure.id))
    );
  }, [structure.id, snapshot]);

  const activeLegs = legs.filter((l) => l.leg.is_active);

  async function handleAddEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!entryLegId || entryQty <= 0 || entryPrice <= 0) return;
    await StructureEngine.addEntry({
      structure_id: structure.id,
      structure_leg_id: entryLegId,
      side: entrySide,
      quantity: entryQty,
      price: entryPrice,
      risk_allocated: entryRisk === "" ? undefined : Number(entryRisk),
    });
    setEntryQty(1);
    setEntryPrice(0);
    setEntryRisk("");
    onChanged();
  }

  async function handleExit(type: "PartialExit" | "LegExit" | "FinalExit") {
    if (!exitLegId || exitQty <= 0 || exitPrice <= 0) return;
    await StructureEngine.exitLeg({
      structure_id: structure.id,
      structure_leg_id: exitLegId,
      quantity: exitQty,
      price: exitPrice,
      execution_type: type,
    });
    setExitQty(1);
    setExitPrice(0);
    onChanged();
  }

  return (
    <div className="panel">
      <button className="secondary" onClick={onBack}>
        ← Back to structures
      </button>
      <h2>
        {structure.name} <span className={`badge badge-${structure.status.replace(/\s/g, "").toLowerCase()}`}>{structure.status}</span>
      </h2>

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Realized P&L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_realized_pnl)}`}>{fmtMoney(snapshot.total_realized_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unrealized P&L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_unrealized_pnl)}`}>{fmtMoney(snapshot.total_unrealized_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total P&L</div>
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
            <th>Contract</th>
            <th>Ratio</th>
            <th>Net Qty</th>
            <th>Avg Price</th>
            <th>Current Price</th>
            <th>Unrealized</th>
            <th>Realized</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.leg.id}>
              <td>{l.contract.month_label}</td>
              <td>{l.leg.ratio}</td>
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

      <div className="two-col">
        <div>
          <h3>Add Entry</h3>
          <form onSubmit={handleAddEntry} className="form">
            <div className="form-row">
              <label>Leg</label>
              <select value={entryLegId} onChange={(e) => setEntryLegId(e.target.value)}>
                {legs.map((l) => (
                  <option key={l.leg.id} value={l.leg.id}>
                    {l.contract.month_label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Side</label>
              <select value={entrySide} onChange={(e) => setEntrySide(e.target.value as LegSide)}>
                <option value="Long">Long</option>
                <option value="Short">Short</option>
              </select>
            </div>
            <div className="form-row">
              <label>Quantity (lots)</label>
              <input type="number" value={entryQty} onChange={(e) => setEntryQty(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>Price</label>
              <input type="number" step="0.01" value={entryPrice} onChange={(e) => setEntryPrice(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>Risk Allocated ($, optional)</label>
              <input
                type="number"
                value={entryRisk}
                onChange={(e) => setEntryRisk(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </div>
            <button type="submit">Add Entry</button>
          </form>
        </div>

        <div>
          <h3>Exit</h3>
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <div className="form-row">
              <label>Leg</label>
              <select value={exitLegId} onChange={(e) => setExitLegId(e.target.value)}>
                {activeLegs.map((l) => (
                  <option key={l.leg.id} value={l.leg.id}>
                    {l.contract.month_label} (net {l.position.net_quantity})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Quantity (lots)</label>
              <input type="number" value={exitQty} onChange={(e) => setExitQty(Number(e.target.value))} />
            </div>
            <div className="form-row">
              <label>Exit Price</label>
              <input type="number" step="0.01" value={exitPrice} onChange={(e) => setExitPrice(Number(e.target.value))} />
            </div>
            <div className="button-row">
              <button type="button" onClick={() => handleExit("PartialExit")}>
                Partial Exit
              </button>
              <button type="button" onClick={() => handleExit("LegExit")}>
                Full Leg Exit
              </button>
            </div>
          </form>
        </div>
      </div>

      <h3>Structure Audit Trail</h3>
      <ul className="audit-list">
        {structureAudit.map((a) => (
          <li key={a.id}>
            <span className="audit-time">{new Date(a.timestamp).toLocaleString()}</span>
            <span className="audit-type">{a.event_type}</span>
            <span>{a.description}</span>
          </li>
        ))}
        {structureAudit.length === 0 && <li className="muted">No events yet.</li>}
      </ul>
    </div>
  );
}
