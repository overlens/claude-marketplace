---
name: idp-auth-nextjs
description: >
  Copy-paste, idiomatic guide for integrating Overlens IDP login/signup/logout into a Next.js
  App Router project (the BFF lives inside Next.js itself). Use this skill whenever you are wiring
  Overlens SSO into a Next.js app — Plataforma, Events, Hodos, or any new Next.js project — and
  especially when the repo contains `next.config.{js,ts,mjs}` together with an `app/` directory.
  Triggers on phrases like "add Overlens login to my Next.js app", "Overlens callback Route
  Handler", "Server Action redirect to Accounts", "PKCE callback in app/api/auth", "protect routes
  with middleware Overlens", "read the Overlens session in a Server Component", "silent refresh
  Route Handler Next.js", or just an Overlens-auth request in a project that is clearly Next.js
  App Router. Provides a complete drop-in: `lib/pkce.ts`, `lib/auth-actions.ts` (login + signup +
  logout Server Actions), `lib/session.ts` (read the JWT in Server Components/layouts),
  `app/api/auth/callback/route.ts`, `app/api/auth/refresh/route.ts`, and `middleware.ts` for route
  protection. If the backend is NOT Next.js (a standalone NestJS/Express/Hono BFF, Rails, Django,
  ASP.NET), prefer `idp-integrate-oauth-web` — it is the multi-framework parent of this skill. If
  the project is a Vite SPA with a separate backend, prefer `idp-auth-vite-bff`. If it is a mobile
  or pure SPA public client (PKCE-only, no `client_secret`), prefer `idp-auth-mobile`. If you are
  only validating JWTs in a Resource Server (not initiating login), prefer `idp-validate-token`.
  For the framework-agnostic concepts behind all of this, the `idp-auth-guide` skill is the
  conceptual companion.
---

# Overlens IDP — Next.js App Router Integration

> **Prove it's correct:** once login works, scaffold the **client/BFF conformance** suite with the `idp-test-integration` skill — drop-in tests that drive callback → refresh → logout against an in-process mock IDP (no browser, no network, deterministic).

This skill drops a working OAuth 2.1 Authorization Code + PKCE login into a **Next.js App Router** project. Next.js *is* your BFF here — the Route Handlers in `app/api/auth/` hold the `client_secret` and run the token exchange server-side. There is no separate backend.

Three actors are involved, and keeping them straight prevents most misconfigurations:

| Actor | URL | Your code talks to it via |
|---|---|---|
| **Your Next.js app** | `yourapp.com` | — (this is what you're building) |
| **Accounts** (login/signup UI) | `accounts.overlens.com.br` | Browser **redirect** (front-channel) |
| **IDP** (token API) | `idp.overlens.com.br` | `fetch` from a Route Handler (back-channel, carries `client_secret`) |

You redirect the browser to **Accounts**, never to the IDP. Your server fetches **IDP** directly, never the browser. Confusing these two URLs is the #1 support ticket.

> **Conceptual companion:** `idp-auth-guide` explains the *why*. This skill is the *how*, specialized for App Router. For non-Next.js backends, `idp-integrate-oauth-web` is the parent.

---

## Before you write code

1. **Confirm it's App Router.** You need `next.config.*` and an `app/` directory. (Pages Router works too — see the note at the bottom — but the templates target App Router's `cookies()`, Server Actions, and Route Handlers.)
2. **Get the OAuth client registered.** You need a `client_id`, `client_secret`, and your callback URL (`https://yourapp.com/api/auth/callback`) registered in the IDP, plus the localhost variant for dev. If you don't have these, ask an admin or use the `idp-register-oauth-client` skill.
3. **Set env vars** (`.env.local` for dev, Vercel/Railway for prod):
   ```env
   ACCOUNTS_URL=https://accounts.overlens.com.br
   IDP_BASE_URL=https://idp.overlens.com.br
   IDP_CLIENT_ID=your_client_id
   IDP_CLIENT_SECRET=your_client_secret      # never prefix with NEXT_PUBLIC_
   IDP_REDIRECT_URI=https://yourapp.com/api/auth/callback
   POST_LOGOUT_REDIRECT_URI=https://yourapp.com/   # must be registered for RP-initiated logout
   ```
   `IDP_CLIENT_SECRET` must **never** carry the `NEXT_PUBLIC_` prefix — that would inline it into the browser bundle and leak it to every visitor. `POST_LOGOUT_REDIRECT_URI` must exact-match a `post_logout_redirect_uri` registered for this client (admin `POST/PATCH /admin/clients`).

