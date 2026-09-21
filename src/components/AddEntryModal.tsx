import { useEffect, useMemo, useState } from "react";
import { v4 as uuid } from "uuid";
import type { Contract, Instrument, StructureSnapshot, StructureTemplate } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { CorrelationEngine } from "../engines/CorrelationEngine";
import { repository } from "../data";
import { Modal } from "./Modal";
import { fmtPrice } from "../utils/format";
import { NewTradeCorrelationPreview } from "./NewTradeCorrelationPreview";

export function AddEntryModal({
  snapshot,
  snapshots,
  contracts,
  templates,
  instruments,
  onClose,
  onSaved,
}: {
  snapshot: StructureSnapshot;
  snapshots: StructureSnapshot[];
  contracts: Contract[];
  templates: StructureTemplate[];
  instruments: Instrument[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const legs = snapshot.legs;
  const [structureLots, setStructureLots] = useState<number>(1);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [legPrices, setLegPrices] = useState<Record<string, number>>(
    Object.fromEntries(legs.map((l) => [l.leg.id, l.current_price ?? 0]))
  );
  const [riskAllocated, setRiskAllocated] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Sizes the price fields' scroll/spinner step to the instrument's real
  // tick size, so incrementing there always lands on a tradeable price.
  const [tickSize, setTickSize] = useState(0.01);

  useEffect(() => {
    repository.getInstrument(snapshot.structure.instrument_id).then((inst) => {
      if (inst) setTickSize(inst.tick_size);
    });
  }, [snapshot.structure.instrument_id]);

  // ONLY this new entry's outright exposure (its direction and lots, legs
  // decomposed to outright months) — compared against the whole existing
  // portfolio, including this structure's own current position, in
  // NewTradeCorrelationPreview.
  const candidateWeights = useMemo(() => {
    const contractsById = new Map(contracts.map((c) => [c.id, c]));
    const templatesById = new Map(templates.map((t) => [t.id, t]));
    const instrumentContractsByInstrument = new Map<string, Contract[]>();
    for (const c of contracts) {
      const list = instrumentContractsByInstrument.get(c.instrument_id) ?? [];
      list.push(c);
      instrumentContractsByInstrument.set(c.instrument_id, list);
    }
    const legInputs = legs.map((l) => ({ contract_id: l.leg.contract_id, ratio: l.leg.ratio }));
    const base = CorrelationEngine.legsToOutrightWeights(legInputs, contractsById, templatesById, instrumentContractsByInstrument);
    return base.map((w) => ({ contract_id: w.contract_id, ratio: w.ratio * direction * structureLots }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, contracts, templates, direction, structureLots]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (structureLots <= 0) {
      setError("Structure lots must be greater than 0.");
      return;
    }
    setSaving(true);
    try {
      const entryGroupId = uuid();
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
          direction,
          risk_allocated: first && riskAllocated !== "" ? Number(riskAllocated) : undefined,
          entry_group_id: entryGroupId,
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
          <label>Direction</label>
          <div className="segmented">
            <button type="button" className={direction === 1 ? "active" : ""} onClick={() => setDirection(1)}>
              Long
            </button>
            <button type="button" className={direction === -1 ? "active" : ""} onClick={() => setDirection(-1)}>
              Short
            </button>
          </div>
          <p className="helper-text">This entry's own direction — other entries on this structure can differ.</p>
        </div>

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
                    step={tickSize}
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

        <NewTradeCorrelationPreview
          candidateWeights={candidateWeights}
          snapshots={snapshots}
          contracts={contracts}
          templates={templates}
          instruments={instruments}
          instrumentId={snapshot.structure.instrument_id}
        />

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save Entry"}
        </button>
      </form>
    </Modal>
  );
}
