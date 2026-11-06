import type { AlertEvent, AlertKind } from "./alertRules";

const ICONS: Record<AlertKind, string> = {
  "stop-hit": "🛑",
  "stop-near": "⚠️",
  "profit-target": "🎯",
  concentration: "🔗",
  correlation: "🔗",
};

/** Teams card colour per kind: red for stops, green for profit, amber for the rest. */
const COLOURS: Record<AlertKind, string> = {
  "stop-hit": "Attention",
  "stop-near": "Warning",
  "profit-target": "Good",
  concentration: "Warning",
  correlation: "Warning",
};

/** Teams cards get long-winded fast; the first lines carry the news. */
const MAX_EVENTS_PER_MESSAGE = 15;

/**
 * An Adaptive Card wrapped in the message envelope that Power Automate's
 * "Post card in a chat or channel" webhook flows expect.
 */
export function buildTeamsMessage(heading: string, events: AlertEvent[], at = new Date()) {
  const shown = events.slice(0, MAX_EVENTS_PER_MESSAGE);
  const body: unknown[] = [
    { type: "TextBlock", text: heading, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: at.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC", isSubtle: true, spacing: "None", wrap: true },
    ...shown.map((e) => ({
      type: "Container",
      spacing: "Medium",
      items: [
        { type: "TextBlock", text: `${ICONS[e.kind]} ${e.title}`, weight: "Bolder", color: COLOURS[e.kind], wrap: true },
        { type: "TextBlock", text: e.detail, spacing: "None", wrap: true },
      ],
    })),
  ];
  if (events.length > shown.length) {
    body.push({ type: "TextBlock", text: `…and ${events.length - shown.length} more — open the dashboard.`, isSubtle: true, wrap: true });
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body },
      },
    ],
  };
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** POSTs a message to the Teams (Power Automate) webhook. Never throws. Node/server side only: the endpoint sends no CORS headers, so a browser could not call it. */
export async function postToTeams(webhookUrl: string, message: unknown): Promise<PostResult> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) return { ok: true, status: response.status };
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: `Teams webhook returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
