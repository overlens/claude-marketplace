---
name: idp-debug-jwt
description: >
  Diagnostic, hands-on skill for debugging a SPECIFIC Overlens IDP token or JWKS that
  is misbehaving — a JWT that "should be valid but isn't", an unexpected payload, a
  `kid` the Resource Server can't find, a stale JWKS cache after key rotation, or a
  suspected forged/algorithm-confusion token. Use this skill whenever a developer is
  staring at an actual token (or JWKS response) trying to understand WHY it fails, as
  opposed to writing fresh validation code. Triggers on phrases like "token inválido
  Overlens", "JWT verify fail", "invalid signature Overlens", "kid not found", "no
  matching key in JWKS", "JWKS cache stale", "decodificar / decode JWT Overlens",
  "why is my Overlens token rejected", "is this Overlens token forged", "JWKS returning
  the wrong key", "token works in dev but not prod", or when someone pastes an Overlens
  JWT and asks what's wrong with it. Provides a zero-dependency inspect script that
  decodes the token, fetches the live JWKS, matches the `kid`, verifies the RS256
  signature, and checks iss/aud/exp/alg — plus a symptom→cause→fix table.
  If the task is to IMPLEMENT JWT validation in a Resource Server from scratch (write
  the guard/strategy), prefer `idp-validate-token`. If the symptom is an HTTP-level
  error — `401 invalid_client`, CORS, `429`, `Max-Age=0` cookies, `redirect_uri`
  mismatch — prefer `idp-troubleshoot-auth-errors`. If you are configuring a generic
  OIDC library, prefer `idp-use-oidc-discovery`.
---

# Overlens IDP — Debug a JWT / JWKS

You're here because a **specific** token or JWKS response is wrong, and you need to know *which* of the many possible reasons. This skill is diagnostic, not constructive — it inspects what already exists. (If you need to *write* a validator, that's `idp-validate-token`.)

> **Canonical docs:** `../../references/docs/learning/jwks.md` (RS256, JWKS, algorithm confusion), `../../references/docs/integration/backend.md` §3 + §9 (user-vs-M2M payload, JWKS cache), `../../references/docs/learning/key-rotation.md` (what rotation does to `kid`s). This skill curates those into a debugging workflow plus an inspect script.

---

## Am I in the right place? (decision gate)

This skill fits when you have an **artifact in hand** — a token string, a JWKS JSON, a verifier error message — and want to explain it. Route elsewhere if:

- You're writing the validation logic for the first time → `idp-validate-token`.
- The error is HTTP-shaped and never reaches signature verification — `401 invalid_client` on `/auth/token`, CORS, `429`, `redirect_uri` mismatch, cookies with `Max-Age=0` → `idp-troubleshoot-auth-errors`.
- You're configuring Auth.js / `openid-client` / `passport-openidconnect` → `idp-use-oidc-discovery`.

A useful tell: "why does my code reject *this* token?" is this skill. "How do I write code to reject bad tokens?" is `idp-validate-token`. "Why do I get a 401 page / curl error?" is `idp-troubleshoot-auth-errors`.

---

## First move: run the inspect script

Almost every JWT question is answered fastest by decoding the token and checking it against the live JWKS in one shot. Don't hand-decode base64 or eyeball the payload — run the bundled script. It's zero-dependency (Node ≥ 18) and prints a labeled verdict for each thing that can be wrong.

```bash
node scripts/inspect-token.mjs <token>
# or pipe it:  echo "<token>" | node scripts/inspect-token.mjs
# staging / custom audience:
node scripts/inspect-token.mjs <token> --jwks <jwks_url> --iss <issuer> --aud <your_api_audience>
```

It reports, in order:

1. **Header + payload** decoded (no trust — this always works even on a forged/expired token).
2. **`alg`** — flags anything other than `RS256`, and shouts if it's `HS*` (the classic algorithm-confusion signature).
3. **User vs M2M** — `!!payload.client_id && !payload.email` is the discriminator. M2M carries `scope`, no `role`/`email`.
4. **`iss` / `aud` / `exp`** — the three checks a Resource Server makes *besides* the signature, and the three most common reasons a perfectly-signed token still 401s.
5. **`kid` lookup + signature** — fetches the JWKS, matches the `kid`, verifies RS256. If the `kid` isn't in the set, it explains the stale-cache vs retired-key fork.

Read the script's verdict, then map it to the table below. The point of the script is to tell you *the signature is fine, your problem is `aud`* — instead of a generic "invalid token".

---

## Symptom → cause → fix

