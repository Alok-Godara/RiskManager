import { repository } from "../data";

/**
 * Tick size for the instrument behind a structure — used to size the
 * scroll/spinner step on execution-price inputs so incrementing there
 * always lands on a real tradeable price, not an arbitrary decimal. Falls
 * back to 0.01 (the most common tick size among seeded instruments) if
 * anything can't be resolved, so a price field never ends up unusable.
 */
export async function tickSizeForStructure(structureId: string): Promise<number> {
  const structure = await repository.getStructure(structureId);
  if (!structure) return 0.01;
  const instrument = await repository.getInstrument(structure.instrument_id);
  return instrument?.tick_size ?? 0.01;
}
