import { useState } from "react";
import { v4 as uuid } from "uuid";
import type { Instrument } from "../../types/domain";
import { repository } from "../../data";
import { Modal } from "../Modal";
import { buildRollingContracts } from "../../utils/contractGen";
import { logAudit } from "../../utils/auditLog";

interface FormState {
  name: string;
  symbol: string;
  exchange_code: string;
  tick_size: number;
  tick_value: number;
  lot_size: number;
  currency: string;
  is_active: boolean;
  notes: string;
}

function blankForm(): FormState {
  return {
    name: "",
    symbol: "",
    exchange_code: "",
    tick_size: 0.01,
    tick_value: 10,
    lot_size: 1000,
    currency: "USD",
    is_active: true,
    notes: "",
  };
}

export function InstrumentSettings({
  instruments,
  onChanged,
}: {
  instruments: Instrument[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<Instrument | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function openAdd() {
    setForm(blankForm());
    setShowAdd(true);
  }

  function openEdit(inst: Instrument) {
    setEditing(inst);
    setForm({
      name: inst.name,
      symbol: inst.symbol,
      exchange_code: inst.exchange_code ?? "",
      tick_size: inst.tick_size,
      tick_value: inst.tick_value,
      lot_size: inst.lot_size,
      currency: inst.currency,
      is_active: inst.is_active,
      notes: inst.notes ?? "",
    });
  }

  function closeModals() {
    setShowAdd(false);
    setEditing(null);
    setError("");
  }

  async function toggleActive(inst: Instrument) {
    const updated: Instrument = { ...inst, is_active: !inst.is_active };
    await repository.upsertInstrument(updated);
    await logAudit({
      event_type: "InstrumentUpdated",
      description: `${inst.name} marked ${updated.is_active ? "active" : "inactive"}`,
    });
    onChanged();
  }

  async function handleDelete(inst: Instrument) {
    setError("");
    if (!window.confirm(`Delete "${inst.name}"? This also removes its contracts. This cannot be undone.`)) return;
    try {
      await repository.deleteInstrument(inst.id);
      await logAudit({ event_type: "InstrumentUpdated", description: `Instrument "${inst.name}" deleted` });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete instrument");
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.symbol) return;
    setSaving(true);
    try {
      const instrument: Instrument = {
        id: uuid(),
        name: form.name,
        symbol: form.symbol.toUpperCase(),
        exchange_code: form.exchange_code || undefined,
        tick_size: form.tick_size,
        tick_value: form.tick_value,
        lot_size: form.lot_size,
        currency: form.currency,
        is_active: form.is_active,
        notes: form.notes || undefined,
        created_at: new Date().toISOString(),
      };
      await repository.upsertInstrument(instrument);
      const contracts = buildRollingContracts(instrument.id, instrument.symbol);
      for (const c of contracts) await repository.upsertContract(c);
      await logAudit({
        event_type: "InstrumentCreated",
        description: `Instrument "${instrument.name}" (${instrument.symbol}) added with ${contracts.length} contract(s)`,
      });
      closeModals();
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      const updated: Instrument = {
        ...editing,
        name: form.name,
        symbol: form.symbol.toUpperCase(),
        exchange_code: form.exchange_code || undefined,
        tick_size: form.tick_size,
        tick_value: form.tick_value,
        lot_size: form.lot_size,
        currency: form.currency,
        is_active: form.is_active,
        notes: form.notes || undefined,
      };
      await repository.upsertInstrument(updated);
      await logAudit({ event_type: "InstrumentUpdated", description: `Instrument "${updated.name}" updated` });
      closeModals();
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const fieldsForm = (
    <>
      <div className="form-row">
        <label>Instrument Name</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Brent Crude" />
      </div>
      <div className="form-row">
        <label>Symbol / Code</label>
        <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="e.g. BZ" />
      </div>
      <div className="form-row">
        <label>Exchange / API Code (optional)</label>
        <input value={form.exchange_code} onChange={(e) => setForm({ ...form, exchange_code: e.target.value })} placeholder="if different from symbol" />
      </div>
      <div className="leg-row">
        <div className="form-row">
          <label>Tick Size</label>
          <input type="number" step="0.0001" value={form.tick_size} onChange={(e) => setForm({ ...form, tick_size: Number(e.target.value) })} />
        </div>
        <div className="form-row">
          <label>Tick Value ($)</label>
          <input type="number" step="0.01" value={form.tick_value} onChange={(e) => setForm({ ...form, tick_value: Number(e.target.value) })} />
        </div>
      </div>
      <div className="leg-row">
        <div className="form-row">
          <label>Lot Size</label>
          <input type="number" value={form.lot_size} onChange={(e) => setForm({ ...form, lot_size: Number(e.target.value) })} />
        </div>
        <div className="form-row">
          <label>Currency</label>
          <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <label>Notes (optional)</label>
        <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <div className="form-row">
        <label>
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            style={{ marginRight: 6 }}
          />
          Active (shown in Create Structure)
        </label>
      </div>
    </>
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Instruments</h2>
        <button onClick={openAdd}>+ Add Instrument</button>
      </div>
      <p className="helper-text">
        Only active instruments appear when creating a new structure. Adding an instrument generates its next 24
        months of contracts automatically, and that window keeps rolling forward on its own.
      </p>
      {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Symbol</th>
            <th>Exchange Code</th>
            <th>Tick Size</th>
            <th>Tick Value</th>
            <th>Lot Size</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {instruments.map((inst) => (
            <tr key={inst.id}>
              <td>{inst.name}</td>
              <td>{inst.symbol}</td>
              <td>{inst.exchange_code ?? "—"}</td>
              <td>{inst.tick_size}</td>
              <td>{inst.tick_value}</td>
              <td>{inst.lot_size}</td>
              <td>
                <button
                  type="button"
                  className={`toggle-switch ${inst.is_active ? "on" : ""}`}
                  onClick={() => toggleActive(inst)}
                  aria-label="Toggle active"
                />
              </td>
              <td>
                <div className="inline-actions">
                  <button type="button" onClick={() => openEdit(inst)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => handleDelete(inst)}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {instruments.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No instruments yet — add one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showAdd && (
        <Modal title="Add Instrument" onClose={closeModals}>
          <form className="form" onSubmit={handleCreate}>
            {fieldsForm}
            <button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Add Instrument"}
            </button>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={closeModals}>
          <form className="form" onSubmit={handleEditSave}>
            {fieldsForm}
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