| Symptom | Most likely cause | Fix |
|---|---|---|
| `kid not found` / "no matching key in JWKS" | Resource Server cached the JWKS **before** a key rotation; the new `kid` isn't in its cache | Force a JWKS refresh (restart the RS, or clear its cache). The IDP serves `Cache-Control: max-age=3600`, so a stale cache can lag up to 1h. See `../../references/docs/learning/key-rotation.md`. |
| `kid not found` **and** token is expired | Token signed by a key already retired from the set | It's just an old token — get a fresh one. Nothing to fix on the server. |
| `invalid signature` but `kid` matches | Token body altered after signing, OR your verifier is checking the wrong key/wrong input | Re-run the inspect script — if it reports VALID, your verifier config is wrong (not the token). |
| Signature valid, still `401` | `iss` or `aud` mismatch, or `exp` passed | Compare the script's iss/aud/exp lines to what your RS pins. Audience mismatch is the #1 silent rejecter. |
| `alg: HS256` on an Overlens token | Forged token (algorithm confusion) or a misconfigured non-Overlens issuer | The IDP signs **only** RS256. A correct RS pins `algorithms: ['RS256']` and rejects this. Never accept `['RS256','HS256']`. See `../../references/docs/learning/jwks.md` §"Algorithm Confusion". |
| Payload has no `email`/`role`, only `client_id`/`scope` | It's an **M2M** token, not a user token | Authorize by `scope`, not `role`. M2M tokens legitimately have no role. |
| Works in dev, fails in prod | dev `JWKS_URL`/`iss`/`aud` differ from prod, or prod RS cached an old/empty JWKS | Point the script at the **prod** JWKS (`--jwks`) and compare iss/aud against prod env. |
| JWKS response missing your `kid`, or empty `keys` | Querying the wrong host, or hitting it mid-rotation | `curl <jwks_url> \| jq '.keys[].kid'` — confirm the expected `kid` is present on the **right** host. |

---

## What a healthy Overlens token looks like

Verify against this so you know what "correct" is:

```jsonc
// Header
{ "alg": "RS256", "typ": "JWT", "kid": "<64-char hex sha256 of the public key>" }

// User payload
{ "sub": "<cuid2>", "email": "u@x.com", "role": "BASIC|ADMIN|SYSTEM",
  "email_verified": true, "iss": "https://idp.overlens.com.br",
  "aud": ["https://api.overlens.com.br"], "iat": …, "exp": iat + 900 }  // 15 min

// M2M payload — note the ABSENCE of email/role/name
{ "sub": "<clientId>", "client_id": "<clientId>", "scope": "fractals:read …",
  "iss": "https://idp.overlens.com.br", "aud": [...], "iat": …, "exp": iat + 300 }  // 5 min
```

Anything outside this shape is the bug. `alg` ≠ `RS256` → reject. `kid` not a 64-char hex → suspect. A user payload without `email`, or an M2M payload with a `role` → not a real Overlens token.

---

## Mental model of the failure modes (why these are the only options)

A Resource Server validates five independent things; a token fails for exactly one of them, and naming which one is the whole job:

1. **Shape** — is it three base64url parts of JSON? (corruption / truncation / it's a JWE)
2. **`alg`** — is it `RS256`? (algorithm confusion if not)
3. **Signature** — does the `kid`'s public key verify it? (tampering, wrong key, stale JWKS)
4. **Claims** — do `iss`, `aud`, `exp` match what this RS expects? (cross-issuer, cross-audience, stale token)
5. **Authorization** — does `role`/`scope` permit the action? (that's authZ, not token validity — and a different skill)

The inspect script walks 1→4 in order and stops at the first failure. Step 5 is out of scope here — if the token verifies and the claims match, the token is *fine*; an authorization denial is a policy question, not a JWT-debugging one.

---

## Common traps

- **Decoding ≠ verifying.** jwt.io and `--decode` show you the payload of *any* string, including a forged one. A readable payload tells you nothing about validity. Always check the signature against the live JWKS.
- **Pasting with `Bearer ` or quotes.** The script strips a leading `Bearer ` and surrounding quotes, but if you hand-decode, that prefix corrupts the first segment.
- **Trusting your local clock.** `exp` checks are clock-sensitive; large skew between the RS host and real time causes spurious expiry. The script uses the host clock — if it disagrees with reality, fix NTP.
- **Comparing `aud` as a string.** `aud` is an array. Membership, not equality.
- **Assuming a missing `kid` means a bad token.** After rotation the *server* may simply need its JWKS cache refreshed. Check the live JWKS before blaming the token.

---

## File map

```
idp-debug-jwt/
├── SKILL.md                    (this file)
├── scripts/
│   └── inspect-token.mjs       (decode + JWKS fetch + kid match + RS256 verify + iss/aud/exp, zero-dep, Node ≥18)
└── references/
    └── diagnostics.md          (deep dives: rotation timeline, algorithm-confusion anatomy, JWKS-by-curl recipes)
```

Read `references/diagnostics.md` when the symptom table isn't enough — it has the rotation timeline that explains `kid`-not-found windows, the full algorithm-confusion walkthrough, and `curl`/`jq` recipes for poking the JWKS directly.
