import { supabase } from "./supabase/client";
import type { DataRepository } from "./DataRepository";
import type {
  Instrument,
  Contract,
  Structure,
  StructureLeg,
  StructureTemplate,
  Execution,
  Position,
  MarketPrice,
  RealizedPnLEvent,
  RiskAllocation,
  StopLossRecord,
  AuditEvent,
  ApiConfig,
  UUID,
} from "../types/domain";

/**
 * SupabaseRepository: cloud-backed implementation of DataRepository.
 *
 * This is the "single swap point" the rest of the app was built around
 * (see data/index.ts) — every domain type already uses snake_case fields
 * that mirror the Postgres schema in `supabase/schema.sql` 1:1, so no field
 * mapping layer is needed. Engines, hooks and UI components are completely
 * unaware this exists; they only ever talk to the `DataRepository` interface.
 */
export class SupabaseRepository implements DataRepository {
  private db() {
    if (!supabase) throw new Error("Supabase is not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
    return supabase;
  }

  // Instruments
  async getInstruments() {
    const { data, error } = await this.db().from("instruments").select("*").order("name");
    if (error) throw error;
    return (data ?? []) as Instrument[];
  }
  async getInstrument(id: UUID) {
    const { data, error } = await this.db().from("instruments").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as Instrument | undefined;
  }
  async upsertInstrument(instrument: Instrument) {
    const { error } = await this.db().from("instruments").upsert(instrument, { onConflict: "id" });
    if (error) throw error;
  }
  async deleteInstrument(id: UUID) {
    const { error } = await this.db().from("instruments").delete().eq("id", id);
    if (error) {
      // Postgres FK "on delete restrict" rejects this if any structure still
      // references the instrument — surface a friendly message either way.
      if (error.code === "23503") {
        throw new Error("Cannot delete: this instrument is used by one or more structures. Deactivate it instead.");
      }
      throw error;
    }
  }

  // Contracts
  async getContracts() {
    const { data, error } = await this.db().from("contracts").select("*");
    if (error) throw error;
    return (data ?? []) as Contract[];
  }
  async getContractsByInstrument(instrumentId: UUID) {
    const { data, error } = await this.db().from("contracts").select("*").eq("instrument_id", instrumentId);
    if (error) throw error;
    return (data ?? []) as Contract[];
  }
  async getContract(id: UUID) {
    const { data, error } = await this.db().from("contracts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as Contract | undefined;
  }
  async upsertContract(contract: Contract) {
    const { error } = await this.db().from("contracts").upsert(contract, { onConflict: "id" });
    if (error) throw error;
  }

  // Structure Templates
  async getStructureTemplates() {
    const { data, error } = await this.db().from("structure_templates").select("*");
    if (error) throw error;
    return (data ?? []) as StructureTemplate[];
  }
  async getStructureTemplate(id: UUID) {
    const { data, error } = await this.db().from("structure_templates").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as StructureTemplate | undefined;
  }
  async upsertStructureTemplate(template: StructureTemplate) {
    const { error } = await this.db().from("structure_templates").upsert(template, { onConflict: "id" });
    if (error) throw error;
  }
  async deleteStructureTemplate(id: UUID) {
    const { error } = await this.db().from("structure_templates").delete().eq("id", id);
    if (error) throw error;
  }

  // Structures
  async getStructures() {
    const { data, error } = await this.db().from("structures").select("*");
    if (error) throw error;
    return (data ?? []) as Structure[];
  }
  async getStructure(id: UUID) {
    const { data, error } = await this.db().from("structures").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as Structure | undefined;
  }
  async upsertStructure(structure: Structure) {
    const { error } = await this.db().from("structures").upsert(structure, { onConflict: "id" });
    if (error) throw error;
  }

  // Structure Legs
  async getLegsByStructure(structureId: UUID) {
    const { data, error } = await this.db().from("structure_legs").select("*").eq("structure_id", structureId);
    if (error) throw error;
    return (data ?? []) as StructureLeg[];
  }
  async getAllLegs() {
    const { data, error } = await this.db().from("structure_legs").select("*");
    if (error) throw error;
    return (data ?? []) as StructureLeg[];
  }
  async getLeg(id: UUID) {
    const { data, error } = await this.db().from("structure_legs").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as StructureLeg | undefined;
  }
  async upsertLeg(leg: StructureLeg) {
    const { error } = await this.db().from("structure_legs").upsert(leg, { onConflict: "id" });
    if (error) throw error;
  }

  // Executions (upsert-by-id — used both to add new rows and to flip an
  // existing row's `status` when it's edited/deleted)
  async getExecutionsByLeg(legId: UUID) {
    const { data, error } = await this.db()
      .from("executions")
      .select("*")
      .eq("structure_leg_id", legId)
      .order("timestamp", { ascending: true });
    if (error) throw error;
    return (data ?? []) as Execution[];
  }
  async getAllExecutions() {
    const { data, error } = await this.db().from("executions").select("*");
    if (error) throw error;
    return (data ?? []) as Execution[];
  }
  async addExecution(execution: Execution) {
    const { error } = await this.db().from("executions").upsert(execution, { onConflict: "id" });
    if (error) throw error;
  }

  // Positions (keyed by structure_leg_id, not id)
  async getPositions() {
    const { data, error } = await this.db().from("positions").select("*");
    if (error) throw error;
    return (data ?? []) as Position[];
  }
  async getPositionByLeg(legId: UUID) {
    const { data, error } = await this.db().from("positions").select("*").eq("structure_leg_id", legId).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as Position | undefined;
  }
  async upsertPosition(position: Position) {
    const { error } = await this.db().from("positions").upsert(position, { onConflict: "structure_leg_id" });
    if (error) throw error;
  }

  // Market Prices (keyed by contract_id)
  async getMarketPrices() {
    const { data, error } = await this.db().from("market_prices").select("*");
    if (error) throw error;
    return (data ?? []) as MarketPrice[];
  }
  async getMarketPrice(contractId: UUID) {
    const { data, error } = await this.db().from("market_prices").select("*").eq("contract_id", contractId).maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as MarketPrice | undefined;
  }
  async upsertMarketPrice(price: MarketPrice) {
    const { error } = await this.db().from("market_prices").upsert(price, { onConflict: "contract_id" });
    if (error) throw error;
  }

  // Realized P&L Events
  async getRealizedPnLEvents() {
    const { data, error } = await this.db().from("realized_pnl_events").select("*");
    if (error) throw error;
    return (data ?? []) as RealizedPnLEvent[];
  }
  async getRealizedPnLEventsByLeg(legId: UUID) {
    const { data, error } = await this.db().from("realized_pnl_events").select("*").eq("structure_leg_id", legId);
    if (error) throw error;
    return (data ?? []) as RealizedPnLEvent[];
  }
  async addRealizedPnLEvent(event: RealizedPnLEvent) {
    const { error } = await this.db().from("realized_pnl_events").upsert(event, { onConflict: "id" });
    if (error) throw error;
  }
  async deleteRealizedPnLEventsByLeg(legId: UUID) {
    const { error } = await this.db().from("realized_pnl_events").delete().eq("structure_leg_id", legId);
    if (error) throw error;
  }

  // Risk Allocations
  async getRiskAllocations() {
    const { data, error } = await this.db().from("risk_allocations").select("*");
    if (error) throw error;
    return (data ?? []) as RiskAllocation[];
  }
  async getRiskAllocationsByStructure(structureId: UUID) {
    const { data, error } = await this.db().from("risk_allocations").select("*").eq("structure_id", structureId);
    if (error) throw error;
    return (data ?? []) as RiskAllocation[];
  }
  async addRiskAllocation(allocation: RiskAllocation) {
    const { error } = await this.db().from("risk_allocations").upsert(allocation, { onConflict: "id" });
    if (error) throw error;
  }
  async deleteRiskAllocationsByExecution(executionId: UUID) {
    const { error } = await this.db().from("risk_allocations").delete().eq("execution_id", executionId);
    if (error) throw error;
  }

  // Stop Loss History
  async getStopLossHistory(structureId: UUID) {
    const { data, error } = await this.db()
      .from("stop_loss_history")
      .select("*")
      .eq("structure_id", structureId)
      .order("timestamp", { ascending: true });
    if (error) throw error;
    return (data ?? []) as StopLossRecord[];
  }
  async addStopLossRecord(record: StopLossRecord) {
    const { error } = await this.db().from("stop_loss_history").upsert(record, { onConflict: "id" });
    if (error) throw error;
  }

  // Audit Log
  async getAuditEvents() {
    const { data, error } = await this.db().from("audit_events").select("*").order("timestamp", { ascending: false });
    if (error) throw error;
    return (data ?? []) as AuditEvent[];
  }
  async addAuditEvent(event: AuditEvent) {
    const { error } = await this.db().from("audit_events").upsert(event, { onConflict: "id" });
    if (error) throw error;
  }

  // API Config
  async getApiConfigs() {
    const { data, error } = await this.db().from("api_configs").select("*");
    if (error) throw error;
    return (data ?? []) as ApiConfig[];
  }
  async upsertApiConfig(config: ApiConfig) {
    const { error } = await this.db().from("api_configs").upsert(config, { onConflict: "id" });
    if (error) throw error;
  }

  // Bulk
  private readonly TABLES = [
    "instruments",
    "contracts",
    "structure_templates",
    "structures",
    "structure_legs",
    "executions",
    "positions",
    "market_prices",
    "realized_pnl_events",
    "risk_allocations",
    "stop_loss_history",
    "audit_events",
    "api_configs",
  ] as const;

  async exportAll() {
    const result: Record<string, unknown> = {};
    for (const table of this.TABLES) {
      const { data, error } = await this.db().from(table).select("*");
      if (error) throw error;
      result[table] = data ?? [];
    }
    return result;
  }

  async clearAll() {
    const pkByTable: Record<(typeof this.TABLES)[number], string> = {
      instruments: "id",
      contracts: "id",
      structure_templates: "id",
      structures: "id",
      structure_legs: "id",
      executions: "id",
      positions: "structure_leg_id",
      market_prices: "contract_id",
      realized_pnl_events: "id",
      risk_allocations: "id",
      stop_loss_history: "id",
      audit_events: "id",
      api_configs: "id",
    };
    for (const table of this.TABLES) {
      const pk = pkByTable[table];
      const { error } = await this.db().from(table).delete().not(pk, "is", null);
      if (error) throw error;
    }
  }
}
