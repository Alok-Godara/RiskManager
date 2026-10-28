import { Fragment, useEffect, useMemo, useState } from "react";
import type { Contract, Execution, EntrySnapshot, Instrument, StructureSnapshot, StructureTemplate } from "../types/domain";
import { EntryEngine, type EntryInputs } from "../engines/EntryEngine";
import { StructureEngine } from "../engines/StructureEngine";
import { contractLifecycleStatus } from "../utils/contractExpiry";
import { fmtMoney, fmtPrice, pnlClass, statusLabel } from "../utils/format";
import { tradeStatusBadgeClass } from "../utils/tradeDirection";
import { IconChevronLeft, IconPencil } from "./icons";
import { AddEntryModal } from "./AddEntryModal";
import { ExitEntryModal } from "./ExitEntryModal";
import { InfoTip } from "./InfoTip";
import { EditEntryModal } from "./EditEntryModal";
import { EditExecutionModal } from "./EditExecutionModal";
import { useStructureValueAtRisk } from "../hooks/useStructureValueAtRisk";

/** The Entries-table columns you can sort by (the heading you click). */
type EntrySortKey =
  | "timestamp"
  | "side"
  | "avg_price"
  | "open_quantity"
  | "closed_quantity"
  | "avg_exit_price"
  | "risk_allocated"
  | "stop_loss_price"
  | "unrealized_pnl"
  | "realized_pnl";

function entrySortValue(en: EntrySnapshot, key: EntrySortKey): number | string | undefined {
  if (key === "timestamp") return new Date(en.timestamp).getTime();
  if (key === "side") return en.side;
  if (key === "risk_allocated") return en.risk_allocated ? en.risk_allocated : undefined; // shown as "—" when 0
  return en[key];
}

