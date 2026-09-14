-- Adds the two tables the Portfolio Correlation & Concentration feature
-- needs (Structures section): settlement_prices (historical daily closes
-- per outright contract, fetched from the reference-data settlement feed —
-- see src/services/settlementData/) and app_settings (a single row holding
-- the correlation/concentration warning thresholds).
--
-- Safe to run even with live data in place — it only adds tables.

create table if not exists settlement_prices (
  id text primary key,
  contract_id uuid not null references contracts(id) on delete cascade,
  date date not null,
  price double precision not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (contract_id, date)
);
create index if not exists settlement_prices_contract_id_idx on settlement_prices(contract_id);
create index if not exists settlement_prices_date_idx on settlement_prices(date);

create table if not exists app_settings (
  id text primary key,
  correlation_warning_threshold double precision not null default 0.7,
  concentration_risk_threshold double precision not null default 0.65
);

alter table settlement_prices enable row level security;
alter table app_settings enable row level security;

drop policy if exists "allow all (anon)" on settlement_prices;
create policy "allow all (anon)" on settlement_prices for all using (true) with check (true);

drop policy if exists "allow all (anon)" on app_settings;
create policy "allow all (anon)" on app_settings for all using (true) with check (true);
