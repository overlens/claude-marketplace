# Next.js (App Router) — Implementation Guide

This guide walks through wiring the OAuth flow in a Next.js 14+ App Router project. Pages Router can use the same logic with API routes; the patterns translate 1:1.

The four files below are in `templates/nextjs/`. Copy them into your project at the paths shown.

---

## File layout

```
lib/
  pkce.ts                      ← copy from templates/pkce.ts
  auth-actions.ts              ← copy from templates/nextjs/auth-actions.ts

app/
  api/
    auth/
      callback/
        route.ts               ← copy from templates/nextjs/callback-route.ts
      refresh/
        route.ts               ← copy from templates/nextjs/refresh-route.ts
  (auth)/                       ← optional route group for login page
    login/
      page.tsx                 ← uses redirectToLogin / redirectToSignup Server Actions
```

---

## Env vars (`.env.local` and Vercel/Railway)

```env
ACCOUNTS_URL=https://accounts.overlens.com.br
IDP_BASE_URL=https://idp.overlens.com.br
IDP_CLIENT_ID=your_client_id
IDP_CLIENT_SECRET=your_client_secret              # never NEXT_PUBLIC_*
IDP_REDIRECT_URI=https://yourapp.com/api/auth/callback
```

`IDP_CLIENT_SECRET` must **not** have the `NEXT_PUBLIC_` prefix — that would inline it into the client bundle.

---

## Step 1 — PKCE utilities (`lib/pkce.ts`)

Copy `templates/pkce.ts` as-is. It exports `generateCodeVerifier`, `generateCodeChallenge`, and `generateState`. The functions are pure — no Next.js dependency.

---

## Step 2 — Server Actions (`lib/auth-actions.ts`)

Copy `templates/nextjs/auth-actions.ts`. Two exports: `redirectToLogin()` and `redirectToSignup()`. Both:
- Generate fresh PKCE + state.
- Set two httpOnly cookies (`pkce_code_verifier`, `oauth_state`) scoped to `/api/auth/callback`.
- Redirect to `accounts.overlens.com.br/login` or `/signup` with all required OAuth params.

### Wiring in a page

```tsx
// app/(auth)/login/page.tsx
import { redirectToLogin, redirectToSignup } from '@/lib/auth-actions';

export default function LoginPage() {
  return (
    <main className="grid place-items-center min-h-screen">
      <h1 className="text-2xl mb-6">Bem-vindo</h1>
      <form action={redirectToLogin}>
        <button type="submit">Entrar</button>
      </form>
      <form action={redirectToSignup}>
        <button type="submit">Criar conta</button>
      </form>
    </main>
  );
}
```

Server Actions are POSTs by design — they can mutate cookies and call `redirect()`. Using `<a href>` doesn't work because cookies can't be set on a GET navigation initiated by the browser.

---

## Step 3 — Callback Route Handler (`app/api/auth/callback/route.ts`)

Copy `templates/nextjs/callback-route.ts`. The handler:

1. Reads `code` and `state` from the URL.
2. Reads `pkce_code_verifier` and `oauth_state` from cookies.
3. Validates `state === savedState` (CSRF check).
4. POSTs to `IDP_BASE_URL/auth/token` with `Authorization: Basic base64(client_id:client_secret)`.
5. Decodes the JWT to read `new_user`.
6. Sets `session_token` (15 min) and `session_refresh` (30 days) cookies on **your** domain.
7. Deletes the temp cookies.
8. Redirects to `/onboarding/profile` (if `new_user`) or `/dashboard`.

### Why decode the JWT here without verifying

We're not making authorization decisions in the callback. We only need to know whether to send the user to onboarding. The IDP just gave us this token via authenticated back-channel — we trust the source. Resource Servers later validate signatures via JWKS. See `idp-validate-token` skill for that side.

---

## Step 4 — Silent refresh (`app/api/auth/refresh/route.ts`)

