---
name: idp-auth-mobile
description: >
  Hands-on, implementation-focused guide for integrating the Overlens IDP into a mobile app or a
  backend-less SPA — a "public client" that runs OAuth 2.1 Authorization Code + PKCE entirely on
  the device, with NO `client_secret`. Use this skill whenever a developer is wiring up
  login/signup/logout against the Overlens IDP from React Native, Expo, native iOS (Swift),
  native Android (Kotlin), Flutter, or any client that cannot safely hold a secret. Triggers on
  phrases like "Overlens login in React Native", "Expo auth Overlens", "deep link callback
  Overlens", "overlens:// custom URL scheme", "ASWebAuthenticationSession Overlens", "Chrome
  Custom Tab Overlens login", "PKCE-only mobile Overlens", "store Overlens tokens in Keychain",
  "exchange code on device Overlens", or when the repository contains `app.json`/`app.config.{js,ts}`
  (Expo), `Info.plist`, `AndroidManifest.xml`, `pubspec.yaml` (Flutter), or a `package.json` with
  `react-native`/`expo` alongside a request to integrate auth. Provides copy-paste templates for
  PKCE generation, opening the system auth browser, capturing the deep link, the secret-less token
  exchange, refresh rotation, secure token storage, and logout — per platform. If the project has
  a server-side backend that CAN hold a `client_secret` (Next.js BFF, NestJS, Rails, Django,
  Express), prefer `idp-integrate-oauth-web` instead — that is a confidential client and the flow
  differs. If the project is a Resource Server only validating JWTs (not initiating login), prefer
  `idp-validate-token`. For a service-to-service flow with no user, prefer `idp-integrate-m2m`. For
  a conceptual overview without code, `idp-auth-guide` is the companion.
---

# Overlens IDP — Mobile / Public Client Integration (PKCE-only)

> **Prove it's correct:** once login works, scaffold the **client/BFF conformance** suite with the `idp-test-integration` skill — drop-in tests that drive callback → refresh → logout against an in-process mock IDP (run with `config: { clientId: 'test-public-pkce', clientSecret: null }` for the secret-less PKCE flow).

This skill walks a developer through wiring **OAuth 2.1 Authorization Code + PKCE** between a mobile app (or backend-less SPA) and the Overlens IDP, where the whole flow runs **on the device** and there is **no `client_secret`**.

The IDP lives at `idp.overlens.com.br` (JSON API). A separate frontend at `accounts.overlens.com.br` provides the login/signup UI. Your app opens the system browser there, captures the callback via a deep link, and exchanges the `code` for tokens **directly from the device**.

> **Conceptual companion:** `idp-auth-guide` covers the model and the why. This skill covers the how, with copy-paste templates per platform.

---

## Are you in the right skill?

A public client is defined by one fact: **it cannot keep a secret.** Anything shipped to a user's device — an `.ipa`, an `.apk`, a JS bundle — can be unpacked, so a `client_secret` embedded there is not a secret. The IDP registers these clients with `isPublic: true` and **issues no secret at all**. Security comes entirely from PKCE.

Run this check before writing code:

1. **Does a server you control sit between the user and the IDP, able to hold `IDP_CLIENT_SECRET`?**
   - **No** (React Native, Expo, native iOS/Android, Flutter, static SPA) → you're a public client. This is the right skill.
   - **Yes** (Next.js BFF, NestJS, Rails, Django, Express) → stop. Use `idp-integrate-oauth-web`. A confidential client runs the token exchange on the server with Basic auth; mixing the two flows is the most common integration mistake.
2. **Are you only *validating* incoming JWTs (an API), not *initiating* login?** → use `idp-validate-token`.
3. **Is there no human in the loop (worker, cron)?** → use `idp-integrate-m2m`.

If you're unsure, the deciding question is literally "can I store a secret where a user can't reach it?" On a device, the answer is no.

---

## The flow (what's different from a web BFF)

```
[Mobile App]                                  [System Browser]        [Accounts SPA]          [IDP API]
   │                                                 │                      │                     │
   │ 1. generate code_verifier + code_challenge(S256), random state         │                     │
   │ 2. open ASWebAuthenticationSession / Custom Tab ──────────────────────►│                     │
   │    accounts.overlens.com.br/login?client_id=overlens-mobile            │                     │
   │      &redirect_uri=overlens://callback&code_challenge&state&scope=openid                      │
   │                                                 │  user authenticates  │                     │
   │                                                 │   POST /auth/authorize ───────────────────►│
   │                                                 │◄── { code, state } ─────────────────────────│
   │ 3. browser redirects to deep link ◄─────────────│                      │                     │
   │    overlens://callback?code=...&state=...       │                      │                     │
   │ 4. app intercepts deep link, validates state                                                  │
   │ 5. POST /auth/token  (FROM THE DEVICE, no Basic auth, no client_secret) ─────────────────────►│
   │    grant_type=authorization_code&code&code_verifier&client_id&redirect_uri                    │
   │◄── { access_token, refresh_token, token_type:"Bearer", expires_in:900 } ──────────────────────│
   │ 6. store tokens in Keychain / EncryptedSharedPreferences (NEVER plaintext)                    │
```

