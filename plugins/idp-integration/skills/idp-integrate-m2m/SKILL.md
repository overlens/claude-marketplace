---
name: idp-integrate-m2m
description: >
  Hands-on, implementation-focused guide for integrating the Overlens IDP into a backend service
  that authenticates as ITSELF (machine-to-machine), with no user in the flow — OAuth 2.0
  `client_credentials` grant (RFC 6749 §4.4). Use this skill whenever a developer is wiring up a
  worker, cron job, queue consumer, microservice, or external system that needs to call another
  Overlens API on its own behalf. Triggers on phrases like "server-to-server Overlens", "M2M
  Overlens", "client_credentials Overlens", "how does my worker authenticate to the Overlens API",
  "my service needs a token to call api.overlens.com.br", "scope-based auth Overlens", "Overlens
  service account", "fractals-service token", "POST /auth/token client_credentials", or when a
  backend service (no browser, no user session) needs to obtain and cache an Overlens access token.
  Provides copy-paste M2M client templates (TypeScript, Python, Go) with in-memory token caching,
  the `POST /admin/clients` registration request, required env vars, and scope guards for the
  Resource Server that consumes the M2M token. If there IS a human user logging in (browser, mobile,
  SPA), this is the WRONG skill — prefer `idp-integrate-oauth-web` (web/BFF) or `idp-auth-mobile`
  (public client). If the task is only to VALIDATE incoming JWTs in a Resource Server (not to obtain
  one), prefer `idp-validate-token`. If the task is to register the OAuth client as an admin, prefer
  `idp-register-oauth-client`.
---

# Overlens IDP — M2M (Machine-to-Machine) Integration

This skill walks a developer through wiring **OAuth 2.0 `client_credentials`** between a backend service and the Overlens IDP. The service authenticates **as itself** — there is no user, no browser, no cookie, no redirect, no PKCE, no refresh token. Just a back-channel `POST /auth/token` with the client's credentials, returning a short-lived (5 min) JWT the service uses as a `Bearer` token against another Overlens API.

> **Mental model:** an M2M token identifies a **service**, not a person. It carries `client_id` and `scope` — never `email` or `role`. Every authorization decision downstream must be **scope-based**.

> **Canonical docs:** `../../references/docs/integration/m2m.md` (full guide), `../../references/docs/integration/oauth-clients.md` §6-C (registration), `../../references/docs/integration/backend.md` §3 (user-vs-M2M discrimination). This skill curates those plus copy-paste templates.

> **Reading a user's global profile?** If your M2M service needs the global identity attributes (`name`, `username`, `email`, `phone`, `document`, `birthDate`, `avatar`) of a user by `sub` — which do **not** travel in the JWT — call `GET /users/:sub` with the `profile:read` scope. See `../../references/docs/integration/m2m-profile-read.md` (RFC-0002). Same `client_credentials` flow as this skill; just request the `profile:read` scope and grant it in the client's `allowedScopes`.

---

## Am I in the right place? (decision gate)

M2M is narrow on purpose. Confirm **all** of these before writing code:

1. **No user in the flow.** The caller is a worker/cron/service acting on its own behalf. If a human is logging in → wrong skill (`idp-integrate-oauth-web` / `idp-auth-mobile`).
2. **You are calling OUT to another Overlens API.** If instead you are *receiving* requests and need to *validate* their JWTs → that's `idp-validate-token` (you may need both: this skill for the caller, that one for the callee).
3. **You can keep a secret.** M2M is a **confidential** client. The `client_secret` lives in a secret manager on a server you control. If the code runs in a browser/mobile/SPA, M2M is impossible — there's nowhere safe for the secret.
4. **You are NOT trying to call `/admin/*`.** Admin endpoints require a **user** JWT with `role=ADMIN`. M2M tokens are rejected by `AdminRoleGuard` by design. There is no M2M path to admin.

If any of these is shaky, resolve it before continuing — most M2M support tickets are actually one of the above misrouted.

