import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------
// This file is the ONLY place that reads Supabase env vars / constructs the
// client. Nothing else in the app imports "@supabase/supabase-js" directly.
//
// Configure by creating a `.env.local` (see `.env.example`) with:
//   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
//   VITE_SUPABASE_ANON_KEY=...
//
// If those are absent, `isSupabaseConfigured` is false and `data/index.ts`
// falls back to the local IndexedDB repository — the app runs either way.
// -----------------------------------------------------------------------

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Accept either the bare project URL or one with a path (e.g. copied with a
// trailing "/rest/v1/") — the JS client wants just the origin.
const url = rawUrl ? rawUrl.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "") : rawUrl;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, anonKey as string)
  : null;
