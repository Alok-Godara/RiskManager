-- Adds the Execution Error tracker (Dashboard -> "Execution Error" card).
--
-- A plain ledger: each row is one adjustment in dollars — negative for money
-- lost to an execution mistake, positive for money gained by one. The card on
-- the Dashboard shows the running total. It is NOT part of any P&L figure; it
-- is only for tracking how much execution errors cost.
--
-- Safe to run more than once. Run it in the Supabase SQL editor.

create table if not exists execution_errors (
  id uuid primary key,
  amount double precision not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists execution_errors_created_at_idx on execution_errors(created_at desc);

alter table execution_errors enable row level security;
drop policy if exists "allow all (anon)" on execution_errors;
create policy "allow all (anon)" on execution_errors for all using (true) with check (true);
