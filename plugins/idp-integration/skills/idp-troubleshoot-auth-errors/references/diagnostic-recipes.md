# Diagnostic recipes — capture the symptom before fixing

These are copy-paste commands to reproduce and capture each class of failure. The goal is to turn a vague "it's broken" into a concrete status code + `error` field + headers, which the master table in `SKILL.md` maps to a cause.

Replace placeholders (`<client_id>`, `<secret>`, your domains) before running. All assume the prod IDP at `idp.overlens.com.br`; swap in your dev host as needed.

---

## 1. The first command for any token-exchange error

`-i` prints headers, which you need for `WWW-Authenticate`, `Set-Cookie`, and CORS. Pipe nothing — read the whole response.

```bash
curl -i -X POST https://idp.overlens.com.br/auth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u '<client_id>:<client_secret>' \
  -d 'grant_type=client_credentials&scope=<scope>'
```

Read off:
- **status line** → 400 vs 401
- **JSON body `error`** → `invalid_client` / `unauthorized_client` / `unsupported_grant_type` / `invalid_grant` / `invalid_scope`
- **`WWW-Authenticate: Basic realm="IDP"`** present → confirms it reached the client-auth check (so it's a credential/registration problem, not a network problem)

For the authorization-code grant, swap the body:
```bash
  -d 'grant_type=authorization_code&code=<code>&code_verifier=<verifier>&client_id=<id>&redirect_uri=<exact_uri>'
```
A `400 invalid_grant` here = expired/reused code or PKCE mismatch. Codes are single-use and live ~5 min.

---

## 2. Verify your Basic header actually encodes `id:secret`

A surprising number of `401 invalid_client` cases are a malformed header (trailing newline in the secret, wrong env). Decode what you're sending:

```bash
# What curl -u sends, made explicit:
printf '%s' '<client_id>:<client_secret>' | base64
# → put that after "Authorization: Basic "

# Reverse-check a header you found in logs/config:
printf '%s' '<the-base64-string>' | base64 -d; echo
# → must print exactly  client_id:secret  with one colon and no stray whitespace
```

If the decoded value has a trailing `%` or newline, your secret was copied with one. Re-copy it.

---

## 3. Catch the `Max-Age=0` cookie bug

```bash
curl -i -X POST https://idp.overlens.com.br/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"u@x.com","password":"x"}' | grep -i 'set-cookie\|max-age'
# Healthy:  Max-Age=900  and  Max-Age=2592000
# Broken:   Max-Age=0     → maxAge passed in seconds instead of ms (IDP-side bug)
```

Even with wrong credentials you can inspect the *shape* of the cookie helper on a successful login in staging. The point is the `Max-Age` value, not whether login succeeds.

---

## 4. Reproduce a `429` and see which limit

Hammer an endpoint and tally the codes. `POST /login` flips to 429 after 10 hits within 60s (per IP, per route — see `../../../references/docs/deploy/rate-limiting.md` for the full table):

```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://idp.overlens.com.br/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"none@none.com","password":"none"}'
done | sort | uniq -c
# Expectation: ~10× 401 then ~5× 429
# Also capture Retry-After:
curl -i -X POST https://idp.overlens.com.br/login -H 'Content-Type: application/json' \
  -d '{"email":"none@none.com","password":"none"}' | grep -i retry-after
```

The throttler is active in **every** environment (since 2026-07-14). If you get **zero** 429s: the target has `IDP_RATE_LIMIT_DISABLED=true` (kill-switch), or the requests landed on different instances without a shared `REDIS_URL` (per-instance counting).

---

## 5. CORS: see the preflight decision

CORS failures show in the browser console, not in a plain `curl`. Simulate the preflight to see if the IDP would allow your origin:

```bash
curl -i -X OPTIONS https://idp.overlens.com.br/auth/token \
  -H 'Origin: https://your-app.example.com' \
  -H 'Access-Control-Request-Method: POST'
# Look for Access-Control-Allow-Origin in the response.
# Absent / not echoing your origin → your origin fails the \.overlens\.com\.br$ allowlist.
```

The deeper fix is almost always architectural: a browser frontend should **not** call `/auth/token` directly. It redirects to `accounts.overlens.com.br` and its own server-side BFF does the exchange. If you're debugging CORS on the IDP from browser JS, that request is in the wrong tier.

In the browser, capture it precisely:
- DevTools → **Network** → the failing request → **Headers**: is there a preflight (`OPTIONS`) that 4xx'd? Is `Origin` what you expect?
- DevTools → **Console**: the exact CORS message ("No 'Access-Control-Allow-Origin' header" vs "credentials mode" mismatch) distinguishes an origin-allowlist failure from a missing `credentials: 'include'`.

---

## 6. Cookie not being set / sent (cross-subdomain, cookie-mode only)

Cookie-mode applies **only** to SPAs under `*.overlens.com.br`. To confirm the request is even asking for credentials:

```javascript
// Every cookie-mode call needs this — without it the browser neither stores nor sends the cookie:
fetch('https://idp.overlens.com.br/token/refresh', {
  method: 'POST',
  credentials: 'include',   // ← the usual culprit when Set-Cookie "doesn't work"
});
```

In DevTools → **Application → Cookies**: confirm the cookie has `Domain=.overlens.com.br` (leading dot) and `SameSite=Lax`. If `Domain` is missing it's host-only and won't cross subdomains — that points at `IDP_COOKIE_DOMAIN` on the IDP. If you're not under `*.overlens.com.br` at all, cookie-mode can't work for you — switch to OAuth.

---

## 7. Confirm an env var is actually set in the deployed environment

"Works locally, 401 in prod" is usually an empty env var in Railway. Don't print the secret; print its presence and length:

```bash
# In the deployed service shell / a boot log line:
node -e 'const k="IDP_CLIENT_SECRET"; const v=process.env[k]; console.log(k, v?`set(len=${v.length})`:"MISSING")'
```

A length that differs from your local value means a different/rotated secret. `MISSING` means the variable was never propagated to that environment.

---

## 8. Is the IDP itself healthy? (rule out 5xx / infra)

Before blaming your integration, confirm the IDP is up and serving keys:

```bash
curl -i https://idp.overlens.com.br/health
# 200 { "status": "ok" } → IDP is up; the problem is your request
# 5xx / timeout      → IDP/Neon issue, not your client. Check IDP logs.

curl -s https://idp.overlens.com.br/.well-known/jwks.json | jq '.keys[0] | keys'
# ["alg","e","kid","kty","n","use"] → key endpoint healthy
```

If `/health` is 5xx, stop debugging your client — the failure is server-side (often a Neon connection problem). If JWKS is fine but your Resource Server still rejects tokens, that's a token-contents problem → `idp-debug-jwt`.
