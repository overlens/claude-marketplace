# Express / Hono / Fastify — Implementation Guide

Use this guide for a plain Node backend: Express, Hono, Fastify, or `Bun.serve`. The template is written for Express (`templates/express/auth.routes.js`); the logic is framework-neutral — only the router/cookie API names differ.

---

## Dependencies (Express)

```bash
npm install express cookie-parser
```

Node 18+ has global `fetch`. On older Node, `npm install node-fetch` and import it.

---

## Wiring

```js
const express = require('express');
const cookieParser = require('cookie-parser');
const { authRouter } = require('./auth.routes'); // copy from templates/express/auth.routes.js

const app = express();
app.use(cookieParser());            // required — req.cookies is undefined without it
app.use('/auth', authRouter);
app.listen(4000);
```

The router exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/login` | Start login → redirect to Accounts |
| `GET` | `/auth/signup` | Start signup → redirect to Accounts |
| `GET` | `/auth/callback` | Exchange code, set session cookies |
| `POST` | `/auth/refresh` | Silent refresh, rotate cookies |
| `GET` | `/auth/logout` | Clear cookies + redirect to IDP `end_session_endpoint` (top-level navigation) |

---

## Env vars

```env
ACCOUNTS_URL=https://accounts.overlens.com.br
IDP_BASE_URL=https://idp.overlens.com.br
IDP_CLIENT_ID=your_client_id
IDP_CLIENT_SECRET=your_client_secret
IDP_REDIRECT_URI=https://yourapp.com/auth/callback
POST_LOGOUT_REDIRECT_URI=https://yourapp.com/
```

`IDP_REDIRECT_URI` must end in `/auth/callback` (matching the router mount) and be registered — see `references/client-registration.md`. `POST_LOGOUT_REDIRECT_URI` must likewise exact-match a `post_logout_redirect_uri` registered for this client (admin `POST/PATCH /admin/clients`).

---

## The maxAge milliseconds gotcha

Express cookies take `maxAge` in **milliseconds**. The template uses `600_000` (temp), `tokens.expires_in * 1000` (access), and `30 * 24 * 60 * 60 * 1000` (refresh). If you ever pass `900`, the browser receives `Max-Age=0` and deletes the cookie instantly — login appears to "work" but the user is immediately logged out.

---

## Logout

`GET /auth/logout` in `templates/express/auth.routes.js` implements OIDC RP-Initiated Logout. The handler:

1. Clears your own session cookies (`session_token`, `session_refresh`) on your domain.
2. Issues a **top-level redirect** (`res.redirect(...)`, reached by a browser navigation — `<a href="/auth/logout">Sair</a>` or `window.location`, never `fetch`/XHR) to the IDP `end_session_endpoint` (`GET {IDP_BASE_URL}/auth/logout`) with `client_id`, `post_logout_redirect_uri`, and a random `state`.
3. The IDP nulls the server-side refresh code, clears its SSO cookies on `.overlens.com.br`, then 302s back to your `post_logout_redirect_uri`.

The `post_logout_redirect_uri` (env `POST_LOGOUT_REDIRECT_URI`) must **exact-match** a URI pre-registered for this client — see `references/client-registration.md`. If absent or unregistered, the IDP redirects to its own fallback page instead of your app.

It must be a navigation, not a `fetch`: only a top-level navigation sends the IDP's first-party cookies and lets the browser honor the `Set-Cookie` clears. There is no per-token revocation (no `grant_type=revoke`, no RFC 7009 `/revoke`) — an already-issued access token stays valid until it expires (≤15 min). For immediate hard revocation, an admin calls `POST /admin/users/:id/block`.

---

## Porting to Hono

Hono's API differs but maps cleanly:

```ts
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const auth = new Hono();

auth.get('/login', (c) => {
  const verifier = genVerifier();
  const challenge = genChallenge(verifier);
  const state = genState();
  setCookie(c, 'pkce_code_verifier', verifier, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth/callback', maxAge: 600 }); // Hono maxAge is SECONDS
  setCookie(c, 'oauth_state', state, { /* same */ });
  const params = new URLSearchParams({ client_id, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'openid profile email' });
  return c.redirect(`${ACCOUNTS_URL}/login?${params}`);
});
// ... callback, refresh, logout follow the same shape
```

⚠️ **Hono's `setCookie` maxAge is in SECONDS, not milliseconds** — the opposite of Express. Use `maxAge: 600` (10 min) in Hono, `maxAge: 600_000` in Express. This catches people switching between the two.

---

## Porting to Fastify

```ts
import fastifyCookie from '@fastify/cookie';
fastify.register(fastifyCookie);

fastify.get('/auth/login', (req, reply) => {
  // ...
  reply.setCookie('pkce_code_verifier', verifier, { httpOnly: true, secure: true, sameSite: 'lax', path: '/auth/callback', maxAge: 600 }); // Fastify maxAge is SECONDS
  reply.redirect(`${ACCOUNTS_URL}/login?${params}`);
});
```

Fastify's `maxAge` is also in **seconds**. Same caveat as Hono.

---

## Frontend integration

The browser-side "Entrar" button navigates to the BFF route:

```html
<a href="/auth/login">Entrar</a>
```

(A GET navigation is fine here because the redirect handler sets the temp cookies as part of the response to that GET — unlike Next.js Server Actions, plain Express GET handlers can set cookies on the response.)

For protected API calls, a fetch interceptor handles refresh:

```js
async function apiFetch(url, init = {}) {
  let res = await fetch(url, { ...init, credentials: 'include' });
  if (res.status === 401) {
    const r = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!r.ok) { window.location.href = '/login'; return res; }
    res = await fetch(url, { ...init, credentials: 'include' });
  }
  return res;
}
```

---

## Validating tokens on protected routes

This skill establishes the session. To require a valid session on protected routes, use the `idp-validate-token` skill — it shows the `passport-jwt` + `jwks-rsa` setup that extracts the JWT from the cookie or Bearer header and verifies it via JWKS.

---

## Common Express-family errors

- **`req.cookies` is undefined** — missing `app.use(cookieParser())`.
- **Cookie set but never sent back** — `secure: true` over plain `http://localhost`. Set `secure: false` in dev or use HTTPS.
- **Browser blocks the cookie cross-origin** — if SPA and BFF are different origins in dev, enable CORS with `credentials: true` and set the SPA fetch to `credentials: 'include'`.
- **maxAge confusion** — Express = ms, Hono/Fastify = seconds. Double-check after copy-paste.
