---
name: idp-register-oauth-client
description: >
  Complete guide for registering — or requesting the registration of — an OAuth client in the
  Overlens IDP, the prerequisite for EVERY integration. Use this skill whenever someone needs a
  `client_id`/`client_secret` for the Overlens IDP, wants to register an OAuth client, add or fix
  `redirectUris`/`postLogoutRedirectUris`, set `allowSignup`, choose
  `allowedGrantTypes`/`allowedScopes`, or register an M2M service client. Triggers on phrases like
  "register an OAuth client", "cadastrar client no IDP", "criar um client OAuth Overlens",
  "I need a client_id and client_secret", "POST /admin/clients", "add my redirect URI to the IDP",
  "my callback URL isn't registered", "allowSignup Overlens", "M2M client registration",
  "public PKCE client registration", "postLogoutRedirectUris", "how do I get my app registered
  with Overlens". Covers the three client types (confidential web BFF, public PKCE mobile/SPA,
  M2M) with the exact `POST /admin/clients` payload for each, all validation rules (clientId
  regex, redirect-URI exact-match/HTTPS rules, allowed grant-type combinations), the
  shown-only-once `client_secret`, and — when the requester is NOT an Overlens admin — generates
  a ready-to-send registration request (exact JSON payload + short covering message) for the
  Overlens team. If the task is to WIRE UP the integration after the client exists, prefer
  `idp-integrate-oauth-web` / `idp-auth-nextjs` / `idp-auth-mobile` / `idp-integrate-m2m`. If an
  already-registered client is producing HTTP errors (`invalid_client`, `invalid_redirect_uri`,
  `unauthorized_client`), prefer `idp-troubleshoot-auth-errors`.
---

# Overlens IDP — Register an OAuth Client

Every system that authenticates via the Overlens IDP needs a registered **OAuth Client**. Without one, the IDP rejects every `/auth/authorize` and `/auth/token` call. This skill gets the client registered correctly on the first try — or, if you can't register it yourself, produces a request the Overlens team can apply without editing.

> **Canonical doc:** `../../references/docs/integration/oauth-clients.md` — full schema, all admin endpoints, audit log, lifecycle, seed/bootstrap. This skill curates it into a registration workflow. When in doubt, the doc wins.

---

## Two modes — figure out which one you're in

Registration happens **only** through the admin API (`POST /admin/clients`) or the admin UI (`accounts.overlens.com.br/admin/clients`). There is no self-service and no Dynamic Client Registration (RFC 7591). The API requires a **user** JWT with `role=ADMIN` — M2M tokens are rejected by `AdminRoleGuard`, so there is no service-account path to it.

So the first question is: **is the person you're helping an Overlens admin?**

- **Yes (admin mode)** → collect the values, build the payload, run `POST /admin/clients` (or walk them through the UI). See "Register via the admin API".
- **No (request mode)** — external integrator, partner, or any dev without `role=ADMIN` → do NOT dead-end. Generate a **registration request**: the exact JSON payload plus a short message to send to the Overlens team. See "Registration-request mode" below. Never invent a `client_id`/`client_secret` or imply the registration already happened.

Either way, start by picking the client type.

---

## Pick the client type (decision gate)

Three questions, in order:

1. **Is there no user in the flow at all** (worker, cron, queue consumer, service calling an API as itself)? → **M2M** (type C).
2. **Does a server you control sit in the flow and hold secrets** (Next.js BFF, NestJS, Express, Rails, Django, ASP.NET)? → **Confidential web** (type A).
3. **Does the code run entirely on the user's device or browser** (React Native, Expo, native iOS/Android, Flutter, backend-less SPA)? → **Public PKCE** (type B).

| Type | `isPublic` | Secret | `allowedGrantTypes` | `redirectUris` |
|---|---|---|---|---|
| A — Confidential web (BFF) | `false` | yes, shown once | `["authorization_code", "refresh_token"]` | https callback URLs (+ localhost for dev) |
| B — Public (mobile/SPA, PKCE) | `true` | **none** (`clientSecret: null`) | `["authorization_code"]` | deep links (`app://callback`) or localhost |
| C — M2M (service) | `false` | yes, shown once | `["client_credentials"]` | **`[]`** — must be empty |

---

## Type A — Confidential web (BFF)

```json
POST /admin/clients
{
  "clientId": "hodos",
  "displayName": "Hodos",
  "isPublic": false,
  "redirectUris": [
    "https://hodos.com.br/api/auth/callback",
    "http://localhost:4000/api/auth/callback"
  ],
  "postLogoutRedirectUris": [
    "https://hodos.com.br/",
    "http://localhost:4000/"
  ],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true
}
```

