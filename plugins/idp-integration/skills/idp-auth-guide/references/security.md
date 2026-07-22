# Overlens IDP — Security Rules & Rationale

These rules are non-negotiable in the Overlens ecosystem. Each one exists because of a specific incident, architectural decision, or empirical validation.

---

## 1. RS256 Only — HS256 Prohibited

**Rule:** All tokens use RS256 asymmetric signing. HS256 and `alg: none` are rejected.

**Why:** The IDP signs tokens with a private key that only it holds. Resource servers validate using the public key from JWKS. If HS256 were used, every service would need the shared secret — compromising one service would compromise token issuance for the entire platform.

**What this means for integrators:** Always verify `alg: RS256` in the JWT header. Reject any token with a different algorithm. Most JWT libraries do this by default when configured with a JWKS URL.

---

## 2. SameSite=Lax — Validated Empirically (SP001)

**Rule:** All auth cookies use `SameSite=Lax`. Never `None`, never `Strict`.

**Why:**
- `SameSite=None` increases CSRF attack surface without benefit — it was tested and rejected.
- `SameSite=Strict` blocks cookies on top-level navigations from external sites (e.g., clicking a link from an email), which breaks the user experience.
- `SameSite=Lax` was empirically validated across Chrome, Firefox, and Safari on `*.overlens.com.br` subdomains during Spike SP001.

**What this means for integrators:** If your app sets its own auth cookies, use `SameSite=Lax` for consistency. The IDP's cookies flow automatically across all `*.overlens.com.br` subdomains.

---

## 3. Cookie maxAge in Milliseconds (Express/NestJS)

**Rule:** `maxAge` values in Express/NestJS are in milliseconds. Use `900_000` for access tokens (15 min), `2_592_000_000` for refresh tokens (30 days).

**Why:** Express `res.cookie()` accepts `maxAge` in ms and divides by 1000 internally for the `Max-Age` HTTP header. Passing `900` (thinking seconds) results in `Max-Age=0`, which immediately deletes the cookie. This was discovered during SP001 and caused silent logout — no error, just the user being kicked out instantly.

**How to detect:** `curl -i POST /login | grep Max-Age` should show `Max-Age=900`, not `Max-Age=0`.

**What this means for integrators:** If you're proxying or re-setting IDP cookies, use the correct units for your framework. In Express: milliseconds. In raw HTTP headers: seconds.

---

## 4. PKCE is Mandatory (S256 Only)

**Rule:** Every authorization request must include `code_challenge` (S256) and the token exchange must include `code_verifier`. Plain PKCE is not supported.

**Why:** OAuth 2.1 mandates PKCE for all clients, not just public ones. This protects against authorization code interception attacks even for confidential clients.

**What this means for integrators:** Your OAuth library must support PKCE. If it doesn't, implement it manually — it's a SHA256 hash and a random string.

---

## 5. Refresh Token is Opaque and Rotated

**Rule:** Refresh tokens are random hex strings (not JWTs). Each use generates a new one and invalidates the old.

**Why:** Opaque tokens can be revoked instantly by deleting from the database. JWT refresh tokens would require a blocklist for revocation. Rotation ensures a leaked refresh token is only usable once — the legitimate client's next refresh will fail, alerting to the compromise.

**What this means for integrators:** After every refresh, store the NEW refresh token and discard the old one. Using an old refresh token will fail, and the server logs it as a potential token theft.

---

## 6. Blocked Users Cannot Refresh

**Rule:** If `blockedAt IS NOT NULL`, `POST /auth/token` with `grant_type=refresh_token` returns 401 immediately.

**Why:** Blocking a user must take effect quickly. Since access tokens live 15 minutes max, blocking + denying refresh means the user loses access within 15 minutes without needing a token revocation system.

**What this means for integrators:** If your app receives a 401 on refresh, redirect to login. Don't retry — the user may be blocked.

---

## 7. User ID (sub) is the Cross-Service Key

**Rule:** The `sub` claim (CUID2) in the JWT is the same ID used across all Overlens services. It's immutable after creation.

**Why:** There's no foreign key between the identity database and the platform database — they're separate PostgreSQL instances. Correlation is by value. Changing the ID would break this correlation silently.

**What this means for integrators:** Use `sub` as your user's primary key. Don't generate your own ID — use the one from the JWT.

---

## 8. Error Responses Don't Reveal User Existence

**Rule:** Login with a non-existent email and login with a wrong password both return the same 401 with the same message.

**Why:** Enumeration attacks. If the error said "email not found" vs "wrong password", an attacker could build a list of valid emails.

**What this means for integrators:** Don't add your own email-existence checks before calling the IDP. Let the IDP handle it and pass through its generic error.

---

## 9. Refresh Token Bound to Client (SEC-004)

**Rule:** The `refreshClientId` field in the database binds a refresh token to the OAuth client that issued it. A refresh token obtained via client A cannot be used by client B.

**Why:** Prevents token misuse across different OAuth clients with different trust levels.

**What this means for integrators:** Each of your registered clients gets its own refresh token chain. Don't share refresh tokens between different client_ids.

---

## 10. CORS Restricted to *.overlens.com.br

**Rule:** In production, CORS allows only origins matching `*.overlens.com.br`. Credentials are included.

**Why:** The IDP sets cookies with `domain=.overlens.com.br`. CORS must match for browsers to send these cookies cross-origin.

**What this means for integrators:** Your frontend must run on a `*.overlens.com.br` subdomain to receive cookies from the IDP. For non-Overlens domains, use the OAuth token flow (back-channel token exchange) instead of relying on cookies.
