# Native Android (Kotlin)

Two routes: **AppAuth-Android** (handles PKCE + Custom Tabs + the callback for you — recommended) or hand-rolled Custom Tabs + a deep-link activity. Either way, use **Chrome Custom Tabs**, never a `WebView` (no shared session; Google blocks its sign-in in webviews).

## 1. Register the deep link

`AndroidManifest.xml`, inside the activity that should receive the callback (with AppAuth this is its `RedirectUriReceiverActivity`, declared by the library; for the hand-rolled route, your own activity):

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="overlens" android:host="callback" />
</intent-filter>
```

With AppAuth you can instead set the scheme via manifest placeholder:

```gradle
android { defaultConfig { manifestPlaceholders["appAuthRedirectScheme"] = "overlens" } }
```

## 2. AppAuth route (recommended)

```kotlin
// build.gradle: implementation("net.openid:appauth:0.11.1")

val config = AuthorizationServiceConfiguration(
    Uri.parse("https://accounts.overlens.com.br/login"),   // authorization endpoint (the SPA)
    Uri.parse("https://idp.overlens.com.br/auth/token")    // token endpoint
)

val request = AuthorizationRequest.Builder(
    config,
    "overlens-mobile",                       // client_id
    ResponseTypeValues.CODE,
    Uri.parse("overlens://callback")
).setScopes("openid", "profile", "email")
 .build()                                    // AppAuth generates PKCE (S256) + state automatically

val authService = AuthorizationService(context)
startActivityForResult(authService.getAuthorizationRequestIntent(request), RC_AUTH)
```

In `onActivityResult`, perform the token exchange — AppAuth attaches the `code_verifier` automatically and sends **no** client secret for a public client:

```kotlin
val resp = AuthorizationResponse.fromIntent(data!!)
authService.performTokenRequest(resp!!.createTokenExchangeRequest()) { tokenResp, ex ->
    val accessToken = tokenResp?.accessToken
    val refreshToken = tokenResp?.refreshToken      // store in EncryptedSharedPreferences
}
```

> As with React Native, AppAuth expects the authorization endpoint to 302-redirect to the deep link. Accounts does this via `window.location`. If you hit a "redirect mismatch", drop to the hand-rolled route below, which mirrors the documented flow exactly.

## 3. Hand-rolled PKCE (if not using AppAuth)

```kotlin
import java.security.MessageDigest
import android.util.Base64
import java.security.SecureRandom

fun b64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

val verifier = b64url(ByteArray(32).also { SecureRandom().nextBytes(it) })
val challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
val state = b64url(ByteArray(32).also { SecureRandom().nextBytes(it) })
```

Build `https://accounts.overlens.com.br/login?client_id=...&redirect_uri=overlens://callback&code_challenge=$challenge&code_challenge_method=S256&state=$state&scope=openid` and open it with `CustomTabsIntent`. Your deep-link activity receives `overlens://callback?code&state`; validate `state`, then POST to `/auth/token`:

```kotlin
// form body, application/x-www-form-urlencoded — no Authorization header
"grant_type=authorization_code&code=$code&code_verifier=$verifier" +
    "&client_id=overlens-mobile&redirect_uri=overlens://callback"
```

## 4. Secure storage

Use `EncryptedSharedPreferences` (androidx.security:security-crypto) or the Android Keystore. Never plain `SharedPreferences` for the refresh token.

## 5. Refresh & logout

Refresh: `grant_type=refresh_token` + `refresh_token` + `client_id`. The IDP rotates — overwrite the stored value. Logout: clear the encrypted store, then open the IDP `end_session_endpoint` (`https://idp.overlens.com.br/auth/logout?client_id=...&post_logout_redirect_uri=<your_deep_link>&state=...`) in a Chrome Custom Tab. The `post_logout_redirect_uri` (your deep link, e.g. `overlens://logged-out`) must first be registered on the client by an admin in `postLogoutRedirectUris` — see `references/client-registration.md`. This ends the IDP SSO session and nulls the server-side refresh code. There is no per-token revocation, so an in-flight access token still expires naturally (≤15 min); admin block is the hard path. See SKILL.md.
