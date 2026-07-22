/**
 * PKCE (Proof Key for Code Exchange) utilities for the OAuth 2.1 Authorization Code flow.
 *
 * The Overlens IDP requires `code_challenge_method=S256` on every authorize call. The flow:
 *   1. Generate a random `code_verifier`.
 *   2. SHA-256 it and base64url-encode → `code_challenge` (sent in the redirect to Accounts).
 *   3. Keep `code_verifier` in an httpOnly cookie scoped to the callback path.
 *   4. On callback, read the verifier from the cookie and send it in POST /auth/token.
 *
 * These functions use `node:crypto`, so they run in the Node runtime (Server Actions and Route
 * Handlers) — NOT in middleware (Edge runtime). Middleware never needs PKCE; it only checks
 * cookie presence.
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
 * Random opaque string for the OAuth `state` parameter (CSRF protection on the flow itself).
 * Store it in a cookie and compare byte-for-byte with the value returned in the callback URL
 * before exchanging the code.
 */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}
