---
name: idp-use-oidc-discovery
description: >
  Guide for pointing a GENERIC OIDC/OAuth library at the Overlens IDP via its OIDC Discovery
  document (`/.well-known/openid-configuration`) — and for knowing exactly where strict libraries
  break. Use this skill whenever someone wants to configure Auth.js / NextAuth, `openid-client`,
  `oidc-client-ts`, `passport-openidconnect`, Spring Security OAuth, or any library that
  auto-configures from an issuer URL or a well-known/discovery document, against the Overlens
  IDP. Triggers on phrases like "Auth.js Overlens", "NextAuth Overlens provider", "openid-client
  Issuer.discover Overlens", "well-known openid-configuration Overlens", "OIDC discovery
  document", "configure a generic OIDC library for Overlens", "passport-openidconnect Overlens",
  "wellKnown URL Overlens", "is the Overlens IDP OIDC compliant". Provides the three copy-paste
  recipes (Auth.js, openid-client, passport-openidconnect) and the conformance-gap table that
  explains why strictly-compliant libraries fail out of the box: the `authorization_endpoint`
  returns JSON, not a 302 (browsers must be sent to the Accounts SPA); `nonce` is not validated;
  the `id_token` `aud` is a string while access-token `aud` is an array; silent SSO is a JSON
  probe, not `prompt=none`. If you are hand-rolling the BFF flow (the recommended default),
  prefer `idp-integrate-oauth-web` / `idp-auth-nextjs`. If a specific token fails verification,
  prefer `idp-debug-jwt`. If you're hitting HTTP errors like `invalid_client` or
  `invalid_redirect_uri`, prefer `idp-troubleshoot-auth-errors`.
---

# Overlens IDP — Using OIDC Discovery (generic libraries)

The IDP exposes an OIDC Discovery document that lets OIDC libraries auto-configure from a single URL:

```
GET https://idp.overlens.com.br/.well-known/openid-configuration
Cache-Control: public, max-age=86400
```

No auth required. It advertises `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`, `userinfo_endpoint`, `end_session_endpoint`, `revocation_endpoint`, plus supported scopes/grants/algorithms (`RS256` only, `code` only, PKCE `S256` only).

> **Canonical doc:** `../../references/docs/integration/oidc-discovery.md` — the full document field-by-field, `GET /auth/userinfo`, all recipes, and the complete conformance table. This skill is the condensed, decision-oriented version.

---

## Library or hand-rolled? (decision gate)

The **recommended default** for Overlens integrations is the hand-rolled BFF flow (~150 lines, full control over cookies and `new_user` routing) — that's `idp-integrate-oauth-web` / `idp-auth-nextjs`. Reach for a generic OIDC library when:

- the framework already ships one and fighting it costs more (Auth.js in an existing NextAuth app, Spring Security);
- you federate multiple identity providers and want one abstraction;
- you only need the **back-channel** pieces (`token_endpoint`, `jwks_uri`, `userinfo_endpoint`, `revocation_endpoint`) — those are 100% standard and work with any lib.

Do **not** bother with discovery for M2M (`client_credentials`) — it adds nothing beyond the `token_endpoint` you already know (`idp-integrate-m2m` covers that flow).

---

## The one thing that breaks every lib (read first)

**The `authorization_endpoint` responds JSON, not a 302.** `GET`/`POST /auth/authorize` returns `200` with `{ "code": "...", "state": "..." }` (valid SSO session) or `{ "status": "login_required", ... }` (no session). The browser redirect back to your `redirect_uri` is performed by the **Accounts SPA** (`accounts.overlens.com.br`), not by the IDP.

Consequence: any lib that builds the authorize URL and sends the browser to the `authorization_endpoint` (openid-client, oidc-client-ts, Auth.js, passport-openidconnect, Spring Security) **will not complete the authorization step without adaptation**. The fix is always the same:

1. Send the browser to **Accounts** — `https://accounts.overlens.com.br/login?client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256&state=...` — instead of the lib-generated authorize URL.
2. Use the lib for everything **after** the callback: token exchange, refresh, JWKS verification, userinfo, revocation. That half is fully standard.

---

## Recipes

> ⚠️ All three configure the back-channel correctly, but the authorize step needs the Accounts redirect described above.

### Auth.js (NextAuth)

```ts
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';

const handler = NextAuth({
  providers: [{
    id: 'overlens',
    name: 'Overlens',
    type: 'oauth',
    wellKnown: 'https://idp.overlens.com.br/.well-known/openid-configuration',
    clientId: process.env.IDP_CLIENT_ID!,
    clientSecret: process.env.IDP_CLIENT_SECRET!,
    authorization: { params: { scope: 'openid profile email' } },
    idToken: false,                  // the IDP issues access_token; id_token only if you request openid explicitly
    checks: ['pkce', 'state'],       // NOT ['nonce'] — the IDP does not validate nonce
    profile(profile) {
      return { id: profile.sub, email: profile.email, name: profile.name };
    },
  }],
});

export { handler as GET, handler as POST };
```

