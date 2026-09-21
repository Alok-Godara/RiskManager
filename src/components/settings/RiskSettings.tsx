import { useEffect, useState } from "react";
import { repository } from "../../data";
import type { AppSettings, CorrelationWindow } from "../../types/domain";
import { CORRELATION_WINDOWS } from "../../types/domain";
import { DEFAULT_PERIODS, DEFAULT_ROLLING_WINDOWS, normalizeWindowConfig } from "../../services/settlementData/correlationContext";

const DEFAULTS: Omit<AppSettings, "id"> = {
  correlation_warning_threshold: 0.7,
  concentration_risk_threshold: 0.65,
  correlation_periods: DEFAULT_PERIODS,
  correlation_rolling_windows: DEFAULT_ROLLING_WINDOWS,
};

/** Structures -> Portfolio Correlation & Concentration warning thresholds — see engines/CorrelationEngine.ts. */
export function RiskSettings() {
  const [form, setForm] = useState<Omit<AppSettings, "id">>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    repository.getAppSettings().then((settings) => {
      if (cancelled) return;
      if (settings) {
        setForm({
          correlation_warning_threshold: settings.correlation_warning_threshold,
          concentration_risk_threshold: settings.concentration_risk_threshold,
          correlation_periods: normalizeWindowConfig(settings.correlation_periods, DEFAULT_PERIODS),
          correlation_rolling_windows: normalizeWindowConfig(settings.correlation_rolling_windows, DEFAULT_ROLLING_WINDOWS),
        });
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function setPeriod(window: CorrelationWindow, days: number) {
    setForm((f) => ({ ...f, correlation_periods: { ...f.correlation_periods, [window]: days } }));
  }
  function setRollingWindow(window: CorrelationWindow, days: number) {
    setForm((f) => ({ ...f, correlation_rolling_windows: { ...f.correlation_rolling_windows, [window]: days } }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await repository.upsertAppSettings({ id: "default", ...form });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="panel">Loading…</div>;

  return (
    <div className="panel">
      <h2>Correlation &amp; Concentration Thresholds</h2>
      <p className="helper-text">
        Used by the Correlation tab to decide when to warn. Both are 0–1 (e.g. 0.70 = 70%).
      </p>
      <form className="form" onSubmit={handleSave}>
        <div className="form-row">
          <label>Correlation warning threshold</label>
          <input
            type="number"
            min={0}
            max={1}
            step="0.05"
            value={form.correlation_warning_threshold}
            onChange={(e) => setForm({ ...form, correlation_warning_threshold: Number(e.target.value) })}
          />
          <p className="helper-text">
            A pair of structures (or a new entry vs. an existing one) at or above this |correlation| gets flagged.
          </p>
        </div>
        <div className="form-row">
          <label>Concentration risk threshold</label>
          <input
            type="number"
            min={0}
            max={1}
            step="0.05"
            value={form.concentration_risk_threshold}
            onChange={(e) => setForm({ ...form, concentration_risk_threshold: Number(e.target.value) })}
          />
          <p className="helper-text">
            When the risk-weighted same-direction fraction across the whole book reaches this level, the portfolio
            is flagged as one-directional.
          </p>
        </div>

        <h3>Per-Window Period &amp; Rolling Window</h3>
        <p className="helper-text">
          <strong>Period</strong> is how many trading days of settlement history that column looks back over.{" "}
          <strong>Rolling window</strong> is the sub-window size used for each individual correlation point within
          that period, slid one day at a time — e.g. period 30 / window 7 computes a 7-day correlation for days
          1–7, then 2–8, then 3–9, ... 24–30, showing a trend across the period instead of one static number.
          Rolling window can't exceed its period.
        </p>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Column</th>
              <th>Period (trading days)</th>
              <th>Rolling Window (days)</th>
            </tr>
          </thead>
          <tbody>
            {CORRELATION_WINDOWS.map((w) => (
              <tr key={w}>
                <td>{w}d</td>
                <td>
                  <input
                    type="number"
                    min={2}
                    value={form.correlation_periods[w]}
                    onChange={(e) => setPeriod(w, Math.max(2, Number(e.target.value)))}
                    style={{ width: 80 }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={2}
                    max={form.correlation_periods[w]}
                    value={form.correlation_rolling_windows[w]}
                    onChange={(e) => setRollingWindow(w, Math.max(2, Number(e.target.value)))}
                    style={{ width: 80 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="helper-text" style={{ marginLeft: 10 }}>Saved.</span>}
      </form>
    </div>
  );
}
