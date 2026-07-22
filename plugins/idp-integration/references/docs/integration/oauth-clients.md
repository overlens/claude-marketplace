# Guia — Gerenciar OAuth Clients

> **Última atualização:** 2026-07-18 (contrato 1.6.0)
>
> Todo sistema que autentica via IDP precisa de um **OAuth Client** registrado: web confidencial, mobile público, M2M, ou painel admin.

---

## 1. Caminhos de registro

| Caminho | Quando usar |
|---|---|
| **API admin (`POST /admin/clients`)** ← caminho primário | Qualquer registro/alteração em produção. Exige JWT de usuário com `role=ADMIN`. Tem audit log. |
| UI admin (`accounts.overlens.com.br/admin/clients`) | Mesmo que a API, mas via interface. Implementada em cima de `POST /admin/clients` etc. |
| Seed (`apps/idp/prisma/seed.ts`) | **Não semeia clients de produção.** Cria apenas o usuário root ADMIN (`ROOT_USER_EMAIL`/`ROOT_USER_PASSWORD`) e, somente com `IDP_TEST_MODE=true` (nunca em produção), os fixtures de teste (`test-web-bff`, `test-public-pkce`, `test-m2m-service`). Ver §8. |

> **Migration note:** versões anteriores deste guia mandavam editar `seed.ts` para registrar clients. Esse caminho **não existe mais** — o seed não semeia clients de produção. Todo registro/alteração é via API/UI admin, onde vivem audit log, soft-delete, disable/enable e as regras de validação.

---

## 2. Modelo de dados

```prisma
model OAuthClient {
  id                     String    @id @default(cuid())
  clientId               String    @unique
  clientSecretHash       String?            // bcrypt; null para clientes públicos
  redirectUris           String[]
  postLogoutRedirectUris String[]           // allowlist do end_session_endpoint (GET /auth/logout) — ver logout.md
  isPublic               Boolean   @default(false)
  displayName            String
  allowSignup            Boolean   @default(true)
  allowedScopes          String[]  @default([])
  allowedGrantTypes      String[]  @default(["authorization_code"])
  webhookUrl             String?            // Push de eventos de perfil (RFC-0004) — ver profile-events.md
  webhookSecret          String?            // segredo HMAC opcional (pré-filtro do webhook)
  webhookDisabledAt      DateTime?          // not null = webhook desativado pelo circuit-breaker
  disabledAt             DateTime?          // lifecycle: disabled (reversível via /enable)
  deletedAt              DateTime?          // lifecycle: soft-delete (não reversível pela API)
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
}

model OAuthClientAuditLog {
  oauthClientId    String
  clientIdSnapshot String       // preservado caso o client seja deletado
  actorUserId      String       // user.id do ADMIN que executou a ação
  action           String       // CREATE | UPDATE | DISABLE | ENABLE | SOFT_DELETE | SECRET_GENERATED
  before           Json?        // estado antes (null em CREATE)
  after            Json?        // estado depois (null em SOFT_DELETE)
  ip               String?
  userAgent        String?
  createdAt        DateTime  @default(now())
}
```

### Projeção pública (`OAuthClientPublic`)

Toda resposta da API admin (exceto a criação inicial) retorna esta forma — **nunca** inclui `clientSecretHash`:

```jsonc
{
  "id": "ckxxx...",
  "clientId": "hodos",
  "displayName": "Hodos",
  "isPublic": false,
  "redirectUris": ["https://hodos.com.br/api/auth/callback"],
  "postLogoutRedirectUris": ["https://hodos.com.br/logged-out"],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true,
  "hasSecret": true,                     // true se clientSecretHash != null
  "webhookUrl": null,                    // RFC-0004; o webhookSecret NUNCA é exposto...
  "hasWebhookSecret": false,             // ...apenas este booleano
  "webhookDisabledAt": null,             // not null = desativado pelo circuit-breaker
  "disabledAt": null,
  "deletedAt": null,
  "createdAt": "2026-05-20T10:00:00.000Z",
  "updatedAt": "2026-05-25T14:30:00.000Z"
}
```

---

## 3. Tipos de cliente