### openid-client (Node)

```ts
import { Issuer } from 'openid-client';

const issuer = await Issuer.discover('https://idp.overlens.com.br');
const client = new issuer.Client({
  client_id: process.env.IDP_CLIENT_ID!,
  client_secret: process.env.IDP_CLIENT_SECRET!,
  redirect_uris: [process.env.IDP_REDIRECT_URI!],
  response_types: ['code'],
});

// use client.callback(), client.refresh(), client.userinfo(token)
// do NOT use client.authorizationUrl() to redirect the browser — send it to Accounts instead
```

### Passport OpenID Connect

```ts
import { Strategy as OidcStrategy } from 'passport-openidconnect';

passport.use(new OidcStrategy({
  issuer: 'https://idp.overlens.com.br',
  authorizationURL: 'https://idp.overlens.com.br/auth/authorize',   // see the JSON-not-302 caveat
  tokenURL: 'https://idp.overlens.com.br/auth/token',
  userInfoURL: 'https://idp.overlens.com.br/auth/userinfo',
  clientID: process.env.IDP_CLIENT_ID!,
  clientSecret: process.env.IDP_CLIENT_SECRET!,
  callbackURL: process.env.IDP_REDIRECT_URI!,
  scope: ['openid', 'profile', 'email'],
}, /* verify callback */));
```

Newer versions accept just `issuer` and run discovery automatically.

---

## Conformance gaps — why a strict lib fails

The IDP is **not** a 100%-conformant OIDC Provider. These are the deltas that actually bite:

| Standard OIDC feature | Status in the Overlens IDP |
|---|---|
| `authorization_endpoint` 302-redirects | **No** — responds JSON; the Accounts SPA does the redirect. Adapt as described above. |
| `id_token` in the token response | Only if the client requests the `openid` scope. Check for the `id_token` field. |
| `aud` of the `id_token` | **String** (= `client_id`), per OIDC Core — while user/M2M **access tokens** use `aud` as an **array**. Never normalize one into the other. |
| `nonce` parameter | Not validated (not accepted). Auth.js: use `checks: ['pkce', 'state']`. |
| `response_type=id_token` (implicit) / hybrid | Not supported — `code` only. |
| `prompt=none` (silent auth) | The literal parameter is not parsed — but silent SSO **exists** as a JSON probe: `GET /auth/authorize` returns `{ code, state }` (live session) or `{ status: "login_required" }`. Apps fronted by Accounts don't need `prompt=none`. |
| `acr_values`, `max_age` | Not supported. |
| Refresh token rotation | Supported — single-use, rotated on every refresh (grace window `REFRESH_ROTATION_GRACE_MS` for benign races). |
| Revocation (RFC 7009) | ✅ `POST /auth/revoke` — revokes refresh tokens; an `access_token` hint is a no-op (JWTs have no blocklist). |
| RP-Initiated Logout | ✅ `end_session_endpoint` = `GET /auth/logout` (advertised in discovery). |
| Dynamic Client Registration (RFC 7591) | Not supported — clients are registered via the admin API (see `idp-register-oauth-client`). |
| Session-management iframe / front-/back-channel logout | Not supported — apps notice end-session on their next silent refresh (≤ 15 min). |

---

## Quick validation

```bash
# well-formed discovery + canonical issuer
curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq '.issuer'

# the endpoints your lib will resolve
curl -s https://idp.overlens.com.br/.well-known/openid-configuration \
  | jq '{authorization_endpoint, token_endpoint, jwks_uri, userinfo_endpoint}'

# JWKS matches the discovery pointer
JWKS=$(curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq -r .jwks_uri)
curl -s "$JWKS" | jq '.keys[0] | {kty, alg, use, kid}'
```

---

## Related skills

- Hand-rolled BFF flow (recommended default): `idp-integrate-oauth-web`, `idp-auth-nextjs`, `idp-auth-vite-bff`.
- Registering the OAuth client the lib will use: `idp-register-oauth-client`.
- A specific token fails verification after the lib is wired: `idp-debug-jwt`.
- HTTP-level errors (`invalid_client`, `invalid_redirect_uri`, CORS, 429): `idp-troubleshoot-auth-errors`.

## Where the real docs live

- `../../references/docs/integration/oidc-discovery.md` — canonical: full document, `GET /auth/userinfo`, recipes (§4), conformance limits (§5)
- `../../references/docs/integration/login.md` §1–§2 — the Accounts-fronted authorize flow the caveat above points to
- `../../references/docs/integration/logout.md` — `end_session_endpoint` and `POST /auth/revoke`

## File map of this skill

```
idp-use-oidc-discovery/
└── SKILL.md                          (this file — self-contained)
```
