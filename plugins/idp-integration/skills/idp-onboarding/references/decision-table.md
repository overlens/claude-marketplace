# Decision table — routing a system to the right idp-* skill

The organized mirror of the Phase 1 interview. Two inputs decide the route: **what the system is**
(interview + repo detection) and **what the user needs** (login? validation? no user at all?).

---

## 1. Routing by interview answer

| The user's system… | Client type | Route to | Also run after |
|---|---|---|---|
| Next.js App Router app where users log in | Confidential (web BFF) | `idp-auth-nextjs` | `idp-test-integration` |
| Vite SPA with a separate backend (different origins, e.g. `:5173` + `:4000`) | Confidential (BFF holds the secret) | `idp-auth-vite-bff` | `idp-test-integration` |
| Any other web framework **with** a server (NestJS, Express, Hono, Fastify, Rails, Django, ASP.NET, Next.js Pages) | Confidential (web BFF) | `idp-integrate-oauth-web` | `idp-test-integration` |
| Mobile app (React Native, Expo, Swift, Kotlin, Flutter) or SPA with **no** backend | Public (PKCE-only, no secret) | `idp-auth-mobile` | `idp-test-integration` |
| API that only **receives** logged-in requests and must recognize the user (never starts a login) | Resource Server (no client needed for validation itself) | `idp-validate-token` | `idp-test-integration` |
| Worker / cron / queue consumer / microservice that calls another API with **no person involved** | M2M (`client_credentials`) | `idp-integrate-m2m` | — |
| Project already built on a generic OIDC library (Auth.js, openid-client, oidc-client-ts…) | Depends on stack | `idp-use-oidc-discovery` | `idp-test-integration` |
| "How does this all work?" / exotic framework / conceptual doubt | — | `idp-auth-guide` (then re-route) | — |

**Multiple needs = multiple routes, in order.** A common combo: a web app where users log in
(route 1) **and** an API of their own that validates the session (add `idp-validate-token`).
Always finish each integration route with `idp-test-integration` — it is the proof.

**Reactive routes** (something already broke, not an integration task):

| Symptom | Route to |
|---|---|
| HTTP error: `401 invalid_client`, `400 invalid_grant`/`unauthorized_client`, CORS, `redirect_uri` mismatch, `429`, cookie `Max-Age=0`, missing `Set-Cookie` | `idp-troubleshoot-auth-errors` |
| A specific token that "should be valid but isn't": bad `iss`/`aud`, `kid not found`, signature fails, stale JWKS | `idp-debug-jwt` |
| Needs a production `client_id`/`client_secret`, or to change `redirectUris`/scopes of an existing client | `idp-register-oauth-client` |

---

## 2. Automatic detection — repo file signals

Use these when the user doesn't know their stack (Phase 0). Detection **suggests**; always confirm
with the user before routing. Check in this order — more specific first.

| Signal (files in the repo) | Conclusion | Route |
|---|---|---|
| `next.config.{js,ts,mjs}` **+** `app/` directory | Next.js App Router | `idp-auth-nextjs` |
| `next.config.{js,ts,mjs}` **+** `pages/` only (no `app/`) | Next.js Pages Router | `idp-integrate-oauth-web` |
| `vite.config.{ts,js}` **+** a separate backend project (monorepo `apps/web/` + `apps/api/`, or two `package.json`s — one frontend, one server) | Vite SPA + BFF | `idp-auth-vite-bff` |
| `vite.config.{ts,js}` with **no** backend anywhere | SPA without backend (public client) | `idp-auth-mobile` |
| `app.json` / `app.config.{js,ts}` (Expo), or `package.json` with `react-native`/`expo` | React Native / Expo app | `idp-auth-mobile` |
| `Info.plist` (iOS) / `AndroidManifest.xml` (Android) / `pubspec.yaml` (Flutter) | Native mobile app | `idp-auth-mobile` |
| `nest-cli.json` | NestJS backend | `idp-integrate-oauth-web` (if it serves login) or `idp-validate-token` (if API-only) |
| `Gemfile` (Rails), `manage.py` (Django), `*.csproj` (ASP.NET) | Server-rendered/BFF web app | `idp-integrate-oauth-web` |
| Express/Hono/Fastify server with routes/controllers but **no pages, no login UI** | Resource Server | `idp-validate-token` |
| Entry point is a worker/cron/queue consumer (no HTTP listener or headless), calls other APIs | M2M service | `idp-integrate-m2m` |
| Config for Auth.js (`auth.config.*`, `[...nextauth]`), `openid-client`, `oidc-client-ts` in deps | Generic OIDC library in use | `idp-use-oidc-discovery` |

### Tie-breakers

- **Next.js beats generic web**: if both `next.config.*` and other backend markers exist, prefer
  `idp-auth-nextjs` (App Router) — it is the dedicated child of `idp-integrate-oauth-web`.
- **Login beats validation**: if the system both starts logins and validates tokens, run the login
  route first, then `idp-validate-token` for its API surface.
- **A backend that CAN hold a secret always wins over public**: only route to `idp-auth-mobile`
  when there is truly no server-side component to keep a `client_secret`.
- **When two signals conflict, ask** — one plain-language question beats a wrong route:
  "Seu sistema tem um servidor próprio rodando, ou é só a parte que aparece no navegador/celular?"

---

## 3. From route to client type (feeds Phase 2)

| Route | Client type to register | `isPublic` | `allowedGrantTypes` |
|---|---|---|---|
| `idp-auth-nextjs`, `idp-auth-vite-bff`, `idp-integrate-oauth-web` | Confidential web BFF | `false` | `["authorization_code", "refresh_token"]` |
| `idp-auth-mobile` | Public (PKCE-only) | `true` | `["authorization_code", "refresh_token"]` |
| `idp-integrate-m2m` | M2M | `false` | `["client_credentials"]` |
| `idp-validate-token` | none — a Resource Server validates tokens without registering a client | — | — |
