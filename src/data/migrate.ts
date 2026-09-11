import { v4 as uuid } from "uuid";
import { repository } from "./index";
import { parseMonthLabel, buildRollingContracts, sortContractsChronologically } from "../utils/contractGen";
import { lastTradingDay } from "../utils/contractExpiry";

const ROLLING_MONTHS = 24;

/**
 * One-time, idempotent backfill for records written before V2/V3 added new
 * fields. Without this, pre-existing local data would silently vanish
 * (instruments filtered out of Create Structure, executions excluded from
 * position recomputation) instead of carrying forward. Safe to run on every
 * startup — it only touches rows missing the new field.
 */
export async function runMigrations(): Promise<void> {
  const instruments = await repository.getInstruments();
  for (const inst of instruments) {
    if (inst.is_active === undefined) {
      await repository.upsertInstrument({ ...inst, is_active: true });
    }
  }

  const legs = await repository.getAllLegs();
  for (const leg of legs) {
    // Pre-V2 legs stored `ratio` as an unsigned magnitude alongside a
    // separate Long/Short `side` field. V2 derives direction from the sign
    // of `ratio` alone (see StructureEngine.sideFromRatio) — normalize old
    // rows so their sign matches their recorded side. No-op for rows
    // already consistent (all newly created legs already satisfy this).
    const expectedSign = leg.side === "Short" ? -1 : 1;
    if (Math.sign(leg.ratio) !== expectedSign && leg.ratio !== 0) {
      await repository.upsertLeg({ ...leg, ratio: Math.abs(leg.ratio) * expectedSign });
    }
  }

  for (const leg of legs) {
    const executions = await repository.getExecutionsByLeg(leg.id);
    for (const ex of executions) {
      if (ex.status === undefined) {
        await repository.addExecution({ ...ex, status: "Active" });
      }
      // Pre-"Entries" executions have no entry_group_id (see
      // Execution.entry_group_id / engines/EntryEngine.ts) — each becomes
      // its own single-leg entry group, since we can't know which other
      // legs were originally submitted alongside it.
      if (!ex.entry_group_id) {
        await repository.addExecution({ ...ex, entry_group_id: uuid() });
      }
    }
  }

  // Pre-expiry-rules contracts have `expiry_date` set to the 1st of their
  // month (a placeholder) or nothing at all — neither is a real
  // last-trading-day (see utils/contractExpiry.ts). Recompute every
  // outright's from the actual exchange rule, so front-month / Active vs.
  // Near Expiry vs. Expired logic is correct for contracts created before
  // this existed. Ordering still holds either way (LTDs increase
  // monotonically with delivery month), so nothing downstream breaks
  // mid-migration.
  const instrumentsById = new Map(instruments.map((i) => [i.id, i]));
  const contracts = await repository.getContracts();
  const correctedExpiryByContractId = new Map<string, string>();

  for (const c of contracts) {
    if (c.kind && c.kind !== "Outright") continue; // Structure quotes handled below, from their anchor
    const instrument = instrumentsById.get(c.instrument_id);
    const parsed = parseMonthLabel(c.month_label);
    if (!instrument || !parsed) continue;
    const correctExpiry = lastTradingDay(instrument, parsed).toISOString();
    correctedExpiryByContractId.set(c.id, correctExpiry);
    if (c.expiry_date !== correctExpiry) {
      await repository.upsertContract({ ...c, expiry_date: correctExpiry });
    }
  }

  // Structure-kind contracts (e.g. "Nov26 Fly") snapshot their anchor's
  // expiry_date at creation time (StructureQuoteEngine.resolveAsOneUnit) —
  // refresh that snapshot now that the anchor's own value may have just
  // been corrected above.
  for (const c of contracts) {
    if (!c.kind || c.kind !== "Structure" || !c.anchor_contract_id) continue;
    const anchorExpiry = correctedExpiryByContractId.get(c.anchor_contract_id);
    if (anchorExpiry && c.expiry_date !== anchorExpiry) {
      await repository.upsertContract({ ...c, expiry_date: anchorExpiry });
    }
  }

  // Pre-V3 structure templates have no `month_offset` on their legs, which
  // the anchor-based expansion (utils/templateExpansion.ts) requires.
  // Backfill with each leg's index — the sequential default that matches
  // how Fly/Calendar Spread templates were implicitly defined before.
  const templates = await repository.getStructureTemplates();
  for (const t of templates) {
    if (t.legs.some((l) => l.month_offset === undefined)) {
      await repository.upsertStructureTemplate({
        ...t,
        legs: t.legs.map((l, i) => ({ ...l, month_offset: l.month_offset ?? i })),
      });
    }
  }

  await ensureRollingContracts();
}

/**
 * Keep every instrument's contract list covering a rolling 24-month window
 * from today, generating only whatever months are missing. Idempotent and
 * cheap (a handful of reads/writes) — safe to call on every load, so the
 * window keeps extending forward as time passes without manual action.
 */
export async function ensureRollingContracts(): Promise<void> {
  const instruments = await repository.getInstruments();
  const now = new Date();
  for (const instrument of instruments) {
    const existing = sortContractsChronologically(await repository.getContractsByInstrument(instrument.id));
    const existingLabels = new Set(existing.map((c) => c.month_label));

    const wanted = buildRollingContracts(instrument, ROLLING_MONTHS, now);
    const missing = wanted.filter((c) => !existingLabels.has(c.month_label));
    for (const c of missing) {
      await repository.upsertContract({ ...c, id: uuid() });
    }
  }
}
