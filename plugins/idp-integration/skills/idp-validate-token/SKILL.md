---
name: idp-validate-token
description: >
  Hands-on, implementation-focused guide for building the token-validation layer of a Resource
  Server that RECEIVES authenticated requests carrying an Overlens IDP access token and must verify
  the JWT locally — without calling the IDP per request. Use this skill whenever a developer is
  wiring up JWT verification, an auth guard, or a `req.user`/principal on an API backend: NestJS,
  Express, Fastify, Hono, Spring Boot resource server, FastAPI, or any framework. Triggers on
  phrases like "validate Overlens JWT in my backend", "JwtAuthGuard NestJS Overlens", "how do I
  verify the Overlens token", "how do I get req.user from the Overlens token", "my API receives a
  Bearer token from Overlens", "passport-jwt jwks-rsa Overlens", "check iss/aud/RS256 on the
  Overlens token", "protect my API routes with the Overlens token", "RolesGuard / scope guard for
  Overlens", or when an API needs to accept a token from BOTH the `Authorization: Bearer` header AND
  the `access_token` cookie and tell a user token apart from an M2M token. Provides copy-paste
  templates: NestJS `JwtStrategy` (Bearer+cookie extraction, RS256 pinned, iss/aud validated),
  `JwtAuthGuard`, `RequireRole`/`RequireScope` guards, `@CurrentPrincipal()` decorator, a plain
  Express middleware, and a discriminated `Principal` (user vs service). If the task is to OBTAIN a
  token for a service to call another API (the caller side, `client_credentials`), that is the wrong
  direction — prefer `idp-integrate-m2m`. If the task is to log a user IN (browser/redirect/PKCE,
  initiating auth), prefer `idp-integrate-oauth-web`, `idp-auth-nextjs`, `idp-auth-vite-bff`, or
  `idp-auth-mobile`. If the token is already failing to verify and the dev is debugging a specific
  bad token (`kid not found`, stale JWKS, forged HS256), prefer `idp-debug-jwt`. For a conceptual,
  framework-agnostic overview of the whole IDP, prefer `idp-auth-guide`.
---

# Overlens IDP — Validating Tokens in a Resource Server

> **Prove it's correct:** once the validator works, scaffold the **Resource Server conformance** suite with the `idp-test-integration` skill — drop-in, offline tests that feed your validation valid + forged tokens (expired, wrong `aud`/`iss`, HS256, bad `kid`, insufficient scope) and assert the contract.

This skill builds the layer where a backend API **receives** an authenticated request and decides whether to trust it. The token is an RS256 JWT minted by the Overlens IDP. Your job is to verify it **locally** — fetch the IDP's public key once via JWKS, cache it for an hour, and verify every request against that cached key with zero calls back to the IDP.

> **Mental model:** your Resource Server is a *bouncer with a photo of a signature*. At the door (boot) it gets the IDP's public key. After that it checks every token against that key on its own — it never phones the IDP to ask "is this real?". That's what makes auth here zero-latency and resilient to a brief IDP outage.

> **Canonical docs:** `../../references/docs/integration/backend.md` (the source of every template here — NestJS, Express, GraphQL), `../../references/docs/learning/jwks.md` (RS256 + JWKS + the attacks the rules stop), `../../references/docs/integration/oidc-discovery.md` (auto-config via a generic OIDC library). This skill curates those into copy-paste form.

---

## Am I in the right place? (decision gate)

This skill is about **receiving and verifying** a token, not obtaining one and not logging anyone in. Confirm the direction before writing code:

1. **Your API is the callee.** Requests arrive already carrying a token; you verify it. ✅ right place.
2. **If instead you need to GET a token** so a worker/service can call *another* API → you're the caller → `idp-integrate-m2m`. (You may need both skills: that one for the outbound call, this one to protect your own endpoints.)
3. **If you need to log a human IN** (redirect to Accounts, PKCE, callback, session cookies) → an auth-flow skill: `idp-auth-nextjs` / `idp-integrate-oauth-web` / `idp-auth-vite-bff` / `idp-auth-mobile`. Validating the resulting token here is a *separate* concern from minting it there.
4. **If a specific token won't verify** and you're staring at `kid not found`, a stale JWKS, or a suspected forged token → `idp-debug-jwt`.

Most "validation" tickets that go sideways are actually one of #2–#4 misrouted. Resolve the direction first.

---

## The big picture

```
[Client: browser / mobile / M2M service]        [IDP: idp.overlens.com.br]        [YOUR Resource Server]
        │                                                 │                                  │
        │                                                 │   (boot) GET /.well-known/jwks.json
        │                                                 │◄─────────────────────────────────│
        │                                                 │   { keys:[{ kid, n, e, alg }] }   │
        │                                                 │──────────────────────────────────►│  cache 1h
        │                                                 │                                  │
        │ GET /api/lessons                                │                                  │
        │   Authorization: Bearer <jwt>   (or)            │                                  │
        │   Cookie: access_token=<jwt>                    │                                  │
        │────────────────────────────────────────────────┼─────────────────────────────────►│
        │                                                 │                    verify locally with cached key:
        │                                                 │                    signature, alg=RS256, iss, aud, exp
        │                                                 │                    build Principal (user | service)
        │◄────────────────────────────────────────────────┼─────────────────────────────────│  200 OK + data
```

