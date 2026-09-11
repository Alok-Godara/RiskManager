import { useMarketDataStatus } from "../../hooks/useMarketDataStatus";
import { isCloudConfigured } from "../../data";

const STATE_LABELS: Record<string, string> = {
  idle: "Waiting for first update",
  ok: "Live",
  partial: "Partially priced",
  error: "Unavailable",
  rate_limited: "Cooling down",
};

export function ApiSettings() {
  const marketData = useMarketDataStatus();
  const isQuantHub = marketData.providerName.startsWith("QuantHub");

  return (
    <div className="panel">
      <h2>API Configuration</h2>
      <p className="helper-text">
        Market data provider and database backend. Swapping either is a config change, not a rewrite — see{" "}
        <code>MarketDataService</code> and <code>DataRepository</code>.
      </p>

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Market Data Provider</div>
          <div className="stat-value">{marketData.providerName}</div>
          <div className="stat-sub">
            {isQuantHub
              ? "QuantHub 1-minute OHLC, polled every 1s for contracts in open positions — pauses automatically if the token gets rate-limited, then resumes"
              : "Simulated prices — set QH_API_TOKEN in .env and restart to use QuantHub"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Feed Status</div>
          <div className={`stat-value ${marketData.state === "error" ? "pnl-neg" : marketData.state === "ok" ? "pnl-pos" : ""}`}>
            {STATE_LABELS[marketData.state] ?? marketData.state}
          </div>
          <div className="stat-sub">
            {marketData.lastError
              ? marketData.lastError
              : marketData.lastSuccessAt
                ? `${marketData.pricedCount}/${marketData.requestedCount} contracts priced${
                    marketData.quoteAsOf ? `, quotes as of ${new Date(marketData.quoteAsOf).toLocaleTimeString()}` : ""
                  } (checked ${new Date(marketData.lastSuccessAt).toLocaleTimeString()})`
                : "No prices fetched yet"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Database</div>
          <div className="stat-value">{isCloudConfigured ? "Supabase" : "Local (IndexedDB)"}</div>
          <div className="stat-sub">
            {isCloudConfigured ? "Connected via VITE_SUPABASE_* env vars" : "Set VITE_SUPABASE_* in .env.local to go cloud"}
          </div>
        </div>
      </div>

      <p className="helper-text">
        QuantHub codes are built from each instrument's <strong>QuantHub / exchange code</strong> (Settings →
        Instruments) plus the standard futures month code — e.g. code <code>CO</code> + Nov 2026 →{" "}
        <code>COX26</code>. A directly-traded structure (a Fly, Calendar Spread, ...) is requested as the exchange's
        own composite code for that shape — e.g. <code>COX26-Z26-F27</code> for a Brent Nov26 Fly — never derived by
        summing outright legs. If an instrument or structure shows no price, that code is usually what needs fixing.
        The Bearer token lives only in <code>.env</code> as <code>QH_API_TOKEN</code> and is injected server-side by
        the dev proxy, so it never reaches the browser bundle.
      </p>
    </div>
  );
}
