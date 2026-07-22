/**
 * Read the current user's session from the `session_token` cookie, for use in Server Components,
 * layouts, and Server Actions. Place at `lib/session.ts`.
 *
 * This decodes the JWT to read its claims — it does NOT verify the signature. That's the correct
 * trade-off here: you're reading a cookie YOU set on YOUR domain after a trusted back-channel
 * token exchange, purely to render the UI and branch on role. You are not authorizing an
 * incoming request from an untrusted caller. Signature verification (via JWKS) belongs in your
 * Resource Server / API — see the `idp-validate-token` skill for that side.
 *
 * Note: this only reads cookies, which is allowed in any server context. Setting/deleting cookies
 * is only allowed in Server Actions, Route Handlers, and middleware — never in a Server Component
 * render. So `getSession()` is safe to call from a page or layout; `logout()` is not.
 */
import { cookies } from 'next/headers';

export interface Session {
  sub: string; // user id (CUID2) — same id as the platform DB and the JWT `sub`
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  emailVerified?: boolean;
  exp: number; // unix seconds
}

interface RawJwtPayload {
  sub: string;
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  email_verified?: boolean;
  exp: number;
}

function decodePayload(jwt: string): RawJwtPayload | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Returns the session, or null if there is no token, the token is malformed, or it has expired.
 * Expired tokens return null so callers treat them as logged-out and trigger silent refresh.
 */
export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get('session_token')?.value;
  if (!token) return null;

  const payload = decodePayload(token);
  if (!payload) return null;

  if (payload.exp * 1000 <= Date.now()) return null;

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    role: payload.role,
    emailVerified: payload.email_verified,
    exp: payload.exp,
  };
}
