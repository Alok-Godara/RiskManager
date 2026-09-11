// Production counterpart to vite.config.ts's dev-server proxy: the client
// always calls the same-origin path `/qh-api/...` (see
// src/services/quantHub/client.ts), and this Edge Function forwards it to
// the real QuantHub API, injecting `Authorization: Bearer <QH_API_TOKEN>`
// server-side — the token lives only in Netlify's site environment
// variables (Site settings -> Environment variables), never in the client
// bundle or in this repo.
//
// Without this, `/qh-api/*` falls through to the SPA catch-all redirect in
// netlify.toml and returns index.html — which is exactly the "QuantHub
// returned a response that isn't valid JSON" error the deployed site was
// hitting; the fetch succeeded, but against the wrong thing entirely.

const DEFAULT_UPSTREAM = "https://qh-api.corp.hertshtengroup.com";

export default async (request: Request): Promise<Response> => {
  const token = Deno.env.get("QH_API_TOKEN");
  if (!token) {
    return jsonError(500, "QH_API_TOKEN is not set in this site's environment variables (Netlify dashboard -> Site configuration -> Environment variables).");
  }

  const upstreamBase = (Deno.env.get("QH_API_URL")?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const incoming = new URL(request.url);
  const upstreamPath = incoming.pathname.replace(/^\/qh-api/, "");
  const upstreamUrl = `${upstreamBase}${upstreamPath}${incoming.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    return jsonError(502, `Could not reach QuantHub: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Pass the upstream response through as-is (status, body, content-type) —
  // client.ts already handles 401/403/429/non-OK/non-JSON explicitly.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const config = { path: "/qh-api/*" };
