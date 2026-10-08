import type { Contract } from "../types/domain";
import { repository } from "../data";

/**
 * Exactly the contracts that currently need a live price: those on an
 * active leg of any structure (per architecture doc section 3 — never fetch
 * more than what's needed). Shared by the browser's polling loop
 * (hooks/useRiskManagerData.ts) and the background price worker.
 */
export async function getRequiredContracts(): Promise<Contract[]> {
  const legs = await repository.getAllLegs();
  const activeLegs = legs.filter((l) => l.is_active);
  const contractIds = new Set(activeLegs.map((l) => l.contract_id));
  const allContracts = await repository.getContracts();
  return allContracts.filter((c) => contractIds.has(c.id));
}
