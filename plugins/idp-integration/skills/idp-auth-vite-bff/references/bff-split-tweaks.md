# BFF Tweaks for the Split-Origin Architecture

The BFF in this architecture is an ordinary Overlens OAuth confidential client. **Get the handlers from the `idp-integrate-oauth-web` skill** — copy `templates/express/auth.routes.js` (Express/Hono/Fastify) or `templates/nestjs/` (NestJS), and `templates/pkce.ts`. They implement `GET /auth/login`, `GET /auth/signup`, `GET /auth/callback`, `POST /auth/refresh`, and `GET /auth/logout` (which clears the BFF cookies and redirects the browser to the IDP `end_session_endpoint`) exactly as needed.

This file lists only what you must **change** because the frontend is a separate-origin Vite SPA. There are three changes plus one addition.

---

## Change 1 — the callback redirects to the SPA origin, not a relative path

The `idp-integrate-oauth-web` templates end the callback with `res.redirect('/dashboard')` (or `/onboarding/profile` for new users). That assumes the BFF also serves those pages. In split mode it doesn't — those routes belong to the **Vite SPA on another origin**. Redirect there instead.

Add a `SPA_ORIGIN` env var and use it:

```js
// Express — replace the final redirect of the /auth/callback handler
const SPA_ORIGIN = process.env.SPA_ORIGIN; // '' when behind a dev proxy / same origin
const dest = payload.new_user ? '/onboarding/profile' : '/dashboard';
res.redirect(`${SPA_ORIGIN}${dest}`);
```

When you use the **dev proxy** (Topology A), set `SPA_ORIGIN=''` so the redirect is relative (`/dashboard`) and the proxy serves it from the SPA — same-origin, no absolute URL needed. When SPA and BFF are on different origins (Topologies B/C), set `SPA_ORIGIN=https://app.example.com` so the browser leaves the BFF and lands back in the SPA.

Apply the same change to the logout handler's post-clear redirect, and to the `error=` redirects (point them at `${SPA_ORIGIN}/login?error=...`).

---

## Change 2 — enable CORS with credentials (when origins differ)

Only needed when the SPA and BFF are on different origins (Topologies B/C, or dev without the proxy). With the dev proxy, skip CORS entirely — the browser only talks to the Vite origin.

Express:

```js
const cors = require('cors');
app.use(cors({ origin: process.env.SPA_ORIGIN, credentials: true }));
```

NestJS (`main.ts`, before `listen`):

```ts
app.enableCors({ origin: process.env.SPA_ORIGIN, credentials: true });
```

Rules the browser enforces (see `cross-origin-cookies.md` §6): the origin must be the **exact** SPA origin, never `*`, and `credentials: true` is required so `Access-Control-Allow-Credentials: true` is sent. The SPA fetches must set `credentials: 'include'` (the templates do).

---

## Change 3 — session cookie attributes match your topology

The `idp-integrate-oauth-web` templates set `sameSite: 'lax'`, `secure: true`, no `domain`. That's correct for Topology A (single origin). Adjust per `cross-origin-cookies.md`:

- **Topology A (dev proxy / single origin):** keep `sameSite: 'lax'`, no `domain`. Use `secure: false` in dev (`http://localhost`), `true` in prod.
- **Topology B (same parent domain):** add `domain: '.example.com'`, keep `sameSite: 'lax'`, `secure: true`.
- **Topology C (unrelated domains):** `sameSite: 'none'`, `secure: true` (forces HTTPS even in dev).

A clean way is to centralize this:

```js
const isProd = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = {
  httpOnly: true,
  secure: isProd,                          // false on http://localhost in dev
  sameSite: process.env.COOKIE_SAMESITE || 'lax', // 'none' only for Topology C
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  path: '/',
};
```

---

## Addition — a `GET /auth/me` endpoint for the SPA

The SPA can't read the httpOnly session cookie, so it needs a way to ask "who am I / am I logged in?". Add a small endpoint the SPA calls on load (consumed by `templates/vite/AuthContext.tsx`).

The robust version validates the JWT — see the **`idp-validate-token`** skill for the `JwtAuthGuard` / `passport-jwt` + JWKS setup. Sketch (NestJS):

```ts
@UseGuards(JwtAuthGuard)            // from idp-validate-token
@Get('me')
me(@CurrentPrincipal() user: AuthenticatedUser) {
  return { id: user.id, email: user.email, name: user.name };
}
```

Express equivalent, decoding the session cookie after the same guard/middleware validates it:

```js
authRouter.get('/me', requireSession, (req, res) => {
  res.json({ id: req.user.sub, email: req.user.email, name: req.user.name });
});
```

If you want a quick version before wiring full validation, you can decode (not verify) the `session_token` cookie and return its claims — but **only as a stopgap**; an unverified token must never gate real data. Move to `idp-validate-token` before shipping.

`GET /auth/me` returns `401` when there's no valid session — that's the signal `AuthContext` uses to treat the user as logged out.

---

## Summary

| Concern | Same-origin BFF (idp-integrate-oauth-web) | This skill (split origin) |
|---|---|---|
| Callback final redirect | relative (`/dashboard`) | `${SPA_ORIGIN}/dashboard` (or relative under dev proxy) |
| CORS | not needed | needed when origins differ; exact origin + credentials |
| Cookie `domain` | none | `.example.com` for same-parent-domain prod |
| Cookie `sameSite` | `lax` | `lax` (A/B) or `none` (C) |
| `GET /auth/me` | often inline | needed — the SPA's only window into the session |

Everything else (PKCE, state, token exchange, refresh rotation, the RP-initiated logout via the `end_session_endpoint`) is identical — don't reinvent it; copy from `idp-integrate-oauth-web`.
