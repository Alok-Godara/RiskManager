import { Fragment, useEffect, useState } from "react";
import type { Contract, Execution, EntrySnapshot, Instrument, StructureSnapshot, StructureTemplate } from "../types/domain";
import { EntryEngine } from "../engines/EntryEngine";
import { StructureEngine } from "../engines/StructureEngine";
import { contractLifecycleStatus } from "../utils/contractExpiry";
import { repository } from "../data";
import { fmtMoney, fmtPrice, pnlClass } from "../utils/format";
import { IconChevronLeft, IconPencil } from "./icons";
import { AddEntryModal } from "./AddEntryModal";
import { ExitEntryModal } from "./ExitEntryModal";
import { EditEntryModal } from "./EditEntryModal";
import { EditExecutionModal } from "./EditExecutionModal";

export function StructureDetail({
  snapshot,
  snapshots,
  contracts,
  templates,
  instruments,
  onBack,
  onChanged,
}: {
  snapshot: StructureSnapshot;
  snapshots: StructureSnapshot[];
  contracts: Contract[];
  templates: StructureTemplate[];
  instruments: Instrument[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const { structure, legs } = snapshot;

  const [entries, setEntries] = useState<EntrySnapshot[]>([]);
  const [otherExecutions, setOtherExecutions] = useState<Execution[]>([]);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [exitingEntry, setExitingEntry] = useState<EntrySnapshot | null>(null);
  // When set, the Exit window is limited to this one leg of the entry (the per-leg Exit button).
  const [exitingLegId, setExitingLegId] = useState<string | undefined>();
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  function toggleEntry(id: string) {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [editingEntry, setEditingEntry] = useState<EntrySnapshot | null>(null);
  const [editingExecution, setEditingExecution] = useState<Execution | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(structure.name);
  const [renameError, setRenameError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [editingRisk, setEditingRisk] = useState(false);
  const [riskDraft, setRiskDraft] = useState<number | "">(structure.initial_dollar_risk);
  const [riskError, setRiskError] = useState("");
  const [savingRisk, setSavingRisk] = useState(false);

  useEffect(() => {
    EntryEngine.buildEntrySnapshots(snapshot).then(setEntries);
    Promise.all(legs.map((l) => repository.getExecutionsByLeg(l.leg.id))).then((lists) => {
      // Entry-type executions get their own aggregated "Entries" table above
      // (see EntryEngine) — this table is exits + any non-Active history.
      const merged = lists
        .flat()
        .filter((e) => e.execution_type !== "Entry")
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setOtherExecutions(merged);
    });
  }, [structure.id, snapshot, legs]);

  useEffect(() => {
    setNameDraft(structure.name);
  }, [structure.name]);

  useEffect(() => {
    setRiskDraft(structure.initial_dollar_risk);
  }, [structure.initial_dollar_risk]);

  const contractLabelByLeg = Object.fromEntries(legs.map((l) => [l.leg.id, l.contract.month_label]));

  // Active Risk: risk_allocated summed only across entries still OPEN right
  // now (open_quantity > 0) — a fully-exited entry no longer ties up any of
  // the structure's risk budget, so it must drop out of this total. Fed
  // straight from the same EntrySnapshot rows the Entries table already
  // renders, not a separate query, so it can never disagree with what's on
  // screen.
  const activeRisk = entries.filter((e) => e.open_quantity > 0).reduce((sum, e) => sum + (e.risk_allocated || 0), 0);

  // Unallocated Risk: the initial budget, minus what's currently tied up in
  // open entries, plus profit already booked (a loss reduces it the same
  // way) — the maximum you could still allocate to a new/scaled-up entry on
  // this structure right now.
  const unallocatedRisk = structure.initial_dollar_risk - activeRisk + snapshot.total_realized_pnl;

  // Structure-level average entry price across every entry, not just per-leg:
  // sum(ratio_i * leg_i avg price) — the same composite-price convention used
  // everywhere else (EntryEngine's per-entry avg_price, QuantHub structure
  // quotes, CorrelationEngine). Each leg's own average_price is already the
  // size-weighted average across all of that leg's entries (Position is
  // cumulative), so this reduce alone gives the structure's overall average
  // without re-deriving anything from raw executions.
  const structureAvgPrice = legs.reduce((sum, l) => sum + l.leg.ratio * l.position.average_price, 0);

  function handleChanged() {
    onChanged();
  }

  async function handleRenameSave() {
    setRenameError("");
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setRenameError("Name cannot be empty.");
      return;
    }
    try {
      await StructureEngine.renameStructure(structure.id, trimmed);
      setRenaming(false);
      onChanged();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to rename");
    }
  }

  async function handleRiskSave() {
    setRiskError("");
    if (riskDraft === "" || riskDraft < 0) {
      setRiskError("Initial risk must be zero or greater.");
      return;
    }
    setSavingRisk(true);
    try {
      await StructureEngine.updateInitialRisk(structure.id, Number(riskDraft));
      setEditingRisk(false);
      onChanged();
    } catch (err) {
      setRiskError(err instanceof Error ? err.message : "Failed to update risk");
    } finally {
      setSavingRisk(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Delete structure "${structure.name}"? This permanently removes all its legs, entries/exits, and realized P&L. This cannot be undone.`
      )
    ) {
      return;
    }
    setDeleteError("");
    setDeleting(true);
    try {
      await StructureEngine.deleteStructure(structure.id);
      onChanged();
      onBack();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <div className="panel">
      <button className="secondary back-button" onClick={onBack}>
        <IconChevronLeft size={14} /> Back to structures
      </button>
      <div className="panel-header">
        {renaming ? (
          <div className="inline-actions">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSave();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setNameDraft(structure.name);
                  setRenameError("");
                }
              }}
              autoFocus
              style={{ fontSize: "1.1em" }}
            />
            <button type="button" onClick={handleRenameSave}>
              Save
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRenaming(false);
                setNameDraft(structure.name);
                setRenameError("");
              }}
            >
              Cancel
            </button>
            <button type="button" className="danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        ) : (
          <div className="inline-actions">
            <h2>
              {structure.name}{" "}
              <span className={`badge badge-${structure.status.replace(/\s/g, "").toLowerCase()}`}>{structure.status}</span>
            </h2>
            <button type="button" className="icon-button" onClick={() => setRenaming(true)} title="Edit structure" aria-label="Edit structure">
              <IconPencil size={14} />
            </button>
          </div>
        )}
        <div className="button-row">
          <button onClick={() => setShowAddEntry(true)}>+ Add Entry</button>
        </div>
      </div>
      {renameError && <p className="helper-text" style={{ color: "var(--red)" }}>{renameError}</p>}
      {deleteError && <p className="helper-text" style={{ color: "var(--red)" }}>{deleteError}</p>}

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Realized P&amp;L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_realized_pnl)}`}>{fmtMoney(snapshot.total_realized_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unrealized P&amp;L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_unrealized_pnl)}`}>{fmtMoney(snapshot.total_unrealized_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total P&amp;L</div>
          <div className={`stat-value ${pnlClass(snapshot.total_pnl)}`}>{fmtMoney(snapshot.total_pnl)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Structure Avg Entry Price</div>
          <div className="stat-value">{fmtPrice(structureAvgPrice)}</div>
          <div className="stat-sub">Composite across all entries — Σ(ratio × leg avg price), not just per-leg</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Initial Risk{" "}
            {!editingRisk && (
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setRiskDraft(structure.initial_dollar_risk);
                  setRiskError("");
                  setEditingRisk(true);
                }}
                title="Edit initial risk"
                aria-label="Edit initial risk"
              >
                <IconPencil size={12} />
              </button>
            )}
          </div>
          {editingRisk ? (
            <div className="inline-actions">
              <input
                type="number"
                min="0"
                step="any"
                value={riskDraft}
                onChange={(e) => setRiskDraft(e.target.value === "" ? "" : Number(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRiskSave();
                  if (e.key === "Escape") {
                    setEditingRisk(false);
                    setRiskDraft(structure.initial_dollar_risk);
                    setRiskError("");
                  }
                }}
                autoFocus
                style={{ width: 100 }}
              />
              <button type="button" onClick={handleRiskSave} disabled={savingRisk}>
                {savingRisk ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditingRisk(false);
                  setRiskDraft(structure.initial_dollar_risk);
                  setRiskError("");
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="stat-value">{fmtMoney(structure.initial_dollar_risk)}</div>
          )}
          <div className="stat-sub">The risk budget you're willing to give this structure — editable any time.</div>
          {riskError && <div className="helper-text" style={{ color: "var(--red)" }}>{riskError}</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Risk</div>
          <div className="stat-value">{fmtMoney(activeRisk)}</div>
          <div className="stat-sub">Sum of risk allocated to entries still open right now</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unallocated Risk</div>
          <div className={`stat-value ${pnlClass(unallocatedRisk)}`}>{fmtMoney(unallocatedRisk)}</div>
          <div className="stat-sub">Initial Risk − Active Risk + Realized P&amp;L — what's free to allocate to a new or bigger entry</div>
        </div>
      </div>

      <h3>Legs</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Leg (traded product)</th>
            <th>Ratio</th>
            <th>Net Qty</th>
            <th>Avg Price</th>
            <th>Live Price</th>
            <th>Unrealized</th>
            <th>Realized</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => {
            const contractStatus = contractLifecycleStatus(l.contract.expiry_date);
            return (
            <tr key={l.leg.id}>
              <td>
                {l.contract.month_label}
                {contractStatus !== "Active" && (
                  <span
                    className={`badge ${contractStatus === "Expired" ? "badge-expired" : "badge-nearexpiry"}`}
                    style={{ marginLeft: 6 }}
                  >
                    {contractStatus}
                  </span>
                )}
              </td>
              <td className={l.leg.ratio >= 0 ? "pnl-pos" : "pnl-neg"}>{l.leg.ratio >= 0 ? `+${l.leg.ratio}` : l.leg.ratio}</td>
              <td>{l.position.net_quantity}</td>
              <td>{fmtPrice(l.position.average_price)}</td>
              <td>{fmtPrice(l.current_price)}</td>
              <td className={pnlClass(l.unrealized_pnl)}>{fmtMoney(l.unrealized_pnl)}</td>
              <td className={pnlClass(l.position.realized_pnl)}>{fmtMoney(l.position.realized_pnl)}</td>
              <td>{l.leg.is_active ? "Active" : "Closed"}</td>
            </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Entries</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date &amp; Time</th>
            <th>Side</th>
            <th>Avg Entry Price</th>
            <th>Open Qty</th>
            <th>Closed Qty</th>
            <th>Avg Exit Price</th>
            <th>Risk Allocated</th>
            <th>Stop Loss (Price)</th>
            <th>Unrealized P&amp;L</th>
            <th>Realized P&amp;L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((en) => (
            <Fragment key={en.entry_group_id}>
              <tr
                className="clickable"
                onClick={() => toggleEntry(en.entry_group_id)}
                title={expandedEntries.has(en.entry_group_id) ? "Click to hide legs" : "Click to show legs"}
                aria-expanded={expandedEntries.has(en.entry_group_id)}
              >
                <td>
                  <span className="muted" aria-hidden="true">
                    {expandedEntries.has(en.entry_group_id) ? "▾" : "▸"}
                  </span>{" "}
                  {new Date(en.timestamp).toLocaleString()}
                </td>
                <td className={en.side === "Long" ? "pnl-pos" : en.side === "Short" ? "pnl-neg" : "muted"}>{en.side}</td>
                <td>{fmtPrice(en.avg_price)}</td>
                <td>
                  {en.open_quantity}
                  {en.kind === "custom" && <span className="muted"> leg lots</span>}
                </td>
                <td>{en.closed_quantity}</td>
                <td>{en.avg_exit_price !== undefined ? fmtPrice(en.avg_exit_price) : "—"}</td>
                <td>{en.risk_allocated ? fmtMoney(en.risk_allocated) : "—"}</td>
                <td>{en.stop_loss_price !== undefined ? fmtPrice(en.stop_loss_price) : "—"}</td>
                <td className={pnlClass(en.unrealized_pnl)}>{fmtMoney(en.unrealized_pnl)}</td>
                <td className={pnlClass(en.realized_pnl)}>{fmtMoney(en.realized_pnl)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="inline-actions">
                    <button type="button" onClick={() => setEditingEntry(en)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setExitingLegId(undefined);
                        setExitingEntry(en);
                      }}
                      disabled={en.open_quantity <= 0}
                    >
                      Exit
                    </button>
                  </div>
                </td>
              </tr>
              {expandedEntries.has(en.entry_group_id) && (
                <tr>
                  <td colSpan={11} style={{ paddingLeft: 32, background: "var(--panel-2)" }}>
                    <table className="data-table compact">
                      <thead>
                        <tr>
                          <th>Leg</th>
                          <th>Side</th>
                          <th>Entered</th>
                          <th>Closed</th>
                          <th>Open</th>
                          <th>Entry Price</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {en.legs.map((l) => (
                          <tr key={l.leg.id}>
                            <td>{l.contract.month_label}</td>
                            <td className={l.execution.side === "Long" ? "pnl-pos" : "pnl-neg"}>{l.execution.side}</td>
                            <td>{l.entered_qty}</td>
                            <td>{l.closed_qty}</td>
                            <td>{l.open_qty}</td>
                            <td>{fmtPrice(l.execution.price)}</td>
                            <td>
                              <div className="inline-actions">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setExitingLegId(l.leg.id);
                                    setExitingEntry(en);
                                  }}
                                  disabled={l.open_qty <= 0}
                                >
                                  Exit
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={11} className="muted">
                No entries yet — click Add Entry above.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {otherExecutions.length > 0 && (
        <>
          <h3>Exits &amp; Corrections</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Contract</th>
                <th>Type</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {otherExecutions.map((ex) => (
                <tr key={ex.id} className={ex.status === "Edited" ? "execution-edited" : ex.status === "Deleted" ? "execution-deleted" : ""}>
                  <td>{new Date(ex.timestamp).toLocaleString()}</td>
                  <td>{contractLabelByLeg[ex.structure_leg_id] ?? "—"}</td>
                  <td>{ex.execution_type}</td>
                  <td className={ex.side === "Long" ? "pnl-pos" : "pnl-neg"}>{ex.side}</td>
                  <td>{ex.quantity}</td>
                  <td>{fmtPrice(ex.price)}</td>
                  <td>{ex.status}</td>
                  <td>
                    {ex.status === "Active" && (
                      <div className="inline-actions">
                        <button type="button" onClick={() => setEditingExecution(ex)}>
                          Edit
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {showAddEntry && (
        <AddEntryModal
          snapshot={snapshot}
          snapshots={snapshots}
          contracts={contracts}
          templates={templates}
          instruments={instruments}
          onClose={() => setShowAddEntry(false)}
          onSaved={handleChanged}
        />
      )}
      {exitingEntry && (
        <ExitEntryModal
          entry={exitingEntry}
          structureId={structure.id}
          legSnapshots={legs}
          onlyLegId={exitingLegId}
          onClose={() => {
            setExitingEntry(null);
            setExitingLegId(undefined);
          }}
          onSaved={handleChanged}
        />
      )}
      {editingEntry && (
        <EditEntryModal
          entry={editingEntry}
          structureId={structure.id}
          onClose={() => setEditingEntry(null)}
          onSaved={handleChanged}
        />
      )}
      {editingExecution && (
        <EditExecutionModal
          execution={editingExecution}
          structureId={structure.id}
          legs={legs}
          onClose={() => setEditingExecution(null)}
          onSaved={handleChanged}
        />
      )}
    </div>
  );
}
