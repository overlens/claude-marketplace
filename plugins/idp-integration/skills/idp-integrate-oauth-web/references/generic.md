# Any Other Server-Side Framework — Implementation Guide

Rails, Django, Laravel, ASP.NET, Spring, Phoenix, Go (net/http), etc. The OAuth 2.1 Authorization Code + PKCE flow is identical everywhere — only the framework's HTTP/cookie/crypto APIs differ. Port the concepts below.

The TypeScript templates in `templates/` are the reference implementation. Read `templates/pkce.ts` and `templates/nextjs/callback-route.ts` to see the canonical logic, then translate.

---

## The five handlers you need

| Handler | Trigger | Responsibility |
|---|---|---|
| `start_login` / `start_signup` | User clicks Entrar/Criar conta | Generate PKCE + state, store them server-side (cookie scoped to callback path), redirect to `ACCOUNTS_URL/login` (or `/signup`) |
| `callback` | Browser returns from Accounts | Validate state, exchange code for tokens, set session cookies on your domain, redirect to dashboard/onboarding |
| `refresh` | Access token expired | Exchange refresh_token, rotate cookies |
| `logout` | User clicks Sair | Clear session cookies, then redirect the browser (top-level navigation) to the IDP `end_session_endpoint` `GET /auth/logout` with `client_id` + a registered `post_logout_redirect_uri` + `state` |

---

## PKCE in your language

```
code_verifier  = base64url(32 random bytes)            # 43 chars
code_challenge = base64url(sha256(code_verifier))
state          = hex(32 random bytes)
```

| Language | Verifier | Challenge |
|---|---|---|
| Python | `secrets.token_urlsafe(32)` | `base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b'=')` |
| Ruby | `SecureRandom.urlsafe_base64(32)` | `Base64.urlsafe_encode64(Digest::SHA256.digest(v), padding: false)` |
| Go | `base64.RawURLEncoding.EncodeToString(randBytes)` | `base64.RawURLEncoding.EncodeToString(sha256.Sum256([]byte(v))[:])` |
| C# | `Base64UrlEncode(RandomNumberGenerator.GetBytes(32))` | `Base64UrlEncode(SHA256.HashData(verifierBytes))` |
| PHP | `rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=')` | same wrapping over `hash('sha256', $v, true)` |

The challenge must be **base64url without padding** (`=` stripped). A common bug is using standard base64 or leaving padding — the IDP rejects the PKCE verification at token exchange with `400 invalid_grant`.

---

## Step 1 — Start the flow

```
verifier  = generate_code_verifier()
challenge = generate_code_challenge(verifier)
state     = generate_state()

set_cookie('pkce_code_verifier', verifier, http_only=true, secure=true, same_site='Lax', path='/auth/callback', max_age=600s)
set_cookie('oauth_state',        state,    http_only=true, secure=true, same_site='Lax', path='/auth/callback', max_age=600s)

redirect_to(ACCOUNTS_URL + '/login?' + urlencode({
  client_id:             IDP_CLIENT_ID,
  redirect_uri:          IDP_REDIRECT_URI,
  code_challenge:        challenge,
  code_challenge_method: 'S256',
  state:                 state,
  scope:                 'openid profile email',
}))
```

Cookie `max_age` units vary by framework — Express uses **ms**, most others (Rails, Django, Hono, Fastify) use **seconds**. Confirm yours. Wrong units = cookie deleted instantly.

---

## Step 2 — Callback

```
code  = query_param('code')
state = query_param('state')
if not code or not state: redirect('/login?error=missing_params')

saved_state = cookie('oauth_state')
verifier    = cookie('pkce_code_verifier')
if saved_state != state: redirect('/login?error=invalid_state')   # CSRF check
if not verifier:         redirect('/login?error=missing_verifier')

# Back-channel token exchange — server to server, carries the secret.
basic = base64(IDP_CLIENT_ID + ':' + IDP_CLIENT_SECRET)
response = http_post(IDP_BASE_URL + '/auth/token',
  headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': 'Basic ' + basic,
  },
  body = urlencode({
    grant_type:    'authorization_code',
    code:          code,
    code_verifier: verifier,
    redirect_uri:  IDP_REDIRECT_URI,
  }))

if response.status != 200: redirect('/login?error=token_exchange_failed')

tokens = json_parse(response.body)
# { access_token, refresh_token, token_type: 'Bearer', expires_in: 900, id_token? }

payload = decode_jwt_payload(tokens.access_token)   # base64url-decode the middle segment; no signature check needed here

set_cookie('session_token',   tokens.access_token,  http_only, secure, same_site='Lax', path='/',     max_age=tokens.expires_in)
set_cookie('session_refresh', tokens.refresh_token, http_only, secure, same_site='Lax', path='/auth', max_age=30*24*3600)

delete_cookie('pkce_code_verifier')
delete_cookie('oauth_state')

redirect(payload.new_user ? '/onboarding/profile' : '/dashboard')
```

