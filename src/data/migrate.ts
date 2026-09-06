import { v4 as uuid } from "uuid";
import { repository } from "./index";
import { parseMonthLabel, buildRollingContracts, sortContractsChronologically } from "../utils/contractGen";

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

  // Pre-V3 contracts have no `expiry_date`, which the anchor + month_offset
  // logic (utils/templateExpansion.ts) needs to sort contracts
  // chronologically. Backfill it by parsing the month label.
  const contracts = await repository.getContracts();
  for (const c of contracts) {
    if (!c.expiry_date) {
      const parsed = parseMonthLabel(c.month_label);
      if (parsed) {
        await repository.upsertContract({ ...c, expiry_date: parsed.toISOString() });
      }
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

    const wanted = buildRollingContracts(instrument.id, instrument.symbol, ROLLING_MONTHS, now);
    const missing = wanted.filter((c) => !existingLabels.has(c.month_label));
    for (const c of missing) {
      await repository.upsertContract({ ...c, id: uuid() });
    }
  }
}
