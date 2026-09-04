import { LocalRepository } from "./LocalRepository";
import { SupabaseRepository } from "./SupabaseRepository";
import { isSupabaseConfigured } from "./supabase/client";
import type { DataRepository } from "./DataRepository";

// -----------------------------------------------------------------------
// SINGLE SWAP POINT.
//
// If VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set (see .env.example),
// the app talks to Supabase/Postgres. Otherwise it falls back to the local
// IndexedDB repository so the app keeps working with zero setup.
//
// Nothing else in the app (engines, services, UI) needs to change either
// way — everything talks to the `DataRepository` interface only.
// -----------------------------------------------------------------------
export const repository: DataRepository = isSupabaseConfigured
  ? new SupabaseRepository()
  : new LocalRepository();

export const isCloudConfigured = isSupabaseConfigured;
export type { DataRepository };
