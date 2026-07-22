/**
 * Route Handler for the OAuth callback.
 *
 * Place this at `app/api/auth/callback/route.ts`. The path must match `IDP_REDIRECT_URI`
 * exactly — the IDP does byte-equality on the registered redirect URI.
 *
 * Sequence:
 *   1. Read `code` and `state` from the URL.
 *   2. Read the temporary cookies set by `redirectToLogin` (pkce_code_verifier, oauth_state).
 *   3. Validate `state` — if it doesn't match, abort.
 *   4. POST /auth/token to the IDP with HTTP Basic Auth (client_id:client_secret).
 *   5. Decode the JWT payload (no verification needed here — the IDP signed it for us
 *      and we'll re-verify on the resource server side; here we only need claims for
 *      branching).
 *   6. Set our own session cookies (NOT on .overlens.com.br — on our own domain).
 *   7. Clean up temp cookies.
 *   8. Redirect to /onboarding or /dashboard based on `new_user` claim.
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

interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  email_verified: boolean;
  new_user?: true;
  iss: string;
  aud: string[];
  iat: number;
  exp: number;
}

function decodeJwtPayload(jwt: string): JwtPayload {
  const [, payloadB64] = jwt.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');

  if (!code || !state) {
    redirect('/login?error=missing_params');
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get('oauth_state')?.value;
  const codeVerifier = cookieStore.get('pkce_code_verifier')?.value;

  // CSRF protection: state must round-trip exactly.
  if (!savedState || savedState !== state) {
    redirect('/login?error=invalid_state');
  }
  if (!codeVerifier) {
    redirect('/login?error=missing_verifier');
  }

  // Token exchange — back-channel, never exposed to the browser.
  let tokenData: TokenResponse;
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

    if (!res.ok) {
      // The IDP returns structured error objects — log them for ops, but don't echo to the user.
      const errorBody = await res.text();
      console.error('IDP token exchange failed', { status: res.status, body: errorBody });
      redirect('/login?error=token_exchange_failed');
    }

    tokenData = (await res.json()) as TokenResponse;
  } catch (err) {
    console.error('IDP token exchange threw', err);
    redirect('/login?error=token_exchange_failed');
  }

  const payload = decodeJwtPayload(tokenData.access_token);

  // Session cookies live on YOUR domain, not on .overlens.com.br.
  // httpOnly so XSS can't steal them; SameSite=lax is the default for same-site auth.
  cookieStore.set('session_token', tokenData.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: tokenData.expires_in, // 900s = 15 min
  });
  cookieStore.set('session_refresh', tokenData.refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth', // limit refresh token to the refresh endpoint
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  // Cleanup — these are useless after callback completes.
  cookieStore.delete('pkce_code_verifier');
  cookieStore.delete('oauth_state');

  // Branch: first-ever login goes to onboarding, returning users to dashboard.
  if (payload.new_user) {
    redirect('/onboarding/profile');
  }
  redirect('/dashboard');
}
