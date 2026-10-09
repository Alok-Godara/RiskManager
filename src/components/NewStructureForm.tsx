import { useEffect, useMemo, useState } from "react";
import type { Contract, Instrument, StructureTemplate } from "../types/domain";
import { StructureEngine } from "../engines/StructureEngine";
import { StructureQuoteEngine, type ResolvedLeg } from "../engines/StructureQuoteEngine";
import { repository } from "../data";
import { expandToOutrights, previewLegs, type PreviewLeg } from "../utils/templateExpansion";
import { dedupeContractsByMonth, sortContractsChronologically } from "../utils/contractGen";
import { contractLifecycleStatus, daysUntilExpiry } from "../utils/contractExpiry";
import { ContractAutocomplete } from "./ContractAutocomplete";
import { InfoTip } from "./InfoTip";

const CUSTOM_TEMPLATE_ID = "__custom__";

interface CustomLegRow {
  // The base structure this leg is traded as (Outright / Spread / Fly / ...).
  // "" = the default (plain Outright) — resolved at use, so it stays valid
  // when the templates list reloads.
  base_template_id: string;
  contract_id: string; // anchor month of that base structure, e.g. Jan26 for a "Jan26 Fly"
  ratio: number; // how many units of that base structure, signed
}

const blankLeg = (): CustomLegRow => ({ base_template_id: "", contract_id: "", ratio: 1 });

const EPS = 1e-6;

function isTrivialOutright(template: StructureTemplate): boolean {
  return template.legs.length === 1 && template.legs[0].ratio === 1 && template.legs[0].month_offset === 0;
}

