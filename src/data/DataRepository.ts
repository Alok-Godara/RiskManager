import type {
  Instrument,
  Contract,
  Structure,
  StructureLeg,
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
 * DataRepository is the ONLY interface the rest of the application talks to
 * for persistence. Today it's backed by LocalRepository (IndexedDB/localStorage).
 * Tomorrow it can be backed by a SupabaseRepository implementing the same
 * interface, with zero changes required in the engines or UI.
 *
 * Every method returns a Promise so a future network-backed implementation
 * is a drop-in replacement.
 */
export interface DataRepository {
  // Instruments
  getInstruments(): Promise<Instrument[]>;
  getInstrument(id: UUID): Promise<Instrument | undefined>;
  upsertInstrument(instrument: Instrument): Promise<void>;

  // Contracts
  getContracts(): Promise<Contract[]>;
  getContractsByInstrument(instrumentId: UUID): Promise<Contract[]>;
  getContract(id: UUID): Promise<Contract | undefined>;
  upsertContract(contract: Contract): Promise<void>;

  // Structures
  getStructures(): Promise<Structure[]>;
  getStructure(id: UUID): Promise<Structure | undefined>;
  upsertStructure(structure: Structure): Promise<void>;

  // Structure Legs
  getLegsByStructure(structureId: UUID): Promise<StructureLeg[]>;
  getAllLegs(): Promise<StructureLeg[]>;
  getLeg(id: UUID): Promise<StructureLeg | undefined>;
  upsertLeg(leg: StructureLeg): Promise<void>;

  // Executions
  getExecutionsByLeg(legId: UUID): Promise<Execution[]>;
  getAllExecutions(): Promise<Execution[]>;
  addExecution(execution: Execution): Promise<void>;

  // Positions (materialized view, recomputed by PositionEngine)
  getPositions(): Promise<Position[]>;
  getPositionByLeg(legId: UUID): Promise<Position | undefined>;
  upsertPosition(position: Position): Promise<void>;

  // Market Prices
  getMarketPrices(): Promise<MarketPrice[]>;
  getMarketPrice(contractId: UUID): Promise<MarketPrice | undefined>;
  upsertMarketPrice(price: MarketPrice): Promise<void>;

  // Realized P&L Events
  getRealizedPnLEvents(): Promise<RealizedPnLEvent[]>;
  addRealizedPnLEvent(event: RealizedPnLEvent): Promise<void>;

  // Risk Allocations
  getRiskAllocations(): Promise<RiskAllocation[]>;
  getRiskAllocationsByStructure(structureId: UUID): Promise<RiskAllocation[]>;
  addRiskAllocation(allocation: RiskAllocation): Promise<void>;

  // Stop Loss History
  getStopLossHistory(structureId: UUID): Promise<StopLossRecord[]>;
  addStopLossRecord(record: StopLossRecord): Promise<void>;

  // Audit Log
  getAuditEvents(): Promise<AuditEvent[]>;
  addAuditEvent(event: AuditEvent): Promise<void>;

  // API Config
  getApiConfigs(): Promise<ApiConfig[]>;
  upsertApiConfig(config: ApiConfig): Promise<void>;

  // Bulk utility (for seeding / import-export / future migration)
  exportAll(): Promise<Record<string, unknown>>;
  clearAll(): Promise<void>;
}
