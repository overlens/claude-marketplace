# Overlens IDP — Troubleshooting Guide

Common integration issues and how to diagnose them.

---

## "I get 400 invalid_client"

**Cause:** The `client_id` is not registered in the IDP's `oauth_clients` table.

**Fix:**
1. Verify your `client_id` matches exactly (case-sensitive)
2. Ask the IDP team to register your client if it's new
3. Check if you're using the right environment (dev vs prod)

---

## "I get 400 invalid_redirect_uri"

**Cause:** The `redirect_uri` you sent doesn't match any URI registered for your client.

**Fix:**
1. The match is **exact** — trailing slashes, query params, and protocol all matter
2. `https://myapp.com/callback` != `https://myapp.com/callback/`
3. Ask the IDP team to add your redirect URI to the client's `redirectUris` array

---

## "I get 400 PKCE validation failed"

**Cause:** The `code_verifier` doesn't match the `code_challenge` sent during authorization.

**Fix:**
1. Verify you're storing the `code_verifier` from step 1 and sending it in step 4
2. Verify the challenge is `BASE64URL(SHA256(code_verifier))` — not base64, not hex, specifically base64url (no padding, `-` and `_` instead of `+` and `/`)
3. Make sure `code_challenge_method` is `S256` (not `plain`)
4. Don't generate a new verifier between the authorize and token requests

---

## "My cookies disappear immediately after login"

**Cause:** Almost certainly a `maxAge` issue.

**Diagnosis:**
```bash
curl -i -X POST https://idp.overlens.com.br/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}' \
  2>&1 | grep -i max-age
```

- If `Max-Age=0` → the server is passing seconds instead of milliseconds
- If `Max-Age=900` → correct (15 minutes)

**Fix:** If you're proxying or re-setting cookies, use milliseconds in Express/NestJS: `maxAge: 900_000` (not `900`).

---

## "I get 401 on token refresh but the user just logged in"

**Possible causes:**

1. **Refresh token already used:** Refresh tokens are single-use. If your code accidentally calls refresh twice (e.g., concurrent requests), the second call fails. Serialize refresh calls.

2. **User is blocked:** `blockedAt` is set. The user can't refresh. Check with the admin.

3. **Wrong client_id:** Refresh tokens are bound to the client that issued them. Using a different `client_id` for refresh will fail.

4. **Cookie path mismatch:** The refresh cookie has `path=/token/refresh`. If you're reading it from a different path, the browser won't send it.

---

## "id_token is missing from the token response"

**Cause:** You didn't include `openid` in the `scope` parameter.

**Fix:** Add `scope=openid` to your authorize request:
```
GET /auth/authorize?...&scope=openid
```

Without `openid`, you get `access_token` and `refresh_token` but no `id_token`.

---

## "new_user is not in the JWT"

**Cause:** `new_user: true` is only present in the JWT after the user's **first-ever** login (registration). All subsequent logins omit it.

**Fix:**
- If you need to detect first login, check for `new_user` immediately after the signup flow's token exchange
- Store a flag in your own database if you need to track it beyond the first token

---

## "CORS error when calling the IDP from my frontend"

**Cause:** Your frontend's origin doesn't match `*.overlens.com.br`.

**Fix:**
- In production, the IDP only accepts requests from `*.overlens.com.br` origins
- For local development, the IDP accepts all origins (`origin: true`)
- If your frontend is not on an Overlens subdomain, use the OAuth flow via your backend (BFF pattern) — don't call the IDP directly from the browser

---

## "JWT signature verification fails"

**Possible causes:**

1. **Using the wrong key:** Fetch from `/.well-known/jwks.json`, match by `kid`
2. **Key rotated:** If you cache the JWKS, refresh it when you encounter an unknown `kid`
3. **Algorithm mismatch:** The IDP uses RS256. If your library tries HS256 or another algorithm, it will fail
4. **Token from wrong environment:** Dev and prod IDP have different keys

---

## "I get 401 with WWW-Authenticate: Basic realm='IDP'"

**Cause:** Client authentication failed on the `/auth/token` endpoint.

**Fix:**
1. If using HTTP Basic: `Authorization: Basic base64(client_id:client_secret)` — make sure the base64 encoding is correct
2. If using body params: include both `client_id` and `client_secret` in the request body
3. Verify `client_secret` is correct (it's stored as a bcrypt hash; the IDP compares hashes)
4. For public clients (`is_public=true`), omit `client_secret` entirely

---

## "Authorization code expired"

**Cause:** Authorization codes expire after 5 minutes.

**Fix:** Exchange the code for tokens immediately after receiving it in the callback. Don't store it for later. If 5 minutes pass, the user needs to re-authenticate.

---

## "State parameter mismatch"

**Cause:** The `state` returned in the callback doesn't match what you sent.

**Fix:**
1. Generate `state` before redirecting, store it in your session
2. Compare exactly in the callback before exchanging the code
3. Make sure your session storage isn't clearing between the redirect and callback (common with SPA routers that lose state on navigation)

---

## Quick Diagnostic Checklist

When something doesn't work, check these in order:

1. Is the `client_id` registered? (`GET /auth/signup?client_id=X` should return 200)
2. Is the `redirect_uri` exactly right? (no trailing slash differences)
3. Is PKCE correct? (S256, base64url encoding, same verifier through the flow)
4. Is `scope=openid` present? (if you expect an id_token)
5. Are you on `*.overlens.com.br`? (for cookie-based flows)
6. Is the JWT algorithm RS256? (not HS256, not none)
7. Is the refresh token fresh? (not reused from a previous exchange)
