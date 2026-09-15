import type { Contract, MarketPrice, UUID } from "../types/domain";
import { repository } from "../data";

/** One provider-supplied mark for a contract. */
export interface PriceQuote {
  price: number;
  bid?: number;
  ask?: number;
  /** Overrides the provider name recorded on the MarketPrice row, if set. */
  source?: string;
  /**
   * Epoch ms the price itself is "as of" (e.g. the OHLC candle's own time),
   * as opposed to when we fetched it. Surfaced in the UI so a stale feed is
   * visible rather than silently showing an old number as live.
   */
  asOf?: number;
}

/**
 * MarketDataProvider: the interface any price source implements. Providers
 * receive whole Contracts (not just symbols) because a real vendor mapping
 * needs the instrument and month behind a contract — see
 * services/quantHub/QuantHubProvider.ts, the live source. Contracts a
 * provider can't price are simply left out of the result.
 */
export interface MarketDataProvider {
  name: string;
  fetchPrices(contracts: Contract[]): Promise<Record<UUID, PriceQuote>>;
}

/**
 * SimulatedProvider: random-walk fallback so the dashboard stays usable
 * with no market-data credentials configured (QH_API_TOKEN unset). Never
 * used when QuantHub is configured.
 */
export class SimulatedProvider implements MarketDataProvider {
  name = "Simulated";
  private lastPrices: Record<string, number> = {};

  async fetchPrices(contracts: Contract[]): Promise<Record<UUID, PriceQuote>> {
    const out: Record<UUID, PriceQuote> = {};
    for (const contract of contracts) {
      const symbol = contract.market_data_symbol ?? contract.code;
      const base = this.lastPrices[symbol] ?? this.seedPrice(symbol);
      // Structure quotes (spreads/flies) trade in a much tighter range than
      // outrights — scale the random walk to roughly 1% of the seed price
      // either way, so simulated fly/spread prices stay plausibly small.
      const driftScale = Math.max(Math.abs(base) * 0.01, 0.002);
      const drift = (Math.random() - 0.5) * 2 * driftScale;
      const next = Math.round((base + drift) * 1000) / 1000;
      this.lastPrices[symbol] = next;
      out[contract.id] = { price: next };
    }
    return out;
  }

  private seedPrice(symbol: string): number {
    // Deterministic-ish seed so different contracts don't all start equal
    let hash = 0;
    for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) % 1000;

    // Our own generated symbols are "SYMBOL-MONTH" for outrights (2 parts)
    // vs "SYMBOL-CODE-MONTH" for structure-level quotes (3 parts, see
    // StructureQuoteEngine) — use that to seed a realistically small
    // spread/fly price instead of an outright-sized one.
    const isStructureQuote = symbol.split("-").length >= 3;
    if (isStructureQuote) {
      return Math.round(((hash % 200) / 100 - 1) * 100) / 100; // ~ -1.00 .. +1.00
    }
    return 60 + (hash % 40); // ~60-100 range, plausible for crude
  }
}

/** Health of the last price refresh, for display in the UI. */
export interface MarketDataStatus {
  providerName: string;
  state: "idle" | "ok" | "partial" | "error" | "rate_limited";
  lastSuccessAt?: string;
  /** ISO time the newest price is "as of" (candle time), when the provider reports one. */
  quoteAsOf?: string;
  /** For state "rate_limited": ISO time polling will resume — an absolute time rather than a countdown, so a UI that isn't re-rendering every second still shows something accurate. */
  retryAt?: string;
  lastError?: string;
  pricedCount: number;
  requestedCount: number;
}

type Listener = () => void;

/**
 * Backoff bounds for rate-limit cooldowns (see asRateLimitSignal). QuantHub
 * allows 50 requests/minute per token (see QUANTHUB_RATE_LIMIT_PER_MINUTE);
 * polling above that budget gets a 429, and live testing showed recovery
 * can take over 90s of complete silence — so the cap here is deliberately
 * generous rather than tuned to guesswork.
 */
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 90_000;

/**
 * Duck-typed rate-limit signal: a provider can throw any error shaped like
 * this (see services/quantHub/client.ts QuantHubError) without
 * MarketDataService importing that provider's own error class — keeping
 * this file provider-agnostic while still backing off automatically
 * instead of hammering a rate-limited API every tick.
 */
interface RateLimitSignal {
  rateLimited: true;
  retryAfterMs?: number;
}
function asRateLimitSignal(err: unknown): RateLimitSignal | undefined {
  if (err && typeof err === "object" && (err as Partial<RateLimitSignal>).rateLimited === true) {
    return err as RateLimitSignal;
  }
  return undefined;
}

/**
 * MarketDataService: the ONLY place that knows how prices are fetched.
 * Today it runs a setInterval in the browser. When deployed online, this
 * same class's fetch/update logic can move into a background worker or
 * server process — the rest of the app (engines, UI) reads prices only
 * through the DataRepository and is unaffected by where fetching runs.
 */
class MarketDataServiceImpl {
  private provider: MarketDataProvider = new SimulatedProvider();
  private intervalId: number | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<Listener>();
  private pollMs = 4000;
  private status: MarketDataStatus = {
    providerName: "Simulated",
    state: "idle",
    pricedCount: 0,
    requestedCount: 0,
  };
  /** Epoch ms — ticks are skipped until this passes (see asRateLimitSignal). */
  private cooldownUntil = 0;
  private consecutiveRateLimits = 0;

