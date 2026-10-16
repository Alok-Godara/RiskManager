import { useCallback, useEffect, useState } from "react";
import { v4 as uuid } from "uuid";
import { repository } from "../data";
import type { ExecutionError } from "../types/domain";
import { fmtMoney, pnlClass } from "../utils/format";
import { InfoTip } from "./InfoTip";

function describeError(err: unknown): string {
  const message =
    err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "Something went wrong";
  if (message.includes("execution_errors")) {
    return "The database doesn't have the execution-error table yet. Run supabase/migrations/010_execution_errors.sql in the Supabase SQL editor, then refresh.";
  }
  return message;
}

/**
 * Dashboard tracker for money lost (or gained) to execution mistakes. A plain
 * running total of dollar adjustments — negative = lost, positive = gained.
 * Not part of any P&L figure; it only exists so you can see what mistakes cost.
 * Read once when the Dashboard opens and again after each change (a tiny table).
 */
export function ExecutionErrorCard() {
  const [entries, setEntries] = useState<ExecutionError[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setEntries(await repository.getExecutionErrors());
      setError("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const total = entries.reduce((sum, e) => sum + e.amount, 0);

  /** `sign` -1 = loss, +1 = gain; the typed number's own sign is ignored so the buttons are never ambiguous. */
  async function add(sign: 1 | -1) {
    const value = Math.abs(Number(amount));
    if (!amount.trim() || !Number.isFinite(value) || value === 0) {
      setError("Enter the dollar amount first, then press Loss or Gain.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await repository.addExecutionError({
        id: uuid(),
        amount: sign * value,
        note: note.trim() || undefined,
        created_at: new Date().toISOString(),
      });
      setAmount("");
      setNote("");
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: ExecutionError) {
    if (!window.confirm(`Remove this entry (${fmtMoney(entry.amount)}${entry.note ? ` — ${entry.note}` : ""})? The total will change.`)) return;
    try {
      await repository.deleteExecutionError(entry.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="stat-card execution-error-card">
      <div className="stat-label">
        Execution Error
        <InfoTip>
          A running total of money lost (or gained) because of execution mistakes — slippage, a wrong fill, a missed stop. Enter
          the dollar amount and press Loss to subtract it or Gain to add it. It is only for tracking: it is not included in any
          P&amp;L figure.
        </InfoTip>
      </div>
      <div className={`stat-value ${pnlClass(total)}`}>{loaded ? fmtMoney(total) : "…"}</div>
      <div className="stat-sub">
        {entries.length === 0 ? "Nothing logged yet" : total < 0 ? "Lost to execution errors" : total > 0 ? "Gained from execution errors" : "Net zero"}
      </div>

      <div className="execution-error-form">
        <input
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          placeholder="Amount ($)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Execution error amount in dollars"
        />
        <input
          type="text"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Execution error note"
        />
        <button type="button" className="danger" disabled={saving} onClick={() => add(-1)}>
          − Loss
        </button>
        <button type="button" className="success" disabled={saving} onClick={() => add(1)}>
          + Gain
        </button>
      </div>
      {error && <p className="helper-text" style={{ color: "var(--red)", marginTop: 8 }}>{error}</p>}

      {entries.length > 0 && (
        <details className="execution-error-history">
          <summary>History ({entries.length})</summary>
          <table className="data-table">
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.created_at).toLocaleDateString()}</td>
                  <td className={pnlClass(e.amount)}>{fmtMoney(e.amount)}</td>
                  <td className="muted">{e.note ?? ""}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => remove(e)} aria-label="Remove entry">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