/** Sorts a copy. Entries with no value for the column ("—") always go last, in either direction. */
function sortEntries(entries: EntrySnapshot[], key: EntrySortKey, dir: "asc" | "desc"): EntrySnapshot[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const va = entrySortValue(a, key);
    const vb = entrySortValue(b, key);
    if (va === undefined && vb === undefined) return 0;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    const cmp = typeof va === "string" || typeof vb === "string" ? String(va).localeCompare(String(vb)) : (va as number) - (vb as number);
    return cmp * sign || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(); // ties: newest first
  });
}

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
  // Entries table order — newest first until you click a column heading.
  const [entrySort, setEntrySort] = useState<{ key: EntrySortKey; dir: "asc" | "desc" }>({ key: "timestamp", dir: "desc" });
  const sortedEntries = useMemo(() => sortEntries(entries, entrySort.key, entrySort.dir), [entries, entrySort]);
  function sortEntriesBy(key: EntrySortKey) {
    setEntrySort((prev) => ({ key, dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc" }));
  }
  /** A clickable column heading: click to sort by it, click again to flip ascending/descending. */
  function sortHeader(key: EntrySortKey, label: string) {
    const active = entrySort.key === key;
    return (
      <th aria-sort={active ? (entrySort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" className="sort-header" onClick={() => sortEntriesBy(key)} title={`Sort by ${label}`}>
          {label}
          <span className="sort-arrow" aria-hidden="true">{active ? (entrySort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
        </button>
      </th>
    );
  }
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
  const [closeError, setCloseError] = useState("");
  const [closingTrade, setClosingTrade] = useState(false);
  const isClosed = structure.status === "Fully Closed";
  const isFlat = !snapshot.legs.some((l) => Math.abs(l.position.net_quantity) > 1e-9);

  /**
   * A closed trade is a finished record — its buttons stay available, but
   * every change first asks for explicit confirmation so a past trade can't be
   * altered (and mixed with later results) by accident.
   */
  function guardClosed(what: string): boolean {
    if (!isClosed) return true;
    return window.confirm(
      `This trade is CLOSED.\n\n${what} will change its recorded history and results.\n\nAre you sure you want to change a closed trade?`
    );
  }

  async function handleCloseTrade() {
    setCloseError("");
    if (!isFlat) {
      const open = snapshot.legs.filter((l) => Math.abs(l.position.net_quantity) > 1e-9).length;
      setCloseError(`Exit all remaining lots first — ${open} leg${open === 1 ? "" : "s"} still hold open lots.`);
      return;
    }
    if (
      !window.confirm(
        `Close trade "${structure.name}"?\n\nFinal realized P&L: ${fmtMoney(snapshot.total_realized_pnl)} gross, ${fmtMoney(snapshot.net_realized_pnl)} after transaction costs.\n\nOnce closed, any change to this trade will ask for confirmation.`
      )
    ) {
      return;
    }
    setClosingTrade(true);
    try {
      await StructureEngine.closeTrade(structure.id);
      onChanged();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Failed to close trade");
    } finally {
      setClosingTrade(false);
    }
  }

  async function handleReopenTrade() {
    setCloseError("");
    if (!window.confirm(`Reopen trade "${structure.name}"? It will count as an open trade again.`)) return;
    setClosingTrade(true);
    try {
      await StructureEngine.reopenTrade(structure.id);
      onChanged();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Failed to reopen trade");
    } finally {
      setClosingTrade(false);
    }
  }
  const { loading: varLoading, valueAtRisk: structureVar } = useStructureValueAtRisk(snapshot, contracts, templates, instruments);
  const holdsPosition = legs.some((l) => Math.abs(l.position.net_quantity) > 1e-9);

  // The executions behind the Entries table are read from the database only when
  // this trade's position actually changes (it is keyed on the legs' quantities,
  // prices and last-updated stamps). Live prices then just re-derive the rows
  // in memory — re-querying on every price tick was a big part of the
  // free-tier data usage.
  const positionSignature = legs
    .map((l) => `${l.leg.id}:${l.position.net_quantity}:${l.position.average_price}:${l.position.realized_pnl}:${l.position.last_updated}`)
    .join("|");
  const [entryInputs, setEntryInputs] = useState<EntryInputs | null>(null);

  useEffect(() => {
    let cancelled = false;
    EntryEngine.loadInputs(snapshot).then((inputs) => {
      if (!cancelled) setEntryInputs(inputs);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure.id, positionSignature]);

  useEffect(() => {
    if (!entryInputs) return;
    setEntries(EntryEngine.buildFromInputs(snapshot, entryInputs));
  }, [snapshot, entryInputs]);

  const derivedOtherExecutions = useMemo(
    () =>
      // Entry-type executions get their own aggregated "Entries" table above
      // (see EntryEngine) — this table is exits + any non-Active history.
      (entryInputs?.executions ?? []).filter((e) => e.execution_type !== "Entry").sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [entryInputs]
  );
  useEffect(() => {
    setOtherExecutions(derivedOtherExecutions);
  }, [derivedOtherExecutions]);

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

  // Average stop-loss: the stop levels of the entries still open (each fixed at
  // entry time from its risk allocation — see EntryEngine), averaged by their
  // open lots, on the same composite price scale as the average entry price.
  // Entries with no risk allocated have no stop and are left out.
  const stopEntries = entries.filter((e) => e.open_quantity > 0 && e.stop_loss_price !== undefined);
  const stopLots = stopEntries.reduce((sum, e) => sum + e.open_quantity, 0);
  const structureAvgStop = stopLots > 0 ? stopEntries.reduce((sum, e) => sum + e.open_quantity * (e.stop_loss_price as number), 0) / stopLots : undefined;

  // Net P&L: realized after the costs paid so far, plus unrealized (gross). No exit cost is projected.
  const netPnl = snapshot.net_pnl;

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
        `Delete trade "${structure.name}"? This permanently removes all its legs, entries/exits, and realized P&L. This cannot be undone.`
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
        <IconChevronLeft size={14} /> Back to trades
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
              <span className={`badge ${tradeStatusBadgeClass(snapshot)}`}>{statusLabel(structure.status)}</span>
            </h2>
            <button
              type="button"
              className="icon-button"
              onClick={() => guardClosed("Editing the trade's name or deleting it") && setRenaming(true)}
              title="Edit trade"
              aria-label="Edit trade"
            >
              <IconPencil size={14} />
            </button>
          </div>
        )}
        <div className="button-row">
          <button onClick={() => guardClosed("Adding an entry") && setShowAddEntry(true)}>+ Add Entry</button>
          {isClosed ? (
            <button type="button" className="secondary" style={{ marginBottom: 0 }} onClick={handleReopenTrade} disabled={closingTrade}>
              Reopen Trade
            </button>
          ) : (
            <button type="button" className="secondary" style={{ marginBottom: 0 }} onClick={handleCloseTrade} disabled={closingTrade}>
              {closingTrade ? "Closing…" : "Close Trade"}
            </button>
          )}
        </div>
      </div>
      {isClosed && (
        <p className="helper-text">
          🔒 Closed{structure.closed_at ? " on " + new Date(structure.closed_at).toLocaleDateString() : ""}. This trade is a finished
          record: you can still edit it, but every change asks for confirmation first.
        </p>
      )}
      {!isClosed && isFlat && entries.length > 0 && (
        <p className="helper-text">All lots are exited. Press Close Trade when you are finished with this trade.</p>
      )}
      {closeError && <p className="helper-text" style={{ color: "var(--red)" }}>{closeError}</p>}
      {renameError && <p className="helper-text" style={{ color: "var(--red)" }}>{renameError}</p>}
      {deleteError && <p className="helper-text" style={{ color: "var(--red)" }}>{deleteError}</p>}

      <div className="card-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className="stat-card">
          <div className="stat-label">
            Net Realized P&amp;L{" "}
            <InfoTip>
              Profit or loss booked on lots you have exited (gross), minus every transaction cost paid on this trade so far —
              both the entry and exit sides, including the entry half already paid on lots still open. The exchange charges per
              outright lot: half the round-turn rate on entry and half on exit. Rates: Settings → Instruments.
            </InfoTip>
          </div>
          <div className={`stat-value ${pnlClass(snapshot.net_realized_pnl)}`}>{fmtMoney(snapshot.net_realized_pnl)}</div>
          <div className="stat-sub">
            Gross {fmtMoney(snapshot.total_realized_pnl)} − TC {fmtMoney(snapshot.total_transaction_cost)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Unrealized P&amp;L (Gross){" "}
            <InfoTip>
              Gross profit or loss on the lots still open, at the current live prices. No transaction costs are taken off here —
              they are already counted in Net Realized.
            </InfoTip>
          </div>
          <div className={`stat-value ${pnlClass(snapshot.total_unrealized_pnl)}`}>{fmtMoney(snapshot.total_unrealized_pnl)}</div>
          <div className="stat-sub">Open lots at live prices</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Net P&amp;L{" "}
            <InfoTip>
              Net Realized P&amp;L plus the gross Unrealized P&amp;L of the open lots. The costs already paid are inside Net
              Realized; no cost for exiting the open lots is deducted — it is only charged if and when you exit them (and not at
              all if you tick "without transaction cost" on that exit).
            </InfoTip>
          </div>
          <div className={`stat-value ${pnlClass(netPnl)}`}>{fmtMoney(netPnl)}</div>
          <div className="stat-sub">Net realized + unrealized</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Daily Swing ($)
            <InfoTip>
              How much this structure's P&amp;L typically moves in one day, in dollars, at the lots you hold in it right now (one
              standard deviation of its daily P&amp;L over the last {structureVar?.observations ?? 90} trading days of settlement
              prices). It looks at this structure on its own — your whole-book figure, with everything offsetting, is on the
              Correlation tab.
              {structureVar && (
                <span style={{ display: "block", marginTop: 6 }}>
                  Value at Risk ({(structureVar.confidence * 100).toFixed(0)}%, 1 day): ±{fmtMoney(structureVar.value_at_risk)} —{" "}
                  {(structureVar.confidence * 100).toFixed(0)}% of days the P&amp;L should stay inside that range.
                </span>
              )}
            </InfoTip>
          </div>
          <div className="stat-value">
            {!holdsPosition ? "—" : structureVar ? "±" + fmtMoney(structureVar.daily_std_dev) : varLoading ? "…" : "—"}
          </div>
          <div className="stat-sub">
            {!holdsPosition
              ? "No open lots"
              : structureVar
                ? "VaR " + (structureVar.confidence * 100).toFixed(0) + "%: ±" + fmtMoney(structureVar.value_at_risk)
                : varLoading
                  ? "Calculating…"
                  : "Not enough settlement history yet"}
          </div>
        </div>
      </div>

      {/* Second row: price levels and risk budget (the four P&L / swing cards stay on top). */}
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Structure Avg Entry Price</div>
          <div className="stat-value">{fmtPrice(structureAvgPrice)}</div>
          <div className="stat-sub">Composite across all entries — Σ(ratio × leg avg price), not just per-leg</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Structure Avg Stop Loss
            <InfoTip>
              The stop levels of your open entries, averaged by their open lots, on the same composite price scale as the average
              entry price. Each entry's stop is where its loss would equal the risk allocated to it. Entries with no risk
              allocated have no stop and are left out.
            </InfoTip>
          </div>
          <div className="stat-value">{structureAvgStop !== undefined ? fmtPrice(structureAvgStop) : "—"}</div>
          <div className="stat-sub">
            {stopEntries.length > 0
              ? "Lot-weighted across " + stopEntries.length + " open entr" + (stopEntries.length === 1 ? "y" : "ies") + " with a stop"
              : "No open entry has risk allocated"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Initial Risk{" "}
            {!editingRisk && (
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  if (!guardClosed("Changing the initial risk")) return;
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
            {sortHeader("timestamp", "Date & Time")}
            {sortHeader("side", "Side")}
            {sortHeader("avg_price", "Avg Entry Price")}
            {sortHeader("open_quantity", "Open Qty")}
            {sortHeader("closed_quantity", "Closed Qty")}
            {sortHeader("avg_exit_price", "Avg Exit Price")}
            {sortHeader("risk_allocated", "Risk Allocated")}
            {sortHeader("stop_loss_price", "Stop Loss (Price)")}
            {sortHeader("unrealized_pnl", "Unrealized P&L")}
            {sortHeader("realized_pnl", "Realized P&L")}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map((en) => (
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
                  {en.legs.some((l) => l.execution.tc_waived) && (
                    <span className="muted" title="No transaction cost charged on this entry"> · no TC</span>
                  )}
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
                    <button type="button" onClick={() => guardClosed("Editing this entry") && setEditingEntry(en)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!guardClosed("Exiting lots")) return;
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
                                    if (!guardClosed("Exiting lots")) return;
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
                  <td>
                    {ex.execution_type}
                    {ex.tc_waived && <span className="muted" title="No transaction cost charged on this fill"> · no TC</span>}
                  </td>
                  <td className={ex.side === "Long" ? "pnl-pos" : "pnl-neg"}>{ex.side}</td>
                  <td>{ex.quantity}</td>
                  <td>{fmtPrice(ex.price)}</td>
                  <td>{ex.status}</td>
                  <td>
                    {ex.status === "Active" && (
                      <div className="inline-actions">
                        <button type="button" onClick={() => guardClosed("Editing this execution") && setEditingExecution(ex)}>
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
