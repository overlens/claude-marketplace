/**
 * OAuth callback Route Handler. Place at `app/api/auth/callback/route.ts`.
 *
 * The URL of this handler MUST equal `IDP_REDIRECT_URI` byte-for-byte — the IDP does string
 * equality on the registered redirect URI (no normalization, no trailing-slash tolerance).
 *
 * This same handler serves BOTH login and signup. The only difference between the two flows is
 * the Accounts path the user was sent to; the callback and token exchange are identical. A fresh
 * signup yields a JWT with `new_user: true`, which we use to branch to onboarding.
 *
 * Sequence: read code+state → validate state against cookie → POST /auth/token (back-channel,
 * Basic auth) → decode JWT for the new_user branch → set session cookies on YOUR domain →
 * clean up temp cookies → redirect.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';

const IDP_BASE_URL = process.env.IDP_BASE_URL!;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_CLIENT_SECRET = process.env.IDP_CLIENT_SECRET!;
const IDP_REDIRECT_URI = process.env.IDP_REDIRECT_URI!;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  id_token?: string;
}

function readNewUser(jwt: string): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return payload.new_user === true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  if (!code || !state) redirect('/login?error=missing_params');

  const store = await cookies();
  const savedState = store.get('oauth_state')?.value;
  const codeVerifier = store.get('pkce_code_verifier')?.value;

  // CSRF protection for the OAuth flow itself: state must round-trip exactly.
  if (!savedState || savedState !== state) redirect('/login?error=invalid_state');
  if (!codeVerifier) redirect('/login?error=missing_verifier');

  // Back-channel token exchange. client_secret stays on the server. The try only wraps the fetch
  // — redirect() throws a control-flow signal, so it must stay OUTSIDE any catch that swallows.
  let tokens: TokenResponse | null = null;
  try {
    const basic = Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: IDP_REDIRECT_URI,
      }),
    });
    if (res.ok) {
      tokens = (await res.json()) as TokenResponse;
    } else {
      console.error('IDP token exchange failed', { status: res.status, body: await res.text() });
    }
  } catch (err) {
    console.error('IDP token exchange threw', err);
  }

  if (!tokens) redirect('/login?error=token_exchange_failed');

  const isNewUser = readNewUser(tokens.access_token);

  // Session cookies on YOUR domain — never on .overlens.com.br. maxAge is in SECONDS here.
  store.set('session_token', tokens.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: tokens.expires_in, // 900s = 15 min
  });
  store.set('session_refresh', tokens.refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth', // so both /api/auth/callback and /api/auth/refresh can read it
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  store.delete('pkce_code_verifier');
  store.delete('oauth_state');

  redirect(isNewUser ? '/onboarding/profile' : '/dashboard');
}
