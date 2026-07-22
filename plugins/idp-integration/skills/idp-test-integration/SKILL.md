---
name: idp-test-integration
description: >
  Scaffolds the VERIFICATION half of an Overlens IDP integration — the drop-in test suite that
  proves the login/validation you just wired is actually correct, offline and deterministic. Use
  this skill right AFTER integrating Overlens auth, whenever a developer (or agent) wants to PROVE
  the integration works rather than build it: "test my Overlens integration", "add integration tests
  for Overlens auth", "prove my callback/refresh/logout is correct", "Resource Server conformance
  for Overlens", "scaffold conformance tests", "is my Overlens token validation correct", "drop-in
  tests for Overlens SSO", "test my BFF Overlens flow without a browser", "conformance kit Overlens",
  "@overlens/idp-testing tests". It installs `@overlens/idp-testing` and drops the T5 conformance kit
  (`runResourceServerConformance` / `runClientConformance`) plus raw token/mock helpers
  (`mintToken`, negative-token factories, `startMockIdp`) into the project — Jest or Vitest, no
  Docker, no network, no real IDP. Two paths: a **Resource Server** that only validates JWTs (uses
  the toolkit + RS flavor) and a **client/BFF** that initiates login (uses the in-process mock IDP +
  client flavor). If the task is to BUILD the validation layer (guard/strategy/req.user) rather than
  test it, prefer `idp-validate-token`. If the task is to BUILD the login flow, prefer
  `idp-auth-nextjs`, `idp-auth-vite-bff`, `idp-auth-mobile`, or `idp-integrate-oauth-web`. If a
  SPECIFIC token is failing to verify and you're debugging it, prefer `idp-debug-jwt`. If an HTTP
  status/error is the symptom (401/403/CORS/redirect_uri), prefer `idp-troubleshoot-auth-errors`. For
  a conceptual overview of the whole IDP, prefer `idp-auth-guide`. This skill is the test
  counterpart of the `idp-auth-*` / `idp-validate-token` skills — it closes the loop "I integrated →
  I proved it's correct (green test)".
---

# Overlens IDP — Scaffolding the Integration Test Suite

You (or the agent) just wired Overlens auth into a project. This skill drops in the **proof**: a
deterministic, offline test suite that turns "I think it works" into `pnpm test` → green. It does
**not** teach how to integrate (the `idp-auth-*` / `idp-validate-token` skills do that) — it teaches
how to **verify** the integration you already have.

> **Why this matters for agents:** the agent's superpower is *iterate until green*. A test that
> gives an unambiguous "the integration is correct" signal is worth more than prose. These tests are
> deterministic by design (fixed test keypair, injectable clock, fixtures, **zero network, zero
> Docker**) so a flaky run never tempts you to weaken an assertion.

---

## Step 0 — Which path are you on?

Answer one question: **does this project VALIDATE tokens, or does it INITIATE login?**

| The project... | Path | Uses | Drop-in |
|---|---|---|---|
| **Validates** the IDP's JWT (an API / Resource Server: NestJS guard, Express middleware, etc.) | **A — Resource Server** | toolkit (T2) | `runResourceServerConformance(adapter)` |
| **Initiates** login (a BFF / SPA+BFF: handles `authorize`→`callback`→`refresh`→`logout`) | **B — Client/BFF** | in-process mock IDP (T4) | `runClientConformance(adapter)` |

A backend that does both → do both suites. A pure SPA/mobile public client (PKCE on-device) → path B
(it still has a callback + token exchange to prove).

---

## Step 1 — Install

```bash
pnpm add -D @overlens/idp-testing
# or: npm i -D @overlens/idp-testing   /   yarn add -D @overlens/idp-testing
```

Works with **Jest** or **Vitest**. For Vitest, enable globals so the kit can register `describe`/`it`:

```ts
// vitest.config.ts
export default { test: { globals: true } };
```

No other setup — the package ships the deterministic test keypair, fixtures, mock IDP, and the
conformance kit. Nothing talks to a real IDP, sandbox, or the network.

---

## Step 2 — Drop in the conformance suite

### Path A — Resource Server

You provide a tiny **adapter** that wraps your real validation; the kit feeds it valid + invalid
tokens and asserts the contract. Copy [`templates/resource-server.conformance.test.ts`](templates/resource-server.conformance.test.ts):

