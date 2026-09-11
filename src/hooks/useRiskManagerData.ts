import { useCallback, useEffect, useState } from "react";
import { repository } from "../data";
import { seedIfEmpty } from "../data/seed";
import { runMigrations } from "../data/migrate";
import { MarketDataService } from "../services/MarketDataService";
import { QuantHubProvider } from "../services/quantHub/QuantHubProvider";
import { PnLEngine } from "../engines/PnLEngine";
import { PortfolioEngine } from "../engines/PortfolioEngine";
import type {
  Instrument,
  Contract,
  Structure,
  StructureTemplate,
  StructureSnapshot,
  PortfolioSummary,
  AuditEvent,
} from "../types/domain";

export function useRiskManagerData() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [templates, setTemplates] = useState<StructureTemplate[]>([]);
  const [structures, setStructures] = useState<Structure[]>([]);
  const [snapshots, setSnapshots] = useState<StructureSnapshot[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [inst, cons, tmpl, structs, snaps, summary, audit] = await Promise.all([
      repository.getInstruments(),
      repository.getContracts(),
      repository.getStructureTemplates(),
      repository.getStructures(),
      PnLEngine.buildAllStructureSnapshots(),
      PortfolioEngine.buildSummary(),
      repository.getAuditEvents(),
    ]);
    setInstruments(inst);
    setContracts(cons);
    setTemplates(tmpl);
    setStructures(structs);
    setSnapshots(snaps);
    setPortfolio(summary);
    setAuditEvents(audit);
    setLoading(false);
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      await runMigrations();
      await seedIfEmpty();
      await reload();

      // QuantHub is the authoritative price source whenever a token is
      // configured (QH_API_TOKEN in .env — see vite.config.ts); otherwise
      // the simulated random walk keeps the dashboard usable.
      if (__QH_CONFIGURED__) MarketDataService.setProvider(new QuantHubProvider());

      // Start continuous market data polling for exactly the contracts
      // required by currently open positions (spec section 3). Each
      // QuantHub request is pinned to `end=now`, so polling picks up the
      // 1-minute candle updating in real time rather than waiting a full
      // minute between prices.
      //
      // 5s, not 1s: live-tested against the real API, a burst of ~15
      // requests in a few seconds triggers a 429, and recovery took over
      // 90s of complete silence (see MarketDataService's rate-limit
      // backoff). One tick is one request (all open-position contracts are
      // batched together), so 5s keeps every normal tick under that
      // threshold with margin instead of spending most of its time in a
      // cooldown loop. MarketDataService.start's pollMs is a plain
      // parameter — lower this if your token's actual limit is higher.
      MarketDataService.start(async () => {
        const legs = await repository.getAllLegs();
        const activeLegs = legs.filter((l) => l.is_active);
        const contractIds = new Set(activeLegs.map((l) => l.contract_id));
        const allContracts = await repository.getContracts();
        return allContracts.filter((c) => contractIds.has(c.id));
      }, __QH_CONFIGURED__ ? 5000 : 4000);

      unsub = MarketDataService.onUpdate(() => {
        reload();
      });
    })();

    return () => {
      MarketDataService.stop();
      if (unsub) unsub();
    };
  }, [reload]);

  const activeInstruments = instruments.filter((i) => i.is_active);
  const activeTemplates = templates.filter((t) => t.is_active);

  return {
    instruments,
    activeInstruments,
    contracts,
    templates,
    activeTemplates,
    structures,
    snapshots,
    portfolio,
    auditEvents,
    loading,
    reload,
  };
}