---

## Drop-in file map

Copy the templates to these exact paths. The paths are not arbitrary: `IDP_REDIRECT_URI` must match `app/api/auth/callback/route.ts`'s URL byte-for-byte, and `session_refresh` is scoped to `/api/auth` so both callback and refresh can read it.

```
lib/
  pkce.ts                          ← templates/lib/pkce.ts
  auth-actions.ts                  ← templates/lib/auth-actions.ts        (login, signup, logout)
  session.ts                       ← templates/lib/session.ts            (read JWT in Server Components)
app/
  api/auth/callback/route.ts       ← templates/app/api/auth/callback/route.ts
  api/auth/refresh/route.ts        ← templates/app/api/auth/refresh/route.ts
middleware.ts                      ← templates/middleware.ts             (protect routes; optional but recommended)
```

The login/signup page and the logout button are tiny — examples are inline below, no template file needed.

---

## How the pieces fit

```
[Browser] ──click "Entrar"──► Server Action redirectToLogin()      (lib/auth-actions.ts)
                                │ generates PKCE + state
                                │ sets pkce_code_verifier + oauth_state cookies (path=/api/auth/callback)
                                ▼
                              redirect → accounts.overlens.com.br/login?client_id&redirect_uri&code_challenge&state
                                                │ user authenticates
                                                ▼
[Browser] ◄──redirect── yourapp.com/api/auth/callback?code&state
                                ▼
                              GET callback route                    (app/api/auth/callback/route.ts)
                                │ validate state === cookie, read code_verifier
                                │ POST idp.overlens.com.br/auth/token  (Basic auth, back-channel)
                                │ set session_token (15m) + session_refresh (30d) on YOUR domain
                                │ delete temp cookies
                                ▼
                              redirect → /onboarding/profile (if new_user) else /dashboard
```

Later, when `session_token` expires mid-session, the frontend hits `POST /api/auth/refresh`, which rotates both cookies. `middleware.ts` guards protected routes by checking for `session_token` presence.

---

## Implementation checklist

- [ ] Copy the six template files to the paths above
- [ ] Set the five env vars (and confirm `IDP_CLIENT_SECRET` has no `NEXT_PUBLIC_` prefix)
- [ ] Add a login page with `<form action={redirectToLogin}>` / `redirectToSignup` buttons
- [ ] Add a `<form action={logout}>` Sair button
- [ ] Decide your protected route matcher in `middleware.ts` (default protects `/dashboard`, `/onboarding`)
- [ ] Wire the client-side 401 interceptor to call `/api/auth/refresh` once before redirecting to login
- [ ] Confirm `IDP_REDIRECT_URI` is byte-identical to the registered redirect URI (no trailing slash)
- [ ] Test the full flow in dev before declaring done (see Testing below)

---

## Usage snippets

### Login / signup page

```tsx
// app/(auth)/login/page.tsx
import { redirectToLogin, redirectToSignup } from '@/lib/auth-actions';

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center gap-4">
      <h1 className="text-2xl">Bem-vindo</h1>
      <form action={redirectToLogin}><button type="submit">Entrar</button></form>
      <form action={redirectToSignup}><button type="submit">Criar conta</button></form>
    </main>
  );
}
```

Server Actions are POSTs — that's what lets them set cookies and `redirect()`. A plain `<a href>` (GET) cannot set the PKCE cookies, so the flow would break. Always use a `<form action={...}>`.

### Logout button

```tsx
import { logout } from '@/lib/auth-actions';

export function LogoutButton() {
  return <form action={logout}><button type="submit">Sair</button></form>;
}
```

### Reading the user in a Server Component

```tsx
// app/dashboard/page.tsx
import { getSession } from '@/lib/session';
import { redirect } from 'next/navigation';

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect('/login');
  return <p>Olá, {session.name}</p>;
}
```

`getSession()` decodes the `session_token` JWT to read claims (`sub`, `email`, `name`, `role`). It does **not** verify the signature — that's fine here because you're only reading your own session cookie for display/branching, not making an authorization decision on an incoming request. Real signature verification belongs in your Resource Server (see `idp-validate-token`).

### Client-side 401 interceptor (silent refresh)

