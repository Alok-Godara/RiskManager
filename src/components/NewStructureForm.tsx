import { useEffect, useMemo, useState } from "react";
import type { Contract, Instrument, StructureTemplate } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { StructureQuoteEngine } from "../engines/StructureQuoteEngine";
import { previewLegs, type PreviewLeg } from "../utils/templateExpansion";
import { sortContractsChronologically } from "../utils/contractGen";
import { ContractAutocomplete } from "./ContractAutocomplete";

const CUSTOM_TEMPLATE_ID = "__custom__";

interface CustomLegRow {
  contract_id: string;
  ratio: number;
}

function isTrivialOutright(template: StructureTemplate): boolean {
  return template.legs.length === 1 && template.legs[0].ratio === 1 && template.legs[0].month_offset === 0;
}

export function NewStructureForm({
  instruments,
  contracts,
  templates,
  onCreated,
  onCancel,
}: {
  instruments: Instrument[];
  contracts: Contract[];
  templates: StructureTemplate[];
  onCreated: () => void;
  onCancel?: () => void;
}) {
  const [instrumentId, setInstrumentId] = useState(instruments[0]?.id ?? "");
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? CUSTOM_TEMPLATE_ID);
  const [baseTemplateId, setBaseTemplateId] = useState<string>("");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [initialRisk, setInitialRisk] = useState<number>(500);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Template path: one anchor contract drives every leg via month_offset.
  const [anchorContractId, setAnchorContractId] = useState("");
  // Custom/ad-hoc path: fully manual leg rows.
  const [customLegs, setCustomLegs] = useState<CustomLegRow[]>([{ contract_id: "", ratio: 1 }]);

  // Anchor selection only ever needs outright months — structure-level
  // quote contracts (already-created Fly/Spread products) aren't valid anchors.
  const instrumentContracts = useMemo(
    () => sortContractsChronologically(contracts.filter((c) => c.instrument_id === instrumentId)),
    [contracts, instrumentId]
  );
  const anchorableContracts = useMemo(
    () => instrumentContracts.filter((c) => !c.kind || c.kind === "Outright"),
    [instrumentContracts]
  );

  const selectedTemplate = templates.find((t) => t.id === templateId);
  const isCustom = templateId === CUSTOM_TEMPLATE_ID || !selectedTemplate;
  const selectedBaseTemplate = templates.find((t) => t.id === baseTemplateId);

  useEffect(() => {
    if (!instrumentId && instruments.length > 0) setInstrumentId(instruments[0].id);
  }, [instruments, instrumentId]);

  // Deliberately depends only on templateId/instrumentId (primitives), NOT
  // on `templates` — that array prop gets a new reference on every
  // background reload (e.g. the 4s market-data poll), and depending on it
  // here would silently wipe the user's in-progress anchor/base-structure
  // selection every few seconds while they're still filling out the form.
  useEffect(() => {
    setAnchorContractId("");
    // Default the base structure to a plain Outright if one exists, else the first available template.
    const outright = templates.find(isTrivialOutright);
    setBaseTemplateId(outright?.id ?? templates[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, instrumentId]);

  let preview: PreviewLeg[] = [];
  let previewError = "";
  if (selectedTemplate && selectedBaseTemplate && anchorContractId) {
    try {
      preview = previewLegs(selectedTemplate, selectedBaseTemplate, anchorContractId, instrumentContracts, direction);
    } catch (err) {
      previewError = err instanceof Error ? err.message : "Could not resolve template";
    }
  }

  const contractLabelById = useMemo(() => new Map(instrumentContracts.map((c) => [c.id, c.month_label])), [instrumentContracts]);

  // Auto-suggest a structure name, unless the user has typed their own.
  useEffect(() => {
    if (nameEdited) return;
    const instrument = instruments.find((i) => i.id === instrumentId);
    if (!instrument) return;
    const dirSuffix = direction === -1 ? " (Short)" : "";
    if (selectedTemplate) {
      const anchorLabel = contractLabelById.get(anchorContractId);
      setName(
        anchorLabel
          ? `${instrument.symbol} ${anchorLabel} ${selectedTemplate.name}${dirSuffix}`
          : `${instrument.symbol} ${selectedTemplate.name}${dirSuffix}`
      );
    } else {
      const labels = customLegs.map((l) => contractLabelById.get(l.contract_id)).filter((v): v is string => Boolean(v));
      setName(labels.length ? `${instrument.symbol} ${labels.join("-")} Custom` : `${instrument.symbol} Custom`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentId, anchorContractId, selectedTemplate, customLegs, nameEdited, direction]);

  function updateCustomLeg(idx: number, patch: Partial<CustomLegRow>) {
    setCustomLegs((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addCustomLegRow() {
    setCustomLegs((prev) => [...prev, { contract_id: "", ratio: 1 }]);
  }
  function removeCustomLegRow(idx: number) {
    setCustomLegs((prev) => prev.filter((_, i) => i !== idx));
  }

  const canSubmit = isCustom
    ? customLegs.every((l) => l.contract_id) && customLegs.length > 0
    : Boolean(anchorContractId) && Boolean(selectedBaseTemplate) && preview.length > 0 && !previewError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!instrumentId || !name || !canSubmit) return;
    const instrument = instruments.find((i) => i.id === instrumentId);
    if (!instrument) return;
    setSubmitting(true);
    try {
      const legs =
        selectedTemplate && selectedBaseTemplate
          ? await StructureQuoteEngine.buildLegsForStructure(selectedTemplate, selectedBaseTemplate, anchorContractId, instrument, direction)
          : customLegs.map((l) => ({ contract_id: l.contract_id, ratio: l.ratio }));

      await StructureEngine.createStructure({
        instrument_id: instrumentId,
        structure_template_id: selectedTemplate?.id,
        name,
        structure_type: selectedTemplate?.name ?? "Custom",
        initial_dollar_risk: initialRisk,
        legs,
      });
      setName("");
      setNameEdited(false);
      setAnchorContractId("");
      setDirection(1);
      setCustomLegs([{ contract_id: "", ratio: 1 }]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create structure");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>New Structure</h2>
        {onCancel && (
          <button type="button" className="secondary" style={{ marginBottom: 0 }} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
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
          {instruments.length === 0 && (
            <p className="helper-text">No active instruments — add one under Settings → Instruments.</p>
          )}
        </div>

        <div className="form-row">
          <label>Structure Template</label>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value={CUSTOM_TEMPLATE_ID}>Custom (build manually)</option>
          </select>
          {templates.length === 0 && (
            <p className="helper-text">No templates yet — create one under Settings → Structure Templates.</p>
          )}
        </div>

        {selectedTemplate && (
          <div className="form-row">
            <label>Base Structure (how it's actually traded)</label>
            <select value={baseTemplateId} onChange={(e) => setBaseTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="helper-text">
              e.g. build a Double Fly from Outrights, from Spreads, or from Flies — the engine works out the
              required legs either way.
            </p>
          </div>
        )}

        <div className="form-row">
          <label>Structure Name</label>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            placeholder="e.g. Brent Jan26 Fly"
          />
        </div>

        <div className="form-row">
          <label>Initial Dollar Risk ($)</label>
          <input type="number" value={initialRisk} onChange={(e) => setInitialRisk(Number(e.target.value))} />
        </div>

        {selectedTemplate && (
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
          </div>
        )}

        {selectedTemplate ? (
          <>
            <div className="form-row">
              <label>Anchor Contract (front month)</label>
              <ContractAutocomplete
                contracts={anchorableContracts}
                value={anchorContractId}
                onChange={setAnchorContractId}
              />
              <p className="helper-text">
                Every leg is derived from this one contract — type a month (e.g. "Apr26") and press Enter.
              </p>
            </div>

            {previewError && anchorContractId && (
              <p className="helper-text" style={{ color: "var(--red)" }}>{previewError}</p>
            )}

            {preview.length > 0 && (
              <>
                <h4>Required Legs — priced &amp; tracked at this level</h4>
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>Leg (traded as one quoted product)</th>
                      <th>Ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((l, i) => (
                      <tr key={i}>
                        <td>
                          {l.label}
                          {l.willCreateQuote && <span className="helper-text"> (new quote — will fetch its own live price)</span>}
                        </td>
                        <td className={l.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>{l.ratio >= 0 ? `+${l.ratio}` : l.ratio}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        ) : (
          <>
            <h4>Legs (custom)</h4>
            {customLegs.map((leg, idx) => (
              <div className="leg-row" key={idx}>
                <ContractAutocomplete
                  contracts={anchorableContracts}
                  value={leg.contract_id}
                  onChange={(id) => updateCustomLeg(idx, { contract_id: id })}
                />
                <input
                  type="number"
                  value={leg.ratio}
                  onChange={(e) => updateCustomLeg(idx, { ratio: Number(e.target.value) })}
                  title="Signed ratio: +1 = long 1 unit, -2 = short 2 units"
                  style={{ width: 70 }}
                />
                {customLegs.length > 1 && (
                  <button type="button" onClick={() => removeCustomLegRow(idx)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={addCustomLegRow} className="secondary">
              + Add Leg
            </button>
            <p className="helper-text">Ratio sign sets direction — no separate Long/Short field needed.</p>
          </>
        )}

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? "Creating…" : "Create Structure"}
        </button>
      </form>
    </div>
  );
}