| Tipo | `isPublic` | `clientSecretHash` | Quando usar |
|---|---|---|---|
| **Web confidencial** | `false` | Não-null | Backend que faz token exchange (Next.js BFF, NestJS) |
| **Público (mobile/SPA-only)** | `true` | `null` | App nativo / SPA sem backend; segurança via PKCE S256 |
| **M2M** | `false` | Não-null | Serviço backend chamando outra API; só `client_credentials` |

### Restrições de combinação (validadas em `POST /admin/clients`)

- `isPublic=true` ⇒ `clientSecretHash=null` automático. PKCE obrigatório no token exchange.
- `allowedGrantTypes=['client_credentials']` ⇒ deve ser confidencial (`isPublic=false`) e `redirectUris=[]`.
- `client_credentials` num client público é rejeitado com `400 unauthorized_client`.
- `redirectUris` em produção (URL `https://`) devem ser HTTPS exato; `http://localhost:*` é permitido.

---

## 4. Endpoints — referência

Todos os endpoints sob `/admin/clients` exigem:
- Cookie `access_token` (ou Bearer `Authorization: Bearer <jwt>`)
- JWT de usuário com `role=ADMIN`
- Header `Cache-Control: private, no-store` é setado pelo IDP automaticamente

> M2M tokens são **rejeitados** pelo `AdminRoleGuard` — não há como administrar OAuth clients via M2M.

### `POST /admin/clients` — criar

```jsonc
// Request body
{
  "clientId": "hodos",
  "displayName": "Hodos",
  "isPublic": false,
  "redirectUris": ["https://hodos.com.br/api/auth/callback", "http://localhost:4000/api/auth/callback"],
  "postLogoutRedirectUris": ["https://hodos.com.br/logged-out"],  // opcional — allowlist do end-session (GET /auth/logout)
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true,
  "webhookUrl": "https://api.hodos.com.br/webhooks/idp",          // opcional — Push de eventos de perfil (RFC-0004)
  "webhookSecret": "um-segredo-forte"                              // opcional — pré-filtro HMAC do webhook
}
```

```jsonc
// Response 201
{
  "client": { /* OAuthClientPublic */ },
  "clientSecret": "abc123...",                                    // null para clients públicos
  "warning": "O client_secret não será exibido novamente. Copie-o agora."
}
```

⚠️ O `clientSecret` aparece **uma única vez** na resposta. Se for perdido, hoje a única saída é **deletar e recriar o client** (ou rotacionar via mecanismo de regeneração quando implementado).

### `GET /admin/clients` — listar

Query params:
- `status`: `active` (default) | `disabled` | `deleted` | `all`
- `type`: `confidential` | `public` | `m2m` | `all` (default)
- `search`: substring de `clientId` ou `displayName` (1-100 chars)
- `page`: ≥ 1 (default 1)
- `pageSize`: 1-100 (default depende do use case)

### `GET /admin/clients/:id` — detalhar
Retorna `OAuthClientPublic`. `404` se não existir.

### `PATCH /admin/clients/:id` — atualizar
Todos os campos opcionais. Campos não enviados ficam inalterados.

```jsonc
{
  "displayName": "Hodos (novo nome)",
  "redirectUris": ["https://hodos.com.br/api/auth/callback"],
  "postLogoutRedirectUris": ["https://hodos.com.br/logged-out"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowSignup": false,
  "isPublic": true,
  "confirmSecretDrop": true,   // OBRIGATÓRIO ao mudar isPublic false→true (limpa secret)
  "webhookUrl": "https://api.hodos.com.br/webhooks/idp",  // "" limpa; URL nova re-arma o circuit-breaker (webhookDisabledAt → null)
  "webhookSecret": "novo-segredo"                          // "" limpa
}
```

### `POST /admin/clients/:id/disable` — desabilitar
Marca `disabledAt=now()`. Tokens existentes seguem válidos até `exp`. Novas requisições `/auth/authorize` ou `/auth/token` para o client são rejeitadas.

### `POST /admin/clients/:id/enable` — reabilitar
Limpa `disabledAt`.

### `DELETE /admin/clients/:id` — soft-delete
Marca `deletedAt=now()`. Não é reversível via API (precisa de SQL direto no Neon). Tokens existentes seguem válidos até `exp`.

### `GET /admin/clients/:id/audit-log` — histórico
Lista todas as mutações com `actorUserId`, `before`, `after`, `ip`, `userAgent`, `createdAt`.

