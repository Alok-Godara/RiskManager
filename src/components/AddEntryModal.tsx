import { useState } from "react";
import type { StructureSnapshot } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { Modal } from "./Modal";
import { fmtPrice } from "../utils/format";

export function AddEntryModal({
  snapshot,
  onClose,
  onSaved,
}: {
  snapshot: StructureSnapshot;
  onClose: () => void;
  onSaved: () => void;
}) {
  const legs = snapshot.legs;
  const [structureLots, setStructureLots] = useState<number>(1);
  const [legPrices, setLegPrices] = useState<Record<string, number>>(
    Object.fromEntries(legs.map((l) => [l.leg.id, l.current_price ?? 0]))
  );
  const [riskAllocated, setRiskAllocated] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (structureLots <= 0) {
      setError("Structure lots must be greater than 0.");
      return;
    }
    setSaving(true);
    try {
      let first = true;
      for (const leg of legs) {
        const qty = Math.abs(leg.leg.ratio) * structureLots;
        if (qty === 0) continue;
        const price = legPrices[leg.leg.id] ?? 0;
        await StructureEngine.addEntry({
          structure_id: snapshot.structure.id,
          structure_leg_id: leg.leg.id,
          quantity: qty,
          price,
          risk_allocated: first && riskAllocated !== "" ? Number(riskAllocated) : undefined,
        });
        first = false;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add entry");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Add Entry — ${snapshot.structure.name}`} onClose={onClose} wide>
      <form className="form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>Structure Lots</label>
          <input type="number" min={0} step="1" value={structureLots} onChange={(e) => setStructureLots(Number(e.target.value))} />
        </div>

        <table className="data-table compact">
          <thead>
            <tr>
              <th>Leg</th>
              <th>Ratio</th>
              <th>Qty (lots)</th>
              <th>Live Price</th>
              <th>Execution Price</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((l) => (
              <tr key={l.leg.id}>
                <td>{l.contract.month_label}</td>
                <td className={l.leg.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>{l.leg.ratio >= 0 ? `+${l.leg.ratio}` : l.leg.ratio}</td>
                <td>{Math.abs(l.leg.ratio) * structureLots}</td>
                <td className="muted">{fmtPrice(l.current_price)}</td>
                <td>
                  <input
                    type="number"
                    step="0.001"
                    value={legPrices[l.leg.id] ?? 0}
                    onChange={(e) => setLegPrices((prev) => ({ ...prev, [l.leg.id]: Number(e.target.value) }))}
                    style={{ width: 100 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="helper-text">
          Execution price defaults to the current live quote for each leg — edit any field if your actual fill
          differs.
        </p>

        <div className="form-row">
          <label>Risk Allocated for this entry ($, optional)</label>
          <input
            type="number"
            value={riskAllocated}
            onChange={(e) => setRiskAllocated(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save Entry"}
        </button>
      </form>
    </Modal>
  );
}
