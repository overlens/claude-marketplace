/**
 * Silent refresh Route Handler. Place at `app/api/auth/refresh/route.ts`.
 *
 * Called by the client-side 401 interceptor (see lib/api-client.ts in the skill) when the
 * access_token expired mid-action. Exchanges the refresh_token with the IDP and rotates both
 * cookies.
 *
 * CRITICAL — refresh token rotation: the IDP invalidates the old refresh_token the instant this
 * exchange succeeds and returns a NEW one. You MUST write the new value to the cookie. If you
 * accidentally keep the old one, the next refresh fails with 401 and the user is logged out
 * despite doing nothing wrong.
 *
 * On any failure (expired/used token, blocked user), clear cookies and return 401 so the
 * interceptor redirects to login.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const IDP_BASE_URL = process.env.IDP_BASE_URL!;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_CLIENT_SECRET = process.env.IDP_CLIENT_SECRET!;

export async function POST() {
  const store = await cookies();
  const refreshToken = store.get('session_refresh')?.value;

  if (!refreshToken) {
    return NextResponse.json({ error: 'no_refresh_token' }, { status: 401 });
  }

  const basic = Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    store.delete('session_token');
    store.delete('session_refresh');
    return NextResponse.json({ error: 'refresh_failed' }, { status: 401 });
  }

  const data: { access_token: string; refresh_token: string; expires_in: number } =
    await res.json();

  store.set('session_token', data.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: data.expires_in,
  });
  // Write the NEW refresh token, not the old one.
  store.set('session_refresh', data.refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 30 * 24 * 60 * 60,
  });

  return NextResponse.json({ ok: true });
}
