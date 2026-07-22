# Overlens IDP — Endpoint Reference

Complete request/response contracts for every IDP endpoint. Base URL: `https://idp.overlens.com.br`

---

## Table of Contents

1. [OAuth Endpoints](#oauth-endpoints)
   - [GET /auth/authorize](#get-authauthorize)
   - [POST /auth/authorize](#post-authauthorize)
   - [POST /auth/authorize/google](#post-authauthorizegoogle)
   - [POST /auth/token](#post-authtoken)
2. [Signup Endpoints](#signup-endpoints)
   - [GET /auth/signup](#get-authsignup)
   - [POST /auth/signup](#post-authsignup)
   - [POST /auth/signup/google](#post-authsignupgoogle)
3. [OIDC Endpoints](#oidc-endpoints)
   - [GET /.well-known/openid-configuration](#get-well-knownopenid-configuration)
   - [GET /auth/userinfo](#get-authuserinfo)
   - [GET /auth/logout (end_session_endpoint)](#get-authlogout-end_session_endpoint)
   - [GET /.well-known/jwks.json](#get-well-knownjwksjson)
4. [Session Endpoints (Cookie-based)](#session-endpoints-cookie-based)
   - [POST /login](#post-login)
   - [POST /login/google](#post-logingoogle)
   - [POST /token/refresh](#post-tokenrefresh)
   - [POST /logout](#post-logout)

---

## OAuth Endpoints

These are the primary endpoints for OAuth 2.1 integration.

### GET /auth/authorize

Initiates the OAuth flow. If the user has an active session (SSO), returns the authorization code immediately. Otherwise, signals that login is required.

**Query Parameters:**

| Param | Required | Type | Notes |
|---|---|---|---|
| `response_type` | Yes | `'code'` | Must be `code` |
| `client_id` | Yes | string | Registered OAuth client ID |
| `redirect_uri` | Yes | string | Must match a registered URI exactly |
| `code_challenge` | Yes | string | S256 hash, base64url encoded |
| `code_challenge_method` | Yes | `'S256'` | Only S256 supported |
| `state` | Recommended | string | CSRF protection |
| `scope` | Optional | string | Space-separated. Default: `profile email`. Add `openid` for id_token |

**Response — Active Session (200):**
```json
{
  "code": "a1b2c3d4e5f6...",
  "state": "your_state_value"
}
```

**Response — No Session (200):**
```json
{
  "status": "login_required",
  "client_id": "your_client_id",
  "display_name": "Your App Name"
}
```

**Errors:**
- `400` — `{ error: "invalid_client", error_description: "Unknown client_id" }`
- `400` — `{ error: "invalid_redirect_uri", error_description: "redirect_uri not registered" }`

---

### POST /auth/authorize

Authenticates with email+password and returns an authorization code. Used by the accounts frontend.

**Request Body (JSON or form-urlencoded):**

```json
{
  "email": "user@example.com",
  "password": "their_password",
  "client_id": "your_client_id",
  "redirect_uri": "https://yourapp.com/callback",
  "code_challenge": "BASE64URL_S256_HASH",
  "code_challenge_method": "S256",
  "state": "optional_state",
  "scope": "openid"
}
```

**Response (200):**
```json
{
  "code": "a1b2c3d4e5f6...",
  "state": "your_state_value"
}
```

**Cookies Set:** `access_token` + `refresh_token` (httpOnly, SameSite=lax, domain=.overlens.com.br)

**Errors:**
- `400` — `{ error: "invalid_credentials", error_description: "Credenciais invalidas" }`
- `400` — `{ error: "invalid_client", error_description: "Unknown client_id" }`
- `400` — `{ error: "invalid_redirect_uri", error_description: "redirect_uri not registered" }`

---

### POST /auth/authorize/google

Authenticates with a Google ID Token and returns an authorization code.

**Request Body:**
```json
{
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "client_id": "your_client_id",
  "redirect_uri": "https://yourapp.com/callback",
  "code_challenge": "BASE64URL_S256_HASH",
  "code_challenge_method": "S256",
  "state": "optional_state",
  "scope": "openid"
}
```

**Response (200):**
```json
{
  "code": "a1b2c3d4e5f6...",
  "state": "your_state_value"
}
```

**Errors:**
- `401` — `{ error: "invalid_token", error_description: "Token Google invalido" }`
- `400` — `{ error: "invalid_client", error_description: "Unknown client_id" }`

---

### POST /auth/token

Exchanges an authorization code for tokens, or refreshes an existing token.

**Authentication:** HTTP Basic (`Authorization: Basic base64(client_id:client_secret)`) OR body params.

**Rate Limit:** 30 requests per 60 seconds per IP (all grant types). `429` responses carry a `Retry-After` header — treat as transient.

#### Grant Type: authorization_code

**Request Body:**
```
grant_type=authorization_code
&code=AUTHORIZATION_CODE
&redirect_uri=https://yourapp.com/callback
&code_verifier=ORIGINAL_PKCE_VERIFIER
&client_id=your_client_id
&client_secret=your_secret
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "a1b2c3d4e5f6...",
  "token_type": "Bearer",
  "expires_in": 900,
  "id_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

`id_token` is only present when scope included `openid`.

#### Grant Type: refresh_token

**Request Body:**
```
grant_type=refresh_token
&refresh_token=CURRENT_REFRESH_TOKEN
&client_id=your_client_id
&client_secret=your_secret
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "new_rotated_token...",
  "token_type": "Bearer",
  "expires_in": 900
}
```

The old refresh_token is immediately invalidated after this call.

**Errors:**
- `401` — `{ error: "invalid_client", error_description: "Client authentication failed" }` (with `WWW-Authenticate: Basic realm="IDP"`)
- `400` — `{ error: "invalid_grant", error_description: "..." }` — various reasons:
  - "Code not found or already used"
  - "Code expired"
  - "client_id mismatch"
  - "redirect_uri mismatch"
  - "PKCE validation failed"
  - "User not found"

---

## Signup Endpoints

### GET /auth/signup

Checks if signup is available for a client.

**Query Parameters:**

| Param | Required | Notes |
|---|---|---|
| `client_id` | Yes | OAuth client ID |
| `redirect_uri` | Optional | For context |
| `code_challenge` | Optional | For context |
| `code_challenge_method` | Optional | For context |

**Response (200):**
```json
{
  "status": "signup_available",
  "client_id": "your_client_id",
  "display_name": "Your App Name",
  "allow_signup": true
}
```

**Errors:**
- `400` — `{ error: "invalid_request", error_description: "client_id is required" }`
- `400` — `{ error: "invalid_client", error_description: "Unknown client_id" }`

---

### POST /auth/signup

Creates a new account and returns an authorization code.

**Rate Limit:** 10 requests per 60 seconds per IP.

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "password": "SecureP@ss123",
  "passwordConfirmation": "SecureP@ss123",
  "client_id": "your_client_id",
  "redirect_uri": "https://yourapp.com/callback",
  "code_challenge": "BASE64URL_S256_HASH",
  "state": "optional_state",
  "scope": "openid"
}
```

**Response (201):**
```json
{
  "code": "a1b2c3d4e5f6...",
  "state": "your_state_value"
}
```

The JWT from the subsequent token exchange will include `new_user: true`.

**Errors:**
- `400` — `{ error: "validation_error", error_description: "Informe um e-mail valido" }`
- `400` — `{ error: "validation_error", error_description: "Senha deve ter ao menos 8 caracteres" }`
- `400` — `{ error: "validation_error", error_description: "As senhas nao coincidem" }`
- `409` — `{ error: "email_exists", error_description: "Este e-mail ja esta cadastrado" }`
- `400` — `{ error: "invalid_client", error_description: "Unknown client_id" }`

---

### POST /auth/signup/google

Creates or links a Google account and returns an authorization code.

**Request Body:**
```json
{
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "client_id": "your_client_id",
  "redirect_uri": "https://yourapp.com/callback",
  "code_challenge": "BASE64URL_S256_HASH",
  "state": "optional_state",
  "scope": "openid"
}
```

**Behavior:**
- **New email + new googleId** → creates account (authProvider=GOOGLE)
- **Existing googleId** → logs in (updates lastLoginAt)
- **Existing email with LOCAL authProvider** → links googleId to existing account

**Response (200):**
```json
{
  "code": "a1b2c3d4e5f6...",
  "state": "your_state_value"
}
```

**Errors:**
- `401` — `{ error: "invalid_token", error_description: "Token Google invalido" }`
- `400` — `{ error: "invalid_client", error_description: "Unknown client_id" }`

---

## OIDC Endpoints

### GET /.well-known/openid-configuration

OIDC Discovery document. No authentication required.

**Response (200):**
```json
{
  "issuer": "https://idp.overlens.com.br",
  "authorization_endpoint": "https://idp.overlens.com.br/auth/authorize",
  "token_endpoint": "https://idp.overlens.com.br/auth/token",
  "jwks_uri": "https://idp.overlens.com.br/.well-known/jwks.json",
  "userinfo_endpoint": "https://idp.overlens.com.br/auth/userinfo",
  "end_session_endpoint": "https://idp.overlens.com.br/auth/logout",
  "scopes_supported": ["openid", "profile", "email"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "none"],
  "claims_supported": ["sub", "email", "name", "email_verified", "iss", "aud", "iat", "exp"],
  "code_challenge_methods_supported": ["S256"]
}
```

**Cache-Control:** `public, max-age=86400` (24 hours)

---

### GET /auth/userinfo

Returns user claims from a valid access token. Stateless — extracts claims from JWT, no DB call.

**Request:**
```
GET /auth/userinfo
Authorization: Bearer <access_token_jwt>
```

**Response (200):**
```json
{
  "sub": "clx1abc...",
  "email": "user@example.com",
  "name": "User Name",
  "email_verified": true
}
```

**Errors:**
- `401` — `{ error: "invalid_token", error_description: "Missing Bearer token" }` (with `WWW-Authenticate: Bearer`)
- `401` — `{ error: "invalid_token", error_description: "Token is invalid or expired" }` (with `WWW-Authenticate: Bearer error="invalid_token"`)

---

### GET /auth/logout (end_session_endpoint)

OIDC RP-Initiated Logout. The OAuth client navigates the **browser** (top-level navigation — link / `window.location` / server redirect, never `fetch`/XHR) to this endpoint. No authentication header; relies on the IDP's first-party cookies.

**Request:**
```
GET /auth/logout
  ?client_id=YOUR_CLIENT_ID                          ← primary identifier
  &post_logout_redirect_uri=https://yourapp.com/     ← must EXACT-MATCH a registered URI for the client
  &state=RANDOM_STATE                                ← echoed back on the redirect
  &id_token_hint=<id_token>                          ← optional; RS256 + iss validated, expiration ignored
```

**Behavior:** nulls the user's server-side `refreshCode`, clears the IDP SSO cookies on `.overlens.com.br` (`Set-Cookie` with `Max-Age=0`), then **302-redirects** to the validated `post_logout_redirect_uri` (with `state` appended). If `post_logout_redirect_uri` is absent or not registered for the client, it redirects to a fallback page instead.

**Response (302):** `Location: <post_logout_redirect_uri>?state=<state>` + cookie-clearing `Set-Cookie` headers.

> Ends the SSO session and invalidates the refresh code — the next `/auth/authorize` prompts for credentials and no silent refresh succeeds. Does **not** revoke already-issued access tokens (no per-token revocation): an in-flight access token stays valid until it expires (≤15 min). For immediate hard revocation, an admin uses `POST /admin/users/:id/block`. `post_logout_redirect_uris` are registered per client via admin `POST/PATCH /admin/clients`.

---

### GET /.well-known/jwks.json

Public key for JWT verification. No authentication required.

**Response (200):**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "n": "modulus_base64url...",
      "e": "AQAB",
      "kid": "key_id_string"
    }
  ]
}
```

**Cache-Control:** `public, max-age=3600` (1 hour)

---

## Session Endpoints (Cookie-based)

These are the original Epic 001 endpoints that use httpOnly cookies directly. They're still active and used by the IDP's own login flow.

### POST /login

**Rate Limit:** 10 requests per 60 seconds.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "their_password"
}
```

**Response (200):** `{ "ok": true }`

**Cookies Set:**
- `access_token` — JWT, httpOnly, secure, SameSite=lax, domain=.overlens.com.br, path=/, maxAge=900s
- `refresh_token` — hex string, httpOnly, secure, SameSite=lax, domain=.overlens.com.br, path=/token/refresh, maxAge=2592000s

**Errors:** `401` — generic unauthorized (same response for bad email or bad password)

### POST /login/google

**Rate Limit:** 10 requests per 60 seconds. **Feature flag:** `idp_google-auth`.

**Request Body:**
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs..."
}
```

**Response (200):** `{ "ok": true }` with same cookies as /login.

### POST /token/refresh

**Rate Limit:** 30 requests per 60 seconds.

**Request:** Reads `refresh_token` from cookie.

**Response (200):** `{ "ok": true }` with new `access_token` and rotated `refresh_token` cookies.

**Errors:** `401` — cookie missing, token not found, or user blocked.

### POST /logout

Cookie-mode logout, used by the first-party Accounts SPA (not by OAuth clients). OAuth/OIDC clients should use the `GET /auth/logout` end_session_endpoint above instead.

**Request:** Reads `refresh_token` from cookie (optional).

**Response (200):** `{ "ok": true }`

Clears both cookies (maxAge=0) and sets `refreshCode = null` in database.