---

## The big picture

```
[Your Service: worker/cron]              [IDP: idp.overlens.com.br]         [Resource Server: api.overlens.com.br]
        │                                          │                                       │
        │ 1. need to call the API                  │                                       │
        │    → ask for a token (cache miss)        │                                       │
        │                                          │                                       │
        │ 2. POST /auth/token ────────────────────►│                                       │
        │    Authorization: Basic base64(id:secret)│                                       │
        │    grant_type=client_credentials         │                                       │
        │    scope=fractals:debit fractals:read    │                                       │
        │                                  validate secret (bcrypt)                        │
        │                                  validate scope ⊆ allowedScopes                  │
        │                                  sign RS256 JWT (exp = iat + 300)                │
        │ 3. ◄── { access_token, expires_in: 300, scope } ─                                │
        │                                          │                                       │
        │ 4. cache token until exp − 30s           │                                       │
        │                                          │                                       │
        │ 5. POST /fractals/debit  Authorization: Bearer <jwt> ───────────────────────────►│
        │                                          │                              validate via JWKS (cached)
        │                                          │                              check iss, aud, alg=RS256, exp
        │                                          │                              check scope covers the action
        │ 6. ◄────────────────────── 200 OK ──────────────────────────────────────────────│
```

Everything is **back-channel** (server → server, JSON + headers). Two URLs that are easy to confuse:
- `idp.overlens.com.br` — where you **get** the token (step 2). This is the only place the `client_secret` goes.
- `api.overlens.com.br` (or whatever the target Resource Server is) — where you **spend** the token (step 5).

---

## What makes M2M different from the user OAuth flow

Devs coming from the web/mobile flow trip on these. Internalize them:

| Concept | User flow (`authorization_code`) | M2M (`client_credentials`) |
|---|---|---|
| Browser / redirect | yes | **no** |
| PKCE | yes | **no** (no `code` to protect) |
| `redirect_uri` | required, exact-match | **`[]`** — none registered |
| Refresh token | yes, rotated | **none** — re-fetch is cheap, just call `/auth/token` again |
| Cookies | session cookies in your domain | **none** — `Bearer` header only |
| Token TTL | 15 min | **5 min** (300s) |
| Identity in JWT | `email`, `role`, `sub`=userId | `client_id`, `scope`, `sub`=clientId |
| Authorization basis | `role` | **`scope`** |

Asking for `grant_type=refresh_token` on an M2M client returns `400 unauthorized_client` — refresh is not in its `allowedGrantTypes`. There is nothing to refresh; obtaining a new token is one cheap call.

---

## Implementation checklist

Treat this as your todo list. Each item is small and verifiable.

- [ ] **Register the M2M client** in the IDP (`isPublic:false`, `allowedGrantTypes:['client_credentials']`, `redirectUris:[]`, exact `allowedScopes`). See `references/client-registration.md`. The `client_secret` is shown **once** — capture it.
- [ ] Store the secret in a secret manager (Railway Variables / Infisical / AWS Secrets Manager). Never in code, never in logs.
- [ ] Set env vars: `IDP_BASE_URL`, `IDP_M2M_CLIENT_ID`, `IDP_M2M_CLIENT_SECRET`, `IDP_M2M_SCOPES`.
- [ ] Copy the M2M client template for your language (`templates/idp-m2m-client.ts` / `.py` / `.go`) — it caches the token in memory until `exp − 30s`.
- [ ] Send the token as `Authorization: Bearer <jwt>` on calls to the target API.
- [ ] On the **Resource Server** side, authorize the caller by **scope** (`payload.scope`), never by `role`. See `references/resource-server.md`.
- [ ] Verify the Resource Server distinguishes M2M from user tokens: `!!payload.client_id && !payload.email`.
- [ ] Confirm you are **not** pointing M2M at any `/admin/*` endpoint (it will 403).

---

## Critical contracts (memorize these)

