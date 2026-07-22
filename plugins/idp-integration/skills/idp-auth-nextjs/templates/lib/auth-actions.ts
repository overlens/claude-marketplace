/**
 * Server Actions for the Overlens IDP OAuth flow: redirect to login, redirect to signup, logout.
 *
 * Place at `lib/auth-actions.ts`. Each is invoked from a `<form action={...}>` button. Server
 * Actions are POSTs, which is what lets them set cookies and call redirect() — a plain <a href>
 * (GET) cannot set the PKCE cookies, so the flow would silently break.
 *
 * Login and signup are identical except for the Accounts path (/login vs /signup). The callback
 * and token exchange are 100% shared — you do NOT write a second callback for signup.
 */
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '@/lib/pkce';

const ACCOUNTS_URL = process.env.ACCOUNTS_URL!;
const IDP_BASE_URL = process.env.IDP_BASE_URL ?? 'https://idp.overlens.com.br';
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_REDIRECT_URI = process.env.IDP_REDIRECT_URI!;
// Must EXACT-MATCH a post_logout_redirect_uri registered for this client with the IDP.
const POST_LOGOUT_REDIRECT_URI = process.env.POST_LOGOUT_REDIRECT_URI!;

// Temp cookies live only for the redirect round-trip. Path-scoped to the callback so they don't
// leak to other routes; httpOnly so XSS can't read the verifier. maxAge is in SECONDS in the
// Next.js cookie API (600 = 10 min) — note this differs from raw Express, which uses ms.
const TEMP_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/api/auth/callback',
  maxAge: 600,
};

async function startFlow(mode: 'login' | 'signup'): Promise<never> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const store = await cookies();
  store.set('pkce_code_verifier', codeVerifier, TEMP_COOKIE_OPTS);
  store.set('oauth_state', state, TEMP_COOKIE_OPTS);

  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    redirect_uri: IDP_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    // openid scope yields an id_token alongside the access_token. The access_token already
    // carries the same claims, so drop this if you don't specifically need an id_token.
    scope: 'openid profile email',
  });

  // Redirect the BROWSER to Accounts (front-channel) — never to idp.overlens.com.br directly.
  redirect(`${ACCOUNTS_URL}/${mode}?${params.toString()}`);
}

export async function redirectToLogin(): Promise<never> {
  return startFlow('login');
}

export async function redirectToSignup(): Promise<never> {
  return startFlow('signup');
}

/**
 * Logout (OIDC RP-Initiated Logout): clear YOUR session cookies, then navigate the browser to the
 * IDP's end_session_endpoint (GET https://idp.overlens.com.br/auth/logout). The IDP nulls the
 * server-side refresh code, clears its SSO cookies on .overlens.com.br, and 302-redirects to your
 * post_logout_redirect_uri (with `state` echoed back). This ends the IDP SSO session, so the next
 * login prompts for credentials instead of silently SSOing the user back in.
 *
 * This MUST be a top-level navigation (redirect), never a fetch/XHR — only a navigation carries the
 * IDP's first-party cookies and lets the browser honor the Set-Cookie clears. A Server Action
 * redirect() is exactly that.
 *
 * `post_logout_redirect_uri` must EXACT-MATCH a URI registered for this client with the IDP
 * (admin POST/PATCH /admin/clients). If absent or unregistered, the IDP redirects to its own
 * fallback page instead of back to you.
 *
 * No per-token revocation: an already-issued access token stays valid until it expires (<=15 min)
 * — accepted tradeoff. For immediate hard revocation (compromised device), an admin must call
 * POST /admin/users/:id/block.
 */
export async function logout(): Promise<never> {
  const store = await cookies();
  store.delete('session_token');
  store.delete('session_refresh');

  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,
    state: crypto.randomUUID(), // echoed back on the redirect
  });
  redirect(`${IDP_BASE_URL}/auth/logout?${params.toString()}`);
}
