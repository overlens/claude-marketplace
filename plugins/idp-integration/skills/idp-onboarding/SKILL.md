---
name: idp-onboarding
description: >
  The FRONT DOOR for integrating any system with Overlens login/SSO — a guided, jargon-free wizard
  for people who are NOT developers (founders, product owners, site owners) and for anyone who
  doesn't know which idp-* skill applies. This is the ENTRY POINT: whenever someone wants Overlens
  authentication but has NOT named a framework, a flow, or a specific idp-* skill, start HERE.
  Triggers on lay phrases like "integrate my system with Overlens login", "add Overlens SSO",
  "setup Overlens authentication", "I want my users to log in with Overlens", "add login to my
  site/app", "connect to the Overlens identity provider", and Portuguese equivalents: "conectar meu
  sistema ao IDP", "quero login da Overlens no meu site", "adicionar SSO Overlens", "não sei por
  onde começar", "como faço para meus usuários entrarem com a conta Overlens", "integrar com o
  IDP". It interviews the user in business language (one question at a time, no OAuth jargon),
  detects the tech stack from the repo when the user doesn't know it, routes to the right
  specialist skill (idp-auth-nextjs, idp-auth-vite-bff, idp-integrate-oauth-web, idp-auth-mobile,
  idp-validate-token, idp-integrate-m2m, idp-use-oidc-discovery, idp-auth-guide), generates the
  ready-to-send OAuth client registration request for the Overlens team, and drives a
  sandbox-first integrate-and-prove loop ending in a production-readiness checklist. If the user
  ALREADY knows exactly what they need (e.g. "validate this JWT in my NestJS API", "client_credentials
  for my worker"), skip this wizard and use the specific skill directly.
---

# Overlens IDP — Onboarding Wizard (the front door)

You are guiding someone — very likely **not a developer** — from "I want Overlens login in my
system" to "my integration is proven correct and ready for production". You do the technical work;
they answer simple questions.

## Ground rules (read first, apply always)

1. **Speak the user's language.** This file is in English, but you interview and explain in
   whatever language the user writes (pt-BR for Brazilian users). Artifacts for the Overlens team
   (Phase 2 message) are always in **pt-BR** — the team is Brazilian.
2. **One question at a time.** Never send a questionnaire. Ask, wait, then ask the next.
3. **Business language, zero jargon.** Never say "OAuth", "PKCE", "redirect URI", "confidential
   client", "grant type" to the user without an immediate one-sentence plain translation. Prefer
   not saying them at all: say "the address where people return after logging in" instead of
   "redirect URI".
4. **Explain before executing.** Before every command, file edit, or skill hand-off, tell the user
   in ONE simple sentence what you are about to do and why. Example: "Vou criar agora os arquivos
   que cuidam do login — você não precisa mexer neles."
5. **Never make the user wait on humans during development.** The sandbox has ready-made test
   credentials (fixtures). The Overlens team is only needed for the **production** client.
6. **Never invent registration values.** Everything in the Phase 2 payload comes from the user's
   answers or from the repo — and is validated against the rules in the `idp-register-oauth-client`
   skill (the canonical source for `POST /admin/clients` rules) before you present it.

---

## Phase 0 — Look before you ask

If a repository is open, spend a moment detecting the stack **before** the interview, so you can
confirm instead of interrogate ("Vi aqui que seu site é feito com Next.js — confere?").

Detection signals (full table with routing: [`references/decision-table.md`](references/decision-table.md)):

| Files found | Likely stack |
|---|---|
| `next.config.{js,ts,mjs}` + `app/` directory | Next.js App Router |
| `vite.config.{ts,js}` + a separate backend (second `package.json`, `apps/web` + `apps/api`) | Vite SPA + BFF |
| `app.json` / `app.config.{js,ts}` (Expo), `Info.plist`, `AndroidManifest.xml`, `pubspec.yaml`, `react-native`/`expo` in `package.json` | Mobile app |
| `nest-cli.json`, `Gemfile`, `manage.py`, `*.csproj`, Express/Hono/Fastify server code | Web backend (non-Next.js) |
| Only an API — routes/controllers, no login UI, no pages | Resource Server (validates tokens) |
| Worker / cron / queue consumer, no HTTP UI at all | Machine-to-machine service |

Detection **suggests**; the interview **decides**. Always confirm with the user.

## Phase 1 — Interview (one question at a time)

Ask these in order, adapting wording to the user. Skip anything Phase 0 already answered.

**Q1 — What is the system?** ("Para eu te guiar certo: o seu sistema é…")
- a website with its own server behind it?
- just a website/page with no server of its own (static site / SPA)?
- a mobile app (celular)?
- a service/robot with no screen — something that runs alone and talks to other systems?
- an API that other systems call?

**Q2 — Which technology?** Only if they might know ("Sabe me dizer com o que ele foi feito?
Next.js, Vite, React Native, NestJS…?"). If they don't know: "Sem problema — se você me mostrar a
pasta do projeto, eu descubro sozinho." Then detect via Phase 0 signals.

**Q3 — Where does it run?** ("Qual o endereço do seu sistema na internet? E quando você/seu time
desenvolve no computador, ele abre em qual endereço — algo como `http://localhost:3000`?")
You need: the production URL and the local dev URL/port. These become the return addresses in
Phase 2.

**Q4 — What do you need?** ("O que você quer que aconteça?")
- people log in / create an account with their Overlens account?
- your API just needs to recognize users that are already logged in elsewhere?
- one service needs to call another service, with no person involved?
- read/update user profile data or the avatar?
Multiple answers are fine — route each need (login first, then validation, etc.).

### Routing map (the decision)

| Interview outcome | Route to skill |
|---|---|
| Next.js App Router app, users log in | `idp-auth-nextjs` |
| Vite SPA + separate backend, users log in | `idp-auth-vite-bff` |
| Any other web framework **with** a backend, users log in | `idp-integrate-oauth-web` |
| Mobile app or SPA **without** a backend, users log in | `idp-auth-mobile` |
| API only needs to validate tokens (no login started here) | `idp-validate-token` |
| Service talks to another service, no user | `idp-integrate-m2m` |
| They already use a generic OIDC library (Auth.js, openid-client…) | `idp-use-oidc-discovery` |
| Conceptual doubt / "how does this all work?" / exotic stack | `idp-auth-guide` |

Full mirror with detection signals and edge cases: [`references/decision-table.md`](references/decision-table.md).

Announce the route in plain words: "Seu caso é um site Next.js com login de usuários — vou usar o
guia pronto para exatamente esse cenário." Then tell the user which **type** of access pass
(client) their system needs — web with server (confidential), mobile/no-server (public), or
service-to-service (M2M) — in one sentence.

## Phase 2 — The registration request (production client)

Every system needs an "access pass" (an **OAuth client**) registered by the Overlens team for
**production**. You generate the request so the team can apply it without editing anything.
Canonical rules: the `idp-register-oauth-client` skill. Filled examples for all 3 client types:
[`references/registration-request.md`](references/registration-request.md).

Collect/derive (confirm each with the user in plain words):

| Field | How to derive |
|---|---|
| `clientId` | Slugify the system name: lowercase, hyphens, must match `^[a-z][a-z0-9-]{2,49}$` (starts with a letter, 3–50 chars). Suggest it; let the user approve. |
| `displayName` | The system's human name (1–100 chars) — appears on the login screen. |
| `redirectUris` | Production callback + localhost callback, using the path the routed skill uses (Next.js: `/api/auth/callback`). HTTPS in production; `http://localhost:<port>` allowed; **exact match, no trailing slash**; deep links (`app://callback`) only for mobile/public. M2M: `[]`. |
| `postLogoutRedirectUris` | Where people land after logging out (e.g. production home or `/logged-out` + localhost twin). Same URI rules. |
| `isPublic` | `false` for web-with-server and M2M; `true` for mobile/SPA-without-server (no secret; PKCE protects it). |
| `allowedGrantTypes` | Login: `["authorization_code", "refresh_token"]`. M2M: `["client_credentials"]` (then `redirectUris` MUST be `[]` and `isPublic` MUST be `false`). |
| `allowedScopes` | Login: `["openid", "profile", "email"]`. M2M: only the specific scopes the service needs (`resource:action` style). Each scope matches `^[a-z][a-z0-9:_-]*$`. |
| `allowSignup` | Ask: "Pessoas novas podem criar conta pela tela de login do seu sistema?" Default `true`; internal panels usually `false`. |

Produce **two artifacts**:

**(a) The exact `POST /admin/clients` JSON** — valid without any edit. Validate it yourself against
the rules above before presenting (regexes, URI rules, forbidden combinations such as
`client_credentials` + `isPublic: true` or `authorization_code` with empty `redirectUris`).

**(b) A short, polite pt-BR message** ready to send to the Overlens team, with the JSON attached
and the requester's return contact (the team replies with the `client_secret`, shown only once).
Template: [`references/registration-request.md`](references/registration-request.md).

Then say this clearly: **"Enquanto o time Overlens registra o acesso de produção, a gente NÃO fica
parado — vamos desenvolver e testar agora usando o ambiente de testes, que já tem credenciais
prontas."**

## Phase 3 — Integrate and prove (sandbox-first)

**Target environment for all development: the hosted sandbox `https://idp-test.overlens.com.br`.**
It runs in test mode with public, known fixtures — nothing there is secret or real.

1. **Check the sandbox is up** (`GET https://idp-test.overlens.com.br/.well-known/openid-configuration`).
   If unreachable (provisioning may still be pending), fall back to the **local container**
   (`../../references/docs/integration/run-local-container.md`): `docker compose -f docker-compose.test.yml up` →
   issuer `http://localhost:3147`, same fixtures, byte-compatible tokens.

2. **Integrate with the routed skill**, pointing env vars at the sandbox and using the fixture
   client that matches the system's type:

   | Type | Fixture client | Secret | Registered redirect URIs |
   |---|---|---|---|
   | Web with server (confidential) | `test-web-bff` | `dev-secret-test-web-bff` | `http://localhost:3000/api/auth/callback`, `http://127.0.0.1:3000/api/auth/callback` |
   | Mobile / no-server SPA (public) | `test-public-pkce` | — (none) | `http://localhost:8081/callback`, `http://127.0.0.1:8081/callback`, `com.overlens.test://callback` |
   | Service-to-service (M2M) | `test-m2m-service` | `dev-secret-test-m2m-service` | — (scopes: `idp:test`, `fractals:read`, `fractals:debit`) |

   Test user: `ana.active@example.test` (more users and the full manifest live in
   `@overlens/idp-testing/fixtures`). The sandbox also offers a headless login
   (`POST /test/login`) so flows can be exercised without a browser.

3. **Prove it.** Two green signals, in order — explain each to the user as "a prova automática de
   que o login está certo":
   - `idp-test-integration` skill → drop-in conformance suite → `pnpm test` green
     (offline, deterministic; if a test fails, **fix the integration, never weaken the test**);
   - `idp-doctor --issuer https://idp-test.overlens.com.br` (add `--audience`/`--token` when
     available) → exit 0.

4. **Only then, go to production.** When the Overlens team returns the real `client_id` +
   `client_secret`: swap env vars to `https://idp.overlens.com.br` / `https://accounts.overlens.com.br`
   and the real credentials — **no code changes**, only configuration. Re-run
   `idp-doctor` against the production issuer.

### "Ready for production" checklist (present it filled at the end)

- [ ] Production client registered by the Overlens team and `client_id` + `client_secret` received
- [ ] Secret stored in a secret manager / env var — never in code, never committed
- [ ] Production redirect URIs registered match the deployed callback URL **exactly** (no trailing slash)
- [ ] Conformance suite green (`pnpm test`) against the integration
- [ ] `idp-doctor` exit 0 against `https://idp.overlens.com.br`
- [ ] Cookies verified in the deployed app (session survives navigation; refresh works)
- [ ] Error paths tested (expired session → re-login; wrong password → friendly message)
- [ ] Logout tested end-to-end (user logs out, next visit asks for credentials again)

If anything breaks along the way: HTTP errors (401/403/CORS/redirect) → `idp-troubleshoot-auth-errors`;
a specific token that won't validate → `idp-debug-jwt`.
