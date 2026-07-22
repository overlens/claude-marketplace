# Cross-Origin Cookies — the make-or-break of Vite + separate BFF

This is the part that breaks Vite-SPA-plus-BFF integrations. The OAuth flow itself is standard; what's hard is making the browser, sitting on the SPA's origin, *send* the BFF's session cookie on every API call. This file is a decision guide for the three viable topologies and the cookie attributes each one needs.

## Table of contents

1. Why a session cookie gets silently withheld
2. The three topologies (and which to choose)
3. Topology A — dev proxy / single origin (recommended)
4. Topology B — same parent domain (recommended for prod)
5. Topology C — unrelated domains (`SameSite=None; Secure`)
6. The CORS-with-credentials rules
7. A debugging flowchart for "cookie set but not sent"

---

## 1. Why a session cookie gets silently withheld

A cookie's `SameSite` attribute controls whether the browser attaches it to a request that originates from a *different site*:

- `SameSite=Lax` (the Overlens default everywhere) — sent on same-site requests and top-level navigations, **withheld** from cross-site sub-requests like `fetch`/`XHR`.
- `SameSite=Strict` — withheld from anything cross-site, including top-level navigation.
- `SameSite=None` — sent on all requests, but **only if `Secure` is also set** (HTTPS).

"Site" here means the *registrable domain* (eTLD+1), not the full origin. `app.example.com` and `api.example.com` are the **same site** (`example.com`). `myapp.com` and `myapi.dev` are **different sites**. `localhost:5173` and `localhost:4000` are the *same site* for cookie purposes (`localhost`), but differ in *origin*, which matters for CORS — see §6.

So the classic failure: BFF sets `SameSite=Lax` session cookie; the SPA on a different site calls the BFF with `fetch(..., credentials:'include')`; the browser stores the cookie but, because the request is cross-site and not a top-level navigation, **does not attach it** → BFF sees no session → `401`. Nothing in the network tab screams "cookie withheld"; it just isn't there.

---

## 2. The three topologies

| | Dev | Prod | SameSite | Secure | CORS needed? | Effort |
|---|---|---|---|---|---|---|
| **A. Single origin (dev proxy / one reverse proxy)** | Vite proxies `/auth`+`/api` to BFF | SPA + BFF behind one host/CDN | `Lax` | as usual | No | lowest |
| **B. Same parent domain** | proxy in dev, subdomains in prod | `app.example.com` + `api.example.com` | `Lax` + `domain=.example.com` | Yes | low |
| **C. Unrelated domains** | two origins | `myapp.com` + `api.other.dev` | `None` | `Secure` (forces HTTPS even in dev) | Yes | highest |

**Pick A for dev and A or B for prod whenever you can.** Topology C is a last resort — it forces HTTPS in development, is the most fragile across browser privacy changes (third-party cookie deprecation), and offers no upside if you control both deployments. If you find yourself reaching for C, first ask whether you can put both behind one domain.

---

## 3. Topology A — single origin (recommended)

**Dev:** the Vite dev server proxies auth/API paths to the BFF (see `templates/vite/vite.config.ts`). The browser only ever sees `http://localhost:5173`. Cookies are first-party; `SameSite=Lax` works; `secure: false` (plain http) is fine because there's no cross-site condition. No CORS.

**Prod:** put the SPA's static bundle and the BFF behind a single reverse proxy / CDN where `/` serves the SPA and `/auth` + `/api` route to the BFF. Same first-party situation. The SPA uses relative URLs everywhere (`VITE_BFF_URL=''`).

Cookie attributes the BFF sets in this topology — exactly the Overlens defaults, minus the `.overlens.com.br` domain (these are *your* cookies on *your* host):

```js
// session access cookie
{ httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: tokens.expires_in * 1000 }
// session refresh cookie
{ httpOnly: true, secure: isProd, sameSite: 'lax', path: '/auth', maxAge: 30*24*60*60*1000 }
```