```jsonc
{
  "items": [
    {
      "id": "...",
      "clientIdSnapshot": "hodos",
      "actorUserId": "ckabc123...",
      "action": "UPDATE",
      "before": { /* OAuthClientPublic anterior */ },
      "after":  { /* OAuthClientPublic novo */ },
      "ip": "189.51.x.x",
      "userAgent": "Mozilla/5.0 ...",
      "createdAt": "2026-05-25T14:30:00.000Z"
    },
    ...
  ]
}
```

Ações registradas: `CREATE`, `UPDATE`, `DISABLE`, `ENABLE`, `SOFT_DELETE`, `SECRET_GENERATED`.

---

## 5. Validações (do DTO)

| Campo | Regra |
|---|---|
| `clientId` | regex `^[a-z][a-z0-9-]{2,49}$` (3-50 chars, começa com letra minúscula, hífen permitido) |
| `displayName` | string 1-100 chars |
| `redirectUris` | array até 20 itens, únicos; HTTPS em produção; `http://localhost:*` permitido; sem trailing slash normalization (exact match no fluxo OAuth) |
| `postLogoutRedirectUris` | opcional (default `[]`); array até 20 itens, únicos; **mesmas regras de URI das `redirectUris`** (HTTPS em produção, `http://localhost:*` permitido, deep link só para client público). Allowlist do end-session `GET /auth/logout` (exact-match) — ver [`logout.md`](./logout.md) §8 |
| `allowedGrantTypes` | array não-vazio, subconjunto de `['authorization_code', 'refresh_token', 'client_credentials']`, sem duplicatas |
| `allowedScopes` | array até 50 itens, cada um casando regex `^[a-z][a-z0-9:_-]*$` |
| `allowSignup` | boolean (default `true`) |
| `webhookUrl` | opcional; string até 2048 chars; **HTTPS obrigatório** + anti-SSRF (rejeita loopback/privado/link-local/metadata). No `PATCH`, `""` limpa o webhook e definir uma URL re-arma o circuit-breaker (`webhookDisabledAt` → `null`). Ver [`profile-events.md`](./profile-events.md) |
| `webhookSecret` | opcional; string até 256 chars (pré-filtro HMAC). No `PATCH`, `""` limpa. Nunca é retornado nas respostas — só o booleano `hasWebhookSecret` |

Combinações inválidas (semânticas — validadas além do shape):
- M2M (`client_credentials`) com `isPublic=true` → `400`
- M2M com `redirectUris` não-vazio → `400`
- `authorization_code` sem nenhum `redirectUri` → `400`
- Mudar `isPublic` de `false`→`true` sem `confirmSecretDrop: true` → `400`

---

## 6. Receitas por caso de uso

### A — Web Next.js com BFF (confidencial)

```json
POST /admin/clients
{
  "clientId": "hodos",
  "displayName": "Hodos",
  "isPublic": false,
  "redirectUris": [
    "https://hodos.com.br/api/auth/callback",
    "http://localhost:4000/api/auth/callback"
  ],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": true
}
```

Env vars no Hodos:
```env
ACCOUNTS_URL=https://accounts.overlens.com.br
IDP_BASE_URL=https://idp.overlens.com.br
IDP_CLIENT_ID=hodos
IDP_CLIENT_SECRET=<secret retornado pela criação>
IDP_REDIRECT_URI=https://hodos.com.br/api/auth/callback
```

Ver [`login.md`](./login.md) para o fluxo de integração.

### B — App mobile (público)

```json
POST /admin/clients
{
  "clientId": "overlens-mobile",
  "displayName": "Overlens App",
  "isPublic": true,
  "redirectUris": ["overlens://callback"],
  "allowedGrantTypes": ["authorization_code"],
  "allowedScopes": ["openid", "profile", "email"]
}
```

Sem `client_secret`. PKCE S256 obrigatório no token exchange. Deep link como redirect_uri.

### C — Serviço M2M

```json
POST /admin/clients
{
  "clientId": "fractals-service",
  "displayName": "Fractals Service",
  "isPublic": false,
  "redirectUris": [],
  "allowedGrantTypes": ["client_credentials"],
  "allowedScopes": ["fractals:debit", "fractals:read", "fractals:report"],
  "allowSignup": false
}
```

Ver [`m2m.md`](./m2m.md).

### D — Painel interno com signup desabilitado

