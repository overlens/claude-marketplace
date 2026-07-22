# Client / BFF — conformance reference

For projects that **initiate** login (a BFF / SPA+BFF / mobile public client that
runs `authorize → callback → token → refresh → logout`). Pairs with the
`idp-auth-*` skills (which build the flow) — this is how you **prove** it's correct,
without a browser.

Template: [`../templates/client-bff.conformance.test.ts`](../templates/client-bff.conformance.test.ts)
· scripted mock: [`../templates/raw-token.test.ts`](../templates/raw-token.test.ts)

---

## How it works

The kit boots an **in-process mock IDP** (the real OAuth/OIDC contract, on a random
loopback port) and acts as the "browser": it takes the `state`+`codeChallenge` your
`startLogin` produces, calls the mock's `/auth/authorize` to get a `code`, then
hands `{ code, state }` to your `handleCallback`. Your client does the real token
exchange against `ctx.issuer` (the mock). No network, no Docker, deterministic.

---

## The adapter contract

```ts
interface ClientAdapter {
  startLogin(ctx): { state: string; codeChallenge: string } | Promise<...>;
  handleCallback(ctx, { code: string; state: string }): ClientResult<Session> | Promise<...>;
  refresh?(ctx, session): ClientResult<Session> | Promise<...>;            // optional
  logout?(ctx, session): ClientResult<{ redirectTo?: string }> | Promise<...>; // optional
  getAccessToken?(session): string | undefined;                            // optional
}

type ClientResult<T> = { ok: true; value: T } | { ok: false; status?: number; error?: string };

runClientConformance(adapter, { config?: Partial<Ctx>, label?: string });
```

The adapter is **stateful** between `startLogin` and `handleCallback` (it stashes
the `code_verifier` keyed by `state`) — exactly like a real BFF keeping the verifier
in an httpOnly cookie / server session. That PKCE+state handling is what's tested.

### The `ctx` the kit injects

| Field | Meaning |
|---|---|
| `issuer` | the mock's base URL — point your client's IDP calls here |
| `jwksUri` | `${issuer}/.well-known/jwks.json` |
| `clientId` | dev client id (from fixtures, default `test-web-bff`) |
| `clientSecret` | dev secret, or `null` for a **public** (PKCE-only) client |
| `redirectUri` / `postLogoutRedirectUri` | exact-match registered URIs |
| `scope` | e.g. `'openid profile email'` |
| `userEmail` / `userSub` | the seeded test user the "browser" authenticates as |

Override any of these via `{ config }` (e.g. `config: { clientId: 'test-public-pkce', clientSecret: null }`).

---

## Case catalog (what gets registered)

| # | Case | Expected | Needs |
|---|---|---|---|
| 1 | callback with valid PKCE | session established (+ token RS256/`sub` ok) | `handleCallback` (+ `getAccessToken`) |
| 2 | `state` mismatch | rejected, no session (CSRF) | `handleCallback` |
| 3 | `code` reused | rejected, no second session | `handleCallback` |
| 4 | IDP rejects the exchange | no session (handled gracefully) | `handleCallback` |
| 5 | refresh | rotates; old refresh dies | `refresh` |
| 6 | logout | redirects to registered `post_logout_redirect_uri` | `logout` |

Missing `refresh`/`logout` render as `it.skip`.

---

## Per-framework wiring

The one requirement: your client's **IDP base URL + client config must be
parameterizable** so the test can point it at `ctx.issuer` (the mock). If your code
reads `process.env.IDP_ISSUER` / `CLIENT_ID` / `CLIENT_SECRET`, either set those env
vars to the `ctx` values in the test, or (better) refactor the IDP calls to take a
config object.

### Next.js BFF (App Router)

Your auth lives in Route Handlers (`app/api/auth/callback`, `.../refresh`) and
Server Actions (login, logout) — see `idp-auth-nextjs`. Extract the **pure pieces**
(PKCE gen, the `code`→token exchange, the refresh call, the logout URL builder) into
functions that accept the IDP base + client config, then wrap them in the adapter:

```ts
import { generatePkce, exchangeCode, rotate, logoutUrl } from '../lib/auth-core';
runClientConformance({
  startLogin: (ctx) => generatePkce(),                         // stash verifier by state
  handleCallback: (ctx, p) => exchangeCode(ctx /* issuer/client */, p),
  refresh: (ctx, s) => rotate(ctx, s),
  logout: (ctx, s) => logoutUrl(ctx, s),
});
```

### Vite + standalone BFF (NestJS / Express / Hono)

Same idea — the BFF holds the secret and runs the flow (see `idp-auth-vite-bff`).
Point the BFF's IDP client at `ctx.issuer` in the test and wrap its handlers.

### Mobile / SPA public client (PKCE-only, no secret)

Run with `config: { clientId: 'test-public-pkce', clientSecret: null }`. The adapter
omits `client_secret` from the exchange (see the template — it already does
`...(ctx.clientSecret ? { client_secret } : {})`). Everything else is identical;
this proves the secret-less PKCE exchange and refresh rotation. See `idp-auth-mobile`.

---

## Scripting negatives directly

`startMockIdp` exposes a **live** `scripts` object to force failures deterministically
(beyond the natural PKCE/redirect/reuse rejections):

```ts
import { startMockIdp } from '@overlens/idp-testing/mock-idp';
const mock = await startMockIdp({ scripts: { http5xxOnce: true } }); // 1st request → 503
mock.scripts.failNextToken = { error: 'invalid_client', status: 401 }; // next /auth/token → 401
// ... drive your client against mock.url, assert it handles the failure ...
await mock.stop();
```

Use this for resilience tests (5xx, latency via `delayMs`) and specific error codes.