Three differences from the web BFF flow you should hold in your head:

- **No `client_secret`, no `Authorization: Basic`.** The token request carries `client_id` in the body instead. The IDP knows the client is public and authenticates the request via the PKCE proof (the `code_verifier` must hash to the `code_challenge` sent earlier).
- **The redirect is a deep link, not an https URL.** `overlens://callback` (or `com.yourco.app://callback`). It must be registered both in the IDP client (`redirectUris`) and in the OS (URL scheme).
- **Tokens land on the device.** There is no server session to hide behind — you are responsible for storing them in OS-backed secure storage and never in plaintext.

---

## Implementation checklist

Treat this as your todo list. Each item is small and verifiable.

- [ ] Confirm the OAuth client is registered with `isPublic: true` and your deep link in `redirectUris` — see `references/client-registration.md`
- [ ] Register the custom URL scheme in the OS (Expo `scheme`, iOS `Info.plist`, Android intent-filter)
- [ ] Read the platform reference: `references/expo.md`, `references/react-native-bare.md`, `references/ios.md`, `references/android.md`, or `references/flutter.md`
- [ ] Copy the platform template and adjust `client_id`, scheme, and storage keys
- [ ] Implement: generate PKCE + state → open system auth session → capture deep link
- [ ] Validate `state` returned matches what you sent (CSRF protection of the flow)
- [ ] Exchange `code` at `POST /auth/token` from the device — body params, **no** Basic header
- [ ] Store `access_token` and `refresh_token` in secure storage (Keychain / EncryptedSharedPreferences / Keystore)
- [ ] Implement silent refresh (`grant_type=refresh_token`), and **overwrite** the stored refresh token every time
- [ ] Handle `new_user: true` in the decoded JWT → route to onboarding instead of home
- [ ] Implement logout: clear secure storage, then open the IDP `end_session_endpoint` (`GET /auth/logout`) in the system browser to end the SSO session (see below)
- [ ] Test on a real device or simulator: the deep link must reopen *your* app, not a browser tab

---

## Critical contracts (memorize these)

### 1. The authorize URL (front-channel — opened in the system browser)

```
https://accounts.overlens.com.br/login
  ?client_id=overlens-mobile
  &redirect_uri=overlens://callback
  &code_challenge=<base64url(sha256(code_verifier))>
  &code_challenge_method=S256
  &state=<random>
  &scope=openid                       # optional; request openid to get an id_token
```

For signup, swap `/login` → `/signup`. Same params. The Accounts SPA forwards these to the IDP when the user submits.

### 2. Token exchange (FROM the device — note what's absent)

```http
POST https://idp.overlens.com.br/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code from deep link>
&code_verifier=<the original verifier you generated in step 1>
&client_id=overlens-mobile
&redirect_uri=overlens://callback        # byte-identical to what you sent in the authorize URL
```

No `Authorization: Basic`. No `client_secret`. The `client_id` goes in the body. The IDP recomputes `sha256(code_verifier)` and rejects the exchange if it doesn't equal the `code_challenge` it stored — that PKCE proof is what authenticates a public client.

**Response 200:**
```json
{ "access_token": "<JWT, 15 min>", "refresh_token": "<opaque, 30 days>", "token_type": "Bearer", "expires_in": 900 }
```

### 3. Silent refresh — same shape, rotated token

```http
POST https://idp.overlens.com.br/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<current refresh_token>
&client_id=overlens-mobile
```

The IDP **rotates the refresh token on every call** — the old one dies immediately. Always persist the new value over the old. A retry that re-sends the previous (now-dead) token will get `401` and lock the user out.

### 4. Logout — local tokens + OIDC RP-Initiated Logout

There is no per-token revocation endpoint (no RFC 7009; `grant_type=revoke` returns `400 unsupported_grant_type`). For a mobile client, logout has two parts:

1. **Delete both tokens from secure storage.** Once they're gone from the device, the session is over for this app.
2. **Open the IDP `end_session_endpoint` in the system browser** to end the IDP SSO session: `GET https://idp.overlens.com.br/auth/logout?client_id=<your_client_id>&post_logout_redirect_uri=<your_app_deep_link>&state=<random>`. The IDP nulls the server-side refresh code (so the stored refresh token is now dead too), clears its SSO cookies, and redirects back to your registered `post_logout_redirect_uri` (use your `overlens://`-style deep link, registered as a `post_logout_redirect_uri` for the client). Open it in the same `ASWebAuthenticationSession` / Custom Tab you use for login so it shares the cookie jar — a background `fetch` won't clear the browser session.

Note: any **already-issued access token** stays valid until it expires (≤15 min) — accepted tradeoff. For hard revocation (lost/stolen device), an admin must block the user via `POST /admin/users/:id/block`; tell the user this is the escalation path.

---

## Platform selection

