# Expo (managed workflow)

Expo is the most common path. Use three Expo modules — no native code, works in Expo Go for dev and in dev/production builds:

```bash
npx expo install expo-web-browser expo-crypto expo-secure-store
```

- `expo-web-browser` → opens the system auth browser (`ASWebAuthenticationSession` on iOS, Custom Tabs on Android) and returns the deep link. **Do not** use a `WebView`.
- `expo-crypto` → SHA-256 + secure random bytes for PKCE (React Native has no `node:crypto`).
- `expo-secure-store` → Keychain (iOS) / encrypted store (Android) for tokens.

The complete, copy-paste implementation is in `templates/expo/auth.ts`. Copy it, set `CLIENT_ID` and `SCHEME`, and wire the three exported functions (`login`, `logout`, `getAccessToken`) to your UI. The notes below explain the parts that trip people up.

## 1. Register the URL scheme

In `app.json` / `app.config.ts`:

```json
{ "expo": { "scheme": "overlens" } }
```

This makes `overlens://...` route back into your app. Your `redirect_uri` is then `overlens://callback` (scheme + a path you choose). The path is arbitrary but must match the IDP registration byte-for-byte.

> If you build a standalone app, the scheme is baked into the native project at prebuild. After changing `scheme`, run `npx expo prebuild --clean` (bare) or rebuild the dev client.

## 2. Build the redirect URI

Let Expo construct it so it's correct in Expo Go (`exp://...`) and in standalone builds (`overlens://...`):

```ts
import * as Linking from 'expo-linking';
const redirectUri = Linking.createURL('callback'); // 'overlens://callback' in a build
```

**Caveat:** in Expo Go this yields an `exp://` URL, which the IDP won't have registered. For real auth testing use a **dev client** or a standalone build, where it resolves to your `overlens://callback`. Register that exact value in the IDP.

## 3. PKCE with expo-crypto

`code_verifier` = 32 random bytes, base64url. `code_challenge` = base64url(SHA-256(verifier)). The template implements both. The one subtlety: `Crypto.digestStringAsync` returns base64 — convert to **base64url** (`+`→`-`, `/`→`_`, strip `=`) or the challenge won't match server-side.

## 4. Open the session and capture the deep link

```ts
import * as WebBrowser from 'expo-web-browser';
const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
if (result.type === 'success') {
  const url = result.url; // overlens://callback?code=...&state=...
}
```

`openAuthSessionAsync` blocks until the browser redirects to `redirectUri`, then hands you the URL. Parse `code` and `state` from it. If `result.type` is `cancel` / `dismiss`, the user backed out — don't treat that as an error.

## 5. Persisting the verifier across backgrounding

When the auth browser opens, the OS may suspend your JS. The template writes `code_verifier` and `state` to `expo-secure-store` **before** opening the browser and reads them back when the deep link returns, so they survive a cold restart. Don't keep them only in React state.

## 6. Token exchange — no secret

```ts
await fetch(`${IDP_BASE_URL}/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code, code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
  }).toString(),
});
```

No `Authorization` header. `client_id` in the body. See the template for the full version with error handling.

## 7. Storage and refresh

Store both tokens with `SecureStore.setItemAsync`. On a `401` from your API, call the refresh function (`grant_type=refresh_token` + `client_id`), and **overwrite** the stored refresh token with the rotated one. The template's `getAccessToken()` refreshes lazily when the access token is near expiry.

The template's `logout()` deletes both tokens and opens the IDP `end_session_endpoint` (`GET /auth/logout`) via `WebBrowser.openAuthSessionAsync` to clear the IDP SSO cookies. For that to work, the `post_logout_redirect_uri` (your deep link, e.g. `overlens://logged-out`) must be registered on the client by an admin in `postLogoutRedirectUris` — see `references/client-registration.md`.

## Testing checklist

- [ ] Tested in a **dev client or standalone build**, not Expo Go (deep link scheme)
- [ ] `overlens://callback` reopens the app (not a browser error)
- [ ] Cancelling the browser is handled gracefully
- [ ] Tokens land in SecureStore (verify they're absent from any AsyncStorage)
- [ ] Refresh rotates and overwrites
- [ ] `new_user: true` routes to onboarding
