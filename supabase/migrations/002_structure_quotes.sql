-- Final migration for your database — brings it up to date with the app's
-- current schema, given only the original supabase/schema.sql has been run
-- so far (nothing else).
--
-- Tracks a trade at the actual structure level it was executed at (e.g. a
-- "Jan26 Fly" priced off its own live quote) instead of always decomposing
-- to outrights. `contracts` needs three new columns for that. Nothing else
-- has changed on your database — earlier drafts of this migration added a
-- `base_template_id` column and two `structure_legs` columns for an
-- approach that was superseded before you ran anything, so this is the
-- only migration you need.
--
-- Safe to run even with live data in place — it only adds columns.

alter table contracts
  add column if not exists kind text check (kind in ('Outright', 'Structure')),
  add column if not exists quote_template_id uuid references structure_templates(id) on delete set null,
  add column if not exists anchor_contract_id uuid references contracts(id) on delete set null;

create index if not exists contracts_quote_lookup_idx on contracts(quote_template_id, anchor_contract_id);
