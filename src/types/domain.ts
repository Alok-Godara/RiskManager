// ============================================================================
// DOMAIN TYPES
// These mirror the eventual relational (Supabase/Postgres) schema.
// Every entity has a stable `id` (uuid) and `created_at` so records can be
// moved to a real relational DB later without redesign.
// ============================================================================

export type UUID = string;

export type StructureStatus = "Open" | "Partially Closed" | "Modified" | "Fully Closed";

export type LegSide = "Long" | "Short";

export type ExecutionType =
  | "Entry"
  | "PartialExit"
  | "LegExit"
  | "FinalExit";

export type AuditEventType =
  | "StructureCreated"
  | "EntryAdded"
  | "EntryEdited"
  | "EntryDeleted"
  | "PositionIncreased"
  | "PositionReduced"
  | "SpreadClosed"
  | "LegClosed"
  | "StructureModified"
  | "StructureDeleted"
  | "StopLossModified"
  | "RiskModified"
  | "RealizedProfitBooked"
  | "FinalExit"
  | "PriceUpdated"
  | "InstrumentCreated"
  | "InstrumentUpdated"
  | "StructureTemplateCreated"
  | "StructureTemplateUpdated"
  | "StructureTemplateDeleted";

// ---------------------------------------------------------------------------
// Instrument: e.g. Brent (BZ), WTI (CL), WBS
// ---------------------------------------------------------------------------
export interface Instrument {
  id: UUID;
  symbol: string; // e.g. "BZ", "CL", "WBS"
  name: string; // e.g. "Brent Crude"
  exchange_code?: string; // exchange/API symbol if different from `symbol`
  // The settlement/refdata API's product symbol for this instrument, if it
  // doesn't match `symbol` — e.g. HGProductKey "ICE:BRN" -> "BRN" (see
  // services/settlementData/client.ts). Defaults to `symbol` when unset,
  // same pattern as `exchange_code` for QuantHub.
  refdata_symbol?: string;
  tick_size: number;
  tick_value: number; // $ value per tick per lot
  lot_size: number; // barrels/units per lot
  currency: string;
  is_active: boolean; // only active instruments appear in structure creation
  notes?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Contract: a priceable, quotable product for an instrument. Two kinds:
//   - "Outright" (default/undefined for back-compat): a single delivery
//     month, e.g. Brent Jan26.
//   - "Structure": a multi-month spread/fly product that the exchange
//     quotes directly as one thing (e.g. "Jan26 Fly"), auto-created the
//     first time a structure trades it. `quote_template_id` + `anchor_
//     contract_id` record what it represents (which template shape,
//     anchored where) so its outright decomposition can still be computed
//     on demand for the true contract-exposure view — but pricing/P&L for
//     the structure itself uses THIS contract's own live quote directly,
//     never synthesized from outright legs (spec V4: track the trade at
//     the actual base structure used for execution).
// ---------------------------------------------------------------------------
export type ContractKind = "Outright" | "Structure";

export interface Contract {
  id: UUID;
  instrument_id: UUID;
  code: string; // e.g. "BZ-JAN26"
  month_label: string; // display label, e.g. "Jan26" or "Jan26 Fly"
  expiry_date?: string; // Outright: reference date. Structure: its anchor's reference date.
  market_data_symbol?: string; // symbol used to query the Market Data Service
  created_at: string;
  kind?: ContractKind; // undefined = "Outright"
  quote_template_id?: UUID; // Structure only: which template shape this quote represents
  anchor_contract_id?: UUID; // Structure only: the front/reference month it's anchored at
}

// ---------------------------------------------------------------------------
// StructureTemplate: a reusable, user-defined recipe — the FIXED, fully
// expanded signed outright ratio pattern for a structure shape (e.g. Fly =
// +1 / -2 / +1, Double Fly = +1 / -3 / +3 / -1). Templates are the ONLY way
// structure "types" are defined now — nothing is hard-coded (spec V2
// section 5).
//
// How a structure is actually CONSTRUCTED/TRADED (as raw outrights, as
// spreads, as flies, ...) is a separate, per-trade choice made at
// structure-creation time (the "Base Structure"), NOT baked into the
// template — see engines/StructureQuoteEngine.ts and utils/decompose.ts,
// which deconvolve this pattern into shifted copies of whatever base
// structure's own pattern was chosen (spec V5).
// ---------------------------------------------------------------------------
export interface StructureTemplateLeg {
  label: string; // placeholder shown before a contract is picked, e.g. "Month 1"
  ratio: number; // signed: +1 = long 1 unit, -2 = short 2 units
  month_offset: number; // months forward from the structure's single anchor contract
}

export interface StructureTemplate {
  id: UUID;
  name: string; // e.g. "Fly", "Calendar Spread", "Outright", "Double Fly"
  code?: string; // short code, optional
  legs: StructureTemplateLeg[];
  is_active: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Structure: the central risk-management unit (outright, spread, fly, etc.)
// `structure_type` is free text (usually the template name at creation time)
// since types are now user-defined via StructureTemplate, not hard-coded.
// ---------------------------------------------------------------------------
export interface Structure {
  id: UUID;
  instrument_id: UUID;
  structure_template_id?: UUID; // undefined for ad-hoc/custom structures
  name: string; // e.g. "Jan-Feb-Mar Fly"
  structure_type: string;
  status: StructureStatus;
  initial_dollar_risk: number;
  current_dollar_risk: number; // adjusted for booked profit
  initial_stop_loss?: number; // $ level
  current_stop_loss?: number;
  notes?: string;
  created_at: string;
  closed_at?: string;
}

// ---------------------------------------------------------------------------
// StructureLeg: a contract-level component of a structure
// e.g. Fly = Leg(Jan, +1) + Leg(Feb, -2) + Leg(Mar, +1)
// ---------------------------------------------------------------------------
export interface StructureLeg {
  id: UUID;
  structure_id: UUID;
  // The tradeable unit this leg represents, at whatever level it was
  // actually traded — an outright month OR a structure-level quote (e.g.
  // "Jan26 Fly"). See Contract.kind. Never further decomposed for
  // pricing/P&L; ratio is relative to 1 structure lot of the top-level
  // structure.
  contract_id: UUID;
  ratio: number; // signed weight relative to 1 structure unit, e.g. +1, -2, +1
  side: LegSide; // derived convenience field for the leg's net side at ratio>0 baseline
  is_active: boolean; // false once fully exited but retained for history
  created_at: string;
}

// ---------------------------------------------------------------------------
// Execution: an individual entry or exit against a leg.
//
// Executions are never destructively edited or deleted — rows are only ever
// added or soft-transitioned via `status` (spec V2 section 9: "Original
// Entry -> Edited Entry", never silent deletion). `getExecutionsByLeg`
// returns the full history for audit display; engines filter to
// `status === "Active"` when recomputing positions/P&L.
// ---------------------------------------------------------------------------
export type ExecutionStatus = "Active" | "Edited" | "Deleted";

export interface Execution {
  id: UUID;
  structure_leg_id: UUID;
  execution_type: ExecutionType;
  side: LegSide; // Long = bought, Short = sold
  quantity: number; // lots, always positive
  price: number;
  risk_allocated?: number; // $ risk assigned to this specific entry (see spec section 10)
  max_adverse_ticks?: number;
  timestamp: string;
  notes?: string;
  // Ties together every leg's Execution created by ONE Add Entry / Exit
  // submission (one row per leg, same id shared across the batch), so the
  // UI can display "one entry" instead of N per-leg rows — see
  // engines/EntryEngine.ts. An edit's replacement row always carries the
  // original's entry_group_id forward.
  entry_group_id: UUID;
  // Set ONLY on an exit-type execution: which entry (its entry_group_id)
  // this exit is closing. Exits are entry-scoped, not FIFO across a leg's
  // whole history — see engines/PositionEngine.ts. Undefined for Entry-type
  // executions.
  closes_entry_group_id?: UUID;

