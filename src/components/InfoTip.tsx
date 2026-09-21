import type { ReactNode } from "react";

/**
 * A small "i" badge that explains, on hover (or keyboard focus), what the
 * number/label next to it means. Pure CSS popover (see .info-tip in
 * App.css) — no library, works inside table headers and stat cards.
 * `align="right"` opens the popover leftwards, for badges near the right
 * edge of the page where a rightward popover would run off-screen.
 */
export function InfoTip({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <span className={`info-tip ${align === "right" ? "align-right" : ""}`} tabIndex={0} role="note" aria-label="More info">
      <span className="info-tip-icon">i</span>
      <span className="info-tip-body">{children}</span>
    </span>
  );
}
