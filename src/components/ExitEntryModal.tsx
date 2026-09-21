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
 * `onlyLegId` limits the window to a single leg of that entry (the per-leg
 * Exit button); each leg's lots default to what's still open on it.
 */
export function ExitEntryModal({
  entry,
  structureId,
  legSnapshots,
  onlyLegId,
  onClose,
  onSaved,
}: {
  entry: EntrySnapshot;
  structureId: string;
  legSnapshots: LegSnapshot[];
  onlyLegId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const rows = entry.legs
    .filter((l) => !onlyLegId || l.leg.id === onlyLegId)
    .map((l) => ({
      ...l,
      currentPrice: legSnapshots.find((s) => s.leg.id === l.leg.id)?.current_price,
      openQty: l.open_qty,
    }));
  const totalOpen = rows.reduce((s, r) => s + r.openQty, 0);

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

  if (totalOpen <= 0) {
    return (
      <Modal title="Exit Entry" onClose={onClose}>
        <p className="empty-hint">This entry has no open quantity left to exit.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={
        onlyLegId
          ? `Exit Leg — ${rows[0]?.contract.month_label ?? ""} (${rows[0]?.execution.side ?? ""})`
          : entry.kind === "structure"
            ? `Exit Entry — ${entry.side} ${entry.structure_lots} lot(s) @ ${fmtPrice(entry.avg_price)}`
            : `Exit Entry — custom (${entry.side})`
      }
      onClose={onClose}
      wide
    >
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
                <td className={r.execution.side === "Long" ? "pnl-pos" : "pnl-neg"}>{r.openQty}</td>
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
          Only this entry's own open lots are affected — other entries stay untouched. Lots default to what is still open;
          reduce for a partial exit.
        </p>

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Confirm Exit"}
        </button>
      </form>
    </Modal>
  );
}
