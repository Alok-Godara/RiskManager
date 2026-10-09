-- One-off data update: sets the risk allocated to EVERY existing entry to
-- $50 per lot (the new default for entries — see DEFAULT_RISK_PER_LOT).
--
-- Lots of an entry:
--   * a normal structure entry (every leg of the trade, lots proportional to the
--     leg ratios): its structure lots, e.g. 3 Flies = 3 lots -> $150;
--   * anything else (single-leg or edited-lot entries): the total leg lots.
-- Same definition the app uses (EntrySnapshot.structure_lots).
--
-- The risk figure lives on ONE execution per entry (its earliest leg), so that
-- row gets the amount and the entry's other legs are cleared (null), exactly as
-- Add Entry stores it. Only live (status = 'Active') entry executions are
-- touched; superseded/deleted history rows and the risk_allocations log are left
-- as they were.
--
-- This overwrites the risk you typed on past entries, so run it once, on purpose,
-- in the Supabase SQL editor. It is NOT undoable — to be safe, take a copy first:
--   create table executions_backup_risk as select id, risk_allocated from executions;

begin;

with ex as (
  select e.id, e.entry_group_id, e.quantity, e.timestamp, l.structure_id,
         e.quantity / nullif(abs(l.ratio), 0) as per_unit
  from executions e
  join structure_legs l on l.id = e.structure_leg_id
  where e.status = 'Active' and e.execution_type = 'Entry'
),
leg_counts as (
  select structure_id, count(*) as legs_in_structure from structure_legs group by structure_id
),
grp as (
  select ex.entry_group_id, ex.structure_id, count(*) as n_legs, sum(ex.quantity) as total_qty,
         max(per_unit) as max_u, min(per_unit) as min_u
  from ex group by ex.entry_group_id, ex.structure_id
),
lots as (
  select g.entry_group_id,
         case when g.n_legs = c.legs_in_structure
                   and g.max_u is not null
                   and g.max_u - g.min_u <= 1e-9 * greatest(1, g.max_u)
              then g.max_u
              else g.total_qty end as lots
  from grp g join leg_counts c on c.structure_id = g.structure_id
),
first_ex as (
  select distinct on (entry_group_id) id, entry_group_id
  from ex order by entry_group_id, timestamp, id
)
update executions e
set risk_allocated = case when e.id = f.id then round((50 * l.lots)::numeric, 2) else null end
from lots l
join first_ex f on f.entry_group_id = l.entry_group_id
where e.entry_group_id = l.entry_group_id
  and e.status = 'Active'
  and e.execution_type = 'Entry';

commit;

-- Preview (read-only), before or after: risk per entry.
-- select entry_group_id, sum(risk_allocated) as risk, count(*) as legs, min(timestamp) as at
-- from executions where status = 'Active' and execution_type = 'Entry'
-- group by entry_group_id order by at desc;