- Include **every** environment's callback (production + staging + dev). No wildcards, no fallback.
- `postLogoutRedirectUris` is the allowlist for RP-initiated logout (`GET /auth/logout`). Without it, logout never redirects back to the app.
- `allowSignup: false` hides "Criar conta" on the Accounts login screen **and is enforced server-side** (signup returns `400 unauthorized_client`) — use it for internal/admin panels.
- `displayName` is shown on the login screen: "Entrar para acessar **Hodos**".

## Type B — Public (mobile / backend-less SPA, PKCE-only)

```json
POST /admin/clients
{
  "clientId": "overlens-mobile",
  "displayName": "Overlens App",
  "isPublic": true,
  "redirectUris": ["overlens://callback"],
  "postLogoutRedirectUris": ["overlens://logged-out"],
  "allowedGrantTypes": ["authorization_code"],
  "allowedScopes": ["openid", "profile", "email"]
}
```

- **No secret exists.** The creation response has `"clientSecret": null`. Security comes entirely from PKCE S256, which is mandatory at token exchange.
- **Deep links are allowed only for public clients** (`overlens://callback`, `com.yourco.app://callback`). Exact byte match — `overlens://callback` ≠ `overlens://callback/`.
- For an SPA in a browser during dev, `http://localhost:<port>/callback` may be registered (http is allowed only for localhost).
- Register the post-logout deep link too, or logout can't return to the app.
- If refresh calls come back `400 unauthorized_client`, add `"refresh_token"` to `allowedGrantTypes`.

## Type C — M2M (service-to-service, `client_credentials`)

```json
POST /admin/clients
{
  "clientId": "fractals-service",
  "displayName": "Fractals Service",
  "isPublic": false,
  "redirectUris": [],
  "allowedGrantTypes": ["client_credentials"],
  "allowedScopes": ["fractals:debit", "fractals:read", "fractals:report"],
  "allowSignup": false
}
```

- `redirectUris` **must** be `[]` — M2M never redirects; a non-empty array is rejected at registration.
- Must be confidential — `client_credentials` on a public client is rejected.
- `allowedScopes` is the **exhaustive** set the service may ever be granted; the token request can only narrow it, never widen it. List exactly what the service needs.
- `allowSignup: false` — no user signup is possible on an M2M client.

---

## Validation rules (the DTO rejects anything else)

| Field | Rule |
|---|---|
| `clientId` | regex `^[a-z][a-z0-9-]{2,49}$` — 3–50 chars, starts with a lowercase letter, hyphens allowed. Unique; duplicates → `400`. |
| `displayName` | string, 1–100 chars |
| `redirectUris` | up to 20, unique. **HTTPS required** for public URLs; `http://localhost:<port>` allowed; deep links (`app://…`) only for public clients. **Exact byte match** at OAuth time — no wildcards, no trailing-slash normalization. |
| `postLogoutRedirectUris` | optional (default `[]`); same URI rules as `redirectUris`. Allowlist for `GET /auth/logout` (exact match). |
| `allowedGrantTypes` | non-empty array, subset of `["authorization_code", "refresh_token", "client_credentials"]`, no duplicates |
| `allowedScopes` | up to 50 items, each matching `^[a-z][a-z0-9:_-]*$` |
| `allowSignup` | boolean, default `true` |

**Invalid combinations** (semantic validation, rejected with `400`):

- `client_credentials` with `isPublic: true`
- `client_credentials` with non-empty `redirectUris`
- `authorization_code` with **no** `redirectUris`
- Changing `isPublic` `false` → `true` via `PATCH` without `confirmSecretDrop: true`

---

## Register via the admin API (admin mode)

```bash
curl -X POST https://idp.overlens.com.br/admin/clients \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '<one of the payloads above>'
```

**Response 201:**

```jsonc
{
  "client": { /* OAuthClientPublic — never contains the secret hash */ },
  "clientSecret": "<client-secret>",   // null for public clients
  "warning": "O client_secret não será exibido novamente. Copie-o agora."
}
```

### ⚠️ The secret is shown ONCE

The `clientSecret` appears **exactly once**, in this response. There is no endpoint to read it again. If it's lost, the only path today is **delete + recreate the client** (no soft rotation, no multiple live secrets). Copy it straight into a secret manager (Railway Variables, Infisical, AWS Secrets Manager, 1Password) — never into code, never into logs.

### Registration errors

| HTTP | Cause |
|---|---|
| 400 | validation failure or an invalid combination (see tables above), or duplicate `clientId` |
| 401 / 403 | missing admin JWT, or the token is not a user with `role=ADMIN` (this includes all M2M tokens) |

### Verify or fix an existing client