  setProvider(provider: MarketDataProvider) {
    this.provider = provider;
    this.setStatus({ providerName: provider.name, state: "idle", pricedCount: 0, requestedCount: 0 });
  }

  getProviderName() {
    return this.provider.name;
  }

  getStatus(): MarketDataStatus {
    return this.status;
  }

  private setStatus(next: MarketDataStatus) {
    this.status = next;
    this.statusListeners.forEach((l) => l());
  }

  /** Fires when prices changed (drives a data reload). */
  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fires when the feed's health changes — no data reload implied. */
  onStatusChange(listener: Listener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  /** Fetch once for the given contracts and persist to the repository. */
  async refresh(contracts: Contract[]): Promise<void> {
    if (contracts.length === 0) return;

    try {
      const quotes = await this.provider.fetchPrices(contracts);
      const timestamp = new Date().toISOString();
      let priced = 0;
      let newestAsOf = 0;

      for (const contract of contracts) {
        const quote = quotes[contract.id];
        if (!quote || !Number.isFinite(quote.price)) continue;
        if (quote.asOf && quote.asOf > newestAsOf) newestAsOf = quote.asOf;
        const marketPrice: MarketPrice = {
          contract_id: contract.id,
          price: quote.price,
          bid: quote.bid,
          ask: quote.ask,
          source: quote.source ?? this.provider.name,
          timestamp,
        };
        await repository.upsertMarketPrice(marketPrice);
        priced++;
      }

      this.setStatus({
        providerName: this.provider.name,
        state: priced === contracts.length ? "ok" : priced > 0 ? "partial" : "error",
        lastSuccessAt: priced > 0 ? timestamp : this.status.lastSuccessAt,
        quoteAsOf: newestAsOf > 0 ? new Date(newestAsOf).toISOString() : this.status.quoteAsOf,
        lastError:
          priced === 0
            ? "No prices returned — check the instrument's QuantHub code in Settings → Instruments."
            : undefined,
        pricedCount: priced,
        requestedCount: contracts.length,
      });

      this.consecutiveRateLimits = 0;
      if (priced > 0) this.notify();
    } catch (err) {
      const rateLimit = asRateLimitSignal(err);
      if (rateLimit) {
        // Back off instead of retrying at the normal cadence and getting
        // rate-limited again next tick — grows with consecutive hits
        // (capped) unless the server told us exactly how long to wait.
        this.consecutiveRateLimits++;
        const backoffMs =
          rateLimit.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (this.consecutiveRateLimits - 1));
        this.cooldownUntil = Date.now() + backoffMs;
        console.warn(`MarketDataService: rate-limited, backing off ${Math.round(backoffMs / 1000)}s`);
        // An absolute retry time, not "in Ns": nothing re-renders the UI
        // while polling is paused, so a relative countdown would just sit
        // frozen on screen looking stuck instead of counting down.
        const retryAt = new Date(this.cooldownUntil);
        this.setStatus({
          providerName: this.provider.name,
          state: "rate_limited",
          lastSuccessAt: this.status.lastSuccessAt,
          quoteAsOf: this.status.quoteAsOf,
          retryAt: retryAt.toISOString(),
          lastError: `Rate-limited by ${this.provider.name} — pausing until ${retryAt.toLocaleTimeString()}, then resuming automatically.`,
          pricedCount: 0,
          requestedCount: contracts.length,
        });
        return;
      }

      // Never let a bad tick crash the dashboard — the last known prices
      // stay on screen and the sidebar shows the feed as unhealthy.
      this.consecutiveRateLimits = 0;
      const message = err instanceof Error ? err.message : "Market data fetch failed";
      console.error("MarketDataService.refresh failed:", err);
      this.setStatus({
        providerName: this.provider.name,
        state: "error",
        lastSuccessAt: this.status.lastSuccessAt,
        quoteAsOf: this.status.quoteAsOf,
        lastError: message,
        pricedCount: 0,
        requestedCount: contracts.length,
      });
    }
  }

  /**
   * Start continuous polling for exactly the contracts currently required
   * by open positions (per architecture doc section 3 — never fetch more
   * than what's needed).
   */
  start(getRequiredContracts: () => Promise<Contract[]>, pollMs = 4000) {
    this.stop();
    this.pollMs = pollMs;
    let busy = false;
    const tick = async () => {
      // At a 1s cadence a slow round trip can outlast the interval — skip
      // this tick rather than let requests pile up concurrently.
      if (busy) return;
      // Skip entirely while backing off from a rate limit — no request at
      // all, not even a cheap one, until the cooldown passes.
      if (Date.now() < this.cooldownUntil) return;
      busy = true;
      try {
        const contracts = await getRequiredContracts();
        await this.refresh(contracts);
      } catch (err) {
        console.error("MarketDataService tick failed:", err);
      } finally {
        busy = false;
      }
    };
    tick();
    this.intervalId = window.setInterval(tick, this.pollMs);
  }

  stop() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const MarketDataService = new MarketDataServiceImpl();
