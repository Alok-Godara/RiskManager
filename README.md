# Risk Manager — Local-First, Deployment-Ready

A structure-based trading risk manager for futures/spread trading (crude & petroleum
products), built to run entirely locally today and migrate to a hosted web app
later **without a rewrite**. Fully configuration-driven — instruments and structure
types (Fly, Calendar Spread, etc.) are defined by you in Settings, never hard-coded.

## Run it

```bash
npm install
npm run dev       # local dev server
npm run build     # production build -> dist/
```

By default everything persists in your browser's IndexedDB (`risk_manager_db`)
— no server, no account, no external calls required. Market prices are
simulated out of the box (`SimulatedProvider`) so the dashboard is fully
usable immediately.

### Optional: connect Supabase for cloud persistence

To store data in a real Postgres database instead of the browser:

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL Editor in your project, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. In your Supabase project, go to Project Settings → API and copy the
   **Project URL** and **anon public** key.
4. Copy `.env.example` to `.env.local` and fill in those two values:
   ```
   VITE_SUPABASE_URL=https://xxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```
5. Restart `npm run dev`. The sidebar's data-source pill will switch from
   "Local (IndexedDB)" to "Supabase", and all reads/writes now go through
   `SupabaseRepository` — no other code changes needed (see `src/data/index.ts`).

The schema enables Row Level Security with an open policy for the anon key,
matching the app's current single-user, no-login design — see the security
note at the top of `supabase/schema.sql` before sharing the URL/key or
deploying somewhere public.

## Architecture (layers, per the spec)

```
src/
  types/domain.ts        Domain model — mirrors the Postgres/Supabase schema
  data/
    DataRepository.ts    The ONLY persistence interface the app talks to
    LocalRepository.ts   IndexedDB implementation (default, zero setup)
    SupabaseRepository.ts  Supabase/Postgres implementation (used when configured)
    indexedDb.ts          Low-level IndexedDB wrapper
    supabase/client.ts    The only file that reads Supabase env vars
    index.ts              Single swap point: local vs. Supabase, env-driven
    seed.ts               Seeds starter instruments + structure templates
    migrate.ts             One-time backfill for fields added after first release
  engines/                Pure calculation layer, no UI or storage-format coupling
    PositionEngine.ts     Executions -> weighted avg price, FIFO realized P&L
    PnLEngine.ts           Realized/unrealized/total P&L at every level
    RiskEngine.ts          Dollar risk + dynamic stop-loss recalculation
    StructureEngine.ts    Orchestrates structure/leg/execution lifecycle,
                           entry/exit/edit/delete, audit log
    InstrumentEngine.ts    True contract-level net exposure across all open structures
    PortfolioEngine.ts     Top-level portfolio roll-up
  services/
    MarketDataService.ts  Provider-agnostic price fetching, decoupled from UI.
                           Polls only the contracts required by open positions.
  utils/
    priceAllocation.ts    Distributes a net structure price across legs
    contractGen.ts         Generates monthly contracts for a new instrument
  components/             UI — reads only through engines/repository, never
                           touches IndexedDB or fetch() directly
    settings/              Instrument + Structure Template management
  hooks/useRiskManagerData.ts   Wires engines -> React state, drives polling
```

### Why this survives the move to a web app

- **UI never touches storage.** All reads/writes go through `DataRepository`.
  Swapping `LocalRepository` for `SupabaseRepository` (same interface, picked
  automatically by `src/data/index.ts` based on env vars) is the only change
  needed anywhere in the app.
- **UI never touches the network.** All price fetching goes through
  `MarketDataService`, which itself delegates to a swappable `MarketDataProvider`.
  When deployed, the polling loop can move from `setInterval` in the browser to
  a background worker/serverless function — the rest of the app is unaffected,
  since it only ever reads the latest price via the repository.
- **Calculations are pure and storage-agnostic.** `PositionEngine`, `PnLEngine`,
  `RiskEngine` etc. take/return plain domain objects.
- **Nothing is hard-coded.** Instruments and structure types are user-managed
  records (Settings → Instruments / Structure Templates), not code constants.
  Adding a new instrument or structure shape never requires a deploy.
- **History is append-only.** Executions are never destructively edited or
  deleted — corrections create a new row and mark the old one `Edited`/`Deleted`
  (`StructureEngine.editExecution` / `deleteExecution`), so realized P&L, risk,
  and audit history stay reconstructable.

## Migrating to the web later

1. ✅ `SupabaseRepository implements DataRepository` already exists, used
   automatically once `.env.local` has Supabase credentials — see above.