### Token request (back-channel)

```
POST https://idp.overlens.com.br/auth/token
Authorization: Basic base64("<client_id>:<client_secret>")
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&scope=fractals:debit fractals:read      # optional; omit → all allowedScopes granted
```

Credentials may instead go in the body (`client_secret_post`) — `client_id` + `client_secret` form fields, no Basic header. Both methods are supported; Basic is the default the templates use.

**Response 200:**
```json
{
  "access_token": "<RS256 JWT, 5 min>",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "fractals:debit fractals:read"
}
```

`scope` in the response is the **effectively granted** set — the intersection of what you requested and the client's `allowedScopes`. Trust the response, not your request.

### The M2M JWT payload

```json
{
  "sub": "fractals-service",
  "client_id": "fractals-service",
  "scope": "fractals:debit fractals:read",
  "iss": "https://idp.overlens.com.br",
  "aud": ["https://api.overlens.com.br"],
  "iat": 1748275200,
  "exp": 1748275500
}
```

There is **no** `email`, `name`, `role`, `email_verified`, or `new_user`. That absence is the discriminator: a Resource Server tells M2M from user with `const isM2M = !!payload.client_id && !payload.email;`.

### Token-endpoint errors

| HTTP | `error` | Cause | Fix |
|---|---|---|---|
| 400 | `invalid_request` | `grant_type` missing | Send `grant_type=client_credentials` |
| 400 | `invalid_scope` | requested a scope not in `allowedScopes` | Request only registered scopes, or widen `allowedScopes` |
| 400 | `unauthorized_client` | `client_credentials` not in the client's `allowedGrantTypes` (e.g. you asked for refresh) | Fix the client registration / stop asking for refresh |
| 401 | `invalid_client` | unknown client, bad secret, or a **public** client trying M2M | Check creds; M2M must be `isPublic:false`. Response carries `WWW-Authenticate: Basic realm="IDP"` |

---

## The #1 thing to get right: cache the token

A 5-minute token with no refresh means the naive approach — fetch a token on every outbound call — hammers `POST /auth/token` (throttled at 30 req/min per IP, in every environment) and adds a round-trip to every request. **Cache the token in memory and reuse it until just before it expires** (the templates use a 30s safety margin).

If you're hitting `429` on `/auth/token`, you almost certainly forgot to cache.

The cache is per-process and in-memory by design — it doesn't need to be shared or persisted. Token loss on restart just means one extra fetch.

---

## Language selection

All three templates implement the same contract: lazy fetch, in-memory cache, refetch at `exp − 30s`, Basic auth.

- **TypeScript / Node / NestJS** → `templates/idp-m2m-client.ts` (the NestJS-injectable `IdpM2MClient`; works standalone too)
- **Python** → `templates/idp_m2m_client.py` (`requests`-based, thread-safe)
- **Go** → `templates/idp_m2m_client.go` (`net/http`, mutex-guarded cache)

For any other language, port the same shape: build Basic header → POST form-encoded `grant_type=client_credentials` (+ optional `scope`) → cache `access_token` with `expiresAt = now + expires_in` → return cached token while `expiresAt − 30 > now`.

---

## Common pitfalls — read before debugging

