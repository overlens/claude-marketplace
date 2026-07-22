/**
 * PKCE (Proof Key for Code Exchange) utilities for the OAuth 2.1 Authorization Code flow.
 *
 * The Overlens IDP requires `code_challenge_method=S256` on every /auth/authorize call.
 * Workflow:
 *   1. Generate a random `code_verifier` (~43-128 chars).
 *   2. Hash it with SHA-256 and base64url-encode to get the `code_challenge`.
 *   3. Send `code_challenge` in the redirect to Accounts; keep `code_verifier` in a
 *      server-side cookie scoped to the callback path.
 *   4. On callback, read `code_verifier` from the cookie and send it in POST /auth/token.
 *
 * Why server-side: the verifier is the proof that the same client started the flow that
 * ends it. Keep it httpOnly so JS can't read it (XSS doesn't get it) and scope its Path to
 * `/api/auth/callback` so it doesn't leak to other endpoints.
 */
import { createHash, randomBytes } from 'node:crypto';

export function generateCodeVerifier(): string {
  // 32 bytes → 43-char base64url string. RFC 7636 requires 43-128 chars.
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Random opaque string for OAuth `state` parameter (CSRF protection on the OAuth flow).
 * Store this in a cookie too, and compare it byte-for-byte with the value returned in the
 * callback URL before exchanging the code.
 */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}
