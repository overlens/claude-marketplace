# Registering the M2M client (stub)

An M2M client is **confidential** and locked to one grant: `isPublic: false`, `allowedGrantTypes: ["client_credentials"]`, `redirectUris: []` (non-empty is rejected at registration), `allowSignup: false`, and an **exhaustive** `allowedScopes` list — the token request can only narrow it, never widen it. Registration is admin-only (`POST /admin/clients`, user JWT with `role=ADMIN`; M2M tokens are rejected). The `client_secret` is returned **once** in the creation response — capture it straight into a secret manager, then set `IDP_BASE_URL`, `IDP_M2M_CLIENT_ID`, `IDP_M2M_CLIENT_SECRET`, `IDP_M2M_SCOPES` on the calling service.

Full guide — payloads, validation rules, admin API, lifecycle, and the non-admin "registration request" mode: use the `idp-register-oauth-client` skill. Canonical: `../../../references/docs/integration/oauth-clients.md` §6-C.
