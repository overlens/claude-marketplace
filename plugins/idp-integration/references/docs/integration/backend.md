# Guia de Integração — Backend (Resource Server)

> Como uma API backend valida JWTs emitidos pelo IDP da Overlens.
>
> **Última atualização:** 2026-07-18

---

## 1. Conceito central

Seu backend **nunca chama o IDP durante uma request**. Em vez disso:

1. No boot, busca a chave pública do IDP via JWKS e a cacheia.
2. A cada request autenticada, valida o JWT **localmente** com essa chave cacheada.
3. Extrai claims (`sub`, `email`, `role`, ou `client_id`/`scope`) — zero chamadas externas.

Resultado: autenticação com latência zero e seu backend continua funcionando mesmo se o IDP estiver temporariamente indisponível (até o cache da chave expirar — TTL 1h).

---

## 2. Transporte do token — duas formas

Seu Resource Server precisa aceitar pelo menos uma (e idealmente as duas):

| Transporte | Quem usa | Header / Cookie |
|---|---|---|
| **Cookie `access_token`** | SPAs sob `*.overlens.com.br` que dependem do modo cookie do IDP, **ou** consumers OAuth que decidiram propagar o token via cookie no seu domínio | `Cookie: access_token=<jwt>` |
| **`Authorization: Bearer`** | Apps mobile, M2M (`client_credentials`), `/auth/userinfo`, qualquer client server-to-server | `Authorization: Bearer <jwt>` |

Recomendação: extrair **Bearer com prioridade** e cair para cookie como fallback. É o que o IDP faz internamente (`AuthGuard` em `apps/idp/src/common/guards/auth.guard.ts`).

---

## 3. Tokens — user vs M2M

Os dois tipos de token são assinados pela mesma chave e validam-se com o mesmo JWKS. A diferença está no payload:

| Campo | User JWT | M2M JWT |
|---|---|---|
| `sub` | CUID2 do usuário | `clientId` do serviço (ex: `fractals-service`) |
| `email` | string | **ausente** |
| `name` | string | **ausente** |
| `role` | `BASIC` \| `ADMIN` \| `SYSTEM` | **ausente** |
| `email_verified` | boolean | **ausente** |
| `client_id` | **ausente** | string |
| `scope` | **ausente** | string (separada por espaço) |
| `exp` | iat + 900 (15min) | iat + 300 (5min) |
| `iss`, `aud`, `iat` | comuns | comuns |

**Discriminação canônica:**
```ts
const isM2M = !!payload.client_id && !payload.email;
```

Resource Servers que aceitam **apenas** uma das duas formas devem rejeitar a outra explicitamente. Resource Servers que aceitam ambas devem ramificar a lógica de autorização:
- **User**: autoriza por **papel local do app** (mapeado a partir do `sub`) e/ou regras de negócio. Ver aviso de depreciação abaixo.
- **M2M**: autoriza por `scope`. **Nunca** confie em `role` — não existe.

> ⚠️ **`role` está `@deprecated` como fonte de autorização (RFC-0003 / ADR-8).** Pela fronteira do ADR-7, papel/permissão é **contextual de app**, não identidade global: o IDP autentica, **cada app autoriza**. O claim `role` continua presente no token (zero breaking change) e os guards abaixo seguem funcionando, mas **novos consumidores não devem depender dele** — mapeie `sub` → papel local no seu próprio domínio. A remoção do claim virá em uma versão major futura, com aviso prévio.

---

## 4. Variáveis de ambiente

```env
JWKS_URL=https://idp.overlens.com.br/.well-known/jwks.json
JWT_ISSUER=https://idp.overlens.com.br
JWT_AUDIENCE=https://api.seuapp.overlens.com.br
```

`JWT_ISSUER` e `JWT_AUDIENCE` precisam bater com o que o IDP emite. O IDP usa:
- `IDP_ISSUER` (default `https://idp.overlens.com.br`)
- `IDP_AUDIENCE` (default `https://api.overlens.com.br`, aceita CSV)

> **Dica:** em vez de hardcode, descubra esses valores via OIDC discovery:
>
> ```bash
> curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq '{issuer, jwks_uri}'
> ```
>
> Libs como `openid-client`, `passport-openidconnect` e `next-auth/Auth.js` consomem esse documento automaticamente. Ver [`oidc-discovery.md`](./oidc-discovery.md).

---

## 5. Integração NestJS

### 5.1 Instalar dependências

```bash
pnpm add @nestjs/passport passport passport-jwt jwks-rsa cookie-parser
pnpm add -D @types/passport-jwt @types/cookie-parser
```