```json
POST /admin/clients
{
  "clientId": "admin-internal",
  "displayName": "Painel Admin Interno",
  "isPublic": false,
  "redirectUris": ["https://admin-internal.overlens.com.br/api/auth/callback"],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email"],
  "allowSignup": false
}
```

`allowSignup=false` deixou de ser informativo — desde o contrato **1.5.0** é
**aplicado pelo IDP**: `POST /auth/signup` e `POST /auth/signup/google` rejeitam
com `400 unauthorized_client` ("Signup is not allowed for this client") antes de
criar qualquer identidade, e o `GET /auth/authorize` expõe `allow_signup` na
resposta `login_required` para a tela de login do Accounts esconder "Criar
conta". O enforcement cobre também o **login Google** (`POST
/auth/authorize/google`) quando o e-mail do id_token **não tem conta** (o
upsert criaria uma — mesmo `400`); contas existentes, incluindo account-linking
de conta LOCAL, seguem logando. Ver [`signup.md`](./signup.md) §5.

---

## 7. Redirect URIs — regras

- **Exact match** byte-a-byte com uma das URIs registradas. Sem wildcards. Sem normalização de trailing slash.
- **HTTPS obrigatório** em URIs públicas. Exceção única: `http://localhost:<porta>...`
- **Deep links** (`overlens://callback`, `com.empresa.app://...`) permitidos apenas para clients públicos.
- **Inclua todas as URIs** que serão usadas: produção + staging + dev. Não há fallback.

Inválidos (rejeitados):
```
https://hodos.com.br/api/auth/callback/   ← trailing slash extra
https://*.overlens.com.br/callback        ← wildcard
http://hodos.com.br/callback              ← http fora de localhost
```

---

## 8. Bootstrap inicial (seed do root user)

O seed **não registra clients OAuth** — o bootstrap real é:

1. **Seed do usuário root ADMIN.** O seed (`apps/idp/prisma/seed.ts`) cria apenas o usuário administrativo a partir de `ROOT_USER_EMAIL`/`ROOT_USER_PASSWORD`:

   ```bash
   DATABASE_URL=... ROOT_USER_EMAIL=... ROOT_USER_PASSWORD=... pnpm --filter @overlens/idp db:seed
   ```

2. **Login no Accounts** com o root user (`accounts.overlens.com.br`).

3. **Cadastro dos clients** via UI (`accounts.overlens.com.br/admin/clients`) ou `POST /admin/clients` — com audit log, validações e o `client_secret` retornado uma única vez.

> Com `IDP_TEST_MODE=true` (**nunca em produção** — o seed recusa rodar os fixtures com `NODE_ENV=production`), o seed também semeia os fixtures de teste: clients `test-web-bff`, `test-public-pkce`, `test-m2m-service` e usuários `*.example.test` — usados pelo container/sandbox ([`run-local-container.md`](./run-local-container.md)).

Para promover admins **adicionais** via SQL, ver [`admin-area.md`](./admin-area.md).

---

## 9. Checklist — registrar novo client

- [ ] Tipo definido (confidencial / público / M2M)
- [ ] `clientId` escolhido (regex `^[a-z][a-z0-9-]{2,49}$`)
- [ ] `redirectUris` listadas (produção + dev), HTTPS ou `localhost`
- [ ] `allowedGrantTypes` correto: `authorization_code`+`refresh_token` (web/mobile) **ou** `client_credentials` (M2M)
- [ ] `allowedScopes` lista exatamente o necessário
- [ ] `allowSignup` definido (raramente `false`)
- [ ] Criado via `POST /admin/clients` por um ADMIN
- [ ] `clientSecret` da resposta guardado em secret manager (não no código, não no log)
- [ ] Para M2M: env do serviço consumidor populada com o secret
- [ ] (Opcional) Entry adicionada em `apps/accounts/src/lib/client-display-names.ts` para nome bonito na tela de login

---

## 10. Limites conhecidos

| Item | Status |
|---|---|
| Regenerar secret sem deletar client | Não implementado — recriar é o caminho atual |
| Restore após `DELETE` (undo soft-delete) | Não há endpoint — precisa SQL direto |
| Múltiplos secrets simultâneos (rotação suave) | Não suportado |
| Wildcard redirect URIs | Por design, nunca será suportado |