Copy `templates/nextjs/refresh-route.ts`. The handler:
- POST-only.
- Reads `session_refresh` from cookies.
- Calls `IDP_BASE_URL/auth/token` with `grant_type=refresh_token`.
- On success: rotates both cookies. **Critically**, writes the new refresh token returned by the IDP — the old one is dead.
- On failure (any reason): clears both cookies and returns 401, so the frontend interceptor redirects to login.

### Frontend interceptor (in any client component using fetch/axios)

```ts
// lib/api-client.ts
export async function apiFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, credentials: 'include' });
  if (res.status !== 401) return res;

  // Try silent refresh once.
  const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
  if (!refreshRes.ok) {
    window.location.href = '/login';
    return res;
  }
  return fetch(url, { ...init, credentials: 'include' });
}
```

---

## Step 5 — Logout

Copy `templates/nextjs/logout-action.ts` to `lib/auth-actions.ts` (alongside the redirect actions):

```ts
'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const IDP_BASE_URL = process.env.IDP_BASE_URL ?? 'https://idp.overlens.com.br';
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
// Must EXACT-MATCH a post_logout_redirect_uri registered for this client with the IDP.
const POST_LOGOUT_REDIRECT_URI = process.env.POST_LOGOUT_REDIRECT_URI!;

export async function logout(): Promise<never> {
  const store = await cookies();
  store.delete('session_token');
  store.delete('session_refresh');

  // OIDC RP-Initiated Logout: a Server Action redirect() is a top-level navigation, so the IDP's
  // first-party cookies are sent and its Set-Cookie clears are honored. The IDP nulls the
  // server-side refresh code, clears its SSO cookies, then 302s back to post_logout_redirect_uri.
  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,
    state: crypto.randomUUID(),
  });
  redirect(`${IDP_BASE_URL}/auth/logout?${params.toString()}`);
}
```

Wire it to a Sair button:

```tsx
import { logout } from '@/lib/auth-actions';

export function LogoutButton() {
  return (
    <form action={logout}>
      <button type="submit">Sair</button>
    </form>
  );
}
```

The logout MUST be a top-level navigation (the Server Action `redirect()` is one) — never a `fetch` to the IDP, which wouldn't carry the IDP cookies. There is no `grant_type=revoke` (it returns `400 unsupported_grant_type`) and no per-token revocation: an already-issued access token stays valid until it expires (≤15 min). For immediate hard revocation, an admin calls `POST /admin/users/:id/block`.

---

## Optional — Auth.js (NextAuth) instead of hand-rolling

If you want a library to handle the boilerplate, the IDP exposes OIDC Discovery. Auth.js auto-configures from one URL. Use the dedicated `idp-use-oidc-discovery` skill or the recipe in `../../../references/docs/integration/oidc-discovery.md` §4.1.

Trade-off: less code, but you lose direct control over cookie names, paths, and the `new_user` branching. Hand-rolling (these templates) is ~150 lines and gives full control. Auth.js is ~30 lines but you adapt to its conventions.

---

## Testing locally

1. Make sure your client has `http://localhost:4000/api/auth/callback` (or whatever port) in `redirectUris`. See `references/client-registration.md`.
2. Run the IDP locally (or hit the production IDP).
3. Visit `http://localhost:4000/login`. The form should redirect to Accounts. Log in. You should land on `/dashboard` (or `/onboarding/profile` on first signup).
4. Inspect cookies with browser devtools — you should see `session_token` and `session_refresh` on `localhost:4000`. You should **not** see any cookies from `.overlens.com.br` (those belong to the Accounts SPA, not your app).
5. Wait 15 minutes (or use `expires_in` shorter via a dev IDP) and trigger an API call. The interceptor should silent-refresh.

---

## What this skill does NOT cover

- **Validating the JWT in your Resource Server (API routes)** — use the `idp-validate-token` skill. The JWT goes from the BFF to your API via `Authorization: Bearer` or the cookie, depending on whether your API is same-origin.
- **The Accounts SPA itself** — that's an Overlens internal project; don't mimic it unless you're maintaining Accounts.
- **Profile editing UI** — see `../../../references/docs/integration/profile.md` (the `/auth/me*` endpoints) once login works.
