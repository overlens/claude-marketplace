# Resource Server — conformance reference

For projects that **validate** the Overlens IDP's JWT (an API / Resource Server).
Pairs with the `idp-validate-token` skill (which builds the validator) — this is
how you **prove** the validator is correct.

Template: [`../templates/resource-server.conformance.test.ts`](../templates/resource-server.conformance.test.ts)
· raw primitives: [`../templates/raw-token.test.ts`](../templates/raw-token.test.ts)

---

## The adapter contract

You implement a thin adapter; the kit drives it with valid + forged tokens.

```ts
interface ResourceServerAdapter {
  verifyBearer(token: string): AdapterResult | Promise<AdapterResult>;
  verifyCookie?(token: string): AdapterResult | Promise<AdapterResult>;        // optional
  verifyScopedM2M?(token: string, requiredScope: string): AdapterResult | Promise<AdapterResult>; // optional
}

type AdapterResult =
  | { ok: true;  principal: { sub: string; email?: string; clientId?: string; scopes?: string[] } }
  | { ok: false; status?: number; error?: string };

runResourceServerConformance(adapter, {
  requiredScope?: string;   // scope the M2M endpoint requires (default 'idp:test')
  m2mClientId?: string;     // client_id used when minting the M2M token (default 'conformance-client')
  label?: string;           // describe() block title
});
```

**Each adapter method validates a token and returns a normalized result** — `ok:true`
with the principal, or `ok:false` (with an optional HTTP `status`). The kit never
sees your framework; it only sees `AdapterResult`.

---

## Point your validator at the TEST environment

The kit mints tokens with the **deterministic test keypair** and these defaults:

| What | Value | Import |
|---|---|---|
| issuer (`iss`) | `http://localhost:3147` | `JWT_ISSUER_DEFAULT` from `@overlens/idp-testing` |
| audience (`aud`) | `['http://localhost:3148']` | `JWT_AUDIENCE_DEFAULT` from `@overlens/idp-testing` |
| public key (JWKS) | test key | `getJwks()` (object) or `startJwksServer()` (URL) |

So in the test, configure **your** validator to verify against `getJwks()` + those
`iss`/`aud`. Two common cases:

- **lib that takes a JWKS object (`jose`)** → `createLocalJWKSet(getJwks())`.
- **lib that takes a `jwksUri` (`jwks-rsa`, `passport-jwt`)** → `const { jwksUri } = await startJwksServer()` and point the lib at it; `await server.close()` in teardown.

Always pin `algorithms: ['RS256']` — that's what makes the HS256/`alg:none` cases fail.

---

## Case catalog (what gets registered)

| # | Case | Expected | Needs |
|---|---|---|---|
| 1 | valid token via **Bearer** | accepted, `principal.sub`/`email` correct | `verifyBearer` |
| 1b | valid token via **cookie** `access_token` | accepted | `verifyCookie` |
| 2 | expired token | rejected | `verifyBearer` |
| 3 | wrong `aud` / wrong `iss` | rejected | `verifyBearer` |
| 4 | algorithm confusion (HS256 / `alg:none`) | rejected | `verifyBearer` |
| 5 | unknown `kid` / invalid signature | rejected | `verifyBearer` |
| 6 | M2M token **without** required scope / **with** it | `403` / accepted | `verifyScopedM2M` + `requiredScope` |
| 7 | user token on the M2M endpoint | rejected (user ≠ M2M) | `verifyScopedM2M` |

Missing optional methods (`verifyCookie`, `verifyScopedM2M`) render as `it.skip` —
pulled out **visibly**, never silently dropped.

---

## Per-framework wiring

The trick is the same everywhere: extract a **pure verify function** and call it
from the adapter (and from your real guard/middleware). See `idp-validate-token`
for the production validator.

### NestJS

If you have a `JwtStrategy`/`JwtAuthGuard`, factor the verification into a function
your strategy calls, then call the same function in the adapter:

```ts
// auth/verify-token.ts (shared by your JwtStrategy and the test)
export async function verifyAccessToken(token: string, jwks, opts) { /* RS256, iss, aud */ }
```

```ts
// resource-server.conformance.test.ts
import { verifyAccessToken } from '../src/auth/verify-token';
// configure jwks/iss/aud for TEST (see above) and wrap in verifyBearer/verifyScopedM2M.
```

### Express / Fastify / Hono

Your `requireAuth` middleware wraps a verify call — expose that call and reuse it:

```ts
verifyBearer: async (token) => {
  try { return { ok: true, principal: await verifyAccessToken(token) }; }
  catch { return { ok: false, status: 401 }; }
}
```

For `jwks-rsa`-based middleware that needs a URL, use `startJwksServer()` in a
`beforeAll` and point the client at `server.jwksUri`.

---

## Raw primitives (custom assertions)

When you need bespoke checks, skip the kit and use the toolkit directly
(see [`../templates/raw-token.test.ts`](../templates/raw-token.test.ts)):

- `mintToken({ sub, email, name?, role?, aud?, iss?, now?, expiresAt? })` — valid user token.
- `mintM2MToken({ clientId, scope, ... })` — valid M2M token.
- Negative factories (each returns a token string): `expiredToken`, `futureIatToken`,
  `wrongAudToken`, `wrongIssToken`, `unknownKidToken`, `invalidSignatureToken`,
  `hs256Token`, `algNoneToken`. Each accepts `{ sub?, email? }`.
- `getJwks()` / `startJwksServer()` — the mock JWKS as object / URL.

---

## Preflight — before a real environment

The conformance suite proves correctness in isolation. Before pointing the
validator at a real sandbox/prod IDP, run the **doctor** to catch config drift
(the classic `IDP_ISSUER` sandbox→prod break):

```bash
npx --package=@overlens/idp-testing idp-doctor \
  --issuer https://idp-test.overlens.com.br \
  --audience https://api.example.com \
  --token "<a real access token>"
```

Checks: discovery reachable + `iss` matches, JWKS reachable, token `kid` present in
JWKS, `aud`/`iss` match, clock skew tolerable. Exit ≠ 0 on any failure. Programmatic:

```ts
import { runPreflight } from '@overlens/idp-testing/doctor';
const report = await runPreflight({ issuer, expectedAudience, token });
expect(report.ok).toBe(true);
```
