import { useEffect, useState } from "react";
import { repository } from "../../data";
import type { AppSettings } from "../../types/domain";

const DEFAULTS: Omit<AppSettings, "id"> = {
  correlation_warning_threshold: 0.7,
  concentration_risk_threshold: 0.65,
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
        });
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        Used by Structures → Portfolio Correlation &amp; Concentration to decide when to warn. Both are 0–1 (e.g.
        0.70 = 70%).
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
            A pair of structures (or a new trade vs. an existing one) at or above this |correlation| gets flagged.
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
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="helper-text" style={{ marginLeft: 10 }}>Saved.</span>}
      </form>
    </div>
  );
}
