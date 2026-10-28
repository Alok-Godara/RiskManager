-- "Exit without TC and P&L (transfer to another trade)" — Exit / Correction windows.
--
-- Marks an exit whose lots are being moved into another trade rather than really
-- exited. In the trade they leave, those lots are treated as if they had never been
-- there: no P&L is realized on them and no transaction cost, entry or exit side, is
-- counted for them. The other trade re-enters them at the original entry price and
-- carries their costs and P&L from there.
--
-- This replaces the earlier tc_waived tick-box (migration 011); that column is kept
-- (nothing reads it any more except as a "this one fill is free" leftover) so
-- running this on a database that already has it is fine.
--
-- Only needed before you use the tick-box for the first time; ordinary exits do not
-- touch the column. Safe to run more than once. Run it in the Supabase SQL editor.

alter table executions add column if not exists transfer_out boolean;
