-- Supports per-entry direction and entry-scoped exits (a structure no
-- longer has a fixed Long/Short baked in at creation — each entry picks its
-- own), and configurable correlation period/rolling-window settings.
-- Safe to run against an existing database: additive only.

alter table executions add column if not exists closes_entry_group_id uuid;

alter table app_settings add column if not exists correlation_periods jsonb;
alter table app_settings add column if not exists correlation_rolling_windows jsonb;
