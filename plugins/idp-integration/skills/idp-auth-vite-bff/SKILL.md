---
name: idp-auth-vite-bff
description: >
  Hands-on, implementation-focused guide for integrating the Overlens IDP into a Vite SPA that has
  a SEPARATE backend-for-frontend (BFF) — the frontend and backend run on different origins
  (e.g. localhost:5173 + localhost:4000, or app.example.com + api.example.com). Use this skill
  whenever a developer is wiring Overlens login/signup/logout into a Vite + React/Vue/Svelte SPA
  whose auth is handled by a standalone NestJS / Express / Hono / Fastify BFF that holds the
  `client_secret`. The defining trait: the Vite app NEVER calls the IDP — it only talks to its own
  BFF, and the BFF runs the whole OAuth flow. Triggers on phrases like "Vite SPA with a separate
  backend Overlens login", "Vite frontend + NestJS BFF Overlens SSO", "how does my React SPA call
  the BFF for Overlens auth", "session cookie not sent from my Vite app to my API", "CORS
  credentials Overlens BFF", "vite dev proxy for /auth", "AuthContext + ProtectedRoute Overlens",
  "redirect back to the SPA after callback", or when the repo has a `vite.config.{ts,js}` frontend
  alongside a separate backend project (monorepo with `apps/web/` + `apps/api/`, or two package.json
  files) and a request to integrate auth. Provides copy-paste Vite-side templates (auth API client
  with silent refresh, AuthContext, ProtectedRoute, dev-proxy config) plus the BFF tweaks that the
  split-origin architecture requires (CORS with credentials, redirecting back to the SPA origin,
  cross-origin cookie rules). If your backend IS your frontend (Next.js App Router, a NestJS app
  serving its own SPA on the same origin), prefer `idp-integrate-oauth-web` or `idp-auth-nextjs` —
  the cross-origin cookie problem disappears. If the SPA has NO backend and exchanges the code on
  the client (PKCE-only, no `client_secret`), prefer `idp-auth-mobile`. If you only need to validate
  JWTs in the BFF/API (not initiate login), prefer `idp-validate-token`. The BFF-internal mechanics
  (PKCE generation, token exchange) are shared with `idp-integrate-oauth-web` — this skill focuses
  on the split.
---

# Overlens IDP — Vite SPA + Separate BFF Integration

> **Prove it's correct:** once login works, scaffold the **client/BFF conformance** suite with the `idp-test-integration` skill — drop-in tests that drive callback → refresh → logout against an in-process mock IDP (no browser, no network, deterministic).

This skill is for one specific architecture: a **Vite single-page app** (React, Vue, Svelte, Solid…) served from one origin, and a **separate backend (BFF)** served from another. The SPA renders the UI and calls your own API; the BFF holds the `client_secret`, runs the OAuth 2.1 Authorization Code + PKCE flow against the Overlens IDP, and owns the session cookies.

The thing that makes this architecture distinct — and the thing this skill exists to get right — is that **the SPA and the BFF live on different origins**, so a session cookie set by the BFF is a *cross-origin* cookie from the SPA's point of view. Get the origins and cookie attributes wrong and login appears to work (the callback succeeds, cookies get set) but every subsequent API call comes back `401` because the browser silently refuses to send the cookie. Most of this skill is about avoiding that trap.

> **Where the BFF internals come from:** generating PKCE, building the redirect to Accounts, and exchanging the `code` for tokens is identical to any server-side OAuth client. That code lives in the `idp-integrate-oauth-web` skill (`templates/express/auth.routes.js`, `templates/nestjs/`, `templates/pkce.ts`). **Read that skill for the BFF handlers.** This skill covers what changes when the frontend is a separate-origin Vite SPA, and provides the Vite-side code.

---

## Decision tree — are you actually in this architecture?

