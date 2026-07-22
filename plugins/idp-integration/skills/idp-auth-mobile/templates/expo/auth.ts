/**
 * Overlens IDP — Expo public-client auth (PKCE-only, no client_secret).
 *
 * Requires:  npx expo install expo-web-browser expo-crypto expo-secure-store expo-linking
 *
 * Exposes three functions for your UI:
 *   - login(mode?)      → runs the full OAuth flow, stores tokens, returns the decoded JWT payload
 *   - getAccessToken()  → returns a valid access token, refreshing lazily if near expiry
 *   - logout()          → clears stored tokens + ends the IDP SSO session via the end_session_endpoint
 *
 * Set CLIENT_ID and the deep-link scheme (app.json `scheme`) before use. Everything here runs
 * on the device; there is no client_secret anywhere — security is PKCE S256.
 */

import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';

// ── Config ─────────────────────────────────────────────────────────────────
const ACCOUNTS_URL = 'https://accounts.overlens.com.br';
const IDP_BASE_URL = 'https://idp.overlens.com.br';
const CLIENT_ID = 'overlens-mobile';
const SCOPE = 'openid profile email';

// Built so it resolves to your custom scheme (e.g. overlens://callback) in a build.
// Register this exact value in the IDP client's redirectUris.
const REDIRECT_URI = Linking.createURL('callback');

// SecureStore keys
const K_ACCESS = 'overlens.access_token';
const K_REFRESH = 'overlens.refresh_token';
const K_EXPIRES_AT = 'overlens.expires_at'; // epoch ms
const K_VERIFIER = 'overlens.pkce_verifier'; // transient (deleted after exchange)
const K_STATE = 'overlens.oauth_state'; // transient

// ── Types ────────────────────────────────────────────────────────────────────
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  new_user?: true;
  exp: number;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is available in the RN/Hermes runtime; if not, polyfill or use Buffer.
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(Crypto.getRandomBytes(32));
  // SHA-256 over the ASCII bytes of the verifier, then base64url.
  const digestB64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  const challenge = digestB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

function randomState(): string {
  return toBase64Url(Crypto.getRandomBytes(32));
}

function decodeJwt(accessToken: string): JwtPayload {
  const [, payload] = accessToken.split('.');
  const json = decodeURIComponent(
    atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  );
  return JSON.parse(json);
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function storeTokens(t: TokenResponse): Promise<void> {
  const expiresAt = Date.now() + t.expires_in * 1000;
  await SecureStore.setItemAsync(K_ACCESS, t.access_token);
  await SecureStore.setItemAsync(K_REFRESH, t.refresh_token); // always overwrite (rotation)
  await SecureStore.setItemAsync(K_EXPIRES_AT, String(expiresAt));
}

// ── Public: login ──────────────────────────────────────────────────────────────
/**
 * Runs the full flow: PKCE → system auth browser → deep link → token exchange → store.
 * Pass 'signup' to land the user on the signup screen instead of login.
 * Returns the decoded JWT (check `.new_user` to route to onboarding), or null if cancelled.
 */
export async function login(mode: 'login' | 'signup' = 'login'): Promise<JwtPayload | null> {
  const { verifier, challenge } = await generatePkce();
  const state = randomState();

  // Persist transient values BEFORE opening the browser — the OS may suspend us.
  await SecureStore.setItemAsync(K_VERIFIER, verifier);
  await SecureStore.setItemAsync(K_STATE, state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: SCOPE,
  });
  const authUrl = `${ACCOUNTS_URL}/${mode}?${params.toString()}`;

  const result = await WebBrowser.openAuthSessionAsync(authUrl, REDIRECT_URI);

  if (result.type !== 'success') {
    // 'cancel' | 'dismiss' — user backed out. Not an error.
    await SecureStore.deleteItemAsync(K_VERIFIER);
    await SecureStore.deleteItemAsync(K_STATE);
    return null;
  }

  const url = new URL(result.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  const savedState = await SecureStore.getItemAsync(K_STATE);
  const savedVerifier = await SecureStore.getItemAsync(K_VERIFIER);
  await SecureStore.deleteItemAsync(K_STATE);
  await SecureStore.deleteItemAsync(K_VERIFIER);

  if (!code || !returnedState || returnedState !== savedState || !savedVerifier) {
    throw new Error('oauth_state_or_code_invalid');
  }

  const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: savedVerifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (!res.ok) throw new Error(`token_exchange_failed_${res.status}`);

  const tokens: TokenResponse = await res.json();
  await storeTokens(tokens);
  return decodeJwt(tokens.access_token);
}

// ── Public: getAccessToken (lazy refresh) ────────────────────────────────────────
/**
 * Returns a valid access token. Refreshes when within 60s of expiry.
 * Returns null if there is no session or the refresh failed (caller should send to login).
 */
export async function getAccessToken(): Promise<string | null> {
  const access = await SecureStore.getItemAsync(K_ACCESS);
  const expiresAt = Number((await SecureStore.getItemAsync(K_EXPIRES_AT)) ?? 0);

  if (access && Date.now() < expiresAt - 60_000) return access;

  // Expired or near-expiry → refresh.
  const refresh = await SecureStore.getItemAsync(K_REFRESH);
  if (!refresh) return null;

  const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!res.ok) {
    // Refresh expired / used / user blocked → session is over.
    await logout();
    return null;
  }

  const tokens: TokenResponse = await res.json();
  await storeTokens(tokens); // overwrites the rotated refresh token
  return tokens.access_token;
}

// ── Public: logout ────────────────────────────────────────────────────────────
/**
 * Logout = clear the local session, then OIDC RP-Initiated Logout to end the IDP SSO session.
 *
 * We open the IDP end_session_endpoint (GET /auth/logout) in the SAME WebBrowser auth session used
 * for login, so it shares the cookie jar and the IDP can clear its SSO cookies. The IDP also nulls
 * the server-side refresh code (killing the stored refresh token), then redirects back to our
 * registered post_logout_redirect_uri (the app deep link). A background fetch would NOT clear the
 * browser session — it must be the in-browser navigation.
 *
 * There is no per-token revocation (RFC 7009 not implemented): an already-issued access token stays
 * valid until it expires (<=15 min). For hard revocation (lost device), an admin must block the
 * user via POST /admin/users/:id/block.
 */
export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(K_ACCESS);
  await SecureStore.deleteItemAsync(K_REFRESH);
  await SecureStore.deleteItemAsync(K_EXPIRES_AT);

  // post_logout_redirect_uri must be registered for this client (admin POST/PATCH /admin/clients).
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    post_logout_redirect_uri: REDIRECT_URI,
    state: Crypto.randomUUID(),
  });
  const logoutUrl = `${IDP_BASE_URL}/auth/logout?${params.toString()}`;
  await WebBrowser.openAuthSessionAsync(logoutUrl, REDIRECT_URI);
}
