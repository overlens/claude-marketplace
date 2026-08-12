# Guia de Integração — M2M (Machine-to-Machine)

> Autenticação de serviço para serviço via OAuth 2.0 `client_credentials` (RFC 6749 §4.4).
>
> **Use este guia quando:** seu sistema é um backend/worker/serviço que precisa chamar outra API da Overlens em nome próprio (não em nome de um usuário). Exemplos: um worker de billing chamando `api.overlens.com.br/fractals`, um cron que reconcilia dados, um serviço externo emitindo eventos.
>
> **Última atualização:** 2026-07-18

---

## 1. Quando usar M2M (e quando NÃO usar)

| Cenário | Use M2M? |
|---|---|
| Worker do seu serviço debitando saldo do usuário X | ✅ Sim — em nome próprio do serviço, autorizado por `scope`. |
| Endpoint público do seu serviço chamado por usuário logado | ❌ Não — propague o JWT do usuário (cookie ou Bearer), valide via JWKS. |
| Comando admin disparado por humano (ex: criar OAuth client) | ❌ Não — `AdminRoleGuard` exige JWT de usuário com `role=ADMIN`. M2M é rejeitado. |
| Frontend (browser, mobile, SPA) | ❌ Não — use OAuth Authorization Code + PKCE. `client_secret` jamais sai do servidor. |

**Regra:** M2M token autentica o **serviço**, não um usuário. Não tem `email`, não tem `role`. Decisões de acesso devem ser por **scope**.

---

## 2. Pré-requisitos

### Registrar um OAuth Client M2M

Toda integração M2M precisa de um client confidencial registrado no IDP com:

- `isPublic: false` (M2M público é inseguro — `client_secret` é a única credencial)
- `allowedGrantTypes: ['client_credentials']` (e somente esse)
- `redirectUris: []` (M2M não usa redirect)
- `allowedScopes: [...]` — lista exaustiva de scopes que esse serviço pode pedir
- `allowSignup: false`

Caminho de registro: API admin (`POST /admin/clients`) — ver [`oauth-clients.md`](./oauth-clients.md). O `client_secret` é retornado **uma única vez** na resposta de criação; guarde-o num secret manager (Railway Variables, AWS Secrets Manager, etc.).

### Exemplo de registro (via `POST /admin/clients`)

Clients M2M **não são semeados** — são cadastrados manualmente por um ADMIN via `POST /admin/clients` ou pela UI `accounts.overlens.com.br/admin/clients`. Exemplo **ilustrativo** de payload de registro:

```jsonc
// POST /admin/clients
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

O `client_secret` vem **uma única vez** na resposta da criação — guarde-o no secret manager do serviço consumidor.

> Para desenvolvimento local (container/sandbox), o fixture de teste M2M é o `test-m2m-service`, semeado **apenas** com `IDP_SEED_FIXTURES=true` — ver [`run-local-container.md`](./run-local-container.md).

---

## 3. Fluxo completo

```
Serviço (Fractals Worker)                IDP (idp.overlens.com.br)         Resource Server (api.overlens.com.br)
        |                                          |                                       |
        |  POST /auth/token  ─────────────────────>|                                       |
        |  Authorization: Basic <base64(id:secret)>|                                       |
        |  grant_type=client_credentials           |                                       |
        |  scope=fractals:debit fractals:read      |                                       |
        |                                          |                                       |
        |                                  Valida client_secret (bcrypt)                   |
        |                                  Valida scope ⊆ allowedScopes                    |
        |                                  Verifica allowedGrantTypes inclui client_credentials
        |                                  Assina JWT RS256 (kid=<RSA_KID>, exp=iat+300)   |
        |                                          |                                       |
        |<─ 200 OK ──────────────────────────────  |                                       |
        |  { access_token, token_type: "Bearer",   |                                       |
        |    expires_in: 300, scope: "..." }       |                                       |
        |                                          |                                       |
        |  POST /fractals/debit  Authorization: Bearer <jwt>  ─────────────────────────>   |
        |                                          |                                       |
        |                                          |     Valida JWT via JWKS (cache)       |
        |                                          |     Verifica iss, aud, alg=RS256, exp |
        |                                          |     Verifica scope inclui o necessário|
        |                                          |                                       |
        |<─ 200 OK ──────────────────────────────────────────────────────────────────────  |
