import { useState } from "react";
import { v4 as uuid } from "uuid";
import type { StructureTemplate, StructureTemplateLeg } from "../../types/domain";
import { repository } from "../../data";
import { Modal } from "../Modal";
import { logAudit } from "../../utils/auditLog";
import { templateRatioString } from "../../utils/templateExpansion";

function blankLegs(): StructureTemplateLeg[] {
  return [{ label: "Month 1", ratio: 1, month_offset: 0 }];
}

export function StructureTemplateSettings({
  templates,
  onChanged,
}: {
  templates: StructureTemplate[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<StructureTemplate | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [legs, setLegs] = useState<StructureTemplateLeg[]>(blankLegs());
  const [saving, setSaving] = useState(false);

  function openAdd() {
    setName("");
    setCode("");
    setIsActive(true);
    setLegs(blankLegs());
    setShowAdd(true);
  }

  function openEdit(t: StructureTemplate) {
    setEditing(t);
    setName(t.name);
    setCode(t.code ?? "");
    setIsActive(t.is_active);
    setLegs(t.legs.map((l) => ({ ...l })));
  }

  function closeModals() {
    setShowAdd(false);
    setEditing(null);
  }

  function updateLeg(idx: number, patch: Partial<StructureTemplateLeg>) {
    setLegs((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLegRow() {
    setLegs((prev) => [...prev, { label: `Month ${prev.length + 1}`, ratio: 1, month_offset: prev.length }]);
  }
  function removeLegRow(idx: number) {
    setLegs((prev) => prev.filter((_, i) => i !== idx));
  }

  async function toggleActive(t: StructureTemplate) {
    const updated: StructureTemplate = { ...t, is_active: !t.is_active };
    await repository.upsertStructureTemplate(updated);
    await logAudit({
      event_type: "StructureTemplateUpdated",
      description: `${t.name} marked ${updated.is_active ? "active" : "inactive"}`,
    });
    onChanged();
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name || legs.length === 0 || legs.some((l) => !l.label)) return;
    setSaving(true);
    try {
      if (editing) {
        const updated: StructureTemplate = { ...editing, name, code: code || undefined, is_active: isActive, legs };
        await repository.upsertStructureTemplate(updated);
        await logAudit({ event_type: "StructureTemplateUpdated", description: `Template "${name}" updated` });
      } else {
        const created: StructureTemplate = {
          id: uuid(),
          name,
          code: code || undefined,
          is_active: isActive,
          legs,
          created_at: new Date().toISOString(),
        };
        await repository.upsertStructureTemplate(created);
        await logAudit({ event_type: "StructureTemplateCreated", description: `Template "${name}" created (${templateRatioString(created)})` });
      }
      closeModals();
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: StructureTemplate) {
    await repository.deleteStructureTemplate(t.id);
    await logAudit({ event_type: "StructureTemplateDeleted", description: `Template "${t.name}" deleted` });
    onChanged();
  }

  const legEditor = (
    <>
      <h4>Legs (fixed outright ratio pattern)</h4>
      {legs.map((leg, idx) => (
        <div className="leg-row" key={idx}>
          <input
            value={leg.label}
            onChange={(e) => updateLeg(idx, { label: e.target.value })}
            placeholder="Label, e.g. Month 1"
          />
          <input
            type="number"
            value={leg.ratio}
            onChange={(e) => updateLeg(idx, { ratio: Number(e.target.value) })}
            title="Signed ratio: +1 = long 1 unit, -2 = short 2 units"
            style={{ width: 65 }}
          />
          <input
            type="number"
            value={leg.month_offset}
            onChange={(e) => updateLeg(idx, { month_offset: Number(e.target.value) })}
            title="Months forward from the structure's anchor contract"
            style={{ width: 65 }}
          />
          {legs.length > 1 && (
            <button type="button" onClick={() => removeLegRow(idx)}>
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="leg-row" style={{ marginTop: -4, marginBottom: 10 }}>
        <span className="helper-text" style={{ minWidth: 0 }}>label</span>
        <span className="helper-text" style={{ width: 65 }}>ratio</span>
        <span className="helper-text" style={{ width: 65 }}>+months</span>
      </div>
      <button type="button" className="secondary" onClick={addLegRow}>
        + Add Leg
      </button>
      <p className="helper-text">
        This is the fixed, fully-expanded outright pattern for the shape — e.g. Fly is +1/-2/+1 at offsets 0/1/2,
        Double Fly is +1/-3/+3/-1 at offsets 0/1/2/3. How it's actually constructed and traded (as outrights,
        spreads, or flies) is chosen separately each time you create a structure.
      </p>
    </>
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Structure Templates</h2>
        <button onClick={openAdd}>+ New Template</button>
      </div>
      <p className="helper-text">
        Define the fixed outright ratio pattern for each structure shape you trade. Structure Type is never
        hard-coded.
      </p>

      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Code</th>
            <th>Legs</th>
            <th>Ratio</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.code ?? "—"}</td>
              <td>{t.legs.length}</td>
              <td className="template-ratio-string">{templateRatioString(t)}</td>
              <td>
                <button
                  type="button"
                  className={`toggle-switch ${t.is_active ? "on" : ""}`}
                  onClick={() => toggleActive(t)}
                  aria-label="Toggle active"
                />
              </td>
              <td>
                <div className="inline-actions">
                  <button type="button" onClick={() => openEdit(t)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => handleDelete(t)}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {templates.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No templates yet — create one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {showAdd && (
        <Modal title="New Structure Template" onClose={closeModals} wide>
          <form className="form" onSubmit={handleSave}>
            <div className="form-row">
              <label>Template Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fly" />
            </div>
            <div className="form-row">
              <label>Code (optional)</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. FLY" />
            </div>
            {legEditor}
            <div className="form-row">
              <label>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} style={{ marginRight: 6 }} />
                Active (shown in Create Structure)
              </label>
            </div>
            <button type="submit" disabled={saving}>
              {saving ? "Creating…" : "Create Template"}
            </button>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={closeModals} wide>
          <form className="form" onSubmit={handleSave}>
            <div className="form-row">
              <label>Template Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-row">
              <label>Code (optional)</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            {legEditor}
            <div className="form-row">
              <label>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} style={{ marginRight: 6 }} />
                Active (shown in Create Structure)
              </label>
            </div>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
