import { useEffect, useMemo, useRef, useState } from "react";
import type { StructureSnapshot } from "../types/domain";
import { fmtMoney, fmtPrice, pnlClass, statusBadgeClass, statusLabel } from "../utils/format";
import { InfoTip } from "./InfoTip";
import { IconSearch } from "./icons";
import { StructureEngine } from "../engines/StructureEngine";

type StatusFilter = "all" | "open" | "closed";

interface Filters {
  search: string;
  /** "all" | "last3" | "last6" | "last12" | "YYYY-MM" (one calendar month) */
  period: string;
  status: StatusFilter;
  type: string; // "" = every type
}

const DEFAULT_FILTERS: Filters = { search: "", period: "all", status: "all", type: "" };
const STORAGE_KEY = "structure-list-filters";

/** Filters survive opening a structure and coming back (the list unmounts) — per-tab convenience only, never required. */
function loadFilters(): Filters {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<Filters>) };
  } catch {
    // storage unavailable — fall through to defaults
  }
  return DEFAULT_FILTERS;
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * When did anything happen on this structure? Every entry fill (opening it or
 * adding to it) counts; a structure that was created but never entered falls
 * back to its creation date so it doesn't vanish from every period.
 */
function activityDates(s: StructureSnapshot): string[] {
  return s.entry_timestamps.length > 0 ? s.entry_timestamps : [s.structure.created_at];
}

function matchesPeriod(s: StructureSnapshot, period: string, now: Date): boolean {
  if (period === "all") return true;
  const dates = activityDates(s);
  if (/^\d{4}-\d{2}$/.test(period)) return dates.some((d) => monthKey(d) === period);
  const months = period === "last3" ? 3 : period === "last6" ? 6 : 12;
  const from = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  return dates.some((d) => new Date(d) >= from);
}

/**
 * A small ▾ button in a column heading that opens a dropdown of choices for
 * that column (e.g. Status: All / Open / Closed). Highlighted while a
 * non-default choice is applied. Closes on outside click or Escape.
 */
