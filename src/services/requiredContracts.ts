import type { Contract, StructureLeg } from "../types/domain";
import { repository } from "../data";

/**
 * Exactly the contracts that currently need a live price: those on an
 * active leg of any structure (per architecture doc section 3 — never fetch
 * more than what's needed). Shared by the browser's polling loop
 * (hooks/useRiskManagerData.ts) and the background price worker.
 *
 * Cached, because this runs on every poll (every few seconds, all day) and
 * the answer changes only when you add or close a trade:
 *   - the leg list (a few KB) is re-read at most once a minute, so a newly added
 *     trade starts being priced within ~60 seconds;
 *   - the full contract list (the big one, ~60 KB) is re-read every 10 minutes,
 *     or immediately if a leg points at a contract we haven't seen.
 * Re-reading both every few seconds is what used up the free database egress.
 */
const LEGS_TTL_MS = 60_000;
const CONTRACTS_TTL_MS = 10 * 60_000;

let legsCache: { at: number; legs: StructureLeg[] } | null = null;
let contractsCache: { at: number; contracts: Contract[] } | null = null;

export async function getRequiredContracts(): Promise<Contract[]> {
  const now = Date.now();
  if (!legsCache || now - legsCache.at > LEGS_TTL_MS) {
    legsCache = { at: now, legs: await repository.getAllLegs() };
  }
  const contractIds = new Set(legsCache.legs.filter((l) => l.is_active).map((l) => l.contract_id));

  const stale = !contractsCache || now - contractsCache.at > CONTRACTS_TTL_MS;
  const unknownContract = contractsCache ? Array.from(contractIds).some((id) => !contractsCache!.contracts.some((c) => c.id === id)) : false;
  if (stale || unknownContract) {
    contractsCache = { at: now, contracts: await repository.getContracts() };
  }
  return contractsCache!.contracts.filter((c) => contractIds.has(c.id));
}

/** Forget the cached legs/contracts — call after changing trades so the next poll sees them. */
export function invalidateRequiredContracts(): void {
  legsCache = null;
}
