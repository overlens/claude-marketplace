---
name: idp-auth-guide
description: >
  Universal integration guide for authenticating users via the Overlens IDP (OAuth 2.1 + OIDC).
  Use this skill whenever someone asks how to integrate authentication with the Overlens Identity Provider,
  SSO, or IDP in any project — especially when the framework is not Next.js or Vite+BFF (those have
  dedicated skills). Also trigger when the user asks about IDP endpoints, OAuth flow, PKCE, token exchange,
  signup flow, or the OIDC discovery document. This skill covers what to implement, not how — it's
  framework-agnostic. If the user mentions Next.js specifically, prefer idp-auth-nextjs. If the user
  mentions Vite + separate backend, prefer idp-auth-vite-bff. If the user asks specifically about
  validating JWT tokens in a backend/API, prefer idp-validate-token.
---

# Overlens IDP — Integration Guide

> **Prove it's correct:** after integrating, scaffold the conformance suite with the `idp-test-integration` skill — drop-in, offline tests (Resource Server **and** client/BFF flavors) that prove your integration honors the IDP contract, `pnpm test` → green.

This guide covers everything a client application needs to integrate with the Overlens Identity Provider. The IDP is a fully compliant **OAuth 2.1 + OIDC Provider** — it supports Authorization Code with PKCE, issues RS256 JWTs, exposes a JWKS endpoint, and provides OIDC Discovery.

> **Framework-specific skills exist.** If the project is:
> - **Next.js** → use the `idp-auth-nextjs` skill (Auth.js integration)
> - **Vite + separate backend** → use the `idp-auth-vite-bff` skill (BFF pattern)
> - **Any backend validating tokens** → use the `idp-validate-token` skill

## The Big Picture

The IDP lives at `idp.overlens.com.br`. A separate frontend at `accounts.overlens.com.br` provides the login/signup UI. The integration flow is standard OAuth 2.1:

```
Your App                    accounts.overlens.com.br            idp.overlens.com.br
   │                                │                                  │
   │  1. Generate PKCE              │                                  │
   │  2. Redirect ─────────────────►│                                  │
   │                                │  3. User authenticates           │
   │                                │  4. POST credentials ──────────►│
   │                                │                                  │  5. Validate
   │                                │  6. ◄── authorization_code ──────│
   │  7. ◄── redirect with code ────│                                  │
   │                                                                   │
   │  8. Exchange code for tokens (back-channel) ────────────────────►│
   │  9. ◄── { access_token, refresh_token, id_token } ───────────────│
   │                                                                   │
   │  10. Validate id_token via JWKS ─────────────────────────────────►│
   │  11. ◄── public key (RS256) ──────────────────────────────────────│
```

## OIDC Discovery

The IDP exposes a standard discovery document. Most OAuth/OIDC libraries can auto-configure from this URL:

```
GET https://idp.overlens.com.br/.well-known/openid-configuration
```

This returns all endpoints, supported scopes, grant types, and signing algorithms — including the `end_session_endpoint` (`https://idp.overlens.com.br/auth/logout`) used for RP-initiated logout. **If your library supports OIDC discovery, just point it at this URL and it handles the rest.**

## Authorization Code + PKCE Flow (Step by Step)

### Step 1: Generate PKCE

PKCE (Proof Key for Code Exchange) is **mandatory** — the IDP rejects requests without it.

```
code_verifier  = random string, 43-128 characters, [A-Za-z0-9-._~]
code_challenge = BASE64URL(SHA256(code_verifier))
```

Store `code_verifier` securely — you need it in step 4. For server-side apps, store it in the server session. For public clients (mobile, SPA), store it in memory.

### Step 2: Redirect to authorize

Redirect the user to the IDP's authorization endpoint:

```
GET https://idp.overlens.com.br/auth/authorize
  ?response_type=code
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=https://yourapp.com/callback
  &code_challenge=BASE64URL_SHA256_HASH
  &code_challenge_method=S256
  &state=RANDOM_STATE_FOR_CSRF
  &scope=openid
```