Pick the variant that matches your project. Each reference has the same shape: scheme setup → PKCE → open auth session → capture deep link → token exchange → secure storage → refresh → logout.

| Project | Read | Primary libs |
|---|---|---|
| **Expo (managed)** | `references/expo.md`, copy `templates/expo/auth.ts` | `expo-web-browser`, `expo-crypto`, `expo-secure-store` |
| **React Native (bare)** | `references/react-native-bare.md` | `react-native-app-auth` **or** `expo-modules` |
| **Native iOS (Swift)** | `references/ios.md` | `ASWebAuthenticationSession`, Keychain |
| **Native Android (Kotlin)** | `references/android.md` | Custom Tabs / AppAuth, `EncryptedSharedPreferences` |
| **Flutter** | `references/flutter.md` | `flutter_appauth` **or** `flutter_web_auth_2` + `flutter_secure_storage` |

Read only the file for your platform — they're independent.

---

## Common pitfalls — read before debugging

These are the failure modes that actually show up in mobile OAuth, in rough order of how often they bite.

1. **Using an embedded WebView instead of the system auth browser.** Don't render `accounts.overlens.com.br` inside a `WebView`. Use `ASWebAuthenticationSession` (iOS) / Chrome Custom Tabs (Android) / `expo-web-browser`. Embedded webviews can't share the system cookie jar (so the user re-logs every time), are a phishing vector, and Google blocks its sign-in inside them outright (`disallowed_useragent`). This is the single biggest mobile-auth mistake.
2. **The deep link doesn't reopen your app.** If `overlens://callback` opens nothing, or opens a browser error page, the URL scheme isn't registered in the OS. Check Expo `scheme`, iOS `CFBundleURLSchemes`, Android `<intent-filter>`. The IDP registration alone is not enough — the OS has to route the scheme back to your app.
3. **`redirect_uri` mismatch.** The value in the authorize URL, the value in the token exchange, and the value registered in the IDP must be **byte-identical**. `overlens://callback` ≠ `overlens://callback/` ≠ `overlens://Callback`. The IDP does exact string match, not URL normalization.
4. **Sending a `client_secret` or `Authorization: Basic`.** You don't have a secret. If a tutorial tells you to add one, it's describing the confidential flow — wrong skill. Public clients authenticate via PKCE only.
5. **Losing the `code_verifier` when the app backgrounds.** Opening the auth browser may suspend your app. If the verifier lived only in a component's memory, it can be gone when the deep link wakes you. Persist it (secure storage or a module-level ref the OS won't reclaim) until the exchange completes, then delete it.
6. **Storing the refresh token in `AsyncStorage` / `localStorage` in plaintext.** That's readable on a rooted/jailbroken device or via a backup. Refresh tokens are 30-day credentials — they belong in Keychain / EncryptedSharedPreferences / Keystore.
7. **Not validating `state`.** Compare the `state` from the deep link against the one you generated before opening the browser. Skipping this reopens a CSRF hole in the flow itself.
8. **Re-sending a used refresh token.** Rotation means the previous token is dead the instant the new one is issued. Overwrite immediately; never retry with the old value.
9. **`code` reuse / expiry.** The authorization `code` is single-use and short-lived (~5 min). If the exchange fails, restart the flow from the authorize URL — don't retry the same `code`.
10. **Confusing the two hosts.** `accounts.overlens.com.br` is where you send the **browser** (front-channel). `idp.overlens.com.br` is where the **device** does the token exchange (back-channel). They are not interchangeable.

For symptom → cause → fix mapping, see `references/troubleshooting.md`.

---

## Where the canonical docs live

This skill is curation + templates. The source of truth for endpoints, schemas, and error codes is the IDP repo under `../../references/docs/integration/`:

- `../../references/docs/integration/frontend.md` §2 — public clients (PKCE-only) — the canonical source for this skill
- `../../references/docs/integration/oauth-clients.md` §3 + §6 case B — registering an `isPublic: true` client
- `../../references/docs/integration/login.md` — the overall flow (written for web, but the front-channel is identical)
- `../../references/docs/integration/logout.md` — RP-initiated logout via the `end_session_endpoint`

When in doubt, read those — they're maintained as the code changes; this skill snapshots the implementation patterns.

---

## File map of this skill

```
idp-auth-mobile/
├── SKILL.md                          (this file)
├── references/
│   ├── client-registration.md        (what to register in the IDP before integrating)
│   ├── expo.md                       (Expo managed workflow specifics)
│   ├── react-native-bare.md          (bare RN / react-native-app-auth)
│   ├── ios.md                        (native Swift + ASWebAuthenticationSession + Keychain)
│   ├── android.md                    (native Kotlin + Custom Tabs + EncryptedSharedPreferences)
│   ├── flutter.md                    (Flutter + flutter_appauth / flutter_web_auth_2)
│   └── troubleshooting.md            (symptom → cause → fix)
└── templates/
    └── expo/
        └── auth.ts                   (full PKCE + auth session + token exchange + refresh + logout + secure store)
```

Read platform files only as needed — they're independent.