```bash
# inspect
curl https://idp.overlens.com.br/admin/clients/<id> -H "Authorization: Bearer $ADMIN_JWT"

# add a missing redirect URI (PATCH replaces the whole array — send the full list)
curl -X PATCH https://idp.overlens.com.br/admin/clients/<id> \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{ "redirectUris": ["https://app.example.com/api/auth/callback", "http://localhost:4000/api/auth/callback"] }'
```

Lifecycle: `POST /admin/clients/:id/disable` (reversible via `/enable`), `DELETE /admin/clients/:id` (soft delete, not reversible via API), `GET /admin/clients/:id/audit-log` (every mutation, with actor/IP/user-agent).

---

## Registration-request mode (the user is NOT an admin)

When the person you're helping cannot call `/admin/clients`, your job is to produce a **request the Overlens team can apply verbatim**. Do this:

1. **Interview the user in their own language.** Collect:
   - the **system name** → becomes `displayName`, and suggests a `clientId` (lowercase slug matching `^[a-z][a-z0-9-]{2,49}$`);
   - the **client type** via the decision gate above (server-held secret? device-only? no user?);
   - **every redirect URI**, per environment (production, staging, dev/localhost) — exact strings, they will be matched byte-for-byte;
   - the **post-logout redirect URIs** (where users land after logout);
   - the **scopes** needed (`openid profile email` for user login; specific `service:action` scopes for M2M);
   - whether **signup** should be allowed (`allowSignup`).
2. **Validate everything locally** against the rules table before emitting — regex on `clientId` and scopes, HTTPS/localhost/deep-link rules on the URIs, grant-type combinations. The payload must be applicable **without edits**.
3. **Emit two things**: the exact JSON body of `POST /admin/clients` in a fenced code block, and a short covering message (in the user's language) to send to the Overlens team.

Example output (message language adapts to the user; the JSON never changes shape):

````markdown
**Registration request — send to the Overlens team** (e.g. the platform/IDP channel):

> Hi! Please register the OAuth client below in the IDP (`POST /admin/clients`).
> System: Hodos (web app with a NestJS BFF). Contact: dev@hodos.com.br.
> Please return the `client_id` confirmation and the `client_secret` through a
> secure channel — we know it is shown only once.

```json
{
  "clientId": "hodos",
  "displayName": "Hodos",
  "isPublic": false,
  "redirectUris": [
    "https://hodos.com.br/api/auth/callback",
    "http://localhost:4000/api/auth/callback"
  ],
  "postLogoutRedirectUris": [
    "https://hodos.com.br/",
    "http://localhost:4000/"
  ],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true
}
```
````

4. **Set expectations**: for confidential/M2M clients the team sends back the `client_secret` **once** — it must go straight into a secret manager. Public clients get no secret at all; the `client_id` alone is enough to start integrating.

---

## Common pitfalls

1. **Forgetting the localhost callback** — dev breaks with `400 invalid_redirect_uri`. Register production **and** dev URIs up front.
2. **Trailing slash / wrong port / http vs https** — the match is byte-for-byte. `…/callback` ≠ `…/callback/`.
3. **Wildcards** — never supported, by design. Register every URI explicitly.
4. **Deep link on a confidential client** — deep links are public-client-only.
5. **`client_credentials` plus redirect URIs (or `isPublic: true`)** — rejected at registration.
6. **Losing the secret** — it is shown once; today the only recovery is delete + recreate. Capture it immediately.
7. **Trying to register via an M2M token** — `/admin/*` requires a user ADMIN JWT; there is no service-account path.
8. **Skipping `postLogoutRedirectUris`** — logout will not redirect back to the app.

---

## Related skills

- Wire up the integration once the client exists: `idp-integrate-oauth-web` (web BFF), `idp-auth-nextjs` (Next.js App Router), `idp-auth-vite-bff` (Vite + BFF), `idp-auth-mobile` (public PKCE), `idp-integrate-m2m` (client_credentials).
- HTTP errors from a registered client (`invalid_client`, `invalid_redirect_uri`, `unauthorized_client`) → `idp-troubleshoot-auth-errors`.
- Configuring a generic OIDC library → `idp-use-oidc-discovery`.

## Where the real docs live

- `../../references/docs/integration/oauth-clients.md` — the canonical guide (schema, endpoints, validations, recipes, lifecycle, bootstrap)
- `../../references/docs/integration/logout.md` §8 — how `postLogoutRedirectUris` is enforced
- `../../references/docs/integration/m2m.md` — the M2M flow the type-C client feeds

## File map of this skill

```
idp-register-oauth-client/
└── SKILL.md                          (this file — self-contained)
```