```

Características importantes:
- **Sem refresh token.** Para um M2M obter um novo token, basta repetir a chamada. Pedir refresh em `client_credentials` retorna `400 unauthorized_client` (refresh não está em `allowedGrantTypes` do client).
- **Sem cookies.** Tudo via headers + JSON.
- **Sem `redirect_uri`.** Não há redirect; tudo back-channel.
- **Sem PKCE.** PKCE protege code flow contra interceptação. Aqui não existe code.

---

## 4. Endpoint — request e response

### Request

```
POST https://idp.overlens.com.br/auth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64("client_id:client_secret")

grant_type=client_credentials
scope=fractals:debit fractals:read    (opcional — se omitido, recebe todos `allowedScopes`)
```

**Alternativa sem header Basic** — credenciais no body (`client_secret_post`):

```
POST /auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id=fractals-service
client_secret=<secret>
scope=fractals:debit
```

Ambos os métodos são suportados (`token_endpoint_auth_methods_supported` lista os dois).

### Response 200

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "fractals:debit fractals:read"
}
```

| Campo | Descrição |
|---|---|
| `access_token` | JWT RS256 assinado pelo IDP. TTL **5 minutos** (300s). |
| `expires_in` | Sempre `300` para M2M. Use para programar refetch antes de expirar. |
| `scope` | Os scopes **efetivamente** concedidos (interseção entre `scope` requisitado e `allowedScopes` do client). |

### Erros

| HTTP | `error` | Causa |
|---|---|---|
| 400 | `invalid_request` | `grant_type` faltando |
| 400 | `invalid_scope` | Um ou mais scopes não estão em `allowedScopes` do client |
| 400 | `unauthorized_client` | `client_credentials` não está em `allowedGrantTypes` do client |
| 401 | `invalid_client` | Client desconhecido OU secret inválido OU client público tentando M2M |

Em `401 invalid_client`, a resposta inclui `WWW-Authenticate: Basic realm="IDP"`.

---

## 5. Payload do JWT M2M

```json
{
  "sub": "fractals-service",
  "client_id": "fractals-service",
  "scope": "fractals:debit fractals:read",
  "iss": "https://idp.overlens.com.br",
  "aud": ["https://api.overlens.com.br"],
  "iat": 1748275200,
  "exp": 1748275500
}
```

| Campo | Descrição |
|---|---|
| `sub` | Igual ao `client_id` por convenção OAuth — identifica o **serviço**. |
| `client_id` | Redundante mas explícito; útil para Resource Servers que distinguem M2M de user. |
| `scope` | Lista separada por espaço dos scopes concedidos. |
| `iss`, `aud`, `iat`, `exp` | Idênticos ao JWT de usuário. |

> **Não existem** os campos `email`, `name`, `role`, `email_verified`, `new_user` em tokens M2M. Use isso para discriminar:
>
> ```ts
> const isM2M = !payload.email && !!payload.client_id;
> ```

---

## 6. Validando M2M no Resource Server

Mesmo JWKS, mesmo `iss`, mesmo `aud` — a diferença é a **lógica de autorização**:

```ts
import { passportJwtSecret } from 'jwks-rsa';
import { Strategy, ExtractJwt } from 'passport-jwt';

passport.use(new Strategy({
  secretOrKeyProvider: passportJwtSecret({
    jwksUri: 'https://idp.overlens.com.br/.well-known/jwks.json',
    cache: true,
    cacheMaxAge: 3_600_000,
  }),
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  issuer: 'https://idp.overlens.com.br',
  audience: 'https://api.overlens.com.br',
  algorithms: ['RS256'],
}, (payload, done) => {
  if (payload.client_id && !payload.email) {
    // M2M
    return done(null, {
      kind: 'service',
      clientId: payload.client_id,
      scopes: (payload.scope ?? '').split(' '),
    });
  }
  // User
  return done(null, {
    kind: 'user',
    id: payload.sub,
    email: payload.email,
    role: payload.role,
  });
}));
```

### Guard de scope (exemplo NestJS)