1. **Fetching a token per request** — see the caching section. This causes `429` and latency. Cache it.
2. **Authorizing by `role`** — M2M tokens have no `role`. Any `RolesGuard`/`role === 'ADMIN'` check fails closed for services. Authorize by **scope**.
3. **Pointing M2M at `/admin/*`** — rejected by design. Admin actions need a user ADMIN token. There is no workaround; if a service "needs to be admin," reconsider the design.
4. **Registering with `isPublic:true`** — a public M2M client is rejected (`400 unauthorized_client` at token time). M2M's only credential is the secret, so it must be confidential.
5. **Registering with non-empty `redirectUris`** — `client_credentials` + redirect URIs is rejected at registration (`400`). M2M uses no redirect.
6. **Asking for a refresh token** — there isn't one. `grant_type=refresh_token` → `400 unauthorized_client`. Just call `/auth/token` again.
7. **Requesting a scope not in `allowedScopes`** — `400 invalid_scope`. The grant can only narrow, never widen, the registered set.
8. **Logging the secret or the token** — the secret is permanent; a leaked token lives ≤5 min but still. Keep both out of logs and error payloads.
9. **Confusing the two hosts** — secret goes to `idp.overlens.com.br/auth/token`; the resulting Bearer goes to the target API. Sending the secret to the wrong host is a credential leak.
10. **Expecting revocation** — there is no token revocation. To cut off a compromised service, rotate its `client_secret` via the admin API; existing tokens still work until `exp` (≤5 min). Plan for that gap.

---

## Coming soon: reading a user's global profile (`GET /users/:sub`, RFC-0002)

> **Status: proposed, not yet implemented.** Don't wire this up yet — there is no live endpoint. Documented here so you design your M2M client with it in mind.

The IDP is the **authority of the user's global profile** — `name`, `username`, `phone`, `document`, `birthDate`, `avatar` (RFC-0001 / ADR-7). These attributes **do not travel in the JWT** (they'd bloat a token sent on every request). The canonical way for a backend to read them by `sub` will be an M2M call — the exact `client_credentials` flow this skill already covers:

```
GET https://idp.overlens.com.br/users/:sub
Authorization: Bearer <M2M access_token>      # scope: profile:read
```

What this means for your integration **today**:

- It's the same token you already obtain here — just register your M2M client with the new **`profile:read`** scope (and `profile:read:pii` if you need `email`/`phone`/`birthDate`) in `allowedScopes` when it ships.
- Authorize stays **scope-based** on the Resource Server side — consistent with everything above.
- The response will carry `ETag` + `Cache-Control: private, max-age=300`; **cache the profile locally with a TTL**, the same discipline as caching the token (the IDP must stay out of your hot read path).
- `avatar` comes back as a deterministic URL derived from `sub` (`cdn.overlens.com.br/avatars/{sub}`) plus an `avatarUpdatedAt` cache-busting signal — nothing to store or sync.

A future **Push** (webhook events, RFC-0004) will only *shorten* the staleness window by telling you when to re-pull; the Pull endpoint above is the foundation. Track `https://github.com/overlens/identity-provider/blob/main/docs/rfc/0002-endpoint-m2m-leitura-de-perfil.md` for the final contract.

---

## Where the real docs live

This skill is curation + templates. The canonical, maintained-with-the-code references:

- `../../references/docs/integration/m2m.md` — the full M2M guide (source of these templates)
- `../../references/docs/integration/oauth-clients.md` §6-C — the exact `POST /admin/clients` body for an M2M client
- `../../references/docs/integration/backend.md` §3 — discriminating user vs M2M, scope guards (the Resource Server side)
- `../../references/docs/integration/oidc-discovery.md` — if you use a generic OIDC/OAuth client library instead of hand-rolling
- `https://github.com/overlens/identity-provider/blob/main/docs/rfc/0002-endpoint-m2m-leitura-de-perfil.md` — proposed `GET /users/:sub` (M2M profile read) and the `profile:read` scope (see "Coming soon" above)

When in doubt, read those — they track code changes; this skill snapshots the patterns.

---

## File map of this skill

```
idp-integrate-m2m/
├── SKILL.md                       (this file)
├── references/
│   ├── client-registration.md     (register the M2M client + env vars before integrating)
│   └── resource-server.md         (the consuming API: discriminate M2M, scope guards)
└── templates/
    ├── idp-m2m-client.ts          (TypeScript / NestJS-injectable client with cache)
    ├── idp_m2m_client.py          (Python client with cache, thread-safe)
    └── idp_m2m_client.go          (Go client with cache, mutex-guarded)
```

Read reference files only as needed — they're independent.
