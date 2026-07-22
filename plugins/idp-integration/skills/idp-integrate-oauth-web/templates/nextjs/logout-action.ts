/**
 * Server Action for logout (OIDC RP-Initiated Logout).
 *
 * Wire it to a `<form action={logout}>` Sair button. The action:
 *   1. Clears YOUR session cookies (session_token, session_refresh on your domain).
 *   2. Sends the browser, via a top-level navigation, to the IDP's OIDC end_session_endpoint
 *      (GET https://idp.overlens.com.br/auth/logout). The IDP nulls the server-side refresh code,
 *      clears its SSO cookies on .overlens.com.br, and 302-redirects to your
 *      post_logout_redirect_uri (with `state` echoed back).
 *
 * Why a redirect and not a fetch: this MUST be a top-level browser navigation. A fetch/XHR would
 * not carry the IDP's first-party cookies, and the browser would not honor the Set-Cookie clears.
 * A Server Action redirect() produces exactly that navigation.
 *
 * Registration requirement: `post_logout_redirect_uri` must EXACT-MATCH a URI registered in this
 * client's allowlist (admin POST/PATCH /admin/clients). If absent or unregistered, the IDP falls
 * back to its own logout page instead of redirecting to you.
 *
 * Scope of what logout does:
 *   - It ends the IDP SSO session and invalidates the refresh code, so the next /auth/authorize
 *     prompts for credentials and no silent refresh succeeds.
 *   - It does NOT revoke already-issued access tokens. There is no per-token revocation (no RFC
 *     7009 /revoke). An in-flight access token stays valid until it expires (<=15 min) — accepted
 *     tradeoff. For immediate hard revocation (compromised device), an IDP admin must call
 *     POST /admin/users/:id/block.
 */
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const IDP_BASE_URL = process.env.IDP_BASE_URL ?? 'https://idp.overlens.com.br';
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
// Must EXACT-MATCH a post_logout_redirect_uri registered for this client with the IDP.
const POST_LOGOUT_REDIRECT_URI = process.env.POST_LOGOUT_REDIRECT_URI!;

export async function logout(): Promise<never> {
  const cookieStore = await cookies();

  // 1. Drop your own session cookies first.
  cookieStore.delete('session_token');
  cookieStore.delete('session_refresh');

  // 2. Navigate the browser to the IDP end_session_endpoint to end the SSO session.
  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,
    state: crypto.randomUUID(), // echoed back on the redirect; verify it if you store it
  });
  redirect(`${IDP_BASE_URL}/auth/logout?${params.toString()}`);
}