```ts
import { runResourceServerConformance } from '@overlens/idp-testing/conformance';
import { verifyMyToken } from '../src/auth'; // YOUR validation

runResourceServerConformance({
  verifyBearer: async (token) => {
    try { return { ok: true, principal: await verifyMyToken(token) }; } // { sub, email }
    catch { return { ok: false, status: 401 }; }
  },
  // optional: if your API also reads the access_token cookie
  // verifyCookie: async (token) => { ... },
  // optional: enables the scope/M2M cases (403 insufficient_scope + user-vs-M2M)
  // verifyScopedM2M: async (token, requiredScope) => { ... },
});
```

It registers: valid token accepted (correct principal), expired rejected, wrong `aud`/`iss`
rejected, algorithm confusion (HS256/`alg:none`) rejected, unknown `kid`/bad signature rejected, and
— if `verifyScopedM2M` is provided — scope-insufficient → 403 and user-vs-M2M distinction. Missing
optional methods show as `it.skip` (visible, never silent).

→ Adapter contract, the full case catalog, and per-framework wiring (NestJS / Express): see
[`references/resource-server.md`](references/resource-server.md).

### Path B — Client / BFF

The kit boots an **in-process mock IDP** and drives your client through `login → callback → refresh
→ logout`, asserting each is handled. You provide an adapter that wraps your client's operations.
Copy [`templates/client-bff.conformance.test.ts`](templates/client-bff.conformance.test.ts):

```ts
import { runClientConformance } from '@overlens/idp-testing/conformance';

runClientConformance({
  startLogin: (ctx) => myBff.startLogin(ctx),            // → { state, codeChallenge } (PKCE + state)
  handleCallback: (ctx, { code, state }) => myBff.handleCallback(ctx, { code, state }),
  refresh: (ctx, session) => myBff.refresh(ctx, session),  // optional → rotation
  logout: (ctx, session) => myBff.logout(ctx, session),    // optional → end_session
  getAccessToken: (session) => session.accessToken,        // optional → enables token assertion
});
```

It registers: callback+PKCE establishes a session, `state` mismatch rejected (CSRF), `code` reuse
rejected, an IDP-rejected exchange creates no session, refresh rotates and kills the old token, and
logout respects `post_logout_redirect_uri`.

→ Adapter contract, case catalog, and per-framework wiring (Next.js BFF / Vite+BFF / mobile): see
[`references/client-bff.md`](references/client-bff.md).

---

## Step 3 — Need custom assertions? Use the raw toolkit

The conformance kits are the fast path. When you need bespoke assertions, the same package exposes
the primitives directly — mint valid tokens, forge negative ones, serve a mock JWKS, or script the
mock IDP. Copy [`templates/raw-token.test.ts`](templates/raw-token.test.ts).

```ts
import { mintToken, getJwks, expiredToken, hs256Token } from '@overlens/idp-testing';
import { startMockIdp } from '@overlens/idp-testing/mock-idp';
import { getTestUser, getTestClient } from '@overlens/idp-testing/fixtures';
```

→ Full primitive reference in both reference docs.

---

## Step 4 — Run it

```bash
pnpm test    # green = the integration honors the Overlens contract
```

If red, the failure message is actionable — fix the integration, not the test. Do **not** weaken an
assertion to make it pass; that defeats the purpose.

---

## Optional — preflight before a real environment

The conformance suite proves the code is correct in isolation. Before pointing the integration at a
real sandbox/prod IDP, run the **doctor** to catch config drift (`issuer`, `aud`, `kid`, clock):

```bash
npx --package=@overlens/idp-testing idp-doctor --issuer https://idp-test.overlens.com.br \
  --audience https://api.example.com --token "<a real access token>"
```

Exit code ≠ 0 on any failed check. See [`references/resource-server.md`](references/resource-server.md) §Preflight.

---

## Routing — when NOT to use this skill

- **Building** the validation layer (guard/strategy/`req.user`) → `idp-validate-token`.
- **Building** the login flow → `idp-auth-nextjs` / `idp-auth-vite-bff` / `idp-auth-mobile` / `idp-integrate-oauth-web`.
- A **specific** token won't verify (debugging one bad JWT, `kid not found`, stale JWKS) → `idp-debug-jwt`.
- An **HTTP error** is the symptom (401 `invalid_client`, CORS, `redirect_uri` mismatch, 429) → `idp-troubleshoot-auth-errors`.
- Conceptual overview of the IDP → `idp-auth-guide`.
