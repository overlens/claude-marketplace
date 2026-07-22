import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-proxy setup for the "Vite SPA + separate BFF" Overlens integration.
 *
 * Why: in development the SPA (this dev server, :5173) and the BFF (:4000) are
 * different origins. A session cookie the BFF sets is then a cross-site cookie
 * from the SPA's point of view, and the browser silently withholds it on
 * `fetch` — so every API call 401s even though login "worked".
 *
 * The fix: proxy `/auth` and `/api` to the BFF. Now the browser only ever talks
 * to http://localhost:5173, the BFF's cookies are first-party, SameSite=Lax
 * works, and you need NO CORS in dev. Set VITE_BFF_URL='' so the app code uses
 * relative URLs (see auth-api.ts).
 *
 * In production, deploy the SPA bundle and the BFF behind one host/CDN where `/`
 * serves the SPA and `/auth` + `/api` route to the BFF — the same relative paths
 * keep working. (If instead you deploy them on sibling subdomains like
 * app.example.com + api.example.com, set VITE_BFF_URL to the BFF origin and
 * configure CORS + cookie domain on the BFF — see references/cross-origin-cookies.md.)
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The OAuth handshake routes on the BFF (login/signup/callback/refresh/logout/me)
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // Your protected API on the BFF (or proxied through it to resource servers)
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
