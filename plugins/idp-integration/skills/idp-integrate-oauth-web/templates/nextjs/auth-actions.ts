/**
 * Server Actions for initiating OAuth login/signup against the Overlens IDP.
 *
 * Place this at `lib/auth-actions.ts` (or wherever your project keeps server-only utilities).
 * The Server Action is invoked by a `<form action={redirectToLogin}>` button in a client/server
 * component. It generates PKCE + state, sets two temporary cookies scoped to the callback path,
 * and redirects the browser to `accounts.overlens.com.br`.
 *
 * Why cookies (not session/redis):
 *   - Cookies survive the redirect chain naturally — no out-of-band storage needed.
 *   - Path-scoped to /api/auth/callback so they don't leak to other endpoints.
 *   - httpOnly so JavaScript can't read them (XSS resilience).
 *
 * Concurrent flows: if the user opens two tabs and starts two flows, each gets its own
 * cookie value (the second overwrites the first). That's acceptable for the common case;
 * if you need true concurrent flow support, switch to short-lived server-side session storage
 * keyed by an opaque flow_id.
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
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_REDIRECT_URI = process.env.IDP_REDIRECT_URI!;

const TEMP_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/api/auth/callback',
  maxAge: 600, // 10 minutes — plenty for a login flow, short enough to limit blast radius
};

async function startFlow(mode: 'login' | 'signup'): Promise<never> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const cookieStore = await cookies();
  cookieStore.set('pkce_code_verifier', codeVerifier, TEMP_COOKIE_OPTS);
  cookieStore.set('oauth_state', state, TEMP_COOKIE_OPTS);

  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    redirect_uri: IDP_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    // Request openid scope to get an id_token in addition to access_token. Drop if you
    // only need the access token (it carries the same claims anyway).
    scope: 'openid profile email',
  });

  redirect(`${ACCOUNTS_URL}/${mode}?${params.toString()}`);
}

export async function redirectToLogin(): Promise<never> {
  return startFlow('login');
}

export async function redirectToSignup(): Promise<never> {
  return startFlow('signup');
}
