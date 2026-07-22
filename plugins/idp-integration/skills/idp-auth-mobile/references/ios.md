# Native iOS (Swift)

Use `ASWebAuthenticationSession` (the system auth browser) and the Keychain. Don't use `WKWebView` for the login UI — it can't share the system session and Google blocks sign-in inside it.

## 1. Register the URL scheme

`Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>overlens</string></array>
  </dict>
</array>
```

`ASWebAuthenticationSession` actually intercepts the callback by `callbackURLScheme` (below), so the app doesn't even need to be re-opened via the URL scheme during the flow — but register it anyway for cold-start deep links.

## 2. PKCE

```swift
import CryptoKit
import Foundation

func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

let verifierData = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
let codeVerifier = base64URL(verifierData)
let codeChallenge = base64URL(Data(SHA256.hash(data: Data(codeVerifier.utf8))))
let state = base64URL(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
```

## 3. Open the auth session

```swift
import AuthenticationServices

let clientId = "overlens-mobile"
let redirectUri = "overlens://callback"
var comps = URLComponents(string: "https://accounts.overlens.com.br/login")!
comps.queryItems = [
    .init(name: "client_id", value: clientId),
    .init(name: "redirect_uri", value: redirectUri),
    .init(name: "code_challenge", value: codeChallenge),
    .init(name: "code_challenge_method", value: "S256"),
    .init(name: "state", value: state),
    .init(name: "scope", value: "openid"),
]

let session = ASWebAuthenticationSession(
    url: comps.url!,
    callbackURLScheme: "overlens"        // scheme only, no "://callback"
) { callbackURL, error in
    guard let callbackURL,
          let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems,
          let code = items.first(where: { $0.name == "code" })?.value,
          let returnedState = items.first(where: { $0.name == "state" })?.value,
          returnedState == state                       // validate state
    else { return /* handle cancel/error */ }
    Task { try await exchangeCode(code, verifier: codeVerifier, redirectUri: redirectUri) }
}
session.presentationContextProvider = self   // ASWebAuthenticationPresentationContextProviding
session.prefersEphemeralWebBrowserSession = false   // true = no shared cookies (forces re-login)
session.start()
```

## 4. Token exchange — no secret

```swift
func exchangeCode(_ code: String, verifier: String, redirectUri: String) async throws {
    var req = URLRequest(url: URL(string: "https://idp.overlens.com.br/auth/token")!)
    req.httpMethod = "POST"
    req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    var body = URLComponents()
    body.queryItems = [
        .init(name: "grant_type", value: "authorization_code"),
        .init(name: "code", value: code),
        .init(name: "code_verifier", value: verifier),
        .init(name: "client_id", value: "overlens-mobile"),
        .init(name: "redirect_uri", value: redirectUri),
    ]
    req.httpBody = body.percentEncodedQuery?.data(using: .utf8)
    let (data, _) = try await URLSession.shared.data(for: req)
    // parse access_token, refresh_token, expires_in; store in Keychain
}
```

No `Authorization` header. `client_id` in the body.

## 5. Keychain storage

Store both tokens with `SecItemAdd` / `kSecClassGenericPassword`. Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so tokens aren't in iCloud backups. On refresh, delete and re-add (or `SecItemUpdate`) — always overwrite the rotated refresh token.

## 6. Refresh & logout

Refresh: same endpoint, `grant_type=refresh_token` + `refresh_token` + `client_id`. Store the new rotated token.

Before logout works, the `post_logout_redirect_uri` (your deep link, e.g. `overlens://logged-out`) must be registered on the client by an admin in `postLogoutRedirectUris` — see `references/client-registration.md`.

Logout: delete both Keychain items, then open the IDP `end_session_endpoint` — `https://idp.overlens.com.br/auth/logout?client_id=...&post_logout_redirect_uri=<your_deep_link>&state=...` — in an `ASWebAuthenticationSession` (same session type as login, so it shares the cookie jar). That ends the IDP SSO session and nulls the server-side refresh code. There is no per-token revocation, so an in-flight access token still expires naturally (≤15 min); admin block is the hard path. See SKILL.md.
