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
  SettlementPrice,
  AppSettings,
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

  /**
   * PostgREST (Supabase's REST layer) caps a single response at 1000 rows
   * by default — a query with no `.range()` silently gets ONLY the first
   * 1000 rows, not an error. Every "get every row in this table" query used
   * to fit under that easily; `settlement_prices` didn't once its history
   * started covering every configured instrument (not just ones actually
   * traded — see correlationContext.ts), and the resulting silent
   * truncation broke correlation for structures whose settlement rows
   * happened to fall past row 1000. This pages through with `.range()`
   * until a page comes back short, so it can never happen again — here or
   * for any other table that grows past 1000 rows over time.
   */
  private async fetchAllPages<T>(
    // Supabase's query builder is thenable (awaitable) but not a real
    // Promise instance — PromiseLike accepts that without requiring
    // catch/finally/Symbol.toStringTag.
    pageFetch: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
  ): Promise<T[]> {
    const PAGE_SIZE = 1000;
    const all: T[] = [];
    let from = 0;
    for (;;) {
      const { data, error } = await pageFetch(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return all;
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
    return this.fetchAllPages<Contract>((from, to) => this.db().from("contracts").select("*").range(from, to));
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
    return this.fetchAllPages<Structure>((from, to) => this.db().from("structures").select("*").range(from, to));
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
  async deleteStructure(id: UUID) {
    // Schema has ON DELETE CASCADE from structure_legs/realized_pnl_events/
    // risk_allocations/stop_loss_history to structures(id), and from
    // executions/positions to structure_legs(id) — one delete here removes
    // every dependent row. audit_events.structure_id is ON DELETE SET NULL,
    // so the audit trail survives.
    const { error } = await this.db().from("structures").delete().eq("id", id);
    if (error) throw error;
  }

  // Structure Legs
  async getLegsByStructure(structureId: UUID) {
    const { data, error } = await this.db().from("structure_legs").select("*").eq("structure_id", structureId);
    if (error) throw error;
    return (data ?? []) as StructureLeg[];
  }
  async getAllLegs() {
    return this.fetchAllPages<StructureLeg>((from, to) => this.db().from("structure_legs").select("*").range(from, to));
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
    return this.fetchAllPages<Execution>((from, to) => this.db().from("executions").select("*").range(from, to));
  }
  async addExecution(execution: Execution) {
    const { error } = await this.db().from("executions").upsert(execution, { onConflict: "id" });
    if (error) throw error;
  }

  // Positions (keyed by structure_leg_id, not id)
  async getPositions() {
    return this.fetchAllPages<Position>((from, to) => this.db().from("positions").select("*").range(from, to));
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
    return this.fetchAllPages<MarketPrice>((from, to) => this.db().from("market_prices").select("*").range(from, to));
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
    return this.fetchAllPages<RealizedPnLEvent>((from, to) => this.db().from("realized_pnl_events").select("*").range(from, to));
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
    return this.fetchAllPages<RiskAllocation>((from, to) => this.db().from("risk_allocations").select("*").range(from, to));
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
    return this.fetchAllPages<AuditEvent>((from, to) =>
      this.db().from("audit_events").select("*").order("timestamp", { ascending: false }).range(from, to)
    );
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

  // Settlement Prices
  async getSettlementPricesByContracts(contractIds: UUID[]) {
    if (contractIds.length === 0) return [];
    return this.fetchAllPages<SettlementPrice>((from, to) =>
      this.db().from("settlement_prices").select("*").in("contract_id", contractIds).range(from, to)
    );
  }
  async upsertSettlementPrice(record: SettlementPrice) {
    const { error } = await this.db().from("settlement_prices").upsert(record, { onConflict: "id" });
    if (error) throw error;
  }
  async upsertSettlementPrices(records: SettlementPrice[]) {
    if (records.length === 0) return;
    const { error } = await this.db().from("settlement_prices").upsert(records, { onConflict: "id" });
    if (error) throw error;
  }
  async deleteSettlementPricesBefore(date: string) {
    const { error } = await this.db().from("settlement_prices").delete().lt("date", date);
    if (error) throw error;
  }

  // App Settings
  async getAppSettings() {
    const { data, error } = await this.db().from("app_settings").select("*").eq("id", "default").maybeSingle();
    if (error) throw error;
    return (data ?? undefined) as AppSettings | undefined;
  }
  async upsertAppSettings(settings: AppSettings) {
    const { error } = await this.db().from("app_settings").upsert(settings, { onConflict: "id" });
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
    "settlement_prices",
    "app_settings",
  ] as const;

  async exportAll() {
    const result: Record<string, unknown> = {};
    for (const table of this.TABLES) {
      result[table] = await this.fetchAllPages<unknown>((from, to) => this.db().from(table).select("*").range(from, to));
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
      settlement_prices: "id",
      app_settings: "id",
    };
    for (const table of this.TABLES) {
      const pk = pkByTable[table];
      const { error } = await this.db().from(table).delete().not(pk, "is", null);
      if (error) throw error;
    }
  }
}
