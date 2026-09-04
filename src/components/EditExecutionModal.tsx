import { useState } from "react";
import type { Execution, LegSnapshot } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { Modal } from "./Modal";

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EditExecutionModal({
  execution,
  structureId,
  legs,
  onClose,
  onSaved,
}: {
  execution: Execution;
  structureId: string;
  legs: LegSnapshot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [legId, setLegId] = useState(execution.structure_leg_id);
  const [quantity, setQuantity] = useState(execution.quantity);
  const [price, setPrice] = useState(execution.price);
  const [timestamp, setTimestamp] = useState(toLocalInputValue(execution.timestamp));
  const [notes, setNotes] = useState(execution.notes ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (quantity <= 0 || price <= 0) {
      setError("Quantity and price must be greater than 0.");
      return;
    }
    setSaving(true);
    try {
      await StructureEngine.editExecution({
        execution_id: execution.id,
        structure_id: structureId,
        structure_leg_id: legId !== execution.structure_leg_id ? legId : undefined,
        quantity,
        price,
        timestamp: new Date(timestamp).toISOString(),
        notes: notes || undefined,
        reason: reason || undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save correction");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setError("");
    try {
      await StructureEngine.deleteExecution({
        execution_id: execution.id,
        structure_id: structureId,
        reason: reason || "Deleted via edit dialog",
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete entry");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Correct Entry — ${execution.execution_type}`} onClose={onClose}>
      <form className="form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>Contract</label>
          <select value={legId} onChange={(e) => setLegId(e.target.value)}>
            {legs.map((l) => (
              <option key={l.leg.id} value={l.leg.id}>
                {l.contract.month_label}
              </option>
            ))}
          </select>
          <p className="helper-text">Direction is fixed by the leg's ratio — change contract here to fix a wrong-contract entry.</p>
        </div>
        <div className="leg-row">
          <div className="form-row">
            <label>Quantity (lots)</label>
            <input type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
          </div>
          <div className="form-row">
            <label>Price</label>
            <input type="number" step="0.001" value={price} onChange={(e) => setPrice(Number(e.target.value))} />
          </div>
        </div>
        <div className="form-row">
          <label>Execution Time</label>
          <input type="datetime-local" value={timestamp} onChange={(e) => setTimestamp(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Notes (optional)</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="form-row">
          <label>Reason for correction (optional, kept in audit trail)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. fat-fingered price" />
        </div>

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <div className="button-row">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save Correction"}
          </button>
          <button type="button" className="secondary" onClick={handleDelete} disabled={saving} style={{ marginBottom: 0 }}>
            Delete Entry
          </button>
        </div>
      </form>
    </Modal>
  );
}