The only time you touch the IDP is the boot-time JWKS fetch (and a lazy refresh when the cache expires or an unknown `kid` shows up). **Never per request.**

---

## What the layer must do — checklist

Treat this as your todo list. Each item maps to a template and is independently verifiable.

- [ ] **Fetch + cache the JWKS** public key (`jwks-rsa` / `jose` / `PyJWKClient`), TTL 1h, with `rateLimit`. Never per request.
- [ ] **Extract the token from Bearer header OR `access_token` cookie** — both, not one. Bearer takes priority, cookie is the fallback. (SPAs in cookie mode send the cookie; mobile/M2M send Bearer. A one-transport server breaks half your callers.)
- [ ] **Pin `algorithms: ['RS256']`.** Never accept HS256 — that's the algorithm-confusion attack (see `references/jwks-security.md`).
- [ ] **Validate `issuer` and `audience` explicitly.** A valid signature for *another* API's audience must still be rejected.
- [ ] **Discriminate user vs M2M** in `validate()`: `!!payload.client_id && !payload.email` → service; else user. Return a typed `Principal`.
- [ ] **Protect endpoints** with `JwtAuthGuard` (auth), then a **local role check** (users) or `RequireScope` (services) for authorization. `RequireRole` (reading the token's `role`) still works but is `@deprecated` — see the callout below.
- [ ] **Never call the IDP on a normal request**, and **never poll it to check if a user is blocked** (see error handling below).

---

## Critical contracts (memorize these)

### The two token transports

| Transport | Who sends it | Where |
|---|---|---|
| `Authorization: Bearer <jwt>` | mobile, M2M services, `/auth/userinfo`, any server-to-server caller | header |
| `Cookie: access_token=<jwt>` | SPAs under `*.overlens.com.br` in the IDP's cookie mode, or OAuth consumers that chose to propagate the token via a cookie in their own domain | cookie |

Extract **Bearer first, cookie as fallback** — this mirrors the IDP's own `AuthGuard`. Accepting only one transport silently locks out half your clients.

### User JWT vs M2M JWT — the discriminator

Both are signed by the same key and pass the same JWKS verification. They differ only in the payload:

| Claim | User JWT | M2M JWT |
|---|---|---|
| `sub` | userId (CUID2) | clientId (e.g. `fractals-service`) |
| `email`, `name`, `role`, `email_verified` | present | **absent** |
| `client_id`, `scope` | **absent** | present (`scope` is space-separated) |
| `exp` | iat + 900 (15min) | iat + 300 (5min) |
| `iss`, `aud`, `iat` | common | common |

```ts
const isM2M = !!payload.client_id && !payload.email; // canonical
```

**Authorize accordingly:** users by a **role local to your app** (mapped from `sub`), services by `scope`. A service token has **no** `role` — gating an M2M endpoint on `role` fails closed and produces a confusing 403.

> ⚠️ **`role` is `@deprecated` as an authorization source (RFC-0003 / ADR-8).** Per the global/local boundary (ADR-7), a user's role is **contextual to each app**, not global identity: the IDP authenticates, **your app authorizes**. The claim is still in the token (no breaking change) and the `RequireRole` template below still works, but treat it as a **transitional bridge** — new code should map `sub` → a role you own, not read `role` from the JWT. The claim will be removed in a future major version. (Global profile attributes — `username`, `phone`, `birthDate`, `avatar` — don't travel in the token either; read them via the profile endpoints, RFC-0001 / RFC-0002.)

### Required env vars

```env
JWKS_URL=https://idp.overlens.com.br/.well-known/jwks.json
JWT_ISSUER=https://idp.overlens.com.br
JWT_AUDIENCE=https://api.seuapp.overlens.com.br
```

`JWT_ISSUER`/`JWT_AUDIENCE` must match what the IDP mints (`IDP_ISSUER`, `IDP_AUDIENCE`). Don't want to hardcode? Resolve them via OIDC discovery — see `references/other-frameworks.md`.

---

## Templates

Copy the set for your stack into `src/auth/`. All implement the same contract above.

**NestJS (the canonical path):**
- `templates/jwt.strategy.ts` — the `JwtStrategy`: Bearer+cookie extraction, RS256 pinned, iss/aud validated, returns a typed `Principal`. **Start here.**
- `templates/jwt-auth.guard.ts` — `JwtAuthGuard` (+ a commented `GqlJwtAuthGuard` for GraphQL).
- `templates/require-role.guard.ts` — authorize a **user** by role. ⚠️ Reads the token's `role`, which is `@deprecated` (RFC-0003); use as a transitional bridge and migrate to a role local to your app.
- `templates/require-scope.guard.ts` — authorize a **service** by scope.
- `templates/current-principal.decorator.ts` — `@CurrentPrincipal()` (+ commented GraphQL variant).

