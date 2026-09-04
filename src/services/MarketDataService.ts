import type { Contract, MarketPrice } from "../types/domain";
import { repository } from "../data";

/**
 * MarketDataProvider: the interface any price source implements.
 * Today we ship a SimulatedProvider (for local dev without an API key)
 * and a genericRestProvider adapter. Swapping providers means writing a
 * new class implementing this interface — nothing else changes.
 */
export interface MarketDataProvider {
  name: string;
  fetchPrices(symbols: string[]): Promise<Record<string, number>>;
}

/**
 * SimulatedProvider produces plausible, slowly-random-walking prices so the
 * dashboard is fully usable without any external API key. Swap for a real
 * provider (ICE, CME, a data vendor's REST/WebSocket API) via
 * MarketDataService.setProvider().
 */
export class SimulatedProvider implements MarketDataProvider {
  name = "Simulated";
  private lastPrices: Record<string, number> = {};

  async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const symbol of symbols) {
      const base = this.lastPrices[symbol] ?? this.seedPrice(symbol);
      // Structure quotes (spreads/flies) trade in a much tighter range than
      // outrights — scale the random walk to roughly 1% of the seed price
      // either way, so simulated fly/spread prices stay plausibly small.
      const driftScale = Math.max(Math.abs(base) * 0.01, 0.002);
      const drift = (Math.random() - 0.5) * 2 * driftScale;
      const next = Math.round((base + drift) * 1000) / 1000;
      this.lastPrices[symbol] = next;
      out[symbol] = next;
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

/**
 * GenericRestProvider: example adapter for a real REST market-data API.
 * Configure base URL / API key via ApiConfig records. Left generic since
 * the actual provider isn't chosen yet (per the architecture doc).
 */
export class GenericRestProvider implements MarketDataProvider {
  name = "GenericRest";
  private baseUrl: string;
  private apiKey?: string;
  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async fetchPrices(symbols: string[]): Promise<Record<string, number>> {
    const url = `${this.baseUrl}?symbols=${encodeURIComponent(symbols.join(","))}`;
    const res = await fetch(url, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`Market data fetch failed: ${res.status}`);
    const json = await res.json();
    // Expect { symbol: price } shape; adapt per real provider's schema.
    return json as Record<string, number>;
  }
}

type Listener = () => void;

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
  private pollMs = 4000;

  setProvider(provider: MarketDataProvider) {
    this.provider = provider;
  }

  getProviderName() {
    return this.provider.name;
  }

  onUpdate(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  /** Fetch once for the given contracts and persist to the repository. */
  async refresh(contracts: Contract[]): Promise<void> {
    if (contracts.length === 0) return;
    const symbolByContract = new Map<string, Contract>();
    contracts.forEach((c) => symbolByContract.set(c.market_data_symbol ?? c.code, c));
    const symbols = Array.from(symbolByContract.keys());

    try {
      const prices = await this.provider.fetchPrices(symbols);
      for (const [symbol, price] of Object.entries(prices)) {
        const contract = symbolByContract.get(symbol);
        if (!contract) continue;
        const marketPrice: MarketPrice = {
          contract_id: contract.id,
          price,
          source: this.provider.name,
          timestamp: new Date().toISOString(),
        };
        await repository.upsertMarketPrice(marketPrice);
      }
      this.notify();
    } catch (err) {
      // Deliberately swallow network errors so a bad tick doesn't crash the
      // dashboard; the UI shows "stale" prices via timestamp comparison.
      console.error("MarketDataService.refresh failed:", err);
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
    const tick = async () => {
      const contracts = await getRequiredContracts();
      await this.refresh(contracts);
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
