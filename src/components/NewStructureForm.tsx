import { useState } from "react";
import type { Contract, Instrument, StructureType, LegSide } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";

interface LegRow {
  contract_id: string;
  ratio: number;
  side: LegSide;
}

export function NewStructureForm({
  instruments,
  contracts,
  onCreated,
}: {
  instruments: Instrument[];
  contracts: Contract[];
  onCreated: () => void;
}) {
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? "");
  const [name, setName] = useState("");
  const [structureType, setStructureType] = useState<StructureType>("Outright");
  const [initialRisk, setInitialRisk] = useState<number>(500);
  const [legs, setLegs] = useState<LegRow[]>([{ contract_id: "", ratio: 1, side: "Long" }]);
  const [submitting, setSubmitting] = useState(false);

  const instrumentContracts = contracts.filter((c) => c.instrument_id === instrumentId);

  function updateLeg(idx: number, patch: Partial<LegRow>) {
    setLegs((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLegRow() {
    setLegs((prev) => [...prev, { contract_id: "", ratio: 1, side: "Long" }]);
  }

  function removeLegRow(idx: number) {
    setLegs((prev) => prev.filter((_, i) => i !== idx));
  }

  function defaultLegCountFor(type: StructureType) {
    if (type === "Outright") return 1;
    if (type === "Spread") return 2;
    if (type === "Fly") return 3;
    return legs.length;
  }

  function handleTypeChange(type: StructureType) {
    setStructureType(type);
    const count = defaultLegCountFor(type);
    setLegs((prev) => {
      const next = [...prev];
      while (next.length < count) next.push({ contract_id: "", ratio: 1, side: "Long" });
      while (next.length > count) next.pop();
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!instrumentId || !name || legs.some((l) => !l.contract_id)) return;
    setSubmitting(true);
    try {
      await StructureEngine.createStructure({
        instrument_id: instrumentId,
        name,
        structure_type: structureType,
        initial_dollar_risk: initialRisk,
        legs: legs.map((l) => ({ contract_id: l.contract_id, ratio: l.ratio, side: l.side })),
      });
      setName("");
      setLegs([{ contract_id: "", ratio: 1, side: "Long" }]);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <h2>New Structure</h2>
      <form onSubmit={handleSubmit} className="form">
        <div className="form-row">
          <label>Instrument</label>
          <select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.symbol})
              </option>
            ))}
          </select>
        </div>

        <div className="form-row">
          <label>Structure Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jan-Feb-Mar Fly" />
        </div>

        <div className="form-row">
          <label>Structure Type</label>
          <select value={structureType} onChange={(e) => handleTypeChange(e.target.value as StructureType)}>
            <option value="Outright">Outright</option>
            <option value="Spread">Spread</option>
            <option value="Fly">Fly</option>
            <option value="Custom">Custom</option>
          </select>
        </div>

        <div className="form-row">
          <label>Initial Dollar Risk ($)</label>
          <input
            type="number"
            value={initialRisk}
            onChange={(e) => setInitialRisk(Number(e.target.value))}
          />
        </div>

        <h4>Legs</h4>
        {legs.map((leg, idx) => (
          <div className="leg-row" key={idx}>
            <select
              value={leg.contract_id}
              onChange={(e) => updateLeg(idx, { contract_id: e.target.value })}
            >
              <option value="">Select contract…</option>
              {instrumentContracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.month_label}
                </option>
              ))}
            </select>
            <select value={leg.side} onChange={(e) => updateLeg(idx, { side: e.target.value as LegSide })}>
              <option value="Long">Long</option>
              <option value="Short">Short</option>
            </select>
            <input
              type="number"
              value={leg.ratio}
              onChange={(e) => updateLeg(idx, { ratio: Number(e.target.value) })}
              title="Ratio weight (e.g. 2 for the belly of a fly)"
              style={{ width: 60 }}
            />
            {structureType === "Custom" && legs.length > 1 && (
              <button type="button" onClick={() => removeLegRow(idx)}>
                ✕
              </button>
            )}
          </div>
        ))}
        {structureType === "Custom" && (
          <button type="button" onClick={addLegRow} className="secondary">
            + Add Leg
          </button>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create Structure"}
        </button>
      </form>
    </div>
  );
}
