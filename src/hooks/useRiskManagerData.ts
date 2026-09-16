import { useCallback, useEffect, useState } from "react";
import { repository, isCloudConfigured } from "../data";
import { seedIfEmpty } from "../data/seed";
import { runMigrations } from "../data/migrate";
import { MarketDataService } from "../services/MarketDataService";
import { QuantHubProvider } from "../services/quantHub/QuantHubProvider";
import { QUANTHUB_RATE_LIMIT_PER_MINUTE } from "../services/quantHub/client";
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
      // required by currently open positions (spec section 3).
      //
      // QuantHub allows ~10 requests/minute per token on /apis/ohlc/. Each
      // poll tick is one OHLC request in the common case — all required
      // contracts fit in a single batch of <= MAX_INSTRUMENTS_PER_REQUEST
      // (50) — so we poll as close to that budget as is safe rather than an
      // arbitrary cadence: 60s / 10 requests = 6000ms at the ceiling; add a
      // margin for jitter (double-invoked effects, clock drift) rather than
      // sitting exactly on the limit. MarketDataService still backs off
      // gracefully if a 429 slips through anyway. See Settings -> API
      // Configuration for feed health.
      const quantHubPollMs = Math.ceil(60_000 / QUANTHUB_RATE_LIMIT_PER_MINUTE) + 100;
      MarketDataService.start(async () => {
        const legs = await repository.getAllLegs();
        const activeLegs = legs.filter((l) => l.is_active);
        const contractIds = new Set(activeLegs.map((l) => l.contract_id));
        const allContracts = await repository.getContracts();
        return allContracts.filter((c) => contractIds.has(c.id));
      }, __QH_CONFIGURED__ ? quantHubPollMs : 4000);

      unsub = MarketDataService.onUpdate(() => {
        reload();
      });
    })();

    return () => {
      MarketDataService.stop();
      if (unsub) unsub();
    };
  }, [reload]);

  // Cloud-only, independent of MarketDataService's own success: a client
  // that can't reach QuantHub at all (e.g. off the corp network — see
  // vite.config.ts's proxy, which needs a route to qh-api.corp...) never
  // gets a `MarketDataService.onUpdate` notification, since that only fires
  // after a successful QuantHub fetch. Without this, such a client's prices
  // would sit frozen at whatever was loaded on first page load forever, even
  // though a DIFFERENT client that CAN reach QuantHub (e.g. an always-on
  // office machine) keeps writing fresh prices into Supabase's
  // `market_prices` table on every one of ITS successful polls already
  // (MarketDataService.refresh -> repository.upsertMarketPrice, no
  // throttling needed there — more frequent shared writes only help). This
  // just re-reads whatever's currently in Supabase every 60s regardless, so
  // a QuantHub-unreachable client still tracks what an always-on reachable
  // one is publishing. 60s is plenty for a risk dashboard and cheap even
  // when redundant with a working local QuantHub feed.
  useEffect(() => {
    if (!isCloudConfigured) return;
    const id = window.setInterval(() => {
      reload();
    }, 60_000);
    return () => window.clearInterval(id);
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