(`secure: false` in dev so `http://localhost` keeps the cookie; `true` in prod.)

---

## 4. Topology B — same parent domain (recommended for prod)

SPA at `https://app.example.com`, BFF at `https://api.example.com`. Same site (`example.com`), so `SameSite=Lax` cookies *can* be shared — but only if you set `domain=.example.com` so the cookie isn't host-locked to `api.example.com`:

```js
{ httpOnly: true, secure: true, sameSite: 'lax', domain: '.example.com', path: '/', maxAge: ... }
```

Because the two subdomains are the same site, a `fetch` from `app.` to `api.` is **same-site**, so `Lax` is attached. You still need **CORS** (different *origin*) — see §6.

In dev, use Topology A's proxy so you don't have to fake subdomains locally.

---

## 5. Topology C — unrelated domains (`SameSite=None; Secure`)

Only when SPA and BFF are on genuinely different registrable domains and you can't unify them. The cross-site `fetch` will only carry the cookie if it's `SameSite=None`, and browsers require `Secure` (HTTPS) for `None`:

```js
{ httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: ... }
```

Consequences to accept:

- **HTTPS everywhere, including dev.** `SameSite=None` without `Secure` is rejected. Use a local TLS tool (mkcert) or a tunnel.
- **Third-party-cookie deprecation risk.** Browsers are progressively restricting cross-site cookies; a flow that relies on `SameSite=None` from a top-level different site may break for users with strict privacy settings. This is the strategic reason to prefer A/B.
- **CORS is mandatory** and must echo the exact origin with credentials (§6).

If you're forced here, document it and revisit whether the deployment can move under one domain later.

---

## 6. CORS-with-credentials rules

Any time the SPA origin differs from the BFF origin (Topologies B and C, and dev-without-proxy), the BFF needs CORS — and credentialed CORS has strict rules the browser enforces:

1. **`Access-Control-Allow-Origin` must be the exact origin**, never `*`. With `*` and credentials the browser discards the response.
2. **`Access-Control-Allow-Credentials: true`** must be present.
3. **The SPA fetch must set `credentials: 'include'`** — otherwise no cookie is sent or stored.
4. **Preflight (`OPTIONS`) must succeed** for non-simple requests (e.g. `POST /auth/refresh` with custom headers).

Express:

```js
const cors = require('cors');
app.use(cors({ origin: process.env.SPA_ORIGIN, credentials: true }));
```

NestJS (`main.ts`):

```ts
app.enableCors({ origin: process.env.SPA_ORIGIN, credentials: true });
```

`SPA_ORIGIN` is a single exact origin like `https://app.example.com` (or `http://localhost:5173` in CORS-based dev). If you need multiple, validate against an allowlist and echo the matched one — don't concatenate or wildcard.

---

## 7. Debugging "cookie set but not sent"

When the callback succeeds but API calls 401, walk this in order:

1. **Is the cookie in the jar?** DevTools → Application → Cookies → the BFF origin. If it's not even there, the `Set-Cookie` was rejected: check `secure` over http (drop it in dev), and check the `domain` attribute isn't a domain the response host can't set.
2. **Is the request cross-site?** Compare the SPA's registrable domain to the BFF's. Same site → `Lax` is fine, look at CORS instead. Different site → `Lax` will be withheld; you need Topology A/B or `None`.
3. **Does the fetch send credentials?** Network tab → the API request → is the cookie in the Request Headers? If absent but present in the jar, you're missing `credentials: 'include'` or the cross-site/SameSite condition above.
4. **Is CORS passing?** Look for a CORS error in console, or a missing `Access-Control-Allow-Credentials: true` / wildcard origin in the response headers.
5. **Is `secure: true` set on plain http?** That alone drops the cookie silently in dev.

90% of the time the answer is step 2 (cross-site + `Lax`) — which the dev proxy makes disappear.
