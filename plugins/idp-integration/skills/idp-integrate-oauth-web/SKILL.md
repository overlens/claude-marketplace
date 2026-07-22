---
name: idp-integrate-oauth-web
description: >
  Hands-on, implementation-focused guide for integrating the Overlens IDP into a web application
  that has a server-side backend (BFF pattern). Use this skill whenever a developer is wiring up
  login/signup/logout against the Overlens IDP from a server-rendered or BFF web app — Next.js
  (App Router or Pages), NestJS BFF, Express/Hono/Fastify backend, Ruby on Rails, Django, ASP.NET,
  or any framework where a server-side handler can hold a `client_secret` and run the token
  exchange. Triggers on phrases like "integrate Overlens login", "Overlens callback handler",
  "PKCE callback Next.js", "wire up the BFF for Overlens SSO", "authorization_code exchange
  Overlens", "Overlens session cookies in my backend", "set up redirect_uri for Overlens", or
  when the repository contains `next.config.{js,ts}`, `nest-cli.json`, `Gemfile`, `manage.py`,
  `*.csproj`, or other backend project markers alongside a request to integrate auth. Provides
  copy-paste templates for PKCE generation, redirect server actions, callback handlers, silent
  refresh, and logout — with framework-specific variants. If the project is specifically Next.js
  App Router, prefer `idp-auth-nextjs` — the dedicated drop-in child of this skill. If the project
  is a Vite SPA with a separate backend, prefer `idp-auth-vite-bff`. If the project is purely a
  mobile or SPA client without a backend (PKCE-only), prefer `idp-auth-mobile`. If the project is a
  Resource Server only validating JWTs (not initiating login), prefer `idp-validate-token`. If
  the dev wants a service-to-service flow with no user, prefer `idp-integrate-m2m`. For a more
  conceptual overview without code, the `idp-auth-guide` skill is the conceptual companion.
---

# Overlens IDP — OAuth Web Client Integration

> **Prove it's correct:** once login works, scaffold the **client/BFF conformance** suite with the `idp-test-integration` skill — drop-in tests that drive callback → refresh → logout against an in-process mock IDP (no browser, no network, deterministic).

This skill walks a developer through wiring **OAuth 2.1 Authorization Code + PKCE** between a web app that has a server-side backend (a "confidential client" in OAuth terminology) and the Overlens IDP.

The IDP lives at `idp.overlens.com.br`. A separate frontend at `accounts.overlens.com.br` provides the login/signup UI. Your job is to redirect the browser there, handle the callback, exchange the code for tokens, and maintain a session in **your own domain**.

> **Conceptual companion:** `idp-auth-guide` covers the model and the why. This skill covers the how, with copy-paste templates.

---

## Decision tree — before you start writing code

Run through these checks. They short-circuit a lot of confusion later.

1. **Does your project have a server-side handler?** If yes (Next.js BFF, NestJS, Express, Rails, Django, ASP.NET, etc.), this is the right skill. If no (pure SPA, mobile, static site), stop and use `idp-auth-mobile` — you're a public client and the flow is different (no `client_secret`, PKCE-only on the device).
2. **Is your frontend a Vite SPA on a *separate origin* from the BFF?** (e.g. `localhost:5173` + `localhost:4000`, or `app.example.com` + `api.example.com` as distinct origins.) If so, the BFF handlers here still apply, but you also hit a cross-origin cookie problem this skill doesn't cover — stop and use `idp-auth-vite-bff`, which handles the split (CORS with credentials, cookie attributes, dev proxy) and reuses these BFF templates.
3. **Is the OAuth Client already registered in the IDP?** You need a `client_id`, `client_secret`, and the `redirect_uri` of your callback registered. See `references/client-registration.md`.
4. **Do you have env vars set?** `ACCOUNTS_URL`, `IDP_BASE_URL`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URI`, `POST_LOGOUT_REDIRECT_URI`. Without these, nothing works.
5. **Do you know where your **own** session cookies will live?** This integration emits cookies in **your domain**, not in `.overlens.com.br`. Pick the cookie names now (`session_token`, `session_refresh`, or whatever you prefer) so they match across files.

If any answer is unclear, resolve before writing code.

---

## The big picture

```
[Browser]
   │
   │ 1. clicks "Entrar"
   ▼
[Your Backend]                                          [Accounts SPA]                    [IDP API]
   │                                                          │                              │
   │ 2. generate PKCE + state                                  │                              │
   │ 3. set temporary cookies (verifier + state) on /api/auth/callback path                  │
   │ 4. redirect ──→ accounts.overlens.com.br/login?client_id&redirect_uri&code_challenge&state
   │                                                          │                              │
   │                                                  user authenticates                     │
   │                                                          │── POST /auth/authorize ─────►│
   │                                                          │◄── { code, state } ──────────│
   │                                                          │                              │
   │◄────────── window.location → your-app.com/callback?code=...&state=... ──────────────────│
   │                                                                                          │
   │ 5. validate state, read code_verifier from cookie                                        │
   │ 6. POST /auth/token (server-to-server) ────────────────────────────────────────────────►│
   │    Authorization: Basic base64(client_id:client_secret)                                  │
   │    grant_type=authorization_code, code, code_verifier, redirect_uri                      │
   │◄── { access_token, refresh_token, token_type: "Bearer", expires_in: 900 } ──────────────│
   │                                                                                          │
   │ 7. create session in YOUR domain (httpOnly cookies on your-app.com)                      │
   │ 8. clean up PKCE/state cookies                                                            │
   │ 9. redirect → /dashboard (or /onboarding if new_user)                                    │
