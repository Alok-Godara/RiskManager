import { MarketDataService } from "../../services/MarketDataService";
import { isCloudConfigured } from "../../data";

export function ApiSettings() {
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
          <div className="stat-value">{MarketDataService.getProviderName()}</div>
          <div className="stat-sub">Polling every 4s for contracts in open positions</div>
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
        To connect a real market-data API, implement a new <code>MarketDataProvider</code> in{" "}
        <code>src/services/MarketDataService.ts</code> and call <code>MarketDataService.setProvider(...)</code> — the
        rest of the app is unaffected.
      </p>
    </div>
  );
}
