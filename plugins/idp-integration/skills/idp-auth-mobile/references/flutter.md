# Flutter

Two routes: **flutter_appauth** (wraps native AppAuth, handles PKCE + system browser + callback) or **flutter_web_auth_2** (you control the browser open and capture the deep link). Store tokens with **flutter_secure_storage** (Keychain / Keystore-backed) either way.

```yaml
# pubspec.yaml
dependencies:
  flutter_appauth: ^7.0.0        # or flutter_web_auth_2: ^3.0.0
  flutter_secure_storage: ^9.0.0
  crypto: ^3.0.0                  # only needed for the manual route
```

## Scheme registration

- **iOS** — `ios/Runner/Info.plist`: add `CFBundleURLTypes` with scheme `overlens` (see `references/ios.md`).
- **Android** — `android/app/src/main/AndroidManifest.xml`: add the `<intent-filter>` with `android:scheme="overlens"` (see `references/android.md`). For flutter_appauth, set the `appAuthRedirectScheme` manifest placeholder in `android/app/build.gradle`.

## Route A — flutter_appauth (recommended)

```dart
final appAuth = const FlutterAppAuth();

final result = await appAuth.authorizeAndExchangeCode(
  AuthorizationTokenRequest(
    'overlens-mobile',                         // clientId
    'overlens://callback',                     // redirectUrl
    serviceConfiguration: const AuthorizationServiceConfiguration(
      authorizationEndpoint: 'https://accounts.overlens.com.br/login',
      tokenEndpoint: 'https://idp.overlens.com.br/auth/token',
    ),
    scopes: ['openid', 'profile', 'email'],
    // No clientSecret — public client. PKCE S256 is generated automatically.
  ),
);
// result.accessToken, result.refreshToken — store in flutter_secure_storage
```

Refresh:

```dart
final refreshed = await appAuth.token(TokenRequest(
  'overlens-mobile', 'overlens://callback',
  serviceConfiguration: const AuthorizationServiceConfiguration(
    authorizationEndpoint: 'https://accounts.overlens.com.br/login',
    tokenEndpoint: 'https://idp.overlens.com.br/auth/token',
  ),
  refreshToken: storedRefreshToken,
  grantType: 'refresh_token',
));
// store refreshed.refreshToken — the IDP rotates it
```

> flutter_appauth expects the authorization endpoint to 302-redirect to the deep link; Accounts does this. If you hit a redirect error, use Route B.

## Route B — flutter_web_auth_2 (manual, mirrors the docs exactly)

```dart
import 'dart:convert';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

String b64url(List<int> b) => base64Url.encode(b).replaceAll('=', '');
final rng = Random.secure();
final verifier = b64url(List<int>.generate(32, (_) => rng.nextInt(256)));
final challenge = b64url(sha256.convert(utf8.encode(verifier)).bytes);
final state = b64url(List<int>.generate(32, (_) => rng.nextInt(256)));

final authUrl = Uri.https('accounts.overlens.com.br', '/login', {
  'client_id': 'overlens-mobile',
  'redirect_uri': 'overlens://callback',
  'code_challenge': challenge,
  'code_challenge_method': 'S256',
  'state': state,
  'scope': 'openid',
});

final resultUrl = await FlutterWebAuth2.authenticate(
  url: authUrl.toString(),
  callbackUrlScheme: 'overlens',
);
final returned = Uri.parse(resultUrl);
final code = returned.queryParameters['code'];
if (returned.queryParameters['state'] != state) throw 'state mismatch';

final tokenResp = await http.post(
  Uri.parse('https://idp.overlens.com.br/auth/token'),
  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
  body: {
    'grant_type': 'authorization_code',
    'code': code,
    'code_verifier': verifier,
    'client_id': 'overlens-mobile',
    'redirect_uri': 'overlens://callback',
  },                                            // no Authorization header
);
```

## Storage, refresh, logout

`flutter_secure_storage` for both tokens. On refresh, overwrite the rotated refresh token. Logout = delete both keys, then open the IDP `end_session_endpoint` (`https://idp.overlens.com.br/auth/logout?client_id=...&post_logout_redirect_uri=<your_deep_link>&state=...`) via `flutter_web_auth_2` (same browser session as login) to end the IDP SSO session and null the server-side refresh code. The `post_logout_redirect_uri` (your deep link, e.g. `overlens://logged-out`) must be registered on the client by an admin in `postLogoutRedirectUris` first — see `references/client-registration.md`. There is no per-token revocation, so an in-flight access token still expires naturally (≤15 min); admin block is the hard path. See SKILL.md.