```

Two channels matter:
- **Front-channel** (browser): redirects to/from Accounts. Carries `code` (short-lived, single-use). Never carries `client_secret`.
- **Back-channel** (your server → IDP): `POST /auth/token` exchange. Carries `client_secret`. Never exposed to browser.

---

## Implementation checklist

Treat this as your todo list. Each item is small and verifiable.

- [ ] Read the framework-specific reference (`references/nextjs.md`, `references/nestjs.md`, or `references/express.md`)
- [ ] Copy `templates/pkce.ts` into your project (or its equivalent for non-TS frameworks)
- [ ] Implement `redirectToLogin` / `redirectToSignup` (Server Action / Route / Controller) — see framework templates
- [ ] Implement callback handler — validates state, exchanges code, sets session cookies, redirects
- [ ] Implement silent refresh endpoint — exchanges refresh_token, rotates cookie
- [ ] Implement logout — clear your session cookies, then redirect the browser (top-level navigation) to the IDP `end_session_endpoint` (`GET /auth/logout`)
- [ ] Handle `new_user: true` in the JWT — redirect to onboarding instead of dashboard
- [ ] Register a `post_logout_redirect_uri` for this client with the IDP (admin `POST/PATCH /admin/clients`)
- [ ] Configure env vars (`ACCOUNTS_URL`, `IDP_BASE_URL`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URI`, `POST_LOGOUT_REDIRECT_URI`)
- [ ] Sanity-check the callback URL is byte-identical to the registered `redirect_uri` (no trailing slash drift)
- [ ] Test the full flow end-to-end in dev before declaring done

---

## Critical contracts (memorize these)

### Redirect URL to Accounts

```
https://accounts.overlens.com.br/login
  ?client_id=<your_client_id>
  &redirect_uri=<your_callback_url>
  &code_challenge=<base64url(sha256(code_verifier))>
  &code_challenge_method=S256
  &state=<random_state>
  &scope=openid                                   # optional, request openid to get id_token
```

For signup, swap `/login` → `/signup`. Same params.

### Token exchange (back-channel)

```
POST https://idp.overlens.com.br/auth/token
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code from callback>
&code_verifier=<original verifier from cookie>
&redirect_uri=<your_callback_url — same as in the redirect>
```

**Response 200:**
```json
{
  "access_token": "<JWT, 15 min>",
  "refresh_token": "<opaque hex, 30 days>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

### Silent refresh

```
POST https://idp.overlens.com.br/auth/token
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<current refresh_token>
```

The IDP rotates the refresh_token on every call — the old one is invalidated immediately. **Always store the new one.**

### Logout — OIDC RP-Initiated Logout

Logout uses the IDP's OIDC `end_session_endpoint`, now advertised in the discovery document: **`GET https://idp.overlens.com.br/auth/logout`**. For consumer logout, you:

1. Clear your own session cookies (`session_token`, `session_refresh`) on your domain, and drop the refresh_token from any storage you keep.
2. Send the browser, via a **top-level navigation** (link / `window.location` / server redirect — never `fetch`/XHR), to the IDP `end_session_endpoint` with:
   - `client_id` (required)
   - `post_logout_redirect_uri` — must **exact-match** a URI registered in this client's allowlist (admin `POST/PATCH /admin/clients`); if absent or unregistered, the IDP redirects to its own fallback page instead
   - `state` — echoed back on the redirect
   - optionally `id_token_hint`
3. The IDP nulls the server-side refresh code, clears its SSO cookies on `.overlens.com.br`, then 302-redirects to your `post_logout_redirect_uri`.

This ends the IDP SSO session, so the next `/auth/authorize` prompts for credentials and no silent refresh succeeds. It does **not** revoke already-issued access tokens — there is no per-token revocation (no RFC 7009 `/revoke`). An in-flight access token stays valid until it expires (≤15 min), an accepted tradeoff. For immediate hard revocation (e.g., compromised device), an admin must use `POST /admin/users/:id/block`.

> It must be a navigation, not a `fetch`: only a top-level navigation sends the IDP's first-party cookies and lets the browser honor the `Set-Cookie` clears the IDP returns.

---

## Framework selection

Pick the framework variant that matches your project:

- **Next.js App Router** → read `references/nextjs.md`, copy from `templates/nextjs/`. For a complete drop-in (with `middleware.ts`, `session.ts`, and onboarding branching wired up), prefer the dedicated `idp-auth-nextjs` skill.
- **NestJS BFF** → read `references/nestjs.md`, copy from `templates/nestjs/`
- **Express / Hono / Fastify / Bun.serve** → read `references/express.md`, copy from `templates/express/`
- **Any other server-side framework (Rails, Django, ASP.NET, etc.)** → read `references/generic.md`. The pattern is the same; only the API names differ. Port the concepts.

