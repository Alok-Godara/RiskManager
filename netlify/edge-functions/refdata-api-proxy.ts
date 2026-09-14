// Production counterpart to vite.config.ts's dev-server proxy for the
// reference-data settlement API (Structures -> Portfolio Correlation &
// Concentration — see src/services/settlementData/). The client always
// calls the same-origin path `/refdata-api/...`; this forwards it to the
// real API, optionally injecting `Authorization: Bearer <REFDATA_API_TOKEN>`
// if one is configured (Netlify site environment variables — nothing in
// this repo assumes that token is required, since the endpoint given
// wasn't documented as needing auth).
//
// `refdataapi` is a bare internal hostname with no public DNS entry, so
// unlike the QuantHub proxy this one will likely need REFDATA_API_URL set
// to something Netlify's edge network can actually reach (a public
// endpoint, or a reverse-proxy/tunnel into the corp network) before a
// deployed site can use it at all — see README.md.

const DEFAULT_UPSTREAM = "http://refdataapi";

export default async (request: Request): Promise<Response> => {
  const upstreamBase = (Deno.env.get("REFDATA_API_URL")?.trim() || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const token = Deno.env.get("REFDATA_API_TOKEN");

  const incoming = new URL(request.url);
  const upstreamPath = incoming.pathname.replace(/^\/refdata-api/, "");
  const upstreamUrl = `${upstreamBase}${upstreamPath}${incoming.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    return jsonError(502, `Could not reach the settlement API: ${err instanceof Error ? err.message : String(err)}`);
  }

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

export const config = { path: "/refdata-api/*" };