| Parameter | Required | Notes |
|---|---|---|
| `response_type` | Yes | Always `code` |
| `client_id` | Yes | Registered with the IDP team |
| `redirect_uri` | Yes | Must be pre-registered in the IDP |
| `code_challenge` | Yes | S256 hash of code_verifier |
| `code_challenge_method` | Yes | Always `S256` (plain not supported) |
| `state` | Recommended | Random string for CSRF protection — verify it in the callback |
| `scope` | Optional | `openid` to get an `id_token`; defaults to `profile email` |

If the user has an active session (SSO), the IDP returns the code immediately. Otherwise, it returns `{ status: "login_required" }` and the accounts frontend shows the login form.

### Step 3: User authenticates

The user logs in on the IDP's domain (email+password or Google). This happens entirely on the IDP — your app doesn't handle credentials.

### Step 4: Exchange code for tokens

After the user authenticates, the IDP redirects to your `redirect_uri` with a `code` and `state`:

```
https://yourapp.com/callback?code=AUTHORIZATION_CODE&state=YOUR_STATE
```

**Verify the `state` matches** what you sent in step 2. Then exchange the code:

```
POST https://idp.overlens.com.br/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTHORIZATION_CODE
&redirect_uri=https://yourapp.com/callback
&code_verifier=YOUR_ORIGINAL_VERIFIER
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
```

For **confidential clients** (server-side apps with a secret), you can also use HTTP Basic Auth:
```
Authorization: Basic base64(client_id:client_secret)
```

For **public clients** (mobile, SPA via BFF), omit `client_secret` — PKCE alone proves the request's legitimacy.

**Response:**
```json
{
  "access_token": "<JWT>",
  "refresh_token": "<opaque_hex_string>",
  "token_type": "Bearer",
  "expires_in": 900,
  "id_token": "<JWT, present when scope includes openid>"
}
```

### Step 5: Validate the id_token

If you requested `scope=openid`, validate the `id_token`:

1. Fetch the public key from `GET https://idp.overlens.com.br/.well-known/jwks.json`
2. Verify the JWT signature is RS256
3. Verify `iss` = `https://idp.overlens.com.br`
4. Verify `aud` contains your client's expected audience
5. Verify `exp` is in the future

Most JWT libraries do all of this automatically given the JWKS URL and expected issuer/audience.

### Step 6: Store tokens securely

- **access_token** — short-lived (15 min). Use it to call APIs.
- **refresh_token** — long-lived (30 days), opaque. Use it to get new tokens.
- **Recommended storage:** httpOnly cookies. Never localStorage (XSS risk).

### Step 7: Refresh tokens

When the access_token expires, exchange the refresh_token:

```
POST https://idp.overlens.com.br/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=CURRENT_REFRESH_TOKEN
&client_id=YOUR_CLIENT_ID
```

The response includes a **new** refresh_token — the old one is immediately invalidated (rotation). Store the new one and discard the old one.

## JWT Payload

The access_token JWT contains these claims:

```json
{
  "sub": "clx1abc...",        // User ID (CUID2) — your cross-service correlation key
  "email": "user@example.com",
  "name": "User Name",
  "role": "BASIC",            // BASIC | ADMIN | SYSTEM — @deprecated as an authorization source (RFC-0003)
  "email_verified": false,
  "new_user": true,           // Only present on first login after signup
  "iss": "https://idp.overlens.com.br",
  "aud": ["https://api.overlens.com.br"],
  "iat": 1711900000,
  "exp": 1711900900           // iat + 900 (15 min)
}
```

