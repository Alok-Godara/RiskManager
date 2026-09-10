import { useSyncExternalStore } from "react";
import { MarketDataService, type MarketDataStatus } from "../services/MarketDataService";

/**
 * Subscribes to market-data feed health (provider, last success, last
 * error). Separate from the price-update listener so a failing feed
 * refreshes the indicator without triggering a full data reload.
 */
export function useMarketDataStatus(): MarketDataStatus {
  return useSyncExternalStore(
    (onChange) => MarketDataService.onStatusChange(onChange),
    () => MarketDataService.getStatus()
  );
}
