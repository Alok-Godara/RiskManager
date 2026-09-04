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
  | "PositionIncreased"
  | "PositionReduced"
  | "SpreadClosed"
  | "LegClosed"
  | "StructureModified"
  | "StopLossModified"
  | "RiskModified"
  | "RealizedProfitBooked"
  | "FinalExit"
  | "PriceUpdated";

// ---------------------------------------------------------------------------
// Instrument: e.g. Brent (BZ), WTI (CL), WBS
// ---------------------------------------------------------------------------
export interface Instrument {
  id: UUID;
  symbol: string; // e.g. "BZ", "CL", "WBS"
  name: string; // e.g. "Brent Crude"
  tick_size: number;
  tick_value: number; // $ value per tick per lot
  lot_size: number; // barrels/units per lot
  currency: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Contract: a specific delivery month of an instrument, e.g. Brent Jan26
// ---------------------------------------------------------------------------
export interface Contract {
  id: UUID;
  instrument_id: UUID;
  code: string; // e.g. "BZ-JAN26"
  month_label: string; // e.g. "Jan26"
  expiry_date?: string;
  market_data_symbol?: string; // symbol used to query the Market Data Service
  created_at: string;
}

// ---------------------------------------------------------------------------
// Structure: the central risk-management unit (outright, spread, fly, etc.)
// ---------------------------------------------------------------------------
export type StructureType = "Outright" | "Spread" | "Fly" | "Custom";

export interface Structure {
  id: UUID;
  instrument_id: UUID;
  name: string; // e.g. "Jan-Feb-Mar Fly"
  structure_type: StructureType;
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
  contract_id: UUID;
  ratio: number; // signed weight relative to 1 structure unit, e.g. +1, -2, +1
  side: LegSide; // derived convenience field for the leg's net side at ratio>0 baseline
  is_active: boolean; // false once fully exited but retained for history
  created_at: string;
}

// ---------------------------------------------------------------------------
// Execution: an individual entry or exit against a leg
// The complete, immutable audit trail of fills.
// ---------------------------------------------------------------------------
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
