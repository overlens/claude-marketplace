# Registration request — templates (JSON + pt-BR message)

Phase 2 produces two artifacts: the exact `POST /admin/clients` JSON (appliable by the Overlens
team **without any edit**) and a short pt-BR covering message. Canonical validation rules live in
the `idp-register-oauth-client` skill — validate the JSON against them before presenting it.

## Validation checklist (run mentally before presenting any JSON)

- `clientId` matches `^[a-z][a-z0-9-]{2,49}$` (3–50 chars, starts with a lowercase letter)
- `displayName` 1–100 chars
- `redirectUris`: ≤ 20, unique; HTTPS for public URLs; `http://localhost:<port>` allowed;
  **exact match — no trailing slash**; deep links (`app://…`) only when `isPublic: true`
- `postLogoutRedirectUris`: same URI rules as `redirectUris`
- `allowedGrantTypes`: non-empty subset of `authorization_code | refresh_token | client_credentials`, no duplicates
- `allowedScopes`: ≤ 50, each matching `^[a-z][a-z0-9:_-]*$`
- Forbidden combinations (the API rejects with `400`):
  - `client_credentials` with `isPublic: true`
  - `client_credentials` with non-empty `redirectUris`
  - `authorization_code` with empty `redirectUris`
  - `isPublic: true` with any expectation of a `client_secret` (public = no secret, PKCE mandatory)

## Message template (pt-BR — the Overlens team is Brazilian)

```
Assunto: Registro de OAuth client — <Nome do Sistema>

Olá, time Overlens!

Gostaríamos de integrar o sistema "<Nome do Sistema>" (<URL de produção>) ao
login da Overlens. Segue o payload de registro pronto para aplicar via
POST /admin/clients (ou pela UI admin), sem necessidade de edição:

<JSON anexado/colado abaixo>

Quando registrado, por favor nos enviem o client_id e o client_secret por um
canal seguro (o secret aparece uma única vez na criação).

Contato para retorno: <nome> — <email/telefone>

Obrigado(a)!
<assinatura>
```

Notes for the agent:
- Fill every `<placeholder>` from interview answers before presenting; never send with gaps.
- For **public** clients (mobile/SPA), adapt the secret sentence: "Este client é público (PKCE),
  então não há client_secret — basta confirmar o client_id registrado."
- Remind the user (not the team) that the secret goes straight into a secret manager/env var.

---

## Example A — Confidential web BFF (site with its own server)

Persona: "Loja da Marina", a Next.js site at `https://lojadamarina.com.br`, dev on `localhost:3000`,
users log in and can sign up.

```json
{
  "clientId": "loja-da-marina",
  "displayName": "Loja da Marina",
  "isPublic": false,
  "redirectUris": [
    "https://lojadamarina.com.br/api/auth/callback",
    "http://localhost:3000/api/auth/callback"
  ],
  "postLogoutRedirectUris": [
    "https://lojadamarina.com.br/",
    "http://localhost:3000/"
  ],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true
}
```

```
Assunto: Registro de OAuth client — Loja da Marina

Olá, time Overlens!

Gostaríamos de integrar o sistema "Loja da Marina" (https://lojadamarina.com.br)
ao login da Overlens. Segue o payload de registro pronto para aplicar via
POST /admin/clients, sem necessidade de edição:

{ ...JSON acima... }

Quando registrado, por favor nos enviem o client_id e o client_secret por um
canal seguro (o secret aparece uma única vez na criação).

Contato para retorno: Marina Souza — marina@lojadamarina.com.br

Obrigada!
Marina
```

## Example B — Public client (mobile app, no server-side secret)

Persona: "Trilhas App", an Expo app, deep link `com.trilhas.app://callback`, Expo dev server on
`localhost:8081`.

```json
{
  "clientId": "trilhas-app",
  "displayName": "Trilhas App",
  "isPublic": true,
  "redirectUris": [
    "com.trilhas.app://callback",
    "http://localhost:8081/callback"
  ],
  "postLogoutRedirectUris": [
    "com.trilhas.app://logged-out"
  ],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true
}
```

```
Assunto: Registro de OAuth client (público/PKCE) — Trilhas App

Olá, time Overlens!

Gostaríamos de integrar o aplicativo "Trilhas App" (app mobile, Expo) ao login
da Overlens. Segue o payload de registro pronto para aplicar via
POST /admin/clients, sem necessidade de edição:

{ ...JSON acima... }

Este client é público (PKCE), então não há client_secret — basta confirmar
quando o client_id estiver registrado.

Contato para retorno: Pedro Lima — pedro@trilhas.app

Obrigado!
Pedro
```

## Example C — M2M service (no user involved)

Persona: "Relatórios Bot", a nightly worker that reads data from another Overlens-protected API.
No browser, no user, no redirects.

```json
{
  "clientId": "relatorios-bot",
  "displayName": "Relatórios Bot",
  "isPublic": false,
  "redirectUris": [],
  "allowedGrantTypes": ["client_credentials"],
  "allowedScopes": ["relatorios:read"],
  "allowSignup": false
}
```

```
Assunto: Registro de OAuth client (M2M) — Relatórios Bot

Olá, time Overlens!

Precisamos registrar o serviço "Relatórios Bot" (worker noturno, sem usuário)
para autenticação serviço-a-serviço. Segue o payload pronto para aplicar via
POST /admin/clients, sem necessidade de edição:

{ ...JSON acima... }

Quando registrado, por favor nos enviem o client_id e o client_secret por um
canal seguro (o secret aparece uma única vez na criação). O secret será
armazenado no secret manager do serviço.

Contato para retorno: Carla Reis — carla@empresa.com.br

Obrigada!
Carla
```

---

## While the team processes the request

Development never waits: point the integration at the sandbox
(`https://idp-test.overlens.com.br`) with the matching fixture client —
`test-web-bff` / `dev-secret-test-web-bff` (confidential), `test-public-pkce` (public),
`test-m2m-service` / `dev-secret-test-m2m-service` (M2M) — and the test user
`ana.active@example.test`. Swap to the real credentials only at the production flip (Phase 3).
