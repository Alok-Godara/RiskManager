import { useState } from "react";
import type { EntrySnapshot } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { Modal } from "./Modal";

export function EditEntryModal({
  entry,
  structureId,
  onClose,
  onSaved,
}: {
  entry: EntrySnapshot;
  structureId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [structureLots, setStructureLots] = useState<number>(entry.structure_lots);
  const [legPrices, setLegPrices] = useState<Record<string, number>>(
    Object.fromEntries(entry.legs.map((l) => [l.leg.id, l.execution.price]))
  );
  const [riskAllocated, setRiskAllocated] = useState<number | "">(entry.risk_allocated || "");
  const [reason, setReason] = useState("");
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
      for (const l of entry.legs) {
        await StructureEngine.editExecution({
          execution_id: l.execution.id,
          structure_id: structureId,
          quantity: Math.abs(l.leg.ratio) * structureLots,
          price: legPrices[l.leg.id] ?? l.execution.price,
          risk_allocated: first ? (riskAllocated === "" ? undefined : Number(riskAllocated)) : undefined,
          reason: reason || undefined,
        });
        first = false;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save entry");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setError("");
    try {
      for (const l of entry.legs) {
        await StructureEngine.deleteExecution({
          execution_id: l.execution.id,
          structure_id: structureId,
          reason: reason || "Entire entry deleted",
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete entry");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit Entry" onClose={onClose} wide>
      <form className="form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>Structure Lots</label>
          <input
            type="number"
            min={0}
            step="1"
            value={structureLots}
            onChange={(e) => setStructureLots(Number(e.target.value))}
          />
        </div>

        <table className="data-table compact">
          <thead>
            <tr>
              <th>Leg</th>
              <th>Ratio</th>
              <th>Qty (lots)</th>
              <th>Execution Price</th>
            </tr>
          </thead>
          <tbody>
            {entry.legs.map((l) => (
              <tr key={l.leg.id}>
                <td>{l.contract.month_label}</td>
                <td className={l.leg.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>
                  {l.leg.ratio >= 0 ? `+${l.leg.ratio}` : l.leg.ratio}
                </td>
                <td>{Math.abs(l.leg.ratio) * structureLots}</td>
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
          Changing Structure Lots recomputes every leg's quantity. Each leg's price stays individually editable.
        </p>

        <div className="form-row">
          <label>Risk Allocated for this entry ($, optional)</label>
          <input
            type="number"
            value={riskAllocated}
            onChange={(e) => setRiskAllocated(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>
        <div className="form-row">
          <label>Reason for correction (optional, kept in audit trail)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. fat-fingered price" />
        </div>

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <div className="button-row">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
          <button type="button" className="secondary" onClick={handleDelete} disabled={saving} style={{ marginBottom: 0 }}>
            Delete Entire Entry
          </button>
        </div>
      </form>
    </Modal>
  );
}
