import { useCallback, useEffect, useRef, useState } from "react";
import { repository, isCloudConfigured } from "../data";
import { seedIfEmpty } from "../data/seed";
import { runMigrations } from "../data/migrate";
import { MarketDataService } from "../services/MarketDataService";
import { getRequiredContracts, invalidateRequiredContracts } from "../services/requiredContracts";
import { QuantHubProvider } from "../services/quantHub/QuantHubProvider";
import { QUANTHUB_BROWSER_REQUESTS_PER_MINUTE, quantHubPollIntervalMs } from "../services/quantHub/client";
import { PnLEngine, type StaticSnapshotData } from "../engines/PnLEngine";
import { PortfolioEngine } from "../engines/PortfolioEngine";
import type {
  Instrument,
  Contract,
  Structure,
  StructureTemplate,
  StructureSnapshot,
  PortfolioSummary,
  AuditEvent,
  MarketPrice,
} from "../types/domain";

/**
 * Data budget. Supabase's free plan allows 5 GB of egress a month, and the app
 * used to blow through it by re-reading every table on every price tick, in
 * every open tab. Now:
 *   - everything that only changes when YOU act on a trade (trades, legs,
 *     positions, executions, contracts, ...) is read once and kept — a "full
 *     reload" happens on load, after any change you make, and every
 *     FULL_RELOAD_MS as a safety net;
 *   - a price tick re-reads only the (tiny) price table and recomputes P&L in
 *     memory — and not more often than PRICE_REFRESH_MIN_MS;
 *   - a hidden tab (locked screen, another tab in front) does neither.
 */
const FULL_RELOAD_MS = 5 * 60_000;
const PRICE_REFRESH_MIN_MS = 10_000;
/** The history log only ever grows; the screen needs the recent part. */
const AUDIT_EVENT_LIMIT = 300;

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export function useRiskManagerData() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [templates, setTemplates] = useState<StructureTemplate[]>([]);
  const [structures, setStructures] = useState<Structure[]>([]);
  const [snapshots, setSnapshots] = useState<StructureSnapshot[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const staticRef = useRef<StaticSnapshotData | null>(null);
  const lastFullReloadRef = useRef(0);
  const lastPriceRefreshRef = useRef(0);

  const applySnapshots = useCallback((staticData: StaticSnapshotData, prices: MarketPrice[]) => {
    const snaps = PnLEngine.buildSnapshots({ ...staticData, prices });
    setSnapshots(snaps);
    setPortfolio(PortfolioEngine.summarize(snaps));
  }, []);

  /**
   * Full read of everything. Called on load, after any change you make, and on a slow timer.
   * The timer passes `cached: true` so the big, rarely-changing contract list is reused.
   */
  const reload = useCallback(async (opts?: { cached?: boolean }) => {
    const [staticData, prices, audit] = await Promise.all([
      PnLEngine.loadStaticData({ cachedContracts: opts?.cached === true }),
      repository.getMarketPrices(),
      repository.getAuditEvents(AUDIT_EVENT_LIMIT),
    ]);
    staticRef.current = staticData;
    lastFullReloadRef.current = Date.now();
    lastPriceRefreshRef.current = Date.now();
    invalidateRequiredContracts(); // so a trade you just added/closed is (un)priced promptly

    setInstruments(staticData.instruments);
    setContracts(staticData.contracts);
    setTemplates(staticData.templates);
    setStructures(staticData.structures);
    applySnapshots(staticData, prices);
    setAuditEvents(audit);
    setLoading(false);
  }, [applySnapshots]);

  /** Price tick: refresh only the prices (given, or one small read) and recompute P&L in memory. */
  const refreshPrices = useCallback(
    async (given?: MarketPrice[]) => {
      const staticData = staticRef.current;
      if (!staticData || pageHidden()) return;
      const now = Date.now();
      if (!given && now - lastPriceRefreshRef.current < PRICE_REFRESH_MIN_MS) return;
      const prices = given ?? (await repository.getMarketPrices());
      lastPriceRefreshRef.current = now;
      applySnapshots(staticData, prices);
    },
    [applySnapshots]
  );

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
      // A tab polls gently (4 requests/minute): it is only here to show
      // prices, and the background worker (src/worker/) does the real polling
      // for everyone. If the worker is running, this tab does not call
      // QuantHub at all — it only re-reads the stored prices.
      const pollMs = __QH_CONFIGURED__ ? quantHubPollIntervalMs(QUANTHUB_BROWSER_REQUESTS_PER_MINUTE) : 15_000;
      MarketDataService.setDeferToWorker(true);
      MarketDataService.start(getRequiredContracts, pollMs);

      unsub = MarketDataService.onUpdate((prices) => {
        refreshPrices(prices);
      });
    })();

    return () => {
      MarketDataService.stop();
      if (unsub) unsub();
    };
  }, [reload, refreshPrices]);

  // Safety net: a slow full re-read (new trades from another tab/person, edits
  // made elsewhere). Cloud only, visible tabs only.
  useEffect(() => {
    if (!isCloudConfigured) return;
    const id = window.setInterval(() => {
      if (!pageHidden()) reload({ cached: true });
    }, FULL_RELOAD_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  // Catch up the moment a hidden tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (pageHidden() || !staticRef.current) return;
      if (Date.now() - lastFullReloadRef.current > FULL_RELOAD_MS) reload({ cached: true });
      else refreshPrices();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload, refreshPrices]);

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
