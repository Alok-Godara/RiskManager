-- Adds an optional per-instrument override for the settlement/refdata feed's
-- own product symbol (its HGProductKey, e.g. "ICE:BRN" -> "BRN"), which is a
-- different convention than the QuantHub exchange_code column added earlier.
-- Settings -> Instruments -> "Settlement API Product Symbol". Safe to run
-- against an existing database: additive only, defaults to null (falls back
-- to `symbol` in code — see services/settlementData/settlementHistoryService.ts).

alter table instruments add column if not exists refdata_symbol text;
