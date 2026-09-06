-- Adds Execution.entry_group_id — ties together every leg's execution row
-- created by ONE Add Entry / Exit submission, so the app can show "one
-- entry" (StructureDetail's Entries table, see engines/EntryEngine.ts)
-- instead of one row per leg. Run this after 002_structure_quotes.sql.
--
-- Safe to run even with live data in place: existing rows are backfilled so
-- each becomes its own single-leg entry group (we can't know which other
-- legs were originally submitted alongside an old row), then the column is
-- locked to not null to match what the app now always writes.

alter table executions
  add column if not exists entry_group_id uuid;

update executions set entry_group_id = gen_random_uuid() where entry_group_id is null;

alter table executions
  alter column entry_group_id set not null;

create index if not exists executions_entry_group_id_idx on executions(entry_group_id);