**Key details:**
- `sub` is the user's unique ID. Use it as the primary key for user data in your system. It's a CUID2 string, the same across all Overlens services.
- `new_user` is **only present** (as literal `true`) on the first-ever login after registration. Use it to trigger onboarding flows. It's absent on all subsequent logins.
- `role` is **`@deprecated` as an authorization source** (RFC-0003 / ADR-8). The IDP authenticates; **each app authorizes**. Don't gate access on the token's `role` — map `sub` → a role local to your own app. The claim is still emitted (no breaking change) and will be removed in a future major version. The profile attributes that describe the user globally (`username`, `phone`, `document`, `birthDate`, `avatar`) do **not** travel in the JWT — read them from the profile endpoints (RFC-0001 / RFC-0002).

## Signup Flow

For registration, redirect to the signup endpoint instead of authorize:

```
GET https://accounts.overlens.com.br/signup
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=https://yourapp.com/callback
  &code_challenge=BASE64URL_SHA256_HASH
  &code_challenge_method=S256
  &state=RANDOM_STATE
```

The signup process returns the same `authorization_code` — the token exchange is identical to login. The JWT will include `new_user: true`.

## Logout (OIDC RP-Initiated Logout)

After clearing any local session state your app keeps, send the browser — via a **top-level navigation**, never `fetch`/XHR — to the IDP `end_session_endpoint`:

```
GET https://idp.overlens.com.br/auth/logout
  ?client_id=YOUR_CLIENT_ID
  &post_logout_redirect_uri=https://yourapp.com/   ← must be registered (exact-match) for this client
  &state=RANDOM_STATE                              ← echoed back on the redirect
  (optionally &id_token_hint=...)
```

The IDP nulls the server-side refresh code, clears its SSO cookies on `.overlens.com.br`, then 302-redirects to your `post_logout_redirect_uri` (with `state`), or to a fallback page if it's absent/unregistered. This ends the SSO session, so the next `/authorize` prompts for credentials and no silent refresh succeeds.

It must be a navigation, not a `fetch`: only a top-level navigation sends the IDP's first-party cookies and lets the browser accept the `Set-Cookie` clears.

The `post_logout_redirect_uris` are registered per client (admin `POST/PATCH /admin/clients`). There is no per-token revocation: an already-issued access token stays valid until it expires (≤15 min). For immediate hard revocation, an admin uses `POST /admin/users/:id/block`.

## Implementation Checklist

Use this as a todo list when integrating:

- [ ] Register your app as an OAuth client with the IDP team (get `client_id` and optionally `client_secret`)
- [ ] Implement PKCE generation (code_verifier + code_challenge with S256)
- [ ] Build the authorize redirect (with all required params)
- [ ] Build the callback handler (verify state, exchange code for tokens)
- [ ] Store tokens securely (httpOnly cookies recommended)
- [ ] Validate the id_token via JWKS (if using openid scope)
- [ ] Implement silent refresh (exchange refresh_token before access_token expires)
- [ ] Handle `new_user: true` in the JWT for onboarding flows
- [ ] Implement logout (call IDP + clear local session)
- [ ] Handle token errors (401 from APIs → trigger refresh → if refresh fails → redirect to login)

## Common Pitfalls

Read `references/troubleshooting.md` for detailed diagnostics. The most frequent issues:

1. **Forgetting PKCE** — The IDP requires S256 code_challenge on every authorize request. No exceptions.
2. **Wrong `redirect_uri`** — Must exactly match what's registered in the IDP. No trailing slashes, no query params differences.
3. **Cookie `maxAge` in milliseconds** — If you're setting cookies in Express/NestJS, remember `maxAge` takes milliseconds. `maxAge: 900` = 0 seconds (cookie deleted immediately). Use `maxAge: 900_000`.
4. **Using the refresh_token twice** — Refresh tokens are single-use. After exchange, only the new token is valid. The old one is permanently revoked.
5. **Not handling `new_user`** — If your app has onboarding, check for `new_user: true` in the JWT after the first token exchange.

## Detailed References

For complete request/response contracts for every endpoint, read `references/endpoints.md`.
For security rules and the reasoning behind them (ADRs), read `references/security.md`.
For debugging common integration errors, read `references/troubleshooting.md`.
