/**
 * Client / BFF conformance — drop-in (Overlens IDP, RFC-0005 / T5 client flavor).
 *
 * The kit boots an in-process mock IDP and drives your client through
 * login → callback → refresh → logout, asserting: callback+PKCE establishes a
 * session, `state` mismatch rejected (CSRF), `code` reuse rejected, an
 * IDP-rejected exchange creates no session, refresh rotates (old token dies), and
 * logout respects `post_logout_redirect_uri` — offline, no Docker, no browser.
 *
 * Works as-is in Jest OR Vitest. Run: `pnpm test`.
 *
 * The reference adapter below is a minimal `fetch`-based BFF. Replace each method
 * with YOUR real client's operation, pointed at `ctx.issuer` (the mock's URL) —
 * see references/client-bff.md for Next.js BFF / Vite+BFF / mobile wiring.
 */
import { createHash, randomBytes } from 'node:crypto';
import { runClientConformance } from '@overlens/idp-testing/conformance';

// Per-`state` PKCE store (a real BFF keeps the verifier in an httpOnly cookie /
// server session keyed by `state`). Module-scoped here for the reference.
const verifiers = new Map<string, string>();

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

runClientConformance({
  // Begin login: generate `state` + PKCE, stash the verifier, return what the
  // "browser" needs to authorize. (Your BFF builds the authorize URL from these.)
  startLogin: () => {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('hex');
    verifiers.set(state, verifier);
    return { state, codeChallenge: s256(verifier) };
  },

  // Handle the IDP callback: validate `state` (CSRF), recover the verifier, and
  // exchange the `code` at the token endpoint. Return ok:false WITHOUT creating a
  // session on any failure.
  handleCallback: async (ctx, { code, state }) => {
    const verifier = verifiers.get(state);
    if (!verifier) return { ok: false, status: 400, error: 'state_mismatch' };

    const res = await fetch(`${ctx.issuer}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        ...(ctx.clientSecret ? { client_secret: ctx.clientSecret } : {}),
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, status: res.status, error: err.error };
    }
    const t = (await res.json()) as { access_token: string; refresh_token: string };
    return { ok: true, value: { accessToken: t.access_token, refreshToken: t.refresh_token } };
  },

  // OPTIONAL — rotate the session's tokens.
  refresh: async (ctx, session) => {
    const res = await fetch(`${ctx.issuer}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: (session as { refreshToken: string }).refreshToken,
        client_id: ctx.clientId,
        ...(ctx.clientSecret ? { client_secret: ctx.clientSecret } : {}),
      }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const t = (await res.json()) as { access_token: string; refresh_token: string };
    return { ok: true, value: { accessToken: t.access_token, refreshToken: t.refresh_token } };
  },

  // OPTIONAL — RP-Initiated Logout; report the redirect the IDP resolved.
  logout: async (ctx) => {
    const res = await fetch(
      `${ctx.issuer}/auth/logout?${new URLSearchParams({
        client_id: ctx.clientId,
        post_logout_redirect_uri: ctx.postLogoutRedirectUri,
      })}`,
      { redirect: 'manual' },
    );
    return { ok: true, value: { redirectTo: res.headers.get('location') ?? undefined } };
  },

  // OPTIONAL — expose the access token so the kit also verifies it (RS256 + sub).
  getAccessToken: (session) => (session as { accessToken?: string }).accessToken,
});
