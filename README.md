# Risk Manager — Local-First, Deployment-Ready

A structure-based trading risk manager for futures/spread trading (crude & petroleum
products), built to run entirely locally today and migrate to a hosted web app
later **without a rewrite**.

## Run it

```bash
npm install
npm run dev       # local dev server
npm run build     # production build -> dist/
```

Everything persists in your browser's IndexedDB (`risk_manager_db`) — no server,
no account, no external calls required. Market prices are simulated out of the
box (`SimulatedProvider`) so the dashboard is fully usable immediately.

## Architecture (layers, per the spec)

```
src/
  types/domain.ts        Domain model — mirrors the future Postgres/Supabase schema
  data/
    DataRepository.ts    The ONLY persistence interface the app talks to
    LocalRepository.ts   Today's implementation (IndexedDB)
    indexedDb.ts          Low-level IndexedDB wrapper
    index.ts              Single swap point: change repository here to go to Supabase
    seed.ts                Seeds Brent/WTI/WBS/HO/RB instruments+contracts on first run
  engines/                Pure calculation layer, no UI or storage-format coupling
    PositionEngine.ts     Executions -> weighted avg price, FIFO realized P&L
    PnLEngine.ts           Realized/unrealized/total P&L at every level
    RiskEngine.ts          Dollar risk + dynamic stop-loss recalculation
    StructureEngine.ts    Orchestrates structure/leg/execution lifecycle + audit log
    InstrumentEngine.ts    True contract-level net exposure across all open structures
    PortfolioEngine.ts     Top-level portfolio roll-up
  services/
    MarketDataService.ts  Provider-agnostic price fetching, decoupled from UI.
                           Polls only the contracts required by open positions.
  components/             UI — reads only through engines/repository, never
                           touches IndexedDB or fetch() directly
  hooks/useRiskManagerData.ts   Wires engines -> React state, drives polling
```

### Why this survives the move to a web app

- **UI never touches storage.** All reads/writes go through `DataRepository`.
  Swapping `LocalRepository` for a future `SupabaseRepository` (same interface)
  is the only change needed anywhere in the app.
- **UI never touches the network.** All price fetching goes through
  `MarketDataService`, which itself delegates to a swappable `MarketDataProvider`.
  When deployed, the polling loop can move from `setInterval` in the browser to
  a background worker/serverless function — the rest of the app is unaffected,
  since it only ever reads the latest price via the repository.
- **Calculations are pure and storage-agnostic.** `PositionEngine`, `PnLEngine`,
  `RiskEngine` etc. take/return plain domain objects. They'd work identically
  whether the data came from IndexedDB or a Postgres row.
- **The data model already looks relational.** Every entity has a `uuid` id
  and explicit foreign keys (`structure_id`, `structure_leg_id`, `contract_id`,
  `instrument_id`) instead of nested blobs, so it maps directly onto normalized
  Supabase/Postgres tables later.
- **History is append-only.** Executions, realized P&L events, stop-loss
  records and the audit log are never mutated or deleted — only new rows are
  added — matching how you'd want an audit-safe ledger to behave in production.

## Migrating to the web later

1. Implement `SupabaseRepository implements DataRepository` (same method
   signatures, backed by Supabase tables mirroring `src/types/domain.ts`).
2. Swap the single line in `src/data/index.ts`.
3. Implement a real `MarketDataProvider` (e.g. wrapping your data vendor's
   REST/WebSocket API) and call `MarketDataService.setProvider(...)`.
4. Move the polling loop (`MarketDataService.start`) into a background worker
   or scheduled serverless function that writes prices via the same
   `DataRepository`, and have the browser simply read the latest row.
5. Deploy with `netlify.toml` (already included) or any static host — the
   frontend build doesn't change.

## Current feature set (Version 1)

- Instrument → Structure → Legs → Entries/Exits hierarchy
- Outright / Spread / Fly / Custom structure types with weighted leg ratios
- Multiple scale-in entries with weighted average price (FIFO realized P&L on exit)
- Partial exits and full leg exits without breaking the parent structure's identity
- Realized, unrealized, and total P&L at entry / leg / structure / instrument /
  portfolio level
- Structure-level and entry-level dollar risk
- Dynamic stop-loss / risk adjustment as realized profit is booked (Initial vs
  Adjusted Current Risk-SL shown side by side)
- Instrument-level net position dashboard (true contract exposure across all
  open structures)
- Portfolio-level summary dashboard
- Complete, append-only audit trail of every action
- Continuous simulated market data polling, scoped only to contracts in open positions
