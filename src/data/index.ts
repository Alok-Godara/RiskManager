import { LocalRepository } from "./LocalRepository";
import type { DataRepository } from "./DataRepository";

// -----------------------------------------------------------------------
// SINGLE SWAP POINT.
// When moving to Supabase, implement `SupabaseRepository implements
// DataRepository` and change this one line. Nothing else in the app
// (engines, services, UI) needs to change.
// -----------------------------------------------------------------------
export const repository: DataRepository = new LocalRepository();

export type { DataRepository };
