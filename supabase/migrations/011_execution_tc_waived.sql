-- Lets a fill be marked "without transaction cost" (Exit / Add Entry / Correction
-- windows): used when nothing is really traded — e.g. a fly is moved out of one
-- trade and into another, so the bookkeeping exit (and re-entry) should not be
-- charged. TransactionCostEngine.executionCost charges 0 for such a fill.
--
-- Only needed before you tick that box for the first time; ordinary fills do not
-- touch the column. Safe to run more than once. Run it in the Supabase SQL editor.

alter table executions add column if not exists tc_waived boolean;
