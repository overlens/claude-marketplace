# JWT / JWKS Diagnostics — deep dives

Read this when the symptom table in `SKILL.md` isn't enough. Each section is independent.

---

## 1. `kid` not found — the rotation timeline

A `kid` (key ID) that the Resource Server can't find is almost always a **timing** problem between key rotation on the IDP and the JWKS cache on the RS — not a bad token. To reason about it, hold the rotation timeline in mind (from `../../../references/docs/learning/key-rotation.md`):

```
T0      JWKS = [v1]          all tokens: kid=v1
T1      JWKS = [v1, v2]      IDP starts signing with v2; new tokens kid=v2, old kid=v1 still verify
T1+     (user tokens live 15min, M2M 5min — old v1 tokens age out)
T1+30m  JWKS = [v2]          v1 removed from the set
```

During `[v1, v2]` both keys verify — no failure. Failures happen at the **edges**, and the cache is what creates them:

- **RS cached `[v1]` before T1, then receives a `kid=v2` token.** Classic stale cache. The IDP serves `Cache-Control: public, max-age=3600`, so an RS can keep an old set for up to an hour. **Fix:** force a refresh — restart the RS, or clear its JWKS cache. A correct verifier (`jwks-rsa` with `rateLimit: true`) auto-refreshes on an unknown `kid`, but only once per its rate window.
- **RS cached `[v2]` after T1+30m, then receives a `kid=v1` token** that was issued just before rotation and hasn't expired. The token is legitimately signed but the key is gone. **This is the real risk window** the 30-minute wait in the rotation runbook exists to avoid. If you hit it: the token will expire within 15min (user) / 5min (M2M); re-fetch a fresh one. Nothing to fix server-side.

**How to tell which:** decode the token's `kid` (the inspect script prints it), then `curl <jwks_url> | jq '.keys[].kid'`. If the token's `kid` is **newer** than what the RS has → stale cache, refresh. If it's **older** than the live set → retired key, get a fresh token.

The IDP's `kid` is the SHA-256 (hex, 64 chars) of the public key in DER form — deterministic and stable across restarts. A `kid` that changed without a deliberate rotation means the `RSA_PRIVATE_KEY` env var changed underneath you.

---

## 2. Algorithm confusion — full anatomy

The attack: RS256 verification uses the **public** key, which is, by design, public (anyone can `curl` the JWKS). HMAC (`HS256`) verification uses a **shared secret**. If a Resource Server is configured to accept *both* algorithms and picks the algorithm from the **token header**, an attacker can:

1. Fetch the public key from `/.well-known/jwks.json`.
2. Forge a token with header `{"alg":"HS256"}` and any payload they like.
3. Sign it with HMAC-SHA256 using **the public key bytes as the HMAC secret**.
4. The vulnerable RS sees `alg:HS256`, grabs "the key" (the public key, which it has), runs HMAC verification — and it passes, because the attacker used that exact value as the secret.

The token is fully forged yet verifies. This is why **the algorithm must be pinned by the verifier, never read from the token**:

```ts
jwt.verify(token, key, { algorithms: ['RS256'] })   // correct — pinned
jwt.verify(token, key, { algorithms: ['RS256','HS256'] })  // VULNERABLE — never do this
jwt.verify(token, key)   // depends on lib defaults — audit it
```

The Overlens IDP signs **only** RS256. Any Overlens token presenting `alg: HS256` (or `none`) is either forged or not from the IDP. The inspect script flags this explicitly. See `../../../references/docs/learning/jwks.md` §"Algorithm Confusion Attack".

`alg: none` is the degenerate case — an unsigned token. Same defense: a pinned `['RS256']` list rejects it.

---

## 3. Poking the JWKS directly with curl

```bash
# Full key set
curl -s https://idp.overlens.com.br/.well-known/jwks.json | jq

# Just the advertised kid(s) — compare against your token's header kid
curl -s https://idp.overlens.com.br/.well-known/jwks.json | jq '.keys[].kid'

# Confirm the shape is right (public parts only — n and e, never d)
curl -s https://idp.overlens.com.br/.well-known/jwks.json | jq '.keys[0] | keys'
# expect: ["alg","e","kid","kty","n","use"]   — if you ever see "d", that's the private exponent leaking. Stop and report it.

# Check the cache header that governs how long a Resource Server may hold this set
curl -sI https://idp.overlens.com.br/.well-known/jwks.json | grep -i cache-control
# expect: Cache-Control: public, max-age=3600

# Discover issuer + jwks_uri without hardcoding (OIDC discovery)
curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq '{issuer, jwks_uri}'
```

If `keys` is empty or missing your expected `kid`, you're likely hitting the wrong host (staging vs prod) or caught the endpoint mid-rotation. Re-check the host and retry.

---

## 4. Decoding by hand (when you can't run the script)

base64url, not base64 — substitute `-`→`+`, `_`→`/`, then pad.

```bash
# Header
echo "<token>" | cut -d. -f1 | tr '_-' '/+' | base64 -d 2>/dev/null | jq

# Payload
echo "<token>" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq
```

```js
// Node one-liner (payload)
node -e "console.log(JSON.stringify(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url')),null,2))" "<token>"
```

Remember: this only **decodes**. It proves nothing about validity — a forged token decodes just as cleanly. Use it to read claims, then verify the signature against the JWKS separately (that's what the inspect script does in one step).

---

## 5. "Signature valid but still rejected" — the claim checklist

When the inspect script reports the signature is VALID and your service still 401s, the failure is in claim validation, not crypto. Walk these against your verifier config:

| Claim | What the RS pins | Common mismatch |
|---|---|---|
| `iss` | `JWT_ISSUER` env (`https://idp.overlens.com.br`) | trailing slash, http vs https, staging issuer |
| `aud` | `JWT_AUDIENCE` env — your API's audience | your API pins a different/custom audience than the token's; `aud` is an array, check membership |
| `exp` | clock | host clock skew; token genuinely expired (15min user / 5min M2M) |
| `alg` | `['RS256']` | verifier left algorithms unpinned |

`iss`/`aud` for the IDP come from its `IDP_ISSUER` / `IDP_AUDIENCE` env (audience accepts CSV → multiple audiences). If your RS validates audience, its expected value must appear in the token's `aud` array. See `../../../references/docs/integration/backend.md` §4.
