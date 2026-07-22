# Why the validation rules are non-negotiable (RS256, JWKS, the attacks they stop)

Read this when you want to understand *why* the strategy pins `RS256`, validates `iss`/`aud` explicitly, and caches the JWKS instead of fetching per request. Each rule closes a real hole.

> Canonical: `../../../references/docs/learning/jwks.md`. This file is the Resource-Server-facing slice.

---

## The asymmetric model in one paragraph

The IDP holds the RSA **private key** and signs every token with it. Your Resource Server only ever sees the **public key** (served via JWKS). Public key verifies, it cannot sign. So compromising your Resource Server leaks nothing useful — an attacker gets a key that can only *check* tokens, not *forge* them. This is the entire reason the IDP uses RS256 instead of a shared HS256 secret.

| Component | Knows | Does NOT know |
|---|---|---|
| IDP | private key (`RSA_PRIVATE_KEY`), `kid` | — |
| JWKS endpoint | public key (`n`, `e`, `kid`) | private key |
| Your Resource Server | public key (via JWKS) | private key |

---

## The four checks every token must pass

`passport-jwt` (and `jose`, `express-jwt`, etc.) do all four once you configure them. Configure all four — a signature check alone is not enough.

1. **Signature** — verified against the JWKS public key matching the token's `kid`.
2. **`algorithms: ['RS256']`** — pin it. See the algorithm-confusion attack below. Never `['RS256', 'HS256']`.
3. **`issuer`** — must equal `JWT_ISSUER` (`https://idp.overlens.com.br`). Rejects tokens from any other issuer.
4. **`audience`** — must match `JWT_AUDIENCE`. A token minted for a *different* Resource Server must not be accepted here just because the signature is valid. `exp` is checked automatically.

---

## Algorithm-confusion attack (why `algorithms: ['RS256']` is mandatory)

The classic break: the public key is, by definition, public. An attacker takes that public key string and uses it as an **HMAC secret** to sign a forged token with `alg: HS256`. If your server accepts both algorithms, it will "verify" the forged token using the public key as the HMAC secret — and it passes.

The fix is to refuse anything but RS256:

```ts
jwt.verify(token, publicKey, {
  algorithms: ['RS256'],                   // rejects HS256 outright
  issuer: 'https://idp.overlens.com.br',
  audience: 'https://api.overlens.com.br',
})
```

The IDP only ever issues RS256, so pinning it costs you nothing and closes the hole completely.

---

## JWKS caching & key rotation

```ts
passportJwtSecret({
  jwksUri: process.env.JWKS_URL,
  cache: true,
  cacheMaxAge: 3_600_000, // 1h — aligned with the IDP's Cache-Control: max-age=3600
  rateLimit: true,        // prevents a thundering herd of fetches on unknown kids
  jwksRequestsPerMinute: 5,
})
```

- **Don't fetch per request.** That re-couples you to the IDP's uptime and latency and turns the IDP into a DoS target. Fetch on boot / cache miss only.
- **Don't cache forever either.** You'd miss key rotation. 1h TTL is the sweet spot.
- **Rotation is zero-downtime by design.** During a rotation the IDP serves *both* keys in the JWKS; the `kid` in each token's header tells your verifier which one to use. Old tokens (kid=v1) keep verifying until they expire (≤15min); new tokens use kid=v2. You don't have to do anything as long as your cache honors `kid`.
- If you see `kid not found` right after a rotation, your cache is stale — that's the `idp-debug-jwt` skill's territory.

---

## What this Resource Server must NOT do

- **Don't call the IDP on a normal request.** Local validation against the cached key is the whole point — zero latency, survives brief IDP outages.
- **Don't poll the IDP to check if a user is blocked.** When a user is blocked the IDP zeroes their `refreshCode`, so they can't refresh — but their *current* access token stays valid until `exp` (≤15min). There is no global blocklist. Checking per request adds a DB call + latency + a cascading-failure dependency. If you genuinely need instant revocation on a critical endpoint, keep a local "blocked users" cache fed by events/webhooks — that's out of the IDP's scope today.
- **Don't authorize M2M by `role`.** Service tokens have no `role`; the check fails closed and the service gets a confusing 403. Authorize services by `scope`.
