import { useCallback, useEffect, useState } from "react";
import { repository } from "../data";
import { seedIfEmpty } from "../data/seed";
import { MarketDataService } from "../services/MarketDataService";
import { PnLEngine } from "../engines/PnLEngine";
import { PortfolioEngine } from "../engines/PortfolioEngine";
import type {
  Instrument,
  Contract,
  Structure,
  StructureSnapshot,
  PortfolioSummary,
  AuditEvent,
} from "../types/domain";

export function useRiskManagerData() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [structures, setStructures] = useState<Structure[]>([]);
  const [snapshots, setSnapshots] = useState<StructureSnapshot[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [inst, cons, structs, snaps, summary, audit] = await Promise.all([
      repository.getInstruments(),
      repository.getContracts(),
      repository.getStructures(),
      PnLEngine.buildAllStructureSnapshots(),
      PortfolioEngine.buildSummary(),
      repository.getAuditEvents(),
    ]);
    setInstruments(inst);
    setContracts(cons);
    setStructures(structs);
    setSnapshots(snaps);
    setPortfolio(summary);
    setAuditEvents(audit);
    setLoading(false);
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      await seedIfEmpty();
      await reload();

      // Start continuous market data polling for exactly the contracts
      // required by currently open positions (spec section 3).
      MarketDataService.start(async () => {
        const legs = await repository.getAllLegs();
        const activeLegs = legs.filter((l) => l.is_active);
        const contractIds = new Set(activeLegs.map((l) => l.contract_id));
        const allContracts = await repository.getContracts();
        return allContracts.filter((c) => contractIds.has(c.id));
      }, 4000);

      unsub = MarketDataService.onUpdate(() => {
        reload();
      });
    })();

    return () => {
      MarketDataService.stop();
      if (unsub) unsub();
    };
  }, [reload]);

  return { instruments, contracts, structures, snapshots, portfolio, auditEvents, loading, reload };
}