Don't forget `app.use(cookieParser())` in `main.ts`, and install deps:
```bash
pnpm add @nestjs/passport passport passport-jwt jwks-rsa cookie-parser
pnpm add -D @types/passport-jwt @types/cookie-parser
```

**Plain Express:**
- `templates/express-jwt-middleware.js` — the whole thing in one file: strategy, `requireAuth`, `requireRole`, `requireScope`.

**Fastify, Hono, FastAPI (Python), Spring Boot:** see `references/other-frameworks.md` — the contract is identical, only the glue differs.

---

## Wiring it up (NestJS)

```ts
// AuthModule
@Module({ imports: [PassportModule], providers: [JwtStrategy], exports: [PassportModule] })
export class AuthModule {}
```

```ts
@Controller('users')
@UseGuards(JwtAuthGuard)                 // any valid token
export class UsersController {
  @Get('me')
  me(@CurrentPrincipal() principal: Principal) {
    if (principal.kind !== 'user') throw new ForbiddenException('user token required');
    return this.users.findById(principal.id);
  }
}

@Controller('admin')
@UseGuards(JwtAuthGuard, new RequireRole('ADMIN'))   // user with role ADMIN
export class AdminController { /* ... */ }

@Controller('fractals')
@UseGuards(JwtAuthGuard)
export class FractalsController {
  @Post('debit')
  @UseGuards(new RequireScope('fractals:debit'))     // service with scope
  async debit() { /* ... */ }
}
```

---

## Error handling — what NOT to do

- **Expired / invalid token** → passport returns `401` automatically. The frontend handles it with a silent refresh; your Resource Server just rejects. Nothing to do here beyond returning the 401.
- **Don't poll the IDP to check `blockedAt`.** When the IDP blocks a user it zeroes their `refreshCode` so they can't refresh — but the *existing* access token stays valid until `exp` (≤15min). There is **no** global blocklist. Calling the IDP per request to check for blocks adds a DB hop, latency, and a cascading-failure dependency. If you truly need instant revocation on a critical endpoint, keep a local "blocked" cache fed by events/webhooks — that's outside the IDP's scope today.
- **Don't relax `algorithms`.** `['RS256', 'HS256']` reopens the algorithm-confusion hole. The IDP only ever issues RS256.

---

## Common pitfalls — read before debugging

1. **Accepting only Bearer, or only cookie.** Cookie-mode SPAs send a cookie; mobile/M2M send Bearer. Use the dual extractor or you lock out half your callers.
2. **Forgetting `cookieParser()`** (NestJS/Express). Without it `req.cookies` is `undefined` and the cookie fallback silently never fires.
3. **Not pinning RS256.** Algorithm-confusion attack. Always `algorithms: ['RS256']`.
4. **Skipping `audience`.** A token signed for another Resource Server verifies on signature alone — you must reject it by `aud`.
5. **Authorizing M2M by `role`.** Service tokens have no `role`. Gate them by `scope`.
6. **Fetching the JWKS per request.** Re-couples you to the IDP's uptime/latency and makes it a DoS target. Cache 1h; refresh lazily.
7. **Calling the IDP to validate each token.** Local verification against the cached public key is the entire design — don't undo it.
8. **`kid not found` after a key rotation.** Your JWKS cache is stale — that's `idp-debug-jwt`, not a code bug here.

---

## Where the real docs live

This skill is curation + templates. The canonical references track the code:

- `../../references/docs/integration/backend.md` — the full Resource Server guide (NestJS, Express, GraphQL); source of these templates.
- `../../references/docs/learning/jwks.md` — RS256, JWKS, algorithm confusion, key rotation (the *why*).
- `../../references/docs/integration/oidc-discovery.md` — auto-config via a generic OIDC library, and the IDP's OIDC-conformance gaps.

When in doubt, read those — this skill snapshots their patterns.

---

## File map of this skill

```
idp-validate-token/
├── SKILL.md                              (this file)
├── references/
│   ├── jwks-security.md                  (RS256, algorithm confusion, JWKS cache/rotation — the why)
│   └── other-frameworks.md               (Fastify, Hono, FastAPI, Spring, OIDC auto-config)
└── templates/
    ├── jwt.strategy.ts                    (NestJS — start here: Bearer+cookie, RS256, iss/aud, Principal)
    ├── jwt-auth.guard.ts                  (JwtAuthGuard + GraphQL variant)
    ├── require-role.guard.ts              (authorize a user by role)
    ├── require-scope.guard.ts             (authorize a service by scope)
    ├── current-principal.decorator.ts     (@CurrentPrincipal())
    └── express-jwt-middleware.js          (plain Express: strategy + role/scope middleware)
```

Read reference files only as needed — they're independent.