### 5.2 `JwtStrategy` — extrai de Bearer ou cookie

```typescript
// src/auth/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';

export type Principal =
  | { kind: 'user'; id: string; email: string; role: 'BASIC' | 'ADMIN' | 'SYSTEM' }
  | { kind: 'service'; clientId: string; scopes: string[] };

interface CommonJwt {
  sub: string;
  iss: string;
  aud: string[];
  iat: number;
  exp: number;
}
interface UserJwt extends CommonJwt {
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  email_verified: boolean;
  new_user?: true;
}
interface M2MJwt extends CommonJwt {
  client_id: string;
  scope: string;
}
type Payload = UserJwt | M2MJwt;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: process.env.JWKS_URL!,
      }),
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),                  // prioridade: Bearer
        (req) => (req?.cookies?.access_token ?? null) as string,    // fallback: cookie
      ]),
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      algorithms: ['RS256'],
    });
  }

  validate(payload: Payload): Principal {
    if ('client_id' in payload && !('email' in payload)) {
      return {
        kind: 'service',
        clientId: payload.client_id,
        scopes: (payload.scope ?? '').split(' ').filter(Boolean),
      };
    }
    if ('email' in payload && payload.role) {
      return {
        kind: 'user',
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
    }
    throw new UnauthorizedException('Token inválido');
  }
}
```

### 5.3 `main.ts` — cookie parser

```typescript
import cookieParser from 'cookie-parser';
// ...
app.use(cookieParser());
```

### 5.4 `AuthModule`

```typescript
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
  exports: [PassportModule],
})
export class AuthModule {}
```

### 5.5 Guards

```typescript
// src/auth/jwt-auth.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

> O `RequireRole` abaixo lê o `role` do token. Mantido para compatibilidade, mas `role` está `@deprecated` (RFC-0003): prefira derivar o papel do `sub` via um mapa local do app. Trate este guard como ponte transitória, não como o destino.

```typescript
// src/auth/require-role.guard.ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class RequireRole implements CanActivate {
  constructor(private readonly role: 'BASIC' | 'ADMIN' | 'SYSTEM') {}
  canActivate(ctx: ExecutionContext) {
    const principal = ctx.switchToHttp().getRequest().user;
    return principal?.kind === 'user' && principal.role === this.role;
  }
}
```

```typescript
// src/auth/require-scope.guard.ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class RequireScope implements CanActivate {
  constructor(private readonly scope: string) {}
  canActivate(ctx: ExecutionContext) {
    const principal = ctx.switchToHttp().getRequest().user;
    return principal?.kind === 'service' && principal.scopes.includes(this.scope);
  }
}
```

### 5.6 Uso

```typescript
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  @Get('me')
  async me(@Req() req: Request) {
    const principal = req.user as Principal;
    if (principal.kind !== 'user') throw new ForbiddenException('Endpoint requer usuário');
    return await this.usersService.findById(principal.id);
  }
}

@Controller('admin')
@UseGuards(JwtAuthGuard, new RequireRole('ADMIN'))
export class AdminController { /* ... */ }

@Controller('fractals')
@UseGuards(JwtAuthGuard)
export class FractalsController {
  @Post('debit')
  @UseGuards(new RequireScope('fractals:debit'))
  async debit() { /* ... */ }
}
```

### 5.7 `@CurrentPrincipal()` decorator

```typescript
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal =>
    ctx.switchToHttp().getRequest().user,
);
```

---

## 6. Integração Express (sem NestJS)

```javascript
const express = require('express');
const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { passportJwtSecret } = require('jwks-rsa');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cookieParser());

passport.use(new JwtStrategy({
  secretOrKeyProvider: passportJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: process.env.JWKS_URL,
  }),
  jwtFromRequest: ExtractJwt.fromExtractors([
    ExtractJwt.fromAuthHeaderAsBearerToken(),
    (req) => req?.cookies?.access_token ?? null,
  ]),
  issuer: process.env.JWT_ISSUER,
  audience: process.env.JWT_AUDIENCE,
  algorithms: ['RS256'],
}, (payload, done) => {
  if (payload.client_id && !payload.email) {
    return done(null, { kind: 'service', clientId: payload.client_id, scopes: (payload.scope ?? '').split(' ') });
  }
  return done(null, { kind: 'user', id: payload.sub, email: payload.email, role: payload.role });
}));

app.use(passport.initialize());
const requireAuth = passport.authenticate('jwt', { session: false });

