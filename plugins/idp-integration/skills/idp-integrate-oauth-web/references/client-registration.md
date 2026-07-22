# OAuth client registration — web BFF (stub)

A web BFF is a **confidential** client: `isPublic: false`, `allowedGrantTypes: ["authorization_code", "refresh_token"]`, `allowedScopes: ["openid", "profile", "email"]`. Register **every** callback in `redirectUris` (production + `http://localhost:<port>/api/auth/callback` for dev) — exact byte match, no wildcards, no trailing-slash normalization — and your post-logout URLs in `postLogoutRedirectUris` (required for `GET /auth/logout` to redirect back; also editable later via `PATCH /admin/clients/:id`). The `client_secret` is returned **once** by `POST /admin/clients`; store it in a secret manager and wire `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URI` (byte-identical to a registered URI).

Full guide — payloads, validation rules, admin API, lifecycle, and the non-admin "registration request" mode: use the `idp-register-oauth-client` skill. Canonical: `../../../references/docs/integration/oauth-clients.md` §6-A.