1. **Is your frontend a Vite SPA that is built and served separately from your backend?** If frontend and backend are the same server/origin (Next.js, a NestJS app rendering its own bundle), you do **not** have the cross-origin problem — use `idp-integrate-oauth-web` (or `idp-auth-nextjs`). Stop here.
2. **Does your backend hold the `client_secret` and do the token exchange?** If there is *no* backend and the SPA itself exchanges the code, you're a public client — use `idp-auth-mobile`. Stop here.
3. **Are the SPA and BFF on the same registrable domain in production?** (e.g. `app.example.com` + `api.example.com`, both under `example.com`.) This is the happy path — `SameSite=Lax` cookies with `domain=.example.com` just work. If they're on genuinely unrelated domains (`myapp.com` + `myapi.dev`), you're forced into `SameSite=None; Secure` and you should read `references/cross-origin-cookies.md` carefully before writing anything.
4. **Have you decided on your dev setup?** The single biggest simplifier is the **Vite dev proxy** (§ below): proxy `/auth` and `/api` from the Vite dev server to the BFF so that, in development, everything is same-origin and the cookie problem evaporates. Strongly recommended. See `templates/vite/vite.config.ts`.

If 1–3 don't all point here, you're in the wrong skill — switch now, before writing code.

---

## The big picture

```
[Browser]                         [Vite SPA]                 [Your BFF]                [Accounts SPA]      [IDP API]
   │  loads app  ───────────────────►│ origin A                 │ origin B                 │                 │
   │                                  │                          │                          │                 │
   │  click "Entrar"                  │                          │                          │                 │
   │  window.location = BFF /auth/login (full navigation, NOT fetch)                        │                 │
   │ ────────────────────────────────┼─────────────────────────►│                          │                 │
   │                                  │           generate PKCE+state, set temp cookies      │                 │
   │ ◄─── 302 redirect ──────────────────────────────────────── accounts.../login?client_id&challenge&state  │
   │ ───────────────────────────────────────────────────────────────────────────────────►│ user authenticates│
   │                                  │                          │                          │── POST /auth/authorize ─►│
   │ ◄─── 302 → BFF /auth/callback?code&state ──────────────────────────────────────────────────────────────│
   │ ────────────────────────────────┼─────────────────────────►│ validate state           │                 │
   │                                  │     POST /auth/token (Basic client_secret) ─────────────────────────►│
   │                                  │   ◄── { access_token, refresh_token, expires_in } ──────────────────│
   │                                  │     set session cookies on origin B                  │                 │
   │ ◄─── 302 → SPA origin A (/dashboard or /onboarding) ───────│                          │                 │
   │                                  │                          │                          │                 │
   │  SPA now calls BFF API with fetch(..., credentials: 'include')                         │                 │
   │  browser attaches the origin-B session cookie  ──────────►│ validates JWT, serves data │                 │
```

Two things are different from a same-origin BFF:

1. **The callback redirect must point back to the SPA's origin**, not a relative path. In the same-origin case the BFF can `res.redirect('/dashboard')`. Here `/dashboard` is the *BFF's* `/dashboard`, which doesn't exist. Redirect to `${SPA_ORIGIN}/dashboard`.
2. **Every SPA→BFF call needs `credentials: 'include'`**, and the BFF needs CORS configured to allow the SPA origin with credentials. A wildcard `Access-Control-Allow-Origin: *` is *invalid* with credentials — the browser rejects it. The origin must be echoed back explicitly.

---

## Implementation checklist

