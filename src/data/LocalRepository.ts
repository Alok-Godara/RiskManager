import type { DataRepository } from "./DataRepository";
import { getAll, getOne, putOne, deleteOne, deleteWhere, clearStore, STORES } from "./indexedDb";
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
 * LocalRepository: today's implementation of DataRepository, backed by
 * IndexedDB. This is the ONLY file that knows persistence is IndexedDB.
 * A future `SupabaseRepository` would implement the exact same
 * `DataRepository` interface, and the app would swap by changing one
 * line in `data/index.ts`.
 */
export class LocalRepository implements DataRepository {
  // Instruments
  async getInstruments() {
    return getAll<Instrument>("instruments");
  }
  async getInstrument(id: UUID) {
    return getOne<Instrument>("instruments", id);
  }
  async upsertInstrument(instrument: Instrument) {
    return putOne("instruments", instrument);
  }
  async deleteInstrument(id: UUID) {
    const structures = await getAll<Structure>("structures");
    if (structures.some((s) => s.instrument_id === id)) {
      throw new Error("Cannot delete: this instrument is used by one or more structures. Deactivate it instead.");
    }
    await deleteWhere<Contract>("contracts", (c) => c.instrument_id === id);
    await deleteOne("instruments", id);
  }

  // Contracts
  async getContracts() {
    return getAll<Contract>("contracts");
  }
  async getContractsByInstrument(instrumentId: UUID) {
    const all = await getAll<Contract>("contracts");
    return all.filter((c) => c.instrument_id === instrumentId);
  }
  async getContract(id: UUID) {
    return getOne<Contract>("contracts", id);
  }
  async upsertContract(contract: Contract) {
    return putOne("contracts", contract);
  }

  // Structure Templates
  async getStructureTemplates() {
    return getAll<StructureTemplate>("structure_templates");
  }
  async getStructureTemplate(id: UUID) {
    return getOne<StructureTemplate>("structure_templates", id);
  }
  async upsertStructureTemplate(template: StructureTemplate) {
    return putOne("structure_templates", template);
  }
  async deleteStructureTemplate(id: UUID) {
    return deleteOne("structure_templates", id);
  }

  // Structures
  async getStructures() {
    return getAll<Structure>("structures");
  }
  async getStructure(id: UUID) {
    return getOne<Structure>("structures", id);
  }
  async upsertStructure(structure: Structure) {
    return putOne("structures", structure);
  }

  // Legs
  async getLegsByStructure(structureId: UUID) {
    const all = await getAll<StructureLeg>("structure_legs");
    return all.filter((l) => l.structure_id === structureId);
  }
  async getAllLegs() {
    return getAll<StructureLeg>("structure_legs");
  }
  async getLeg(id: UUID) {
    return getOne<StructureLeg>("structure_legs", id);
  }
  async upsertLeg(leg: StructureLeg) {
    return putOne("structure_legs", leg);
  }

  // Executions
  async getExecutionsByLeg(legId: UUID) {
    const all = await getAll<Execution>("executions");
    return all
      .filter((e) => e.structure_leg_id === legId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  async getAllExecutions() {
    return getAll<Execution>("executions");
  }
  async addExecution(execution: Execution) {
    return putOne("executions", execution);
  }

  // Positions (keyed by structure_leg_id, not id)
  async getPositions() {
    return getAll<Position>("positions");
  }
  async getPositionByLeg(legId: UUID) {
    return getOne<Position>("positions", legId);
  }
  async upsertPosition(position: Position) {
    return putOne("positions", position, position.structure_leg_id);
  }

  // Market Prices (keyed by contract_id)
  async getMarketPrices() {
    return getAll<MarketPrice>("market_prices");
  }
  async getMarketPrice(contractId: UUID) {
    return getOne<MarketPrice>("market_prices", contractId);
  }
  async upsertMarketPrice(price: MarketPrice) {
    return putOne("market_prices", price, price.contract_id);
  }

  // Realized P&L Events
  async getRealizedPnLEvents() {
    return getAll<RealizedPnLEvent>("realized_pnl_events");
  }
  async getRealizedPnLEventsByLeg(legId: UUID) {
    const all = await getAll<RealizedPnLEvent>("realized_pnl_events");
    return all.filter((r) => r.structure_leg_id === legId);
  }
  async addRealizedPnLEvent(event: RealizedPnLEvent) {
    return putOne("realized_pnl_events", event);
  }
  async deleteRealizedPnLEventsByLeg(legId: UUID) {
    return deleteWhere<RealizedPnLEvent>("realized_pnl_events", (r) => r.structure_leg_id === legId);
  }

  // Risk Allocations
  async getRiskAllocations() {
    return getAll<RiskAllocation>("risk_allocations");
  }
  async getRiskAllocationsByStructure(structureId: UUID) {
    const all = await getAll<RiskAllocation>("risk_allocations");
    return all.filter((r) => r.structure_id === structureId);
  }
  async addRiskAllocation(allocation: RiskAllocation) {
    return putOne("risk_allocations", allocation);
  }
  async deleteRiskAllocationsByExecution(executionId: UUID) {
    return deleteWhere<RiskAllocation>("risk_allocations", (r) => r.execution_id === executionId);
  }

  // Stop Loss History
  async getStopLossHistory(structureId: UUID) {
    const all = await getAll<StopLossRecord>("stop_loss_history");
    return all
      .filter((s) => s.structure_id === structureId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  async addStopLossRecord(record: StopLossRecord) {
    return putOne("stop_loss_history", record);
  }

  // Audit Log
  async getAuditEvents() {
    const all = await getAll<AuditEvent>("audit_events");
    return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  async addAuditEvent(event: AuditEvent) {
    return putOne("audit_events", event);
  }

  // API Config
  async getApiConfigs() {
    return getAll<ApiConfig>("api_configs");
  }
  async upsertApiConfig(config: ApiConfig) {
    return putOne("api_configs", config);
  }

  // Bulk
  async exportAll() {
    const result: Record<string, unknown> = {};
    for (const store of STORES) {
      result[store] = await getAll(store);
    }
    return result;
  }
  async clearAll() {
    for (const store of STORES) {
      await clearStore(store);
    }
  }
}