// A structure has no direction of its own — every leg is built/preview'd at
// the template's canonical ratio sign. Direction is chosen per entry (see
// AddEntryModal), not here.
const CANONICAL_DIRECTION = 1 as const;

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
  const [initialRisk, setInitialRisk] = useState<number>(500);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Template path: one anchor contract drives every leg via month_offset.
  const [anchorContractId, setAnchorContractId] = useState("");
  // Custom/ad-hoc path: fully manual leg rows.
  const [customLegs, setCustomLegs] = useState<CustomLegRow[]>([blankLeg()]);

  // Anchor selection only ever needs outright months — structure-level
  // quote contracts (already-created Fly/Spread products) aren't valid
  // anchors. Also excludes months already past their real last-trading-day
  // (utils/contractExpiry.ts) — only give the user active contracts to
  // trade; a Near Expiry one stays selectable, just flagged in the picker.
  const instrumentContracts = useMemo(
    () => dedupeContractsByMonth(sortContractsChronologically(contracts.filter((c) => c.instrument_id === instrumentId))),
    [contracts, instrumentId]
  );
  const anchorableContracts = useMemo(
    () =>
      instrumentContracts.filter(
        (c) => (!c.kind || c.kind === "Outright") && contractLifecycleStatus(c.expiry_date) !== "Expired"
      ),
    [instrumentContracts]
  );

  const selectedTemplate = templates.find((t) => t.id === templateId);
  const isCustom = templateId === CUSTOM_TEMPLATE_ID || !selectedTemplate;
  const selectedBaseTemplate = templates.find((t) => t.id === baseTemplateId);

  // Custom path: every leg is "N units of <base structure> anchored at <month>"
  // (a plain Outright by default), so a custom structure can be assembled from
  // Flies / Spreads / etc. — same base-leg idea as the template path above.
  const defaultCustomBaseId = templates.find(isTrivialOutright)?.id ?? "";
  const baseFor = (leg: CustomLegRow) => templates.find((t) => t.id === (leg.base_template_id || defaultCustomBaseId));

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
      preview = previewLegs(selectedTemplate, selectedBaseTemplate, anchorContractId, instrumentContracts, CANONICAL_DIRECTION);
    } catch (err) {
      previewError = err instanceof Error ? err.message : "Could not resolve template";
    }
  }

  const contractLabelById = useMemo(() => new Map(instrumentContracts.map((c) => [c.id, c.month_label])), [instrumentContracts]);

  // What the custom legs add up to once every base structure is expanded to
  // its outright months: the final structure's real shape, e.g. +1 Jan Fly
  // and -1 Feb Fly net to +1 / -3 / +3 / -1 = a Double Fly.
  const customBreakdown = useMemo(() => {
    const outrights = sortContractsChronologically(instrumentContracts.filter((c) => !c.kind || c.kind === "Outright"));
    const net = new Map<string, number>();
    const errors: string[] = [];
    for (const leg of customLegs) {
      if (!leg.contract_id || !leg.ratio) continue;
      const base = templates.find((t) => t.id === (leg.base_template_id || defaultCustomBaseId));
      try {
        const expanded = base
          ? expandToOutrights(base, leg.contract_id, instrumentContracts)
          : [{ contract_id: leg.contract_id, ratio: 1 }];
        for (const o of expanded) net.set(o.contract_id, (net.get(o.contract_id) ?? 0) + o.ratio * leg.ratio);
      } catch (err) {
        const label = contractLabelById.get(leg.contract_id) ?? "leg";
        errors.push(`${label}${base ? " " + base.name : ""}: ${err instanceof Error ? err.message : "can't be resolved"}`);
      }
    }
    const rows = outrights
      .map((c, index) => ({ contract: c, index, ratio: Math.round((net.get(c.id) ?? 0) * 1e6) / 1e6 }))
      .filter((r) => Math.abs(r.ratio) > EPS);

    // Does the net shape equal one of the saved templates (either direction —
    // a structure has no direction of its own)?
    let matched: StructureTemplate | undefined;
    if (rows.length > 0) {
      const first = rows[0].index;
      const dense = new Array(rows[rows.length - 1].index - first + 1).fill(0);
      for (const r of rows) dense[r.index - first] = r.ratio;
      matched = templates.find((t) => {
        const offsets = t.legs.map((l) => l.month_offset);
        const min = Math.min(...offsets);
        const tDense = new Array(Math.max(...offsets) - min + 1).fill(0);
        for (const l of t.legs) tDense[l.month_offset - min] += l.ratio;
        if (tDense.length !== dense.length) return false;
        const same = tDense.every((v, i) => Math.abs(v - dense[i]) < EPS);
        const flipped = tDense.every((v, i) => Math.abs(v + dense[i]) < EPS);
        return same || flipped;
      });
    }
    return { rows, errors, matched };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customLegs, templates, instrumentContracts, contractLabelById]);

  function nearExpiryHint(c: Contract): string | undefined {
    if (contractLifecycleStatus(c.expiry_date) !== "Near Expiry") return undefined;
    const days = daysUntilExpiry(c.expiry_date);
    return days !== undefined ? `expires in ${days}d` : "near expiry";
  }

  // Auto-suggest a structure name, unless the user has typed their own.
  useEffect(() => {
    if (nameEdited) return;
    const instrument = instruments.find((i) => i.id === instrumentId);
    if (!instrument) return;
    if (selectedTemplate) {
      const anchorLabel = contractLabelById.get(anchorContractId);
      setName(
        anchorLabel
          ? `${instrument.symbol} ${anchorLabel} ${selectedTemplate.name}`
          : `${instrument.symbol} ${selectedTemplate.name}`
      );
    } else {
      const labels = customLegs
        .filter((l) => contractLabelById.get(l.contract_id))
        .map((l) => {
          const base = baseFor(l);
          const month = contractLabelById.get(l.contract_id) as string;
          return base && !isTrivialOutright(base) ? `${month} ${base.name}` : month;
        });
      setName(labels.length ? `${instrument.symbol} ${labels.join("-")} Custom` : `${instrument.symbol} Custom`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentId, anchorContractId, selectedTemplate, customLegs, nameEdited]);

  function updateCustomLeg(idx: number, patch: Partial<CustomLegRow>) {
    setCustomLegs((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addCustomLegRow() {
    setCustomLegs((prev) => [...prev, blankLeg()]);
  }
  function removeCustomLegRow(idx: number) {
    setCustomLegs((prev) => prev.filter((_, i) => i !== idx));
  }

  const canSubmit = isCustom
    ? customLegs.length > 0 &&
      customLegs.every((l) => l.contract_id && l.ratio !== 0) &&
      customBreakdown.errors.length === 0 &&
      customBreakdown.rows.length > 0
    : Boolean(anchorContractId) && Boolean(selectedBaseTemplate) && preview.length > 0 && !previewError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!instrumentId || !name || !canSubmit) return;
    const instrument = instruments.find((i) => i.id === instrumentId);
    if (!instrument) return;
    setSubmitting(true);
    try {
      let legs: ResolvedLeg[];
      if (selectedTemplate && selectedBaseTemplate) {
        legs = await StructureQuoteEngine.buildLegsForStructure(
          selectedTemplate,
          selectedBaseTemplate,
          anchorContractId,
          instrument,
          CANONICAL_DIRECTION
        );
      } else {
        // Each custom leg = N units of a base structure (Outright / Spread /
        // Fly / ...) at an anchor month: find-or-create that quote contract,
        // then merge repeats of the same contract into one leg.
        let known = await repository.getContractsByInstrument(instrument.id);
        const merged = new Map<string, number>();
        for (const l of customLegs) {
          const base = baseFor(l);
          let contractId = l.contract_id;
          if (base) {
            const quote = await StructureQuoteEngine.resolveAsOneUnit(base, l.contract_id, instrument, known);
            if (!known.some((c) => c.id === quote.id)) known = [...known, quote];
            contractId = quote.id;
          }
          merged.set(contractId, (merged.get(contractId) ?? 0) + l.ratio);
        }
        legs = Array.from(merged.entries())
          .filter(([, ratio]) => Math.abs(ratio) > EPS)
          .map(([contract_id, ratio]) => ({ contract_id, ratio }));
        if (legs.length === 0) throw new Error("These legs cancel out — nothing left to trade.");
      }

      await StructureEngine.createStructure({
        instrument_id: instrumentId,
        structure_template_id: selectedTemplate?.id,
        name,
        structure_type: selectedTemplate?.name ?? customBreakdown.matched?.name ?? "Custom",
        initial_dollar_risk: initialRisk,
        legs,
      });
      setName("");
      setNameEdited(false);
      setAnchorContractId("");
      setCustomLegs([blankLeg()]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create trade");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>New Trade</h2>
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
          <label>Trade Name</label>
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

        {selectedTemplate ? (
          <>
            <div className="form-row">
              <label>Anchor Contract (front month)</label>
              <ContractAutocomplete
                contracts={anchorableContracts}
                value={anchorContractId}
                onChange={setAnchorContractId}
                hintFor={nearExpiryHint}
              />
              <p className="helper-text">
                Every leg is derived from this one contract — type a month (e.g. "Apr26") and press Enter. Only
                contracts still trading are offered; one nearing its last trading day is flagged, not hidden.
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
            <h4>
              Legs (custom){" "}
              <InfoTip>
                Build the structure from any base legs. Each row is "N units of a base structure starting at a month" — e.g.
                pick Fly + Jan26 + ratio +1 for one Jan26 Fly, then add Fly + Feb26 + ratio −1 for a Feb26 Fly; together they
                make a Double Fly. Pick Outright to use single months. Ratio sign sets direction. The table below shows what
                the legs add up to in outright months.
              </InfoTip>
            </h4>
            <div className="leg-row helper-text" style={{ marginBottom: 2 }}>
              <span style={{ width: 150 }}>Base leg</span>
              <span style={{ flex: 1 }}>Starting month</span>
              <span style={{ width: 70 }}>Ratio</span>
            </div>
            {customLegs.map((leg, idx) => (
              <div className="leg-row" key={idx}>
                <select
                  value={leg.base_template_id || defaultCustomBaseId}
                  onChange={(e) => updateCustomLeg(idx, { base_template_id: e.target.value })}
                  style={{ width: 150 }}
                  title="What this leg is traded as: a single month (Outright), a Spread, a Fly, ..."
                >
                  {templates.length === 0 && <option value="">Outright</option>}
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <ContractAutocomplete
                  contracts={anchorableContracts}
                  value={leg.contract_id}
                  onChange={(id) => updateCustomLeg(idx, { contract_id: id })}
                  hintFor={nearExpiryHint}
                />
                <input
                  type="number"
                  value={leg.ratio}
                  onChange={(e) => updateCustomLeg(idx, { ratio: Number(e.target.value) })}
                  title="Signed ratio of this base leg: +1 = 1 unit, -2 = 2 units the other way"
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

            {customBreakdown.errors.map((msg, i) => (
              <p key={i} className="helper-text" style={{ color: "var(--red)" }}>
                {msg}
              </p>
            ))}

            {customBreakdown.rows.length > 0 && (
              <>
                <h4>
                  Final structure — outright months{" "}
                  <InfoTip>
                    All legs above expanded to single months and added up (months that cancel are dropped). This is the real
                    shape you are creating. If it equals a saved template it is named after it.
                  </InfoTip>
                </h4>
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Net ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customBreakdown.rows.map((r) => (
                      <tr key={r.contract.id}>
                        <td>{r.contract.month_label}</td>
                        <td className={r.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>{r.ratio >= 0 ? `+${r.ratio}` : r.ratio}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="helper-text">
                  {customBreakdown.matched
                    ? `This is a ${customBreakdown.matched.name} (${customBreakdown.rows.map((r) => (r.ratio >= 0 ? "+" : "") + r.ratio).join(" / ")}).`
                    : `Shape: ${customBreakdown.rows.map((r) => (r.ratio >= 0 ? "+" : "") + r.ratio).join(" / ")} — no saved template matches, it will be created as Custom.`}
                </p>
              </>
            )}
          </>
        )}

        {error && <p className="helper-text" style={{ color: "var(--red)" }}>{error}</p>}

        <button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? "Creating…" : "Create Trade"}
        </button>
      </form>
    </div>
  );
}
