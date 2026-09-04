import { v4 as uuid } from "uuid";
import { repository } from "./index";
import type { Instrument, StructureTemplate, StructureTemplateLeg } from "../types/domain";
import { buildRollingContracts } from "../utils/contractGen";

/** Seed a sensible default instrument/contract set for a crude & products trader. */
export async function seedIfEmpty() {
  await seedDefaultTemplates();

  const existing = await repository.getInstruments();
  if (existing.length > 0) return;

  const instruments: Omit<Instrument, "id" | "created_at">[] = [
    { symbol: "BZ", name: "Brent Crude", tick_size: 0.01, tick_value: 10, lot_size: 1000, currency: "USD", is_active: true },
    { symbol: "CL", name: "WTI Crude", tick_size: 0.01, tick_value: 10, lot_size: 1000, currency: "USD", is_active: true },
    { symbol: "WBS", name: "WTI Midland (Houston)", tick_size: 0.01, tick_value: 10, lot_size: 1000, currency: "USD", is_active: true },
    { symbol: "HO", name: "NY Harbor ULSD", tick_size: 0.0001, tick_value: 4.2, lot_size: 42000, currency: "USD", is_active: true },
    { symbol: "RB", name: "RBOB Gasoline", tick_size: 0.0001, tick_value: 4.2, lot_size: 42000, currency: "USD", is_active: true },
  ];

  for (const inst of instruments) {
    const instrument: Instrument = { ...inst, id: uuid(), created_at: new Date().toISOString() };
    await repository.upsertInstrument(instrument);

    for (const contract of buildRollingContracts(instrument.id, instrument.symbol)) {
      await repository.upsertContract(contract);
    }
  }
}

/** Seed a starter set of structure templates so the app isn't empty on first run. */
async function seedDefaultTemplates() {
  const existing = await repository.getStructureTemplates();
  if (existing.length > 0) return;

  const outrightLegs: StructureTemplateLeg[] = [{ label: "Month", ratio: 1, month_offset: 0 }];
  const calendarLegs: StructureTemplateLeg[] = [
    { label: "Front Month", ratio: 1, month_offset: 0 },
    { label: "Back Month", ratio: -1, month_offset: 1 },
  ];
  const flyLegs: StructureTemplateLeg[] = [
    { label: "Month 1", ratio: 1, month_offset: 0 },
    { label: "Month 2", ratio: -2, month_offset: 1 },
    { label: "Month 3", ratio: 1, month_offset: 2 },
  ];

  const now = new Date().toISOString();
  const outright: StructureTemplate = { id: uuid(), name: "Outright", legs: outrightLegs, is_active: true, created_at: now };
  const calendarSpread: StructureTemplate = { id: uuid(), name: "Calendar Spread", legs: calendarLegs, is_active: true, created_at: now };
  const fly: StructureTemplate = { id: uuid(), name: "Fly", legs: flyLegs, is_active: true, created_at: now };

  // Double Fly's fixed outright pattern (+1/-3/+3/-1) is exactly what you
  // get by combining 2 adjacent Flies (+1/-2/+1 and +1/-2/+1 shifted by one
  // month) or 3 adjacent Spreads (+1/-1 shifted) — how it's actually
  // constructed/traded is chosen per-structure via "Base Structure" at
  // creation time, not baked into the template (spec V5).
  const doubleFlyLegs: StructureTemplateLeg[] = [
    { label: "Month 1", ratio: 1, month_offset: 0 },
    { label: "Month 2", ratio: -3, month_offset: 1 },
    { label: "Month 3", ratio: 3, month_offset: 2 },
    { label: "Month 4", ratio: -1, month_offset: 3 },
  ];
  const doubleFly: StructureTemplate = { id: uuid(), name: "Double Fly", legs: doubleFlyLegs, is_active: true, created_at: now };

  await repository.upsertStructureTemplate(outright);
  await repository.upsertStructureTemplate(calendarSpread);
  await repository.upsertStructureTemplate(fly);
  await repository.upsertStructureTemplate(doubleFly);
}
