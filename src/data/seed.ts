import { v4 as uuid } from "uuid";
import { repository } from "./index";
import type { Instrument, Contract } from "../types/domain";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];

/** Seed a sensible default instrument/contract set for a crude & products trader. */
export async function seedIfEmpty(year = 26) {
  const existing = await repository.getInstruments();
  if (existing.length > 0) return;

  const instruments: Omit<Instrument, "id" | "created_at">[] = [
    { symbol: "BZ", name: "Brent Crude", tick_size: 0.01, tick_value: 10, lot_size: 1000, currency: "USD" },
    { symbol: "CL", name: "WTI Crude", tick_size: 0.01, tick_value: 10, lot_size: 1000, currency: "USD" },
    { symbol: "WBS", name: "WTI Midland (Houston)", tick_size: 0.01, tick_value: 10, lot_size: 1000, currency: "USD" },
    { symbol: "HO", name: "NY Harbor ULSD", tick_size: 0.0001, tick_value: 4.2, lot_size: 42000, currency: "USD" },
    { symbol: "RB", name: "RBOB Gasoline", tick_size: 0.0001, tick_value: 4.2, lot_size: 42000, currency: "USD" },
  ];

  for (const inst of instruments) {
    const instrument: Instrument = { ...inst, id: uuid(), created_at: new Date().toISOString() };
    await repository.upsertInstrument(instrument);

    for (const month of MONTHS) {
      const contract: Contract = {
        id: uuid(),
        instrument_id: instrument.id,
        code: `${instrument.symbol}-${month.toUpperCase()}${year}`,
        month_label: `${month}${year}`,
        market_data_symbol: `${instrument.symbol}-${month.toUpperCase()}${year}`,
        created_at: new Date().toISOString(),
      };
      await repository.upsertContract(contract);
    }
  }
}
