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
 * Change PASSWORD below any time. Bump PASSWORD_VERSION alongside it if you
 * also want everyone who already unlocked (their browser has the old
 * version's localStorage flag) to be prompted again.
 */
const PASSWORD = "changeme";
const PASSWORD_VERSION = "1";
const STORAGE_KEY = `risk-manager-unlocked-v${PASSWORD_VERSION}`;

function readUnlocked(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // localStorage unavailable (private browsing, disabled storage, etc.) — fall through to the prompt every load.
    return false;
  }
}

export function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(readUnlocked);
  const [input, setInput] = useState("");
  const [showError, setShowError] = useState(false);

  if (unlocked) return <>{children}</>;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (input === PASSWORD) {
      try {
        localStorage.setItem(STORAGE_KEY, "true");
      } catch {
        // Ignore — still unlock for this page load even if it can't be remembered.
      }
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
