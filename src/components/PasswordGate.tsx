import { useState, type FormEvent, type ReactNode } from "react";

/**
 * A soft, DECORATIVE access gate — not real security. The password ships in
 * the client-side JS bundle in plain text; anyone who opens devtools can
 * read it straight out of the source, and nothing here is encrypted or
 * server-checked. This only keeps someone who stumbles onto the deployed
 * URL from poking around the dashboard — it does nothing against anyone who
 * actually wants in. If real access control is ever needed, this should be
 * replaced with server-side auth, not hardened further.
 *
 * Deliberately NOT remembered anywhere (no localStorage/sessionStorage/
 * cookie) — every full page load prompts again, by request.
 *
 * Change PASSWORD below any time.
 */
const PASSWORD = "changeme";

export function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [input, setInput] = useState("");
  const [showError, setShowError] = useState(false);

  if (unlocked) return <>{children}</>;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (input === PASSWORD) {
      setUnlocked(true);
    } else {
      setShowError(true);
    }
  }

  return (
    <div className="password-gate">
      <form className="password-gate-card" onSubmit={handleSubmit}>
        <div className="password-gate-brand">
          <div className="brand-mark">RM</div>
          <div className="brand-text">
            <span className="brand-name">Risk Manager</span>
            <span className="brand-sub">Structure Trading</span>
          </div>
        </div>
        <label htmlFor="gate-password">Enter the access password to continue</label>
        <input
          id="gate-password"
          type="password"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowError(false);
          }}
          autoFocus
        />
        {showError && <p className="password-gate-error">Incorrect password.</p>}
        <button type="submit">Unlock</button>
      </form>
    </div>
  );
}
