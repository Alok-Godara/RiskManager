-- ============================================================================
-- Risk Manager — Supabase / Postgres schema (V2)
--
-- Mirrors src/types/domain.ts 1:1 (same snake_case field names) so
-- SupabaseRepository needs zero field-mapping.
--
-- How to use:
--   1. Open your Supabase project's SQL Editor (left sidebar).
--   2. New query -> paste this whole file -> Run.
--   3. Copy Project Settings -> API -> "Project URL" and "anon public" key
--      into .env.local (see .env.example) as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
--   4. Restart `npm run dev` — the app will now read/write Supabase instead
--      of IndexedDB (see src/data/index.ts).
--
-- Security note: this schema enables Row Level Security with permissive
-- policies for the anon key (open read/write), matching the app's current
-- single-user, no-login design. Anyone with your anon key + URL could read
-- or write your data. That's fine for a private personal dashboard, but
-- before sharing the URL or deploying somewhere public, add Supabase Auth
-- and tighten these policies to `auth.uid() = owner_id`-style checks.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- instruments
-- ---------------------------------------------------------------------------
create table if not exists instruments (
  id uuid primary key,
  symbol text not null,
  name text not null,
  exchange_code text,
  tick_size double precision not null,
  tick_value double precision not null,
  lot_size double precision not null,
  currency text not null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- structure_templates — the fixed, fully-expanded outright ratio pattern
-- for a structure shape (e.g. Fly = [{label:"Month 1",ratio:1,month_offset:0},
-- {label:"Month 2",ratio:-2,month_offset:1},{label:"Month 3",ratio:1,month_offset:2}],
-- Double Fly = same idea with ratios +1/-3/+3/-1). How a structure is
-- actually CONSTRUCTED (as outrights, spreads, or flies) is a separate,
-- per-trade choice ("Base Structure") made at structure-creation time, not
-- stored on the template — see engines/StructureQuoteEngine.ts and
-- utils/decompose.ts. Defined before `contracts` because
-- contracts.quote_template_id references it.
-- ---------------------------------------------------------------------------
create table if not exists structure_templates (
  id uuid primary key,
  name text not null,
  code text,
  legs jsonb not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- contracts
-- ---------------------------------------------------------------------------
create table if not exists contracts (
  id uuid primary key,
  instrument_id uuid not null references instruments(id) on delete cascade,
  code text not null,
  month_label text not null,
  expiry_date timestamptz,
  market_data_symbol text,
  created_at timestamptz not null default now(),
  -- "Outright" (default/null) = single delivery month. "Structure" = a
  -- spread/fly the exchange quotes directly as one product (e.g. "Jan26
  -- Fly"), auto-created the first time a structure trades it — see
  -- StructureQuoteEngine. Priced and P&L'd directly via ITS OWN live quote,
  -- never synthesized from outright legs.
  kind text check (kind in ('Outright', 'Structure')),
  quote_template_id uuid references structure_templates(id) on delete set null,
  anchor_contract_id uuid references contracts(id) on delete set null
);
create index if not exists contracts_instrument_id_idx on contracts(instrument_id);
create index if not exists contracts_quote_lookup_idx on contracts(quote_template_id, anchor_contract_id);

-- ---------------------------------------------------------------------------
-- structures
-- ---------------------------------------------------------------------------
create table if not exists structures (
  id uuid primary key,
  instrument_id uuid not null references instruments(id) on delete restrict,
  structure_template_id uuid references structure_templates(id) on delete set null,
  name text not null,
  structure_type text not null,
  status text not null check (status in ('Open', 'Partially Closed', 'Modified', 'Fully Closed')),
  initial_dollar_risk double precision not null default 0,
  current_dollar_risk double precision not null default 0,
  initial_stop_loss double precision,
  current_stop_loss double precision,
  notes text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists structures_instrument_id_idx on structures(instrument_id);

-- ---------------------------------------------------------------------------
-- structure_legs
-- ---------------------------------------------------------------------------
create table if not exists structure_legs (
  id uuid primary key,
  structure_id uuid not null references structures(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete restrict,
  ratio double precision not null default 1,
  side text not null check (side in ('Long', 'Short')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
  -- Note: `contract_id` may reference either an outright Contract or a
  -- "Structure"-kind quote Contract (e.g. "Jan26 Fly") — see contracts.kind.
  -- The leg is never further decomposed for pricing/P&L.
);
create index if not exists structure_legs_structure_id_idx on structure_legs(structure_id);
create index if not exists structure_legs_contract_id_idx on structure_legs(contract_id);

-- ---------------------------------------------------------------------------
-- executions — the append-only source of truth for positions. Corrections
-- never mutate/delete a row: they add a new row and flip the old row's
-- `status` to 'Edited'/'Deleted' (see StructureEngine.editExecution/deleteExecution).
-- ---------------------------------------------------------------------------
create table if not exists executions (
  id uuid primary key,
  structure_leg_id uuid not null references structure_legs(id) on delete cascade,
  execution_type text not null check (execution_type in ('Entry', 'PartialExit', 'LegExit', 'FinalExit')),
  side text not null check (side in ('Long', 'Short')),
  quantity double precision not null,
  price double precision not null,
  risk_allocated double precision,
  max_adverse_ticks double precision,
  timestamp timestamptz not null default now(),
  notes text,
  -- Ties together every leg's Execution created by ONE Add Entry / Exit
  -- submission, so the UI can show "one entry" instead of one row per leg
  -- (see engines/EntryEngine.ts). A correction's replacement row always
  -- carries the original's entry_group_id forward.
  entry_group_id uuid not null,
  status text not null default 'Active' check (status in ('Active', 'Edited', 'Deleted')),
  edited_from_execution_id uuid,
  edited_to_execution_id uuid,
  edit_reason text
);
create index if not exists executions_structure_leg_id_idx on executions(structure_leg_id);
create index if not exists executions_entry_group_id_idx on executions(entry_group_id);

-- ---------------------------------------------------------------------------
-- positions (materialized/derived — keyed by structure_leg_id, recomputed by PositionEngine)
-- ---------------------------------------------------------------------------
create table if not exists positions (
  structure_leg_id uuid primary key references structure_legs(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete restrict,
  net_quantity double precision not null default 0,
  average_price double precision not null default 0,
  realized_pnl double precision not null default 0,
  last_updated timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- market_prices (latest known price per contract — keyed by contract_id)
-- ---------------------------------------------------------------------------
create table if not exists market_prices (
  contract_id uuid primary key references contracts(id) on delete cascade,
  price double precision not null,
  bid double precision,
  ask double precision,
  source text not null,
  timestamp timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- realized_pnl_events (regenerated wholesale for a leg whenever its
-- execution history changes — see StructureEngine.recomputeLegFull)
-- ---------------------------------------------------------------------------
create table if not exists realized_pnl_events (
  id uuid primary key,
  structure_id uuid not null references structures(id) on delete cascade,
  structure_leg_id uuid not null references structure_legs(id) on delete cascade,
  execution_id uuid not null references executions(id) on delete cascade,
  quantity double precision not null,
  entry_price double precision not null,
  exit_price double precision not null,
  realized_pnl double precision not null,
  timestamp timestamptz not null default now()
);
create index if not exists realized_pnl_events_structure_id_idx on realized_pnl_events(structure_id);
create index if not exists realized_pnl_events_leg_id_idx on realized_pnl_events(structure_leg_id);

-- ---------------------------------------------------------------------------
-- risk_allocations (structure-level and entry-level risk history)
-- ---------------------------------------------------------------------------
create table if not exists risk_allocations (
  id uuid primary key,
  structure_id uuid not null references structures(id) on delete cascade,
  execution_id uuid references executions(id) on delete cascade,
  dollar_risk double precision not null,
  reason text,
  timestamp timestamptz not null default now()
);
create index if not exists risk_allocations_structure_id_idx on risk_allocations(structure_id);
create index if not exists risk_allocations_execution_id_idx on risk_allocations(execution_id);

-- ---------------------------------------------------------------------------
-- stop_loss_history
-- ---------------------------------------------------------------------------
create table if not exists stop_loss_history (
  id uuid primary key,
  structure_id uuid not null references structures(id) on delete cascade,
  stop_loss_price_equivalent double precision,
  dollar_risk_basis double precision not null,
  reason text not null,
  timestamp timestamptz not null default now()
);
create index if not exists stop_loss_history_structure_id_idx on stop_loss_history(structure_id);

-- ---------------------------------------------------------------------------
-- audit_events (append-only log of everything that happens)
-- ---------------------------------------------------------------------------
create table if not exists audit_events (
  id uuid primary key,
  event_type text not null,
  structure_id uuid references structures(id) on delete set null,
  structure_leg_id uuid references structure_legs(id) on delete set null,
  execution_id uuid references executions(id) on delete set null,
  description text not null,
  payload jsonb,
  timestamp timestamptz not null default now()
);
create index if not exists audit_events_timestamp_idx on audit_events(timestamp desc);

-- ---------------------------------------------------------------------------
-- api_configs (Market Data Service provider configuration)
-- ---------------------------------------------------------------------------
create table if not exists api_configs (
  id uuid primary key,
  provider_name text not null,
  base_url text,
  api_key text,
  poll_interval_ms integer not null default 4000,
  enabled boolean not null default true
);

-- ============================================================================
-- Row Level Security — open policies for the anon key (single-user, no-login
-- design today). See the security note at the top of this file.
-- ============================================================================
alter table instruments enable row level security;
alter table contracts enable row level security;
alter table structure_templates enable row level security;
alter table structures enable row level security;
alter table structure_legs enable row level security;
alter table executions enable row level security;
alter table positions enable row level security;
alter table market_prices enable row level security;
alter table realized_pnl_events enable row level security;
alter table risk_allocations enable row level security;
alter table stop_loss_history enable row level security;
alter table audit_events enable row level security;
alter table api_configs enable row level security;

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'instruments','contracts','structure_templates','structures','structure_legs',
      'executions','positions','market_prices','realized_pnl_events','risk_allocations',
      'stop_loss_history','audit_events','api_configs'
    ])
  loop
    execute format('drop policy if exists "allow all (anon)" on %I;', t);
    execute format(
      'create policy "allow all (anon)" on %I for all using (true) with check (true);',
      t
    );
  end loop;
end $$;
