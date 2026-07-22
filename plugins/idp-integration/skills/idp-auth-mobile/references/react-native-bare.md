# React Native (bare workflow)

Two viable paths. Choose based on how much you want to hand-roll.

## Path A — reuse the Expo modules (recommended)

The Expo modules work in bare RN via `expo` as a dependency. This gives you the same `templates/expo/auth.ts` with no native glue:

```bash
npx install-expo-modules@latest
npm install expo-web-browser expo-crypto expo-secure-store
```

Then follow `references/expo.md` and copy `templates/expo/auth.ts`. The only bare-specific step is registering the URL scheme in the native projects (see below) instead of `app.json`.

## Path B — react-native-app-auth (AppAuth, RFC 8252)

`react-native-app-auth` wraps the native AppAuth SDKs and handles PKCE, the system browser, and the deep link for you. The catch with Overlens: the **authorization endpoint is the Accounts SPA**, not a classic IDP `/authorize`. Configure it explicitly via `serviceConfiguration` (skip discovery):

```ts
import { authorize, refresh } from 'react-native-app-auth';

const config = {
  issuer: 'https://idp.overlens.com.br',
  clientId: 'overlens-mobile',
  redirectUrl: 'overlens://callback',
  scopes: ['openid', 'profile', 'email'],
  usePKCE: true,                 // S256 by default
  serviceConfiguration: {
    authorizationEndpoint: 'https://accounts.overlens.com.br/login',
    tokenEndpoint: 'https://idp.overlens.com.br/auth/token',
  },
  // No clientSecret — public client.
};

const result = await authorize(config);   // opens system browser, returns tokens
// result.accessToken, result.refreshToken, result.idToken
```

> **Test this early.** AppAuth expects the authorization endpoint to perform a standard 302 redirect to the deep link. Accounts is a SPA that achieves the same end result (`window.location` to `overlens://callback?code&state`), which AppAuth normally handles — but if you hit a "redirect not handled" error, fall back to Path A, where you control the browser open and deep-link capture explicitly. Path A always works because it mirrors the documented flow byte-for-byte.

Refresh:

```ts
const refreshed = await refresh(config, { refreshToken: result.refreshToken });
// store refreshed.refreshToken — the IDP rotates it
```

## Native URL scheme registration (both paths)

**iOS** — `ios/<App>/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>overlens</string></array>
  </dict>
</array>
```

**Android** — `android/app/src/main/AndroidManifest.xml`, inside your main `<activity>`:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="overlens" android:host="callback" />
</intent-filter>
```

After editing native files, rebuild (`npx react-native run-ios` / `run-android`) — JS-only reloads won't pick up scheme changes.

## Secure storage in bare RN

If you took Path A, use `expo-secure-store`. Otherwise use `react-native-keychain` (`setGenericPassword` / `getGenericPassword`) — it's Keychain on iOS and Keystore-backed on Android. **Never** `AsyncStorage` for the refresh token.

The endpoint contracts (no `client_secret`, `client_id` in body, refresh rotation, logout via the `GET /auth/logout` end_session_endpoint, no per-token revocation) are identical to the rest of this skill — see SKILL.md "Critical contracts".

Before logout works, the `post_logout_redirect_uri` (your deep link, e.g. `overlens://logged-out`) must be registered on the client by an admin in `postLogoutRedirectUris` — see `references/client-registration.md`.
