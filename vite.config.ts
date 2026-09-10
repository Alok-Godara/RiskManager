import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

const QH_DEFAULT_URL = 'https://qh-api.corp.hertshtengroup.com'

/**
 * The QuantHub Bearer token is read here, in the Node-side dev/preview
 * server, and injected into proxied requests — so it is NEVER bundled into
 * the browser JavaScript. That's why it's `QH_API_TOKEN` and not
 * `VITE_QH_API_TOKEN`: Vite only exposes `VITE_`-prefixed vars to client
 * code. Proxying also avoids CORS, since the app calls a same-origin
 * `/qh-api/...` path.
 *
 * When deploying, point VITE_QH_API_BASE at an equivalent server-side proxy
 * (e.g. a Netlify Edge Function) that adds the same header.
 */
function quantHubProxy(token: string | undefined, target: string): Record<string, ProxyOptions> {
  return {
    '/qh-api': {
      target,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/qh-api/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`)
          proxyReq.setHeader('accept', 'application/json')
        })
        proxy.on('error', (err) => {
          console.error('[qh-api proxy]', err.message)
        })
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' as the third arg loads ALL env vars, not just VITE_-prefixed ones.
  const env = loadEnv(mode, process.cwd(), '')
  const token = env.QH_API_TOKEN?.trim() || undefined
  const target = env.QH_API_URL?.trim() || QH_DEFAULT_URL
  const proxy = quantHubProxy(token, target)

  if (!token) {
    console.warn('[qh-api] QH_API_TOKEN is not set — the app will fall back to simulated prices.')
  }

  return {
    plugins: [react()],
    // Only whether a token exists reaches the client, never its value.
    define: { __QH_CONFIGURED__: JSON.stringify(Boolean(token)) },
    server: { proxy },
    preview: { proxy },
  }
})
