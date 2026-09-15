import { useEffect, useState } from "react";
import { v4 as uuid } from "uuid";
import type { EntrySnapshot, LegSnapshot } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { tickSizeForStructure } from "../utils/instrumentLookup";
import { Modal } from "./Modal";
import { fmtPrice } from "../utils/format";

/**
 * Exits some/all of ONE SPECIFIC ENTRY, never any other entry on the same
 * structure — exits are entry-scoped (Execution.closes_entry_group_id, see
 * PositionEngine), not a generic "close whatever's open on this leg."
 */
export function ExitEntryModal({
  entry,
  structureId,
  legSnapshots,
  onClose,
  onSaved,
}: {
  entry: EntrySnapshot;
  structureId: string;
  legSnapshots: LegSnapshot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const rows = entry.legs.map((l) => ({
    ...l,
    currentPrice: legSnapshots.find((s) => s.leg.id === l.leg.id)?.current_price,
    openQty: Math.abs(l.leg.ratio) * entry.open_quantity,
  }));

  const [closeQty, setCloseQty] = useState<Record<string, number>>(
    Object.fromEntries(rows.map((r) => [r.leg.id, r.openQty]))
  );
  const [exitPrices, setExitPrices] = useState<Record<string, number>>(
    Object.fromEntries(rows.map((r) => [r.leg.id, r.currentPrice ?? r.execution.price]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tickSize, setTickSize] = useState(0.01);

  useEffect(() => {
    tickSizeForStructure(structureId).then(setTickSize);
  }, [structureId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const exitGroupId = uuid();
      for (const r of rows) {
        const qty = closeQty[r.leg.id] ?? 0;
        if (qty <= 0) continue;
        const price = exitPrices[r.leg.id] ?? r.currentPrice ?? r.execution.price;
        await StructureEngine.exitLeg({
          structure_id: structureId,
          structure_leg_id: r.leg.id,
          quantity: qty,
          price,
          closes_entry_group_id: entry.entry_group_id,
          entry_group_id: exitGroupId,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to exit entry");
    } finally {
      setSaving(false);
    }
  }

  if (entry.open_quantity <= 0) {
    return (
      <Modal title="Exit Entry" onClose={onClose}>
        <p className="empty-hint">This entry has no open quantity left to exit.</p>
      </Modal>
    );
  }

  return (
    <Modal title={`Exit Entry — ${entry.side} ${entry.structure_lots} lot(s) @ ${fmtPrice(entry.avg_price)}`} onClose={onClose} wide>
      <form className="form" onSubmit={handleSubmit}>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Leg</th>
              <th>Open (this entry)</th>
              <th>Close Qty</th>
              <th>Live Price</th>
              <th>Exit Price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.leg.id}>
                <td>{r.contract.month_label}</td>
                <td className={r.leg.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>{r.openQty}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={r.openQty}
                    value={closeQty[r.leg.id] ?? 0}
                    onChange={(e) => setCloseQty((prev) => ({ ...prev, [r.leg.id]: Number(e.target.value) }))}
                    style={{ width: 80 }}
                  />
                </td>
                <td className="muted">{fmtPrice(r.currentPrice)}</td>
                <td>
                  <input
                    type="number"
                    step={tickSize}
                    value={exitPrices[r.leg.id] ?? 0}
                    onChange={(e) => setExitPrices((prev) => ({ ...prev, [r.leg.id]: Number(e.target.value) }))}
                    style={{ width: 100 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="helper-text">
          Only this entry's own open quantity is affected — other entries on this structure stay untouched. Close
          quantities default to this entry's full open amount; reduce for a partial exit.
        </p>

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Confirm Exit"}
        </button>
      </form>
    </Modal>
  );
}
