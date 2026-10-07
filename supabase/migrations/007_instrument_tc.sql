-- Adds the per-instrument exchange transaction cost: $ per OUTRIGHT lot per
-- ROUND TURN (1 buy + 1 sell). The exchange charges per outright, so a
-- spread = 2x, a fly = 4x, a D-fly = 8x; half is charged on entry and half on
-- exit. Editable in Settings -> Instruments. Safe to run against an existing
-- database: additive only, nullable.
--
-- If a value is left null the app falls back to the schedule default for the
-- symbol (see engines/TransactionCostEngine.ts), so the update below only
-- makes the stored values explicit/editable from day one.

alter table instruments add column if not exists tc_per_outright_rt double precision;

update instruments set tc_per_outright_rt = 1.78 where tc_per_outright_rt is null and upper(symbol) in ('CL', 'BZ');
update instruments set tc_per_outright_rt = 1.90 where tc_per_outright_rt is null and upper(symbol) = 'BRN';
update instruments set tc_per_outright_rt = 2.04 where tc_per_outright_rt is null and upper(symbol) = 'WBS';
update instruments set tc_per_outright_rt = 2.10 where tc_per_outright_rt is null and upper(symbol) = 'GO';