function ColumnFilter({
  label,
  options,
  value,
  defaultValue,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="col-filter" ref={rootRef}>
      <button
        type="button"
        className={`col-filter-button ${value !== defaultValue ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filter by ${label}`}
        title={`Filter by ${label}`}
      >
        ▾
      </button>
      {open && (
        <div className="col-filter-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`col-filter-option ${o.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * The trade's current price: sum of each leg's ratio x its live price — the
 * same composite convention used for entry prices (Structure Avg Entry Price)
 * and QuantHub structure quotes. Undefined if any leg has no live price yet.
 */
function livePrice(s: StructureSnapshot): number | undefined {
  if (s.legs.length === 0 || s.legs.some((l) => l.current_price === undefined)) return undefined;
  return s.legs.reduce((sum, l) => sum + l.leg.ratio * (l.current_price as number), 0);
}

/** The most recent entry (opening or adding to a position) on this trade; a trade never entered counts from the day it was created. */
function latestEntryTime(s: StructureSnapshot): number {
  return Math.max(...activityDates(s).map((d) => new Date(d).getTime()));
}

export function StructureList({
  snapshots,
  onSelect,
  onNewStructure,
  onChanged,
}: {
  snapshots: StructureSnapshot[];
  onSelect: (id: string) => void;
  onNewStructure: () => void;
  onChanged: () => void;
}) {
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [cloneError, setCloneError] = useState("");
  async function handleClone(id: string) {
    setCloneError("");
    setCloningId(id);
    try {
      await StructureEngine.cloneStructure(id);
      onChanged();
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : "Failed to clone trade");
    } finally {
      setCloningId(null);
    }
  }
  const [filters, setFiltersState] = useState<Filters>(loadFilters);
  function setFilters(patch: Partial<Filters>) {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  // Calendar months in which anything was opened/added, newest first — the
  // "pick September" choices. Includes the selected month even if it has no
  // activity anymore, so the select never shows a blank.
  const monthOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const s of snapshots) for (const d of activityDates(s)) keys.add(monthKey(d));
    if (/^\d{4}-\d{2}$/.test(filters.period)) keys.add(filters.period);
    return Array.from(keys).sort().reverse();
  }, [snapshots, filters.period]);

  const typeOptions = useMemo(
    () => Array.from(new Set(snapshots.map((s) => s.structure.structure_type))).sort((a, b) => a.localeCompare(b)),
    [snapshots]
  );

  const visible = useMemo(() => {
    const now = new Date();
    const needle = filters.search.trim().toLowerCase();
    return snapshots
      .filter((s) => {
        const closed = s.structure.status === "Fully Closed";
        if (filters.status === "open" && closed) return false;
        if (filters.status === "closed" && !closed) return false;
        if (filters.type && s.structure.structure_type !== filters.type) return false;
        if (needle && !`${s.structure.name} ${s.structure.structure_type}`.toLowerCase().includes(needle)) return false;
        return matchesPeriod(s, filters.period, now);
      })
      // Newest entry first — whatever you traded or added to most recently is at the top.
      .sort((a, b) => latestEntryTime(b) - latestEntryTime(a));
  }, [snapshots, filters]);

  const filtersActive =
    filters.search !== "" || filters.period !== "all" || filters.status !== "all" || filters.type !== "";

  // Totals over exactly the trades on screen. Net P&L = realized AFTER transaction
  // costs + unrealized — the same definition as a trade's own Net P&L card.
  const totals = useMemo(() => {
    const realizedNet = visible.reduce((sum, s) => sum + s.net_realized_pnl, 0);
    const unrealized = visible.reduce((sum, s) => sum + s.total_unrealized_pnl, 0);
    return { realizedNet, unrealized, net: realizedNet + unrealized };
  }, [visible]);

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <div className="list-header-left">
            <h2>Trades</h2>
            <div className="search-box">
              <IconSearch size={14} />
              <input
                type="search"
                value={filters.search}
                onChange={(e) => setFilters({ search: e.target.value })}
                placeholder="Search trades…"
                aria-label="Search trades"
              />
            </div>
            {filtersActive && (
              <div
                style={{ display: "flex", alignItems: "baseline", gap: 8, whiteSpace: "nowrap" }}
                title={`Realized after TC ${fmtMoney(totals.realizedNet)} + unrealized ${fmtMoney(totals.unrealized)}`}
              >
                <span className="stat-label" style={{ margin: 0 }}>
                  Net P&amp;L
                  <InfoTip>
                    Total for the {visible.length} trade{visible.length === 1 ? "" : "s"} shown: realized P&amp;L after transaction
                    costs ({fmtMoney(totals.realizedNet)}) plus unrealized P&amp;L ({fmtMoney(totals.unrealized)}). It adds up each
                    trade's whole result, not only the part earned inside the chosen period.
                  </InfoTip>
                </span>
                <strong className={pnlClass(totals.net)}>{fmtMoney(totals.net)}</strong>
              </div>
            )}
          </div>
          <div className="list-header-right">
            <select
              value={filters.period}
              onChange={(e) => setFilters({ period: e.target.value })}
              aria-label="Time period"
              title="Show trades where you opened a position or added to one in this period"
            >
              <option value="all">All time</option>
              <option value="last3">Last 3 months</option>
              <option value="last6">Last 6 months</option>
              <option value="last12">Last 12 months</option>
              {monthOptions.length > 0 && <option disabled>──────────</option>}
              {monthOptions.map((key) => (
                <option key={key} value={key}>
                  {monthLabel(key)}
                </option>
              ))}
            </select>
            <button onClick={onNewStructure}>+ New Trade</button>
          </div>
        </div>

        {cloneError && <p className="helper-text" style={{ color: "var(--red)" }}>{cloneError}</p>}
        {filtersActive && (
          <p className="helper-text" style={{ margin: "8px 0 0" }}>
            Showing {visible.length} of {snapshots.length} trades ·{" "}
            <a href="#clear" onClick={(e) => { e.preventDefault(); setFilters(DEFAULT_FILTERS); }}>
              Clear filters
            </a>
          </p>
        )}

        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>
                Type
                <ColumnFilter
                  label="type"
                  value={filters.type}
                  defaultValue=""
                  onChange={(type) => setFilters({ type })}
                  options={[{ value: "", label: "All types" }, ...typeOptions.map((t) => ({ value: t, label: t }))]}
                />
              </th>
              <th>
                Status
                <ColumnFilter
                  label="status"
                  value={filters.status}
                  defaultValue="all"
                  onChange={(status) => setFilters({ status: status as StatusFilter })}
                  options={[
                    { value: "all", label: "All" },
                    { value: "open", label: "Open" },
                    { value: "closed", label: "Closed" },
                  ]}
                />
              </th>
              <th>Realized (Gross)</th>
              <th>Realized (Net of TC)</th>
              <th>Unrealized</th>
              <th>Total P&L</th>
              <th>
                Active Risk
                <InfoTip align="right">
                  The risk you allocated to entries that still have open lots. An entry that is fully exited no longer counts.
                  Same figure as "Active Risk" on the trade page.
                </InfoTip>
              </th>
              <th>
                Live Price
                <InfoTip align="right">
                  The trade's price right now: each leg's live price times its ratio, added up (e.g. a Fly = Mar − 2 × Apr + May).
                  Same convention as the entry prices on the trade page. Shows — until every leg has a live price.
                </InfoTip>
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.structure.id} className="clickable" onClick={() => onSelect(s.structure.id)}>
                <td>{s.structure.name}</td>
                <td>{s.structure.structure_type}</td>
                <td>
                  <span className={`badge ${statusBadgeClass(s.structure.status)}`}>{statusLabel(s.structure.status)}</span>
                  {s.structure.status !== "Fully Closed" &&
                    (s.open_entry_count > 0 ? (
                      <span
                        className="muted"
                        style={{ marginLeft: 6 }}
                        title={`${s.open_entry_count} entr${s.open_entry_count === 1 ? "y" : "ies"} with open lots`}
                      >
                        {s.open_entry_count} open
                      </span>
                    ) : (
                      <span className="muted" style={{ marginLeft: 6 }} title="No open lots — press Close Trade when you are done">
                        flat
                      </span>
                    ))}
                </td>
                <td className={pnlClass(s.total_realized_pnl)}>{fmtMoney(s.total_realized_pnl)}</td>
                <td className={pnlClass(s.net_realized_pnl)}>{fmtMoney(s.net_realized_pnl)}</td>
                <td className={pnlClass(s.total_unrealized_pnl)}>{fmtMoney(s.total_unrealized_pnl)}</td>
                <td className={pnlClass(s.total_pnl)}>{fmtMoney(s.total_pnl)}</td>
                <td>{fmtMoney(s.active_risk)}</td>
                <td>{livePrice(s) !== undefined ? fmtPrice(livePrice(s)) : "—"}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="secondary"
                    style={{ marginBottom: 0, padding: "4px 10px" }}
                    onClick={() => handleClone(s.structure.id)}
                    disabled={cloningId !== null}
                    title="Clone this trade: a new empty trade with the same legs and risk, named Name-II, Name-III, Name-IV…"
                    aria-label={`Clone ${s.structure.name}`}
                  >
                    {cloningId === s.structure.id ? "Cloning…" : "Clone"}
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  {snapshots.length === 0
                    ? "No trades yet — click + New Trade above."
                    : "No trades match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