---

## Step 3 — Refresh

```
refresh_token = cookie('session_refresh')
if not refresh_token: return 401 {error: 'no_refresh_token'}

basic = base64(IDP_CLIENT_ID + ':' + IDP_CLIENT_SECRET)
response = http_post(IDP_BASE_URL + '/auth/token',
  headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basic },
  body = urlencode({ grant_type: 'refresh_token', refresh_token: refresh_token }))

if response.status != 200:
  delete_cookie('session_token'); delete_cookie('session_refresh')
  return 401 {error: 'refresh_failed'}

tokens = json_parse(response.body)
set_cookie('session_token',   tokens.access_token,  ..., max_age=tokens.expires_in)
set_cookie('session_refresh', tokens.refresh_token, ..., max_age=30*24*3600)   # NEW value — old is dead
return 200 {ok: true}
```

The IDP **rotates** the refresh token on every refresh. Always persist the new one; the old one is permanently invalidated.

---

## Step 4 — Logout

OIDC RP-Initiated Logout. Clear your local cookies, then send the browser (top-level navigation, never `fetch`) to the IDP `end_session_endpoint`:

```
delete_cookie('session_token')
delete_cookie('session_refresh')
redirect('https://idp.overlens.com.br/auth/logout?' + urlencode({
  client_id: IDP_CLIENT_ID,
  post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,  # must be registered with the IDP
  state: random_state(),                               # echoed back on the redirect
}))
```

The IDP nulls the server-side refresh code, clears its SSO cookies on `.overlens.com.br`, and 302-redirects to your `post_logout_redirect_uri`. There is no `grant_type=revoke` (it returns `400 unsupported_grant_type`) and no per-token revocation: an already-issued access token stays valid until it expires (≤15 min). For hard revocation (compromised device), an IDP admin uses `POST /admin/users/:id/block`.

---

## JWT payload (for branching only)

```json
{
  "sub": "clx...",            // user id (CUID2) — your cross-service key
  "email": "u@example.com",
  "name": "User Name",
  "role": "BASIC",            // BASIC | ADMIN | SYSTEM
  "email_verified": false,
  "new_user": true,           // present only on first login after signup
  "iss": "https://idp.overlens.com.br",
  "aud": ["https://api.overlens.com.br"],
  "iat": 1748275200,
  "exp": 1748276100
}
```

In the callback you only **decode** (not verify) the payload to read `new_user`. Verification happens in Resource Servers via JWKS — see the `idp-validate-token` skill.

---

## Framework-specific cookie/crypto cheat sheet

| Framework | Set cookie | maxAge unit | Random bytes | SHA-256 |
|---|---|---|---|---|
| Rails | `cookies[:x] = { value:, httponly: true, secure: true, same_site: :lax, path:, expires: }` | use `expires:` (Time) | `SecureRandom` | `Digest::SHA256` |
| Django | `response.set_cookie('x', v, httponly=True, secure=True, samesite='Lax', max_age=600)` | seconds | `secrets` | `hashlib.sha256` |
| Laravel | `cookie('x', v, 10, '/auth/callback', null, true, true, false, 'lax')` | minutes (!) | `random_bytes` | `hash('sha256', ...)` |
| ASP.NET | `Response.Cookies.Append("x", v, new CookieOptions {...})` | use `MaxAge` (TimeSpan) | `RandomNumberGenerator` | `SHA256` |
| Spring | `ResponseCookie.from("x", v).httpOnly(true).secure(true).sameSite("Lax").path(...).maxAge(600).build()` | seconds | `SecureRandom` | `MessageDigest` |
| Go | `http.SetCookie(w, &http.Cookie{... MaxAge: 600})` | seconds | `crypto/rand` | `crypto/sha256` |

Laravel's `cookie()` helper takes **minutes** — yet another units variant. Always confirm before shipping.

---

## Library shortcut

If your framework has a mature OIDC client library (e.g., `omniauth_openid_connect` for Rails, `mozilla-django-oidc` for Django, `Microsoft.AspNetCore.Authentication.OpenIdConnect` for ASP.NET), you can point it at the IDP's discovery document instead of hand-rolling:

```
https://idp.overlens.com.br/.well-known/openid-configuration
```

See `../../../references/docs/integration/oidc-discovery.md` for the discovery contract and known gaps (no `nonce` validation, no `prompt=none` literal, no `/auth/revoke` per-token revocation). The discovery document now advertises `end_session_endpoint` (`GET /auth/logout`) for RP-initiated logout.
