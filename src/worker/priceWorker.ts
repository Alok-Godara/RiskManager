/**
 * Background price worker — keeps live prices flowing into Supabase with NO
 * browser open (so a locked screen, a closed tab or a throttled background
 * tab can't stall them). It runs the very same MarketDataService +
 * QuantHubProvider the dashboard uses, writing to `market_prices`; every
 * dashboard (local or deployed) just re-reads those rows.
 *
 *   npm run worker:build   # bundles this file into dist-worker/
 *   npm run worker:start   # runs it (Ctrl+C to stop)
 *
 * For always-on use, scripts/install-background-services.ps1 registers it to start
 * at Windows logon and restart if it ever exits. Needs QH_API_TOKEN (and the
 * VITE_SUPABASE_* values) in .env.local, same as the dev server.
 */
import { isCloudConfigured } from "../data";
import { MarketDataService, WORKER_SOURCE_TAG } from "../services/MarketDataService";
import { QuantHubProvider } from "../services/quantHub/QuantHubProvider";
import { configureQuantHubClient, QUANTHUB_WORKER_REQUESTS_PER_MINUTE, quantHubPollIntervalMs } from "../services/quantHub/client";
import { getRequiredContracts } from "../services/requiredContracts";

// Minimal typing for the few Node globals used (the app's tsconfig is
// browser-only and doesn't pull in @types/node).
declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(event: string, handler: (...args: unknown[]) => void): void;
  loadEnvFile(path: string): void;
};

const HEARTBEAT_MS = 15 * 60_000;
const QUANTHUB_DEFAULT_URL = "https://qh-api.corp.hertshtengroup.com";

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// .env.local wins over .env (same precedence as Vite); real environment
// variables win over both because loadEnvFile never overrides them.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file absent — fine
  }
}

const token = process.env.QH_API_TOKEN?.trim();
if (!token) {
  log("QH_API_TOKEN is not set — refusing to start (the worker never writes simulated prices to the shared database).");
  process.exit(1);
}
if (!isCloudConfigured) {
  log("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — nothing to write prices to. Exiting.");
  process.exit(1);
}

configureQuantHubClient({ baseUrl: process.env.QH_API_URL?.trim() || QUANTHUB_DEFAULT_URL, bearerToken: token });
MarketDataService.setProvider(new QuantHubProvider());
MarketDataService.setSourceTag(WORKER_SOURCE_TAG);

// 20 requests/minute of the token's 30/minute allowance (see client.ts) —
// leaves headroom for other clients. MarketDataService backs off on its own if
// a 429 slips through.
const pollMs = quantHubPollIntervalMs(QUANTHUB_WORKER_REQUESTS_PER_MINUTE);

let lastLogged = "";
MarketDataService.onStatusChange(() => {
  const s = MarketDataService.getStatus();
  // Log only when the feed's health changes, not on every tick.
  const key = `${s.state}|${s.lastError ?? ""}`;
  if (key === lastLogged) return;
  lastLogged = key;
  log(
    `feed ${s.state}: ${s.pricedCount}/${s.requestedCount} contracts priced${s.quoteAsOf ? `, quotes as of ${s.quoteAsOf}` : ""}${
      s.lastError ? ` — ${s.lastError}` : ""
    }`
  );
  // A rejected token won't fix itself. The token is read from .env.local only
  // at startup, so exit and let the supervisor (scripts/run-price-worker.cmd,
  // 15s later) start a fresh process that re-reads it — updating the token in
  // .env.local is then all that's needed, no rebuild or manual restart.
  if (s.lastError?.includes("rejected the credentials")) {
    log("QuantHub rejected the token — exiting so it is re-read from .env.local on restart");
    MarketDataService.stop();
    process.exit(3);
  }
});

setInterval(() => {
  const s = MarketDataService.getStatus();
  log(`alive — feed ${s.state}, last success ${s.lastSuccessAt ?? "never"}, ${s.pricedCount}/${s.requestedCount} priced`);
}, HEARTBEAT_MS);

// A transient failure (network down, Supabase hiccup) must never kill the
// worker — the next tick simply tries again.
process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`));
process.on("uncaughtException", (err) => log(`uncaught exception: ${err instanceof Error ? err.message : String(err)}`));

function shutdown() {
  log("stopping");
  MarketDataService.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`price worker starting — polling QuantHub every ${(pollMs / 1000).toFixed(1)}s`);
MarketDataService.start(getRequiredContracts, pollMs);