2. ✅ The swap in `src/data/index.ts` is env-driven already — nothing to change.
3. Implement a real `MarketDataProvider` (e.g. wrapping your data vendor's
   REST/WebSocket API) and call `MarketDataService.setProvider(...)`.
4. Move the polling loop (`MarketDataService.start`) into a background worker
   or scheduled function (e.g. a Supabase Edge Function on a cron) that writes
   prices via the same `DataRepository`, and have the browser simply read the
   latest row.
5. Deploy with `netlify.toml` (already included) or any static host — the
   frontend build doesn't change. Set the same `VITE_SUPABASE_*` values as
   environment variables in Netlify.

## Structure templates — the core concept

A **Structure Template** (Settings → Structure Templates) is the fixed,
fully-expanded outright ratio pattern for a shape — nothing more:

| Template | Legs (signed ratio) |
| --- | --- |
| Outright | `+1` |
| Calendar Spread | `+1 / -1` |
| Fly | `+1 / -2 / +1` |
| Double Fly | `+1 / -3 / +3 / -1` |

Positive = long, negative = short. Each leg also carries a `month_offset`
(months forward from a single anchor contract). Note Double Fly's pattern is
exactly what you get from 2 adjacent Flies, or 3 adjacent Calendar Spreads —
that's not a coincidence, see below.

**How a structure is actually constructed/traded is a separate choice made
every time you create one** — not baked into the template. Alongside the
Structure Template, you pick a **Base Structure** (Outright / Spread / Fly /
any other template) and one anchor contract. `utils/decompose.ts` then
*deconvolves* the target pattern into shifted, weighted copies of the base
structure's own pattern — e.g. Double Fly ÷ Fly = `+1` Fly@anchor, `-1`
Fly@anchor+1month; Double Fly ÷ Spread = `+1/-2/+1` across 3 consecutive
spreads. A Direction toggle (Long/Short) flips every resulting leg's sign.

**Positions are tracked at whatever level was actually traded, never
auto-decomposed to outrights.** Each resulting leg is a `StructureLeg`
referencing a `Contract` — either a plain outright, or (for a non-trivial
base structure) one with `kind: "Structure"` (e.g. "Jan26 Fly", auto-created
the first time that anchor+template combination trades, reused after) —
priced, entered and exited directly off ITS OWN live quote, exactly like a
real exchange-quoted spread/fly. `engines/StructureQuoteEngine.ts` resolves
these at creation time; `utils/templateExpansion.ts` can still decompose a
quote down to outrights, but ONLY for the Positions tab's true
contract-exposure view — never for pricing or P&L. A "Custom (build
manually)" option is always available for one-off structures that don't fit
a saved template.

## Current feature set (Version 5)

- Supabase/Postgres (or local IndexedDB) persistence behind a single `DataRepository`
- Instrument management (Settings → Instruments): add/edit/deactivate/delete
  (blocked if in use), with rolling 24-month contract generation that keeps
  extending forward on its own — only active instruments appear when creating
  a structure
- Structure Template management (Settings → Structure Templates): define your
  own signed-ratio structure shapes, optionally built from another template as
  a base structure (composite/nested templates), instead of hard-coded types
- Structures tab shows the list + portfolio risk by default; "+ New Structure"
  opens the creation flow as its own page
- Simplified structure creation: Instrument → Template → one type-ahead anchor
  contract → auto-suggested (editable) name — every leg's contract derives
  from the anchor automatically
- One "Add Entry" modal per structure — enter structure lots; each leg's
  execution price defaults to its own live quote (outright or structure-level,
  e.g. "Jan26 Fly"), editable per leg for your actual fill
- One "Exit / Reduce" modal — exit by structure lots (auto-filling each leg's
  close quantity) or set each leg's close quantity individually for a partial
  exit; exit price likewise defaults to the live quote, editable
- Edit or delete any past execution (wrong price/qty/time/contract) — the
  original is kept and marked `Edited`/`Deleted`, a corrected row replaces it,
  and position, realized P&L, risk and stop-loss all recompute automatically
- Multiple scale-in entries with weighted average price (FIFO realized P&L on exit)
- Realized, unrealized, and total P&L at entry / leg / structure / instrument /
  portfolio level, color-coded green/red throughout
- Structure-level and entry-level dollar risk; dynamic stop-loss/risk
  adjustment as realized profit is booked (Initial vs Adjusted Current shown
  side by side)
- Instrument-level net position view (true contract exposure across all open
  structures) and a portfolio-level summary dashboard
- Complete, append-only audit trail of every action (History tab, portfolio-wide)
- Continuous simulated market data polling, scoped only to contracts in open positions