```ts
@Injectable()
export class RequireScope implements CanActivate {
  constructor(private readonly required: string) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const principal = req.user;
    if (principal?.kind !== 'service') return false; // bloqueia user tokens
    return principal.scopes.includes(this.required);
  }
}

// uso
@Post('debit')
@UseGuards(JwtAuthGuard, new RequireScope('fractals:debit'))
async debit() { /* ... */ }
```

---

## 7. Cliente M2M (exemplo Node.js / NestJS)

Cache do token em memória até `exp - 30s` para não chamar o IDP em todo request:

```ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class IdpM2MClient {
  private cached: { token: string; expiresAt: number } | null = null;
  private readonly logger = new Logger(IdpM2MClient.name);

  constructor(
    private readonly idpUrl: string,        // https://idp.overlens.com.br
    private readonly clientId: string,      // 'fractals-service'
    private readonly clientSecret: string,
    private readonly scopes: string[],      // ['fractals:debit', 'fractals:read']
  ) {}

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt - 30 > now) {
      return this.cached.token;
    }

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(`${this.idpUrl}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.scopes.join(' '),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error({ status: res.status, body }, 'M2M token fetch failed');
      throw new Error('Failed to obtain M2M token');
    }

    const data: { access_token: string; expires_in: number } = await res.json();
    this.cached = {
      token: data.access_token,
      expiresAt: now + data.expires_in,
    };
    return data.access_token;
  }
}
```

Uso:

```ts
const token = await this.idpM2M.getToken();
await fetch(`${apiUrl}/fractals/debit`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, amount: 10 }),
});
```

---

## 8. Variáveis de ambiente recomendadas

No serviço consumidor:

```env
IDP_BASE_URL=https://idp.overlens.com.br
IDP_M2M_CLIENT_ID=fractals-service
IDP_M2M_CLIENT_SECRET=<secret retornado pelo /admin/clients na criação>
IDP_M2M_SCOPES=fractals:debit,fractals:read
```

Do lado do IDP **não há env var por client**: o secret vive apenas como hash bcrypt na tabela `oauth_clients`, gravado no momento da criação via `POST /admin/clients`.

---

## 9. Rate limiting

O endpoint `POST /auth/token` está sob o throttler `auth` (**30 req/min por IP**, ativo em todos os ambientes — ver [`rate-limiting.md`](../deploy/rate-limiting.md)). M2M com cache de token (§7) fica bem abaixo desse limite em uso normal.

> Se você está estourando o throttler, provavelmente está pedindo token a cada request em vez de cachear.

---

## 10. Checklist de integração M2M

- [ ] Client registrado via `POST /admin/clients` com `isPublic=false`, `allowedGrantTypes=['client_credentials']`, `redirectUris=[]`
- [ ] `allowedScopes` listando exatamente os scopes que o serviço precisa
- [ ] `client_secret` guardado em secret manager (nunca em código nem em log)
- [ ] Token cacheado em memória até `expires_in - margem` (recomendado: 30s)
- [ ] Resource Server distingue user vs M2M (`payload.client_id && !payload.email`)
- [ ] Resource Server autoriza por **scope**, não por `role` (M2M não tem `role`)
- [ ] `AdminRoleGuard` (endpoints `/admin/*`) **NÃO** é alvo de M2M — é rejeitado por design
- [ ] Sem PKCE, sem refresh token, sem redirect — tudo back-channel

---

## 11. Limites e roadmap

| Item | Status |
|---|---|
| Refresh de token M2M | Não suportado (re-fetch é barato — basta repetir `/auth/token`). |
| Revocação de token M2M | Não suportado. Mitigação: rotacionar `client_secret` via API admin → tokens antigos continuam válidos até `exp` (≤ 5 min). |
| Múltiplos secrets por client (rotação suave) | Não suportado. Rotação atual é "trocar e aceitar gap de ≤5min em pior cenário". |
| Mutual TLS (mTLS) | Não suportado. |
| JWT client assertion (`client_secret_jwt`/`private_key_jwt`) | Não suportado. Use Basic ou body. |

---

## 12. Caso de uso: ler o perfil global de um usuário

Precisa dos atributos globais de identidade (`name`, `username`, `email`, `phone`, `document`, `birthDate`, `avatar`) de **qualquer** usuário por `sub`? Use o endpoint M2M **`GET /users/:sub`** (scope `profile:read`). Ver guia dedicado: [`m2m-profile-read.md`](./m2m-profile-read.md).
