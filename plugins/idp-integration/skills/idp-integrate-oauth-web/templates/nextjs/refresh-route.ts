/**
 * Silent refresh endpoint. Place at `app/api/auth/refresh/route.ts`.
 *
 * Called by the frontend interceptor when the access_token expired and the user is mid-action.
 * The frontend POSTs to /api/auth/refresh (your domain), this handler exchanges the refresh
 * token with the IDP and rotates both cookies.
 *
 * Critical detail — refresh token rotation:
 *   The IDP invalidates the old refresh_token the moment this exchange succeeds. The response
 *   contains a NEW refresh_token. We MUST write the new one to the cookie, or the next refresh
 *   will fail with 401 invalid_grant. If you keep the old value by mistake, the user gets
 *   logged out at the next refresh attempt — even though they did nothing wrong.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const IDP_BASE_URL = process.env.IDP_BASE_URL!;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_CLIENT_SECRET = process.env.IDP_CLIENT_SECRET!;

export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('session_refresh')?.value;

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
    // Refresh failed — could be: token already used (race), user blocked, refresh expired.
    // Whatever the cause, the session is done. Clear local cookies so the user re-logs.
    cookieStore.delete('session_token');
    cookieStore.delete('session_refresh');
    return NextResponse.json({ error: 'refresh_failed' }, { status: 401 });
  }

  const data: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  } = await res.json();

  cookieStore.set('session_token', data.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: data.expires_in,
  });
  // CRITICAL: write the new refresh token, not the old one.
  cookieStore.set('session_refresh', data.refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 30 * 24 * 60 * 60,
  });

  return NextResponse.json({ ok: true });
}
