-- Adds the per-instrument QuantHub product code for QUOTED spreads / flies, for
-- instruments whose exchange lists them under a different product than the
-- outrights. CLBZ (WTI-Brent): outrights are WTCLCO<month>, the quoted calendar
-- spread ("spread box") is CLBZZX<m1>-<m2> (e.g. CLBZZXQ27-U27).
--
-- Optional: the app already knows CLBZ's code, so nothing breaks if this is not
-- run — it is only needed to set/change the code from Settings -> Instruments.
-- Additive only, nullable.

alter table instruments add column if not exists structure_exchange_code text;

update instruments set structure_exchange_code = 'CLBZZX'
  where structure_exchange_code is null and upper(coalesce(exchange_code, '')) = 'WTCLCO';
