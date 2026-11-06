/**
 * Teams alerts, run by the headless price worker (so they go out with no browser
 * open). Three kinds, all posted to one Power Automate webhook (TEAMS_WEBHOOK_URL):
 *   - stop loss: an open entry near (>= 80% of its risk) or at/past its stop;
 *   - profit target: a trade whose net P&L reached 1.5x its initial risk;
 *   - correlation: the portfolio turning "Concentrated", or a highly-correlated pair.
 * Same rules as the Dashboard's Alerts section (src/services/alerts/alertRules.ts).
 *
 * Data budget (Supabase egress): prices come from the worker's own memory, never
 * the database; positions/trades are re-read every STATIC_RELOAD_MS; correlation
 * reads stored settlement history once an hour.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CorrelationWindow, UUID } from "../types/domain";
import { CORRELATION_WINDOWS } from "../types/domain";
import { PnLEngine, type StaticSnapshotData } from "../engines/PnLEngine";
import { CorrelationEngine, VAR_LOOKBACK_DAYS } from "../engines/CorrelationEngine";
import { MarketDataService } from "../services/MarketDataService";
import { buildCorrelationContext, getCorrelationSettings, historyTradingDaysFor } from "../services/settlementData/correlationContext";
import { holdsPosition } from "../utils/tradeDirection";
import {
  CORRELATION_KEY_PREFIXES,
  CORRELATION_STATUS_WINDOW,
  STOP_PROFIT_KEY_PREFIXES,
  correlationAlerts,
  profitAlerts,
  stopAlerts,
  type AlertEvent,
} from "../services/alerts/alertRules";
import { planAlerts, revertUnsent, type AlertState } from "../services/alerts/alertDispatch";
import { buildTeamsMessage, postToTeams } from "../services/alerts/teamsWebhook";

const CHECK_MS = 30_000;
/** Trades/positions/executions are read this often (~250 KB each time, so ~24 MB/day at 15 min); a trade you just opened or closed is picked up within this long. */
const DEFAULT_RELOAD_MINUTES = 15;
const CORRELATION_MS = 60 * 60_000;
const STATE_DIR = "logs";
const STATE_FILE = "logs/alert-state.json";

function loadState(): AlertState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as AlertState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state: AlertState) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), "utf8");
  } catch {
    // Not fatal: worst case a restart re-sends alerts that are still active.
  }
}

export function startAlertMonitor(webhookUrl: string, log: (message: string) => void, reloadMinutes = DEFAULT_RELOAD_MINUTES) {
  const STATIC_RELOAD_MS = Math.max(1, reloadMinutes) * 60_000;
  let state = loadState();
  let staticData: StaticSnapshotData | null = null;
  let staticLoadedAt = 0;
  let lastCorrelationAt = 0;
  let lastPositionSignature = "";
  let busy = false;

  async function dispatch(events: AlertEvent[], checkedPrefixes: string[]) {
    const plan = planAlerts(events, state, checkedPrefixes, Date.now());
    if (plan.toSend.length === 0) {
      state = plan.next;
      saveState(state);
      return;
    }
    const heading = plan.toSend.length === 1 ? "Risk Manager alert" : `Risk Manager alerts (${plan.toSend.length})`;
    const result = await postToTeams(webhookUrl, buildTeamsMessage(heading, plan.toSend));
    if (result.ok) {
      state = plan.next;
      log(`Teams: sent ${plan.toSend.length} alert(s): ${plan.toSend.map((e) => e.key).join(", ")}`);
    } else {
      state = revertUnsent(plan, state);
      log(`Teams: send FAILED, will retry next check — ${result.error ?? result.status}`);
    }
    saveState(state);
  }

  async function checkCorrelation(data: StaticSnapshotData) {
    const prices = MarketDataService.getLatestPrices();
    const snapshots = PnLEngine.buildSnapshots({ ...data, prices });
    const open = snapshots.filter(holdsPosition);
    if (open.length < 2) {
      await dispatch([], CORRELATION_KEY_PREFIXES);
      return;
    }
    const settings = await getCorrelationSettings();
    const withLegs = open.map((s) => ({
      structure: s.structure,
      legs: s.legs.map((l) => ({ contract_id: l.leg.contract_id, ratio: l.leg.ratio, net_quantity: l.position.net_quantity })),
    }));
    const historyDays = Math.max(historyTradingDaysFor(settings.periods), VAR_LOOKBACK_DAYS + 1);
    const context = await buildCorrelationContext(withLegs, data.contracts, data.templates, data.instruments, historyDays);
    const exposureById = new Map(open.map((s) => [s.structure.id, CorrelationEngine.structureExposureLots(s.legs)]));
    const dollarSeriesById = new Map(context.openStructures.map((s) => [s.structure.id, s.positionDollarSeries]));
    const window: CorrelationWindow = CORRELATION_WINDOWS.includes(CORRELATION_STATUS_WINDOW as CorrelationWindow)
      ? (CORRELATION_STATUS_WINDOW as CorrelationWindow)
      : CORRELATION_WINDOWS[0];
    const analysis = CorrelationEngine.analyzePortfolioConcentration(
      context.openStructures,
      window,
      settings.periods,
      settings.correlation,
      settings.concentration,
      exposureById,
      dollarSeriesById
    );
    await dispatch(correlationAlerts(analysis), CORRELATION_KEY_PREFIXES);
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      if (!staticData || now - staticLoadedAt >= STATIC_RELOAD_MS) {
        staticData = await PnLEngine.loadStaticData({ cachedContracts: true });
        staticLoadedAt = now;
      }
      const prices = MarketDataService.getLatestPrices();
      if (prices.length === 0) return; // no quote fetched yet — nothing reliable to judge

      const snapshots = PnLEngine.buildSnapshots({ ...staticData, prices });
      await dispatch([...stopAlerts(snapshots), ...profitAlerts(snapshots)], STOP_PROFIT_KEY_PREFIXES);

      // Correlation: hourly, and straight away when the held positions change.
      const signature = snapshots
        .filter(holdsPosition)
        .map((s) => `${s.structure.id}:${s.legs.map((l) => `${l.leg.contract_id as UUID}=${l.position.net_quantity}`).join(",")}`)
        .sort()
        .join("|");
      if (now - lastCorrelationAt >= CORRELATION_MS || signature !== lastPositionSignature) {
        lastCorrelationAt = now;
        lastPositionSignature = signature;
        try {
          await checkCorrelation(staticData);
        } catch (err) {
          log(`alerts: correlation check failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log(`alerts: check failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  }

  setInterval(check, CHECK_MS);
  setTimeout(check, 20_000); // let the first price tick land
  log(`Teams alerts on — checking every ${CHECK_MS / 1000}s (stop loss, profit target, correlation); trades re-read every ${reloadMinutes} min`);
}
