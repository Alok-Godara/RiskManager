-- Merges duplicate contract rows and prevents them coming back.
--
-- Background: the rolling-contract top-up ran twice at once (two tabs / a
-- double-rendered effect), and each run inserted its own copy of every missing
-- month, so an instrument ended up with e.g. two "Dec26" rows. The app now
-- ignores the twins when picking months and uses deterministic contract ids,
-- but any structure that already holds a leg on the "other" twin would not net
-- against positions on the first one — this script merges them properly.
--
-- What it does, in one transaction:
--   1. For every (instrument, code) outright with more than one row, keeps the
--      row that structure legs already point at (most legs first, else the
--      oldest), and re-points structure_legs / positions / quote anchors from
--      the others to it.
--   2. Deletes the leftover twins (their market_prices and settlement_prices
--      rows go with them via ON DELETE CASCADE — the app re-fetches settlement
--      history for the surviving row on its own).
--   3. Does the same for duplicate "Structure" quote contracts (same template
--      + anchor), which can only be detected after step 1 re-pointed anchors.
--   4. Adds a unique index so a duplicate outright can never be inserted again.
--
-- Safe to re-run (it is a no-op once clean). Run it in the Supabase SQL editor.
-- To preview what would be merged first, run just the SELECT at the bottom.

begin;

-- 1. outrights -------------------------------------------------------------
create temp table contract_keep on commit drop as
select c.id as dup_id,
       first_value(c.id) over (
         partition by c.instrument_id, c.code
         order by (select count(*) from structure_legs l where l.contract_id = c.id) desc, c.created_at, c.id
       ) as keep_id
from contracts c
where c.kind is null or c.kind = 'Outright';

delete from contract_keep where dup_id = keep_id;

update structure_legs l set contract_id = k.keep_id from contract_keep k where l.contract_id = k.dup_id;
update positions p set contract_id = k.keep_id from contract_keep k where p.contract_id = k.dup_id;
update contracts c set anchor_contract_id = k.keep_id from contract_keep k where c.anchor_contract_id = k.dup_id;
delete from contracts c using contract_keep k where c.id = k.dup_id;

-- 2. structure quotes (same template + anchor) -----------------------------
create temp table quote_keep on commit drop as
select c.id as dup_id,
       first_value(c.id) over (
         partition by c.instrument_id, c.quote_template_id, c.anchor_contract_id
         order by (select count(*) from structure_legs l where l.contract_id = c.id) desc, c.created_at, c.id
       ) as keep_id
from contracts c
where c.kind = 'Structure' and c.quote_template_id is not null and c.anchor_contract_id is not null;

delete from quote_keep where dup_id = keep_id;

update structure_legs l set contract_id = k.keep_id from quote_keep k where l.contract_id = k.dup_id;
update positions p set contract_id = k.keep_id from quote_keep k where p.contract_id = k.dup_id;
delete from contracts c using quote_keep k where c.id = k.dup_id;

-- 3. never again ------------------------------------------------------------
create unique index if not exists contracts_outright_code_key
  on contracts (instrument_id, code)
  where kind is null or kind = 'Outright';

commit;

-- Preview (read-only): outright months that currently exist more than once.
-- select i.symbol, c.code, count(*) as copies
-- from contracts c join instruments i on i.id = c.instrument_id
-- where c.kind is null or c.kind = 'Outright'
-- group by i.symbol, c.code having count(*) > 1 order by i.symbol, c.code;
