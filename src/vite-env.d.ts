/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Same-origin base path proxied to the QuantHub API. Defaults to "/qh-api". */
  readonly VITE_QH_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Injected by vite.config.ts: true when QH_API_TOKEN is configured on the
 * server side. The token itself never reaches the client bundle.
 */
declare const __QH_CONFIGURED__: boolean;