  status: ExecutionStatus;
  edited_from_execution_id?: UUID; // set on the replacement row
  edited_to_execution_id?: UUID; // set on the original row once superseded
  edit_reason?: string;
}

// ---------------------------------------------------------------------------
// Position: derived/materialized current state of a leg (computed by
// PositionEngine, persisted for fast reads — not the source of truth,
// Executions are the source of truth).
// ---------------------------------------------------------------------------
export interface Position {
  structure_leg_id: UUID;
  contract_id: UUID;
  net_quantity: number; // signed: + long, - short
  average_price: number;
  realized_pnl: number;
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Market Price: latest known price for a contract
// ---------------------------------------------------------------------------
export interface MarketPrice {
  contract_id: UUID;
  price: number;
  bid?: number;
  ask?: number;
  source: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Realized P&L Event: permanent record, never overwritten
// ---------------------------------------------------------------------------
export interface RealizedPnLEvent {
  id: UUID;
  structure_id: UUID;
  structure_leg_id: UUID;
  execution_id: UUID;
  quantity: number;
  entry_price: number;
  exit_price: number;
  realized_pnl: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Risk Allocation: structure-level or entry-level risk assignment history
// ---------------------------------------------------------------------------
export interface RiskAllocation {
  id: UUID;
  structure_id: UUID;
  execution_id?: UUID; // present for entry-level allocation
  dollar_risk: number;
  reason?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Stop Loss History
// ---------------------------------------------------------------------------
export interface StopLossRecord {
  id: UUID;
  structure_id: UUID;
  stop_loss_price_equivalent?: number;
  dollar_risk_basis: number;
  reason: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Audit Event: append-only log of everything that happens
// ---------------------------------------------------------------------------
export interface AuditEvent {
  id: UUID;
  event_type: AuditEventType;
  structure_id?: UUID;
  structure_leg_id?: UUID;
  execution_id?: UUID;
  description: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// API Configuration (for the Market Data Service)
// ---------------------------------------------------------------------------
export interface ApiConfig {
  id: UUID;
  provider_name: string;
  base_url?: string;
  api_key?: string; // stored locally only, never sent anywhere but the provider
  poll_interval_ms: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Settlement Price: one instrument's official daily close for one outright
// contract, from the reference-data settlement feed (see
// services/settlementData/) — the historical series correlation analysis is
// built from. `id` is deterministic (`${contract_id}::${date}`), not a
// random UUID, so re-fetching an already-stored date upserts in place
// instead of duplicating (see settlementHistoryService.ts).
// ---------------------------------------------------------------------------
export interface SettlementPrice {
  id: UUID;
  contract_id: UUID;
  date: string; // "YYYY-MM-DD", the settlement's own trading date
  price: number;
  source: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// App Settings: a single persisted row (id "default") for small,
// cross-device user preferences that don't belong on any one entity — today
// just the correlation/concentration warning thresholds (Structures ->
// Portfolio Correlation & Concentration). Repository-backed like everything
// else here (not localStorage), so it stays in sync across devices the same
// way the rest of the app's data does.
// ---------------------------------------------------------------------------
export interface AppSettings {
  id: UUID; // always "default"
  correlation_warning_threshold: number; // 0..1 — pairwise |correlation| that triggers a warning
  concentration_risk_threshold: number; // 0..1 — risk-weighted same-direction fraction that triggers a warning
  // Trading-day lookback per label, e.g. { 5: 5, 15: 15, 30: 30 } by default
  // — how far back settlement history is fetched/considered for that column.
  correlation_periods: Record<CorrelationWindow, number>;
  // Sub-window size per label used for the ROLLING correlation trend within
  // its period (see engines/CorrelationEngine.ts rollingCorrelationTrend) —
  // e.g. period=30/window=7 computes a 7-day correlation, slid one day at a
  // time across the trailing 30 days, producing a trend rather than one
  // number. Clamped to <= that label's period.
  correlation_rolling_windows: Record<CorrelationWindow, number>;
}

// ---------------------------------------------------------------------------
// Computed / view-model types (not persisted, produced by engines)
// ---------------------------------------------------------------------------
export interface LegSnapshot {
  leg: StructureLeg;
  contract: Contract;
  position: Position;
  current_price?: number;
  unrealized_pnl: number;
  market_value: number;
}

export interface StructureSnapshot {
  structure: Structure;
  legs: LegSnapshot[];
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  remaining_risk_capacity: number;
}

// ---------------------------------------------------------------------------
// EntrySnapshot: one "Add Entry" submission, aggregated across every leg it
// touched (see engines/EntryEngine.ts) — the unit the Entries table in
// StructureDetail displays, instead of one row per leg per execution.
// ---------------------------------------------------------------------------
export interface EntrySnapshot {
  entry_group_id: UUID;
  structure_id: UUID;
  timestamp: string;
  structure_lots: number; // ORIGINAL size implied by qty = |ratio| * structure_lots on each leg
  side: LegSide; // this entry's own chosen direction — see StructureEngine.addEntry's `direction` input
  avg_price: number; // composite structure price for this entry: sum(ratio_i * price_i)
  risk_allocated: number;
  open_quantity: number; // structure lots still open (structure_lots minus whatever's been exited from THIS entry)
  closed_quantity: number; // structure lots exited from this entry specifically (entry-scoped, not FIFO — see PositionEngine)
  avg_exit_price?: number; // composite exit price, qty-weighted across this entry's own exits; undefined until closed_quantity > 0
  unrealized_pnl: number; // based on open_quantity only
  realized_pnl: number; // sum of RealizedPnLEvent rows from exits that closed this entry, in $ (see PositionEngine's tick-value conversion)
  // Composite price level (same sum(ratio_i * price_i) convention as avg_price)
  // at which this entry's loss would equal risk_allocated. Undefined if no
  // risk was allocated to this entry.
  stop_loss_price?: number;
  legs: { leg: StructureLeg; contract: Contract; execution: Execution }[];
}

export interface InstrumentNetPositionRow {
  contract_id: UUID;
  contract_label: string;
  long_lots: number;
  short_lots: number;
  net_lots: number;
}

export interface PortfolioSummary {
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  net_pnl: number;
  total_dollar_risk: number;
  risk_utilized: number;
  remaining_risk_capacity: number;
  open_structures: number;
  closed_structures: number;
}

// ---------------------------------------------------------------------------
// Correlation & Concentration (see engines/CorrelationEngine.ts) — built
// from settlement-price history, never live/intraday prices, since it's a
// day-over-day co-movement read, not a real-time one.
// ---------------------------------------------------------------------------
export const CORRELATION_WINDOWS = [5, 15, 30] as const;
export type CorrelationWindow = (typeof CORRELATION_WINDOWS)[number];

export interface WindowCorrelation {
  window: CorrelationWindow;
  correlation?: number; // -1..1, undefined if too few paired observations
  observations: number; // daily diffs actually used
}

export interface StructurePairCorrelation {
  structure_a_id: UUID;
  structure_a_name: string;
  structure_b_id: UUID;
  structure_b_name: string;
  windows: WindowCorrelation[];
}

export interface NewTradeCorrelationAnalysis {
  window: CorrelationWindow;
  perStructure: { structure_id: UUID; structure_name: string; correlation?: number; observations: number }[];
  // Risk-weighted average correlation vs the existing book at this window.
  portfolioCorrelation?: number;
  verdict: "Diversifying" | "Concentrating" | "Neutral" | "Insufficient data";
  warnings: string[];
}

export interface PortfolioConcentrationAnalysis {
  window: CorrelationWindow;
  pairs: StructurePairCorrelation[];
  highCorrelationPairs: StructurePairCorrelation[]; // subset of `pairs` over the warning threshold
  // Risk-weighted fraction of pairwise exposure that's mutually
  // reinforcing (positively correlated) rather than offsetting — see
  // CorrelationEngine.analyzePortfolioConcentration for the exact formula.
  sameDirectionRiskFraction?: number;
  isConcentrated: boolean;
  drivingPairs: StructurePairCorrelation[]; // top contributors to sameDirectionRiskFraction
  warnings: string[];
}
