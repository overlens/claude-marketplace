/**
 * auth-api.ts — the SPA's only door to the BFF.
 *
 * Two responsibilities:
 *  1. `startLogin` / `startSignup` — FULL NAVIGATIONS to the BFF. These cannot be
 *     fetch() calls: the BFF responds with a 302 to accounts.overlens.com.br, an
 *     interactive login page the user must see. Only a top-level navigation can do that.
 *  2. `apiFetch` — wraps fetch with `credentials: 'include'` (so the BFF session cookie
 *     rides along) and a 401 → silent-refresh → retry-once interceptor.
 *
 * BFF base URL:
 *  - Dev with the Vite proxy (recommended): VITE_BFF_URL='' → relative paths, same-origin.
 *  - Sibling subdomains / different origin: VITE_BFF_URL='https://api.example.com' and
 *    the BFF must send CORS (exact origin + credentials). See references/cross-origin-cookies.md.
 */

const BFF = import.meta.env.VITE_BFF_URL ?? ''; // '' under the dev proxy

/** Navigate the browser to the BFF login route. NOT a fetch — this leaves the SPA. */
export function startLogin(): void {
  window.location.href = `${BFF}/auth/login`;
}

/** Navigate the browser to the BFF signup route. */
export function startSignup(): void {
  window.location.href = `${BFF}/auth/signup`;
}

/**
 * Logout is a NAVIGATION, not a fetch. The BFF clears its own session cookies, then 302-redirects
 * the browser to the IDP end_session_endpoint (GET /auth/logout) to end the SSO session. A fetch
 * would not carry the IDP's first-party cookies nor honor its Set-Cookie clears, so the SSO session
 * would survive — hence a top-level navigation. The IDP redirects back to the registered
 * post_logout_redirect_uri afterwards.
 */
export function logout(): void {
  window.location.href = `${BFF}/auth/logout`;
}

let refreshInFlight: Promise<boolean> | null = null;

/** Ask the BFF to rotate the session via the IDP refresh grant. Deduped so a burst
 *  of 401s triggers a single refresh. Returns true if the session is now valid. */
async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${BFF}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * Fetch a BFF/API endpoint with the session cookie attached. On 401, transparently
 * refresh once and retry; if refresh fails the caller gets the original 401 and
 * should route the user to login.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${BFF}${path}`;
  const res = await fetch(url, { ...init, credentials: 'include' });
  if (res.status !== 401) return res;

  const refreshed = await refreshSession();
  if (!refreshed) return res; // still 401 — caller decides (usually redirect to login)

  return fetch(url, { ...init, credentials: 'include' });
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

/** Ask the BFF who the current user is. Resolves to null when not authenticated. */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const res = await apiFetch('/auth/me');
  if (!res.ok) return null;
  return (await res.json()) as CurrentUser;
}