```ts
// lib/api-client.ts
export async function apiFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, credentials: 'include' });
  if (res.status !== 401) return res;
  const refreshed = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
  if (!refreshed.ok) { window.location.href = '/login'; return res; }
  return fetch(url, { ...init, credentials: 'include' });  // retry once
}
```

---

## Next.js-specific gotchas

These are the ones that bite specifically in App Router. The OAuth-level pitfalls (state validation, redirect_uri match, refresh rotation) are covered in the templates' comments and in `idp-integrate-oauth-web`'s troubleshooting reference.

1. **`cookies()` is async in Next.js 15+** — `await cookies()` before `.get`/`.set`/`.delete`. The templates already `await`. In Next.js 14 it's sync, but `await` on a non-promise is harmless, so the templates work on both.
2. **You can only set cookies in a Server Action, Route Handler, or middleware** — never in a Server Component render. `getSession()` only *reads* cookies, which is allowed anywhere. That's why login/logout are Server Actions and the callback is a Route Handler.
3. **`redirect()` throws a control-flow signal** — don't wrap it in a `try/catch` that swallows everything, or the redirect won't happen. In the callback template, the `try` is only around the `fetch`; the `redirect()` calls are outside it.
4. **`NEXT_PUBLIC_` on the secret** — repeating because it's the worst one: `NEXT_PUBLIC_IDP_CLIENT_SECRET` ships your secret to every browser. Keep it as plain `IDP_CLIENT_SECRET`.
5. **Middleware runs on the Edge runtime** — don't import `node:crypto` or do a token exchange there. Middleware should only check cookie *presence* and redirect; the actual crypto/fetch stays in Route Handlers (Node runtime). The `middleware.ts` template follows this.
6. **`maxAge` is in seconds for `cookies().set()`** — Next.js's cookie API uses seconds (`maxAge: 900` = 15 min), unlike raw Express which uses milliseconds. The templates use seconds. Don't copy a `900_000` from an Express example into a Next.js `cookies().set()`.

---

## Logout — OIDC RP-Initiated Logout

Logout = delete your own session cookies, then redirect the browser to the IDP's `end_session_endpoint` (`GET https://idp.overlens.com.br/auth/logout`) with `client_id`, a registered `post_logout_redirect_uri`, and `state`. A Server Action `redirect()` is a top-level navigation, which is required — a `fetch` to the IDP wouldn't send its first-party cookies nor honor the `Set-Cookie` clears. The IDP nulls the server-side refresh code, clears its SSO cookies on `.overlens.com.br`, and 302s back to your `post_logout_redirect_uri`, ending the SSO session so the next login prompts for credentials.

There is no `grant_type=revoke` (it returns `400 unsupported_grant_type`) and no per-token revocation: an already-issued access token stays valid until it expires (≤15 min). For immediate hard revocation (compromised device), an admin must call `POST /admin/users/:id/block`. The `logout` Server Action template handles this correctly.

---

## Testing locally

1. Ensure your client has `http://localhost:3000/api/auth/callback` in its registered `redirectUris`.
2. Visit `http://localhost:3000/login` → click Entrar → you land on Accounts → log in → you should return to `/dashboard` (or `/onboarding/profile` on a fresh signup).
3. In devtools → Application → Cookies, confirm `session_token` and `session_refresh` exist **on localhost:3000**. You should see **no** cookies from `.overlens.com.br` — those belong to the Accounts SPA, not your app.
4. Hit a protected route while logged out → middleware should bounce you to `/login`.

---

## Pages Router note

If the project uses `pages/` instead of `app/`, the logic is identical; only the API surface changes: Server Actions become `pages/api/auth/login.ts` handlers, `cookies()` becomes `req.cookies` / `res.setHeader('Set-Cookie', ...)`, and `redirect()` becomes `res.redirect()`. Port the four Route Handlers to `pages/api/auth/*` and you're done. If most of the app is Pages Router, `idp-integrate-oauth-web` (which covers generic Node BFFs) may read more naturally.

---

## Where the canonical docs live

This skill is curation + drop-in templates. The maintained source of truth in this repo:

- `../../references/docs/integration/login.md` — full login flow (these templates derive from it)
- `../../references/docs/integration/signup.md` — signup (incremental over login; same callback)
- `../../references/docs/integration/logout.md` — RP-initiated logout via the `end_session_endpoint`
- `../../references/docs/integration/frontend.md` §1 — the OAuth frontend model
- `../../references/docs/integration/oauth-clients.md` — what must be registered

When code and skill disagree, the docs win — they track the running IDP.
