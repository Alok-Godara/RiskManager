import { useState } from "react";
import type { StructureSnapshot } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { Modal } from "./Modal";
import { fmtPrice } from "../utils/format";

export function ExitModal({
  snapshot,
  onClose,
  onSaved,
}: {
  snapshot: StructureSnapshot;
  onClose: () => void;
  onSaved: () => void;
}) {
  const legs = snapshot.legs.filter((l) => l.leg.is_active && l.position.net_quantity !== 0);

  const [structureLots, setStructureLots] = useState<number>(1);
  const [useStructureLots, setUseStructureLots] = useState(true);
  const [legCloseQty, setLegCloseQty] = useState<Record<string, number>>(
    Object.fromEntries(legs.map((l) => [l.leg.id, Math.abs(l.position.net_quantity)]))
  );
  const [legExitPrices, setLegExitPrices] = useState<Record<string, number>>(
    Object.fromEntries(legs.map((l) => [l.leg.id, l.current_price ?? 0]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function closeQtyFor(leg: (typeof legs)[number]): number {
    if (useStructureLots) return Math.min(Math.abs(leg.leg.ratio) * structureLots, Math.abs(leg.position.net_quantity));
    return legCloseQty[leg.leg.id] ?? 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      for (const leg of legs) {
        const qty = closeQtyFor(leg);
        if (qty <= 0) continue;
        const price = legExitPrices[leg.leg.id] ?? 0;
        await StructureEngine.exitLeg({
          structure_id: snapshot.structure.id,
          structure_leg_id: leg.leg.id,
          quantity: qty,
          price,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to exit position");
    } finally {
      setSaving(false);
    }
  }

  if (legs.length === 0) {
    return (
      <Modal title={`Exit — ${snapshot.structure.name}`} onClose={onClose}>
        <p className="empty-hint">No open legs to exit.</p>
      </Modal>
    );
  }

  return (
    <Modal title={`Exit / Reduce — ${snapshot.structure.name}`} onClose={onClose} wide>
      <form className="form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>
            <input type="checkbox" checked={useStructureLots} onChange={(e) => setUseStructureLots(e.target.checked)} style={{ marginRight: 6 }} />
            Exit by structure lots (uncheck to set each leg's close quantity individually)
          </label>
        </div>
        {useStructureLots && (
          <div className="form-row">
            <label>Structure Lots to Exit</label>
            <input type="number" min={0} step="1" value={structureLots} onChange={(e) => setStructureLots(Number(e.target.value))} />
          </div>
        )}

        <table className="data-table compact">
          <thead>
            <tr>
              <th>Leg</th>
              <th>Open Exposure</th>
              <th>Close Qty</th>
              <th>Live Price</th>
              <th>Exit Price</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((l) => (
              <tr key={l.leg.id}>
                <td>{l.contract.month_label}</td>
                <td className={l.position.net_quantity >= 0 ? "pnl-pos" : "pnl-neg"}>
                  {l.position.net_quantity >= 0 ? `+${l.position.net_quantity}` : l.position.net_quantity}
                </td>
                <td>
                  {useStructureLots ? (
                    closeQtyFor(l)
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={Math.abs(l.position.net_quantity)}
                      value={legCloseQty[l.leg.id] ?? 0}
                      onChange={(e) => setLegCloseQty((prev) => ({ ...prev, [l.leg.id]: Number(e.target.value) }))}
                      style={{ width: 80 }}
                    />
                  )}
                </td>
                <td className="muted">{fmtPrice(l.current_price)}</td>
                <td>
                  <input
                    type="number"
                    step="0.001"
                    value={legExitPrices[l.leg.id] ?? 0}
                    onChange={(e) => setLegExitPrices((prev) => ({ ...prev, [l.leg.id]: Number(e.target.value) }))}
                    style={{ width: 100 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="helper-text">
          Exit price defaults to the current live quote for each leg — edit if your actual fill differs.
          {!useStructureLots && " Close quantities default to each leg's full open amount — reduce for a partial exit."}
        </p>

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Confirm Exit"}
        </button>
      </form>
    </Modal>
  );
}