app.get('/dados', requireAuth, (req, res) => res.json({ principal: req.user }));
app.listen(3000);
```

---

## 7. GraphQL (NestJS code-first)

```typescript
@Injectable()
export class GqlJwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext) {
    return GqlExecutionContext.create(context).getContext().req;
  }
}
```

```typescript
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal =>
    GqlExecutionContext.create(ctx).getContext().req.user,
);
```

---

## 8. Tratamento de erros

### Token expirado / inválido
Passport retorna `401` automaticamente. Frontends devem tratar com refresh (ver [`frontend.md`](./frontend.md) §1.3).

### Conta inacessível (bloqueada / desativada / excluída) — matriz fluxo × status

Os três estados de conta (`blockedAt`, `deactivatedAt`, `deletedAt`) são tratados de forma **unificada** em todos os fluxos de emissão/renovação de token. O código de erro depende do **fluxo**, nunca do estado:

| Fluxo | Endpoint | Resposta para conta inacessível |
|---|---|---|
| OAuth — exchange | `POST /auth/token` (`grant_type=authorization_code`) | `400 { error: "invalid_grant", error_description: "Account is not accessible" }` |
| OAuth — refresh | `POST /auth/token` (`grant_type=refresh_token`) | `400 { error: "invalid_grant", error_description: "Account is not accessible" }` |
| Sessão cookie — refresh | `POST /token/refresh` | `401 Unauthorized` |
| SSO — authorize | `GET /auth/authorize` (cookie `access_token` de conta inacessível) | `200 { status: "login_required" }` — cookie ignorado, **não é erro** |
| Login | `POST /login`, `POST /auth/authorize` | `401` genérico (mesma mensagem de credenciais inválidas) |

Regras para o consumidor:

- **Trate `400 invalid_grant` (OAuth) e `401` (cookie) como falha DEFINITIVA de sessão**: descarte tokens/cookies locais e redirecione ao login. Não faça retry — a conta não volta a renovar sozinha.
- A `error_description` é **genérica e idêntica para os 3 estados** — a resposta nunca revela se a conta está bloqueada, desativada ou excluída (mesma filosofia do 401 de credenciais). O estado real existe apenas nos logs estruturados do IDP.
- O `access_token` já emitido continua válido até `exp` (≤ 15min) — não há blocklist global.
- **Não** chame o IDP a cada request para checar bloqueio. Custo: 1 DB call por request, latência adicional, falha cascateada se IDP estiver lento.
- Se você precisa de bloqueio instantâneo para um endpoint crítico, mantenha um cache de "users bloqueados" e propague via webhook/eventos (ver `profile-events.md` — eventos `account-deactivated`/`account-deleted`).

### M2M com `role`
Não existe. Se sua lógica precisa diferenciar serviços, use o `client_id` (igual a `payload.sub` em M2M) ou checagem por scope.

---

## 9. JWKS — cache e rotação

```typescript
secretOrKeyProvider: passportJwtSecret({
  cache: true,
  rateLimit: true,             // previne thundering herd se receber muitos tokens com kid desconhecido
  cacheMaxAge: 3_600_000,      // 1h — alinhado com o Cache-Control do IDP
  jwksRequestsPerMinute: 5,
  jwksUri: process.env.JWKS_URL,
})
```

O IDP serve `Cache-Control: public, max-age=3600` — mantenha o cache do seu lado alinhado (1h). Seu Resource Server deve **selecionar a chave pelo `kid`** do header do JWT e estar pronto para um JWKS com **múltiplas chaves** (as libs acima já fazem isso). O procedimento real de rotação do IDP está em [`../deploy/rsa-keys.md`](../deploy/rsa-keys.md) — hoje a troca de chave é única, com uma janela de transição; publicar múltiplas chaves simultâneas no JWKS é evolução planejada. Conceito em [`../learning/key-rotation.md`](../learning/key-rotation.md).

---

## 10. Checklist

- [ ] `cookie-parser` no `main.ts` (NestJS) ou `app.use(cookieParser())` (Express)
- [ ] `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` configurados
- [ ] `jwtFromRequest` extrai Bearer **e** cookie (não apenas um)
- [ ] `algorithms: ['RS256']` — explicitamente, nunca aceite outros
- [ ] `validate()` distingue user vs M2M (`!!payload.client_id && !payload.email`)
- [ ] Endpoints autenticados protegidos por `JwtAuthGuard`
- [ ] Endpoints com restrição usam `RequireRole` (user) ou `RequireScope` (M2M ou user com scope)
- [ ] Resource Server nunca chama o IDP em request normal (apenas no boot via JWKS)
- [ ] Não há lógica que checa "usuário bloqueado" a cada request
- [ ] JWKS cache configurado (1h alinhado com IDP)