- [ ] Decide dev strategy: **dev proxy** (recommended, same-origin in dev) or **CORS** (two origins in dev). See `references/cross-origin-cookies.md`.
- [ ] Implement the BFF handlers (login/signup/callback/refresh/logout) from `idp-integrate-oauth-web` — copy its Express or NestJS templates.
- [ ] Apply the **two split-mode BFF tweaks**: (a) callback redirects to `${SPA_ORIGIN}/...`, (b) CORS allows the SPA origin with `credentials: true`. See `references/bff-split-tweaks.md`.
- [ ] Pick session cookie attributes for your origin topology (same parent domain → `Lax` + `domain=.example.com`; unrelated domains → `None; Secure`). See `references/cross-origin-cookies.md`.
- [ ] Copy `templates/vite/auth-api.ts` — the fetch wrapper with `credentials: 'include'` and 401→silent-refresh→retry.
- [ ] Copy `templates/vite/AuthContext.tsx` — loads the current user once on mount, exposes `login()`/`logout()`.
- [ ] Copy `templates/vite/ProtectedRoute.tsx` — gate routes behind the session.
- [ ] Add a BFF `GET /auth/me` endpoint (or proxy one) so the SPA can ask "am I logged in?" — see `references/bff-split-tweaks.md`.
- [ ] Wire the "Entrar"/"Criar conta" buttons to `window.location.href = '<BFF>/auth/login'` (full navigation — a `fetch` cannot follow the cross-origin redirect to Accounts).
- [ ] Configure env on **both** sides: BFF (`ACCOUNTS_URL`, `IDP_BASE_URL`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URI`, `SPA_ORIGIN`) and SPA (`VITE_BFF_URL`).
- [ ] Verify the registered `redirect_uri` points at the **BFF** callback (`<BFF>/auth/callback`), byte-identical. The SPA origin is never a `redirect_uri`.
- [ ] Test end-to-end: click Entrar → authenticate → land back in the SPA logged in → reload page stays logged in → an API call carries the cookie.

---

## Why the "Entrar" button is a navigation, not a fetch

A natural instinct is to `fetch('<BFF>/auth/login')`. It won't work: that endpoint responds with a `302` to `accounts.overlens.com.br`, and `fetch` cannot transparently navigate the browser across origins to a login page the user needs to *see and interact with*. The login flow is a **full top-level navigation** — the browser's address bar travels SPA → BFF → Accounts → BFF → SPA. So:

```html
<!-- React: an anchor or a button that sets location -->
<a href={`${import.meta.env.VITE_BFF_URL}/auth/login`}>Entrar</a>
```

Only the **API calls after login** are `fetch` (with `credentials: 'include'`). The login handshake itself is navigation.

---

## The dev proxy — strongly recommended

In development, the simplest way to make cookies behave is to eliminate the cross-origin condition entirely: have the Vite dev server proxy `/auth` and `/api` to the BFF. The browser then only ever talks to `http://localhost:5173`, the BFF's cookies are first-party, `SameSite=Lax` works, and you don't need CORS at all in dev.

```ts
// vite.config.ts (excerpt — full file in templates/vite/vite.config.ts)
server: {
  proxy: {
    '/auth': { target: 'http://localhost:4000', changeOrigin: true },
    '/api':  { target: 'http://localhost:4000', changeOrigin: true },
  },
}
```

With this, the SPA calls relative paths (`fetch('/api/...')`, `window.location.href = '/auth/login'`) and the proxy forwards them. Set `VITE_BFF_URL=''` (empty) in dev so the templates use relative URLs. In production, where SPA and BFF are deployed under the same parent domain (or behind one reverse proxy / CDN), the same relative paths keep working.

If you cannot proxy and must run two origins in dev, read `references/cross-origin-cookies.md` — you'll need CORS with credentials and `secure`/`SameSite` set correctly for `localhost`.

---

## Critical contracts (memorize)

- **`redirect_uri` is the BFF callback**, e.g. `https://api.example.com/auth/callback`, registered byte-identical in the IDP. The SPA origin is *never* a redirect URI in this architecture.
- **Login AND logout are navigations**: `window.location.href = '<BFF>/auth/login'` (and `.../auth/logout`). Refresh/API are `fetch(..., { credentials: 'include' })`. Logout must NOT be a `fetch` — only a top-level navigation carries the IDP's first-party cookies and lets the browser honor the IDP's `Set-Cookie` clears.
- **CORS with credentials forbids `*`**: the BFF must echo the exact SPA origin in `Access-Control-Allow-Origin` and send `Access-Control-Allow-Credentials: true`.
- **Refresh token is single-use and rotated** on every `grant_type=refresh_token` call — the BFF must overwrite the stored refresh cookie with the new value each time (same rule as every Overlens integration).
- **Logout is OIDC RP-Initiated Logout**: the SPA navigates the browser to `<BFF>/auth/logout`; the BFF clears its own session cookies and 302-redirects to the IDP `end_session_endpoint` (`GET /auth/logout`) with `client_id` + a registered `post_logout_redirect_uri` + `state`, which ends the IDP SSO session. There is still no `grant_type=revoke` (it returns `400`) and no per-token revocation — an in-flight access token stays valid until it expires (≤15 min); admin block is the hard-revocation path. Get the BFF logout handler from `idp-integrate-oauth-web`.

---

## Common pitfalls — read before debugging

1. **Cookie set on callback, never sent on API calls** — the #1 symptom of this architecture. Almost always a cross-origin cookie issue: SPA and BFF on different sites and the session cookie is `SameSite=Lax` (so it's withheld from cross-site `fetch`). Fix: dev proxy (same-origin), or same-parent-domain + `domain=.example.com`, or `SameSite=None; Secure`. See `references/cross-origin-cookies.md`.
2. **`Access-Control-Allow-Origin: *` with credentials** — the browser rejects the response entirely. Echo the specific origin; never wildcard when `credentials: true`.
3. **Callback redirects to a BFF-relative path** — `res.redirect('/dashboard')` lands the user on the BFF, which has no `/dashboard`. Redirect to `${SPA_ORIGIN}/dashboard`.
4. **`fetch`-ing the login route** — it 302s to Accounts; fetch can't drive an interactive cross-origin login. Use a navigation.
5. **Missing `credentials: 'include'`** — without it the browser sends no cookies *and* ignores `Set-Cookie` on the response. Every SPA→BFF call needs it.
6. **`secure: true` cookies over `http://localhost`** — the browser drops them. In dev either use the proxy (so it's all `localhost`, still set `secure: false`) or run HTTPS. `SameSite=None` *requires* `Secure`, which is the real reason two plain-HTTP localhost origins can't share a `None` cookie.
7. **`redirect_uri` drift between SPA and BFF** — people sometimes register the SPA origin. It must be the BFF callback. The SPA never appears in the OAuth params.
8. **CSRF/state lost across the redirect** — the temp `code_verifier`/`state` cookies are set by the BFF on its own origin scoped to `/auth/callback`; they're first-party to the BFF so they survive the Accounts round-trip. Don't try to carry them in the SPA.
9. **Refresh-token reuse after rotation** — storing the old refresh token and retrying locks the user out. Always persist the rotated value the BFF receives.
10. **Trying to read the JWT in the SPA** — the access token lives in an httpOnly cookie the SPA can't read (by design). To know who's logged in, the SPA calls a BFF `GET /auth/me`; don't try to decode the token client-side.

---

## File map of this skill

```
idp-auth-vite-bff/
├── SKILL.md                              (this file)
├── references/
│   ├── cross-origin-cookies.md           (the heart: SameSite, origins, dev proxy vs CORS)
│   └── bff-split-tweaks.md               (what changes in the BFF vs idp-integrate-oauth-web)
└── templates/
    └── vite/
        ├── vite.config.ts                (dev proxy config)
        ├── auth-api.ts                    (fetch wrapper + 401→refresh→retry)
        ├── AuthContext.tsx                (React: load /auth/me, login(), logout())
        └── ProtectedRoute.tsx             (React Router route guard)
```

For the BFF login/callback/refresh/logout handlers, read the **`idp-integrate-oauth-web`** skill and copy its Express or NestJS templates — then apply the two tweaks in `references/bff-split-tweaks.md`.

---

## Where the real docs live

This skill is curation + templates. Canonical sources in the IDP repo:

- `../../references/docs/integration/frontend.md` §1 — the OAuth frontend model (this architecture's reference)
- `../../references/docs/integration/login.md` — full login flow + token exchange (the BFF side)
- `../../references/docs/integration/backend.md` — validating the JWT in the BFF/API (`idp-validate-token` curates this)
- `../../references/docs/integration/logout.md` — RP-initiated logout via the `end_session_endpoint`