> **Separate-origin Vite SPA in front of this BFF?** If a Vite SPA on its own origin talks to this backend, copy the BFF handlers here as usual, then switch to `idp-auth-vite-bff` for the cross-origin half (CORS with credentials, cookie attributes, dev proxy, and the Vite-side `auth-api`/`AuthContext`/`ProtectedRoute`). This skill alone will leave you with cookies that get set on callback but never sent on API calls.

Each framework reference has the same structure: redirect handler → callback handler → refresh handler → logout handler → cookies → env vars → testing.

---

## Common pitfalls — read these before debugging

1. **`redirect_uri` byte-mismatch** — Must match what's registered in the IDP **exactly**. No trailing slash, no query params, no port mismatch. The IDP does string equality, not URL normalization.
2. **`maxAge` in seconds instead of milliseconds (Express/Node)** — `res.cookie('x', v, { maxAge: 900 })` sets `Max-Age=0` and the browser deletes the cookie immediately. Use `900_000`. This bites everyone exactly once.
3. **State validation skipped** — Storing `state` in a cookie and not comparing it on callback opens a CSRF hole in the OAuth flow itself. Always check `cookieState === queryState` before exchanging the code.
4. **Code verifier read from a global variable** — If the user opens two tabs and starts two flows, the second overwrites the first. Always store `code_verifier` in a cookie scoped to the callback path.
5. **`client_secret` reaching the browser** — Any time you log the env, embed it in a frontend bundle, or pass it as a query param, you've leaked it. The token exchange must be in a server-only file.
6. **Refresh token reuse** — A refresh_token is single-use. After the exchange, the old one is dead. If your code stores the old one and retries on failure, you'll lock the user out. Always overwrite with the new value.
7. **Forgetting `new_user`** — On first login after signup, the JWT contains `new_user: true`. If your app has onboarding (most do), branch on this in the callback. The flag is absent on all subsequent logins.
8. **Setting cookies on `.overlens.com.br`** — Don't. Your session cookies belong to **your domain**. Only the IDP's own cookies live on `.overlens.com.br` (used by the Accounts SPA, not by you).
9. **Logging out via `fetch` to the IDP** — The `GET /auth/logout` end_session_endpoint must be reached by a **top-level navigation**, not an XHR/`fetch`. A `fetch` won't send the IDP's first-party cookies nor honor its `Set-Cookie` clears, so the SSO session survives. (There is no `grant_type=revoke` — that grant type does not exist; logout is the end_session redirect.) See `references/troubleshooting.md`.
10. **Mixing the Accounts URL and the IDP URL** — `accounts.overlens.com.br` is where you redirect the **browser** (front-channel). `idp.overlens.com.br` is where your **server** does the token exchange (back-channel). Confusing the two is the #1 misconfiguration in support tickets.

For diagnostic mapping (symptom → cause → fix) see `references/troubleshooting.md`.

---

## Where the real docs live

This skill is curation + templates. The canonical reference for endpoints, schemas, and error codes lives in the IDP repository under `../../references/docs/integration/`. Specifically:

- `../../references/docs/integration/login.md` — full login flow with Next.js code (the original source of templates here)
- `../../references/docs/integration/signup.md` — signup flow (incremental over login)
- `../../references/docs/integration/logout.md` — logout in both modes, gotchas
- `../../references/docs/integration/oauth-clients.md` — how clients are registered, allowed grant types, scopes
- `../../references/docs/integration/frontend.md` §1 — UI patterns for the OAuth consumer
- `../../references/docs/integration/oidc-discovery.md` — if you prefer using a library (Auth.js, openid-client) instead of hand-rolling

When in doubt, read those. They're maintained as code changes; this skill snapshots the implementation patterns.

---

## File map of this skill

```
idp-integrate-oauth-web/
├── SKILL.md                          (this file)
├── references/
│   ├── client-registration.md        (what to register in the IDP before integrating)
│   ├── nextjs.md                     (Next.js App Router specifics)
│   ├── nestjs.md                     (NestJS BFF specifics)
│   ├── express.md                    (Express / Hono / Fastify specifics)
│   ├── generic.md                    (any other server-side framework)
│   └── troubleshooting.md            (symptom → cause → fix)
└── templates/
    ├── pkce.ts                       (PKCE verifier + challenge generation)
    ├── nextjs/
    │   ├── auth-actions.ts           (Server Actions: redirectToLogin, redirectToSignup)
    │   ├── callback-route.ts         (Route Handler: GET /api/auth/callback)
    │   ├── refresh-route.ts          (Route Handler: POST /api/auth/refresh)
    │   └── logout-action.ts          (Server Action: logout)
    ├── nestjs/
    │   ├── auth.controller.ts        (callback + refresh + logout endpoints)
    │   └── idp-client.service.ts     (token exchange wrapper)
    └── express/
        └── auth.routes.js            (Express equivalent of all four handlers)
```

Read framework files only as needed — they're independent.
