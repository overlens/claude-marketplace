/**
 * Route protection middleware. Place at `middleware.ts` in the project root (next to app/).
 *
 * Middleware runs on the EDGE runtime, so it must NOT import node:crypto, run a token exchange,
 * or verify a JWT signature (those need the Node runtime and the JWKS fetch). Its only job here
 * is a cheap gate: is there a session_token cookie? If not, bounce to /login. Real signature
 * verification happens in your Resource Server / API — see the `idp-validate-token` skill.
 *
 * We deliberately do NOT decode the JWT to check expiry here. An expired-but-present token still
 * lets the request through to the page; the page's data fetch then 401s and the client-side
 * interceptor silently refreshes. Gating on presence alone keeps middleware fast and avoids
 * fighting the refresh flow. If you want a stricter gate, decode the exp claim with a pure-JS
 * base64 decode (no node:crypto) — but presence is enough for most apps.
 */
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get('session_token')?.value);

  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    // Preserve where the user was headed so you can send them back after login if you choose to
    // read this on the login page. (Optional — drop if you always land on /dashboard.)
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

// Protect these route trees. Adjust to your app. The matcher excludes Next.js internals, the auth
// API routes (they must stay reachable while logged out), and the login/signup pages themselves.
export const config = {
  matcher: ['/dashboard/:path*', '/onboarding/:path*'],
};
