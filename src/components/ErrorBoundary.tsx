import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches a crash while drawing a screen and shows a message instead of a blank
 * page — the rest of the app (sidebar, other tabs) keeps working. Remount it
 * (change its `key`) to try again, e.g. when the user switches tab.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel">
        <h2>Something went wrong on this screen</h2>
        <p className="helper-text" style={{ color: "var(--red)" }}>
          {this.state.error.message}
        </p>
        <p className="helper-text">
          Reload the page (Ctrl+Shift+R). If it keeps happening, the server may be serving a mix of old and new files — restart it.
        </p>
        <div className="button-row">
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button type="button" className="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
