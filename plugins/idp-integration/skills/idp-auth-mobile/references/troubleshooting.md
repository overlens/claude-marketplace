# Troubleshooting — symptom → cause → fix

Mobile-specific failure modes. For broader auth errors (CORS, rate limit, feature flags) see the `idp-troubleshoot-auth-errors` skill.

| Symptom | Likely cause | Fix |
|---|---|---|
| Auth browser opens but tapping "Entrar" / finishing login does nothing; app never returns | Deep link scheme not registered in the OS, or `callbackURLScheme` doesn't match | Verify the scheme in Expo `scheme` / iOS `CFBundleURLSchemes` / Android `<intent-filter>`. Rebuild — JS reload won't apply native scheme changes. Test on a dev client/standalone build, not Expo Go. |
| `400 invalid_request` / `invalid_redirect_uri` on `/auth/authorize` | `redirect_uri` not byte-identical to the registered value | Compare char-by-char: `overlens://callback` vs `overlens://callback/` vs `overlens://Callback`. The IDP does exact match. Fix the registration (`references/client-registration.md`) or your code. |
| `400 invalid_grant` on `/auth/token` | `code` expired (>5 min), already used, OR `code_verifier` doesn't hash to the `code_challenge` sent | Restart the flow (don't retry the same code). Confirm you send the **same** verifier you generated; ensure it survived app backgrounding (persist it before opening the browser). Confirm you convert the SHA-256 digest to **base64url**, not plain base64. |
| `401 invalid_client` on `/auth/token` | Client not found, or you sent a `client_secret`/Basic header for a public client | Remove any `Authorization` header. Put `client_id` in the body. Confirm the client is registered `isPublic: true`. |
| `400 unauthorized_client` on refresh | `refresh_token` not in the client's `allowedGrantTypes` | Ask an admin to add `"refresh_token"` to `allowedGrantTypes`. |
| Login works once, next refresh returns `401` | Re-sent the old (rotated, now-dead) refresh token | The IDP rotates on every refresh. Always overwrite stored refresh token with the new one from the response; never retry with the previous value. |
| User has to log in every single time (no SSO across visits) | Using an embedded `WebView`, or `prefersEphemeralWebBrowserSession = true` | Use the system auth browser (`ASWebAuthenticationSession` / Custom Tabs / `expo-web-browser`). Set ephemeral to `false` so the system cookie jar persists the IDP session. |
| Google sign-in shows `disallowed_useragent` | Login UI rendered inside a `WebView` | Google blocks OAuth in embedded webviews. Use the system browser. |
| `state` mismatch error in your own code | `state` not persisted across backgrounding, or two flows started in parallel | Persist `state` (and `code_verifier`) to secure storage before opening the browser; read it back on the deep link. |
| Tokens readable in a device backup / on a rooted device | Stored in `AsyncStorage` / plain `SharedPreferences` / `UserDefaults` | Move to SecureStore / Keychain / EncryptedSharedPreferences. Use device-only accessibility (`...ThisDeviceOnly`). |
| Logout "doesn't work" — IDP still has an SSO session, next login is silent | Only cleared local tokens; never ended the IDP SSO session | After clearing local tokens, open the IDP `end_session_endpoint` (`GET /auth/logout`) in the system browser session. That nulls the server-side refresh code and clears the IDP SSO cookies. An in-flight access token still expires naturally (≤15 min — no per-token revocation); for hard revocation an admin blocks the user (`POST /admin/users/:id/block`). |
| `grant_type=revoke` → `400 unsupported_grant_type` | Tried to log out by POSTing to `/auth/token` — that grant type doesn't exist (no RFC 7009) | Don't call it. Logout is the `GET /auth/logout` end_session_endpoint navigation — see SKILL.md "Logout". |

## Quick self-check before filing a ticket

1. Decode the access token (paste the middle segment into a base64url decoder) — does `iss` say `https://idp.overlens.com.br`? Is `sub` present?
2. Did you send `client_id` in the token body and **no** `Authorization` header?
3. Is `redirect_uri` identical in all three places (authorize URL, token body, IDP registration)?
4. Is your verifier→challenge base64**url** (not base64)?
5. Are you testing on a build where the custom scheme actually routes back (not Expo Go)?
