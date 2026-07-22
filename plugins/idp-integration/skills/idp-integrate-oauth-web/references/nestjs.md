# NestJS (BFF) — Implementation Guide

Use this guide when your web app's backend is a NestJS service (typical: Vite SPA frontend + NestJS BFF, or a pure NestJS app rendering EJS/Handlebars). The BFF holds `IDP_CLIENT_SECRET` and runs the token exchange; the SPA only sees session cookies on **your** domain.

The templates live in `templates/nestjs/` — copy them into your project under `src/auth/`.

---

## File layout

```
src/
  auth/
    pkce.ts                    ← copy from templates/pkce.ts
    idp-client.service.ts      ← copy from templates/nestjs/idp-client.service.ts
    auth.controller.ts         ← copy from templates/nestjs/auth.controller.ts
    auth.module.ts             ← register controller + services
  main.ts                       ← already exists; add cookieParser
```

---

## Dependencies

```bash
pnpm add @nestjs/config cookie-parser
pnpm add -D @types/cookie-parser
```

`cookie-parser` is required — without it, `req.cookies` is `undefined` and every callback fails silently.

---

## Step 1 — `main.ts`

```ts
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());                  // OBRIGATÓRIO — antes de qualquer controller que leia cookies
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
```

---

## Step 2 — `auth.module.ts`

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { IdpClientService } from './idp-client.service';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [IdpClientService],
})
export class AuthModule {}
```

Then import `AuthModule` in your `AppModule`.

---

## Step 3 — `pkce.ts`

Copy `templates/pkce.ts` as-is. It's pure Node crypto; no Nest dependencies.

---

## Step 4 — `idp-client.service.ts`

Copy `templates/nestjs/idp-client.service.ts`. The service is a thin wrapper over the IDP's `/auth/token` endpoint, exposing two methods:

- `exchangeCode(code, codeVerifier): Promise<TokenSet>`
- `refresh(refreshToken): Promise<TokenSet>`

Both fail with a structured `IdpTokenError` carrying HTTP status + body — useful when logging or branching on specific IDP error codes.

The service reads env vars via `ConfigService.getOrThrow`. If any of `IDP_BASE_URL`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URI` is missing, the app fails to boot — that's intentional. A missing env var should never silently default to an empty string in production.

---

## Step 5 — `auth.controller.ts`

Copy `templates/nestjs/auth.controller.ts`. Five routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/login` | Start login flow → redirects to Accounts |
| `GET` | `/auth/signup` | Start signup flow → redirects to Accounts |
| `GET` | `/auth/callback` | Callback handler — exchanges code, sets session cookies |
| `POST` | `/auth/refresh` | Silent refresh — rotates cookies |
| `GET` | `/auth/logout` | Clears session cookies + redirect to IDP `end_session_endpoint` (top-level navigation) |

### The maxAge in milliseconds gotcha

Express (which NestJS uses by default) takes `maxAge` in **milliseconds**. The controller template uses:
- Temp cookies: `maxAge: 600_000` (10 minutes)
- Session refresh: `maxAge: 30 * 24 * 60 * 60 * 1000`
- Access token: `maxAge: tokens.expires_in * 1000` (server returns seconds; we multiply)

If you ever see "I logged in but immediately got logged out", check the `Max-Age` in the response cookies. If it's 0, you sent `900` instead of `900_000`.

### `@Res()` and `passthrough`

The template uses `@Res() res: Response` because we need direct control over `res.cookie`, `res.clearCookie`, `res.redirect`. **Do not** use `@Res({ passthrough: true })` here — passthrough mode doesn't let you call `res.redirect` reliably (Nest's interceptors fight with it).

---

## Step 6 — Frontend integration

If you have a separate SPA (Vite, etc.):

```ts
// In the SPA — POST refresh on 401
async function apiFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, credentials: 'include' });
  if (res.status !== 401) return res;

  const refreshed = await fetch('http://localhost:4000/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  });
  if (!refreshed.ok) {
    window.location.href = '/login';
    return res;
  }
  return fetch(url, { ...init, credentials: 'include' });
}
```

The "Entrar" button should `window.location.href = '/auth/login'` (the BFF route, not the IDP).

---

## Env vars

```env
ACCOUNTS_URL=https://accounts.overlens.com.br
IDP_BASE_URL=https://idp.overlens.com.br
IDP_CLIENT_ID=your_client_id
IDP_CLIENT_SECRET=your_client_secret
IDP_REDIRECT_URI=https://yourapp.com/auth/callback
POST_LOGOUT_REDIRECT_URI=https://yourapp.com/
```

Make sure `IDP_REDIRECT_URI` ends in `/auth/callback` (matching the controller route) and is registered in the IDP — see `references/client-registration.md`. `POST_LOGOUT_REDIRECT_URI` must likewise exact-match a `post_logout_redirect_uri` registered for this client (admin `POST/PATCH /admin/clients`).

---

## Logout

The `GET /auth/logout` route in `templates/nestjs/auth.controller.ts` implements OIDC RP-Initiated Logout. The handler:

1. Clears your own session cookies (`session_token`, `session_refresh`) on your domain via `res.clearCookie`.
2. Issues a **top-level redirect** (`res.redirect(...)`, reached by a browser navigation — `window.location.href = '/auth/logout'`, never `fetch`/XHR) to the IDP `end_session_endpoint` (`GET {IDP_BASE_URL}/auth/logout`) with `client_id`, `post_logout_redirect_uri`, and a random `state`.
3. The IDP nulls the server-side refresh code, clears its SSO cookies on `.overlens.com.br`, then 302s back to your `post_logout_redirect_uri`.

The `post_logout_redirect_uri` (env `POST_LOGOUT_REDIRECT_URI`) must **exact-match** a URI pre-registered for this client — see `references/client-registration.md`. If absent or unregistered, the IDP redirects to its own fallback page instead of your app.

It must be a navigation, not a `fetch`: only a top-level navigation sends the IDP's first-party cookies and lets the browser honor the `Set-Cookie` clears. There is no per-token revocation (no `grant_type=revoke`, no RFC 7009 `/revoke`) — an already-issued access token stays valid until it expires (≤15 min). For immediate hard revocation, an admin calls `POST /admin/users/:id/block`.

---

## Validating tokens on protected routes

This skill creates the session. To **protect** routes (require a valid session to access), use the `idp-validate-token` skill — it shows how to extract the JWT from the cookie and validate it via JWKS. Sketch:

```ts
@UseGuards(JwtAuthGuard)
@Get('me')
async me(@CurrentPrincipal() user: AuthenticatedUser) {
  return { id: user.id, email: user.email };
}
```

But the `JwtAuthGuard` config lives in the validation skill, not here.

---

## Common errors specific to NestJS

- **`req.cookies is undefined`** — you forgot `app.use(cookieParser())` in `main.ts`.
- **`redirect()` doesn't redirect** — you used `@Res({ passthrough: true })`. Drop the passthrough.
- **Cookies don't appear in the browser** — your `secure: true` cookies require HTTPS. In dev with `http://localhost`, set `secure: false` (or use a tunnel like ngrok for HTTPS).
- **CORS error in dev when the SPA calls the BFF** — enable CORS in `main.ts`: `app.enableCors({ origin: 'http://localhost:5173', credentials: true })`.
