# Troubleshooting — OAuth Web Integration

Symptom → cause → fix. Ordered roughly by how often each one bites.

---

## Login appears to work, but the user is immediately logged out

**Cause:** cookie `maxAge` in the wrong unit. Express/NestJS take **milliseconds**; Rails/Django/Hono/Fastify/Spring take **seconds**; Laravel takes **minutes**. Passing `900` to Express sets `Max-Age=0` and the browser deletes the cookie on receipt.

**Fix:** check the `Set-Cookie` header in devtools. If `Max-Age=0` (or absent), correct the unit. Express needs `900_000`, not `900`.

---

## `400 invalid_grant` on the token exchange

Several distinct causes, all returning the same status. The `error_description` narrows it:

| `error_description` | Cause | Fix |
|---|---|---|
| "PKCE validation failed" | `code_verifier` doesn't hash to the `code_challenge` sent at authorize | Ensure you store the verifier and send the **same** one. Check base64url-no-padding encoding of the challenge. |
| "Code expired" | Took >5 min between authorize and token exchange | Codes are short-lived. Don't park the callback. |
| "Code not found or already used" | Reused a code, or two callback invocations raced | Codes are single-use. Don't retry the exchange with the same code. |
| "redirect_uri mismatch" | `redirect_uri` in token call ≠ the one in authorize | Send the identical `redirect_uri` in both requests. |
| "client_id mismatch" | Code was issued for a different client | Check `IDP_CLIENT_ID` consistency. |

---

## `401 invalid_client` on the token exchange

**Cause:** client authentication failed. The `client_id` is unknown, the `client_secret` is wrong, or your Basic Auth header is malformed.

**Fix:**
- Verify `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET` env values (no trailing whitespace, no quotes accidentally included).
- The Basic header is `base64(client_id + ':' + client_secret)`. A common bug: base64-encoding only the secret, or forgetting the colon.
- Confirm the client exists and isn't disabled: `GET /admin/clients/:id` (needs admin). If `disabledAt` is set, re-enable it.

The response carries `WWW-Authenticate: Basic realm="IDP"` — a useful confirmation that you hit the auth check.

---

## `400 invalid_redirect_uri` at authorize or callback

**Cause:** the `redirect_uri` you sent isn't byte-identical to a registered one.

**Fix:** the IDP does string equality. Compare character-by-character:
- Trailing slash? (`/callback` ≠ `/callback/`)
- Scheme? (`http` ≠ `https`)
- Port? (`:3000` ≠ `:4000`)
- Extra query params? (none allowed in the registered URI)

Register the exact URL via `PATCH /admin/clients/:id` (see `references/client-registration.md`).

---

## Works in dev, breaks in production with a CORS error

**Cause:** you're trying to call the IDP **directly from the browser**. The IDP's CORS in production only allows origins matching `\.overlens\.com\.br$`. Your app's origin isn't allowed — by design.

**Fix:** the browser should only ever redirect to `accounts.overlens.com.br` (front-channel). The token exchange (`POST /auth/token`) must happen **server-side** (back-channel). If you see a CORS error, you've put the token exchange in client code. Move it to your backend.

---

## `state` validation always fails

**Causes:**
- Cookie path mismatch — the `oauth_state` cookie is scoped to `/api/auth/callback`, but your callback route is at a different path, so the cookie isn't sent.
- `secure: true` cookie over `http://localhost` in dev — the browser silently drops it. Set `secure: false` in dev.
- SameSite too strict — must be `Lax`, not `Strict`. `Strict` blocks the cookie on the cross-site redirect back from Accounts.

**Fix:** align the cookie `path` with the actual callback route, use `secure: false` on localhost, and keep `sameSite: 'lax'`.

---

## User gets logged out at the next refresh, even though everything seemed fine

**Cause:** you stored the **old** refresh token instead of the new one after a refresh. The IDP rotates refresh tokens — every successful refresh invalidates the previous token and issues a new one. If your code keeps the old value, the next refresh uses a dead token → `401`.

**Fix:** in the refresh handler, always overwrite `session_refresh` with `tokens.refresh_token` from the response. Never keep the value you sent.

---

## `403` on `POST /login/google` (if you wired Google directly)

**Cause:** this skill is about the OAuth code flow, where Google sign-in happens **on Accounts**, not your app. If you're hitting `/login/google` directly, you've taken the cookie-mode path (Accounts-internal). That endpoint is gated by the PostHog feature flag `idp_google-auth`.

**Fix:** for OAuth web clients, you don't call `/login/google`. The user clicks "Continuar com Google" on the Accounts page; Accounts handles the Google handshake and returns a `code` to your callback like any other login. Don't replicate Google sign-in in your app.

---

## "I logged out but the user is logged back in instantly"

**Cause:** you cleared your local session cookies but the **IDP-side** cookie session (on `.overlens.com.br`) is still active. The next `/auth/authorize` SSOs the user back in silently.

**Fix:** after clearing local cookies, send the browser via a **top-level navigation** to the IDP `end_session_endpoint` — `GET https://idp.overlens.com.br/auth/logout?client_id=...&post_logout_redirect_uri=...&state=...`. That nulls the server-side refresh code and ends the IDP SSO session, so the next login prompts for credentials. If you reach it via `fetch`/XHR instead of a navigation, the IDP's first-party cookies aren't sent and the `Set-Cookie` clears aren't honored — the session survives.

---

## Logout: there is no `grant_type=revoke` (use `end_session`)

**Cause:** some older code tries to revoke a refresh token by POSTing `grant_type=revoke` to `/auth/token`. That grant type does not exist (`400 unsupported_grant_type`) and never did revoke anything.

**Fix:** logout is an OIDC RP-Initiated Logout, not a token revocation. Navigate the browser (top-level, not `fetch`) to the `end_session_endpoint` `GET /auth/logout` with `client_id` + a registered `post_logout_redirect_uri` + `state`. That ends the SSO session and invalidates the refresh code. There is still no per-token revocation (no RFC 7009 `/revoke`): an already-issued access token stays valid until it expires (≤15 min). For immediate hard revocation (compromised device), an admin calls `POST /admin/users/:id/block`.

---

## The JWT decodes but `new_user` is never set

**Cause:** `new_user: true` appears **only** on the first token issued right after signup. On every subsequent login it's absent (not `false` — absent). If you're testing with an existing account, you won't see it.

**Fix:** test the onboarding branch with a brand-new account (a fresh email through `/signup`). For existing accounts, `new_user` being absent is correct behavior.

---

## Deep diagnostics

For endpoint-level contracts and the full error catalog, see the IDP repo:
- `../../../references/docs/integration/login.md` §10 (token endpoint errors)
- `../../../references/docs/integration/frontend.md` §4 (error table)
- `https://github.com/overlens/identity-provider/blob/main/docs/deploy/railway.md` §11 (operational troubleshooting)
- `../../../references/docs/deploy/rate-limiting.md` (if you hit `429`)
