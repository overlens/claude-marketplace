# Rate Limiting

> **Público:** time IDP + Accounts (operação); as seções 4 e 6 interessam também a
> integradores (contrato do `429`/`Retry-After`).
> Como o IDP throttles requests, por endpoint e por IP. Saber isso evita surpresas em CI/cargas e ajuda a diagnosticar `429`.
>
> **Última atualização:** 2026-07-14 — throttler **religado** (P4) com limites generosos por rota. Antes desta data o throttler estava desligado em todos os ambientes (`skipIf: () => true`).

---

## 1. Storage

Configurado em `apps/idp/src/modules/auth/auth.module.ts`:

- **Com `REDIS_URL`:** `ThrottlerStorageRedisService` — contagem global compartilhada entre instâncias.
- **Sem `REDIS_URL`:** storage in-memory — **isolado por instância**. Em múltiplas réplicas no Railway, isso significa que um atacante pode multiplicar tentativas pelo número de instâncias.

Em produção **use Redis**.

---

## 2. Limites por rota

A contagem é **por rota × chave** (IP, ou client no M2M). Estourar `/login` não afeta `/auth/token` nem qualquer outra rota.

| Rota | Perfil | Limite | Janela |
|---|---|---|---|
| `POST /login` | `auth` | 10 req | 60 s |
| `POST /login/google` | `auth` | 10 req | 60 s |
| `POST /auth/authorize` (email+senha) | `auth` | 10 req | 60 s |
| `POST /auth/authorize/google` | `auth` | 10 req | 60 s |
| `POST /token/refresh` | `auth` | 30 req | 60 s |
| `POST /auth/token` (todos os grant types) | `auth` | 30 req | 60 s |
| `POST /signup` | `signup` | 10 req | 60 s |
| `POST /auth/signup` | `signup` | 10 req | 60 s |
| `PATCH /auth/me`, `POST /auth/me/deactivate`, `DELETE /auth/me`, avatar | `profile` | 20 req | 60 s |
| `GET /auth/me/email` | `profile-reveal` | 10 req | 60 s |
| `POST /auth/me/password` | `password-change` | 5 req | 15 min |
| `POST /auth/password/forgot` | `password-reset` | 3 req | 15 min |
| `POST /auth/password/reset` | `password-reset` | 10 req | 15 min |
| `GET /users/:sub` (M2M) | `m2m-profile-read` | 600 req (**por client**) | 60 s |
| **Todas as demais rotas** (discovery, JWKS, `GET /auth/authorize`, `/auth/revoke`, `/auth/logout`, admin, health…) | `default` | 60 req | 60 s |

> Limites deliberadamente **generosos** (rollout do P4): a intenção é conter abuso óbvio sem atrapalhar uso legítimo. Apertar só depois de observar volumetria real.

**Isenções:** `GET /auth/signup` e `POST /auth/signup/google` usam `@SkipThrottle()` e não contam em nenhum perfil.

> ### ⚠️ `POST /auth/password/forgot` tem uma SEGUNDA camada, fora do throttler
>
> Só limitar por IP é insuficiente aqui: um atacante com IPs rotativos inundaria
> a caixa de uma vítima específica (assédio + queima da reputação do domínio
> remetente). Existe, portanto, uma cota **por identidade** — default 3 pedidos
> por hora, `PASSWORD_RESET_MAX_PER_IDENTITY` / `PASSWORD_RESET_IDENTITY_WINDOW_MS`
> — contada dentro do `RequestPasswordResetUseCase`, não pelo throttler (o
> `@nestjs/throttler` v6 não sabe chavear por um campo do body).
>
> **Ao estourar essa cota o endpoint responde `202`, não `429`.** Um 429 nesse
> ramo confirmaria que o e-mail existe e desfaria a não-enumeração que o resto
> do fluxo garante (ADR-0012). Só o limite **por IP** produz 429.

### Escopo por rota (detalhe de implementação)

No `@nestjs/throttler` v6, todo perfil nomeado definido no módulo aplicaria a **todas** as rotas por default. O IDP escopa cada perfil às rotas que o **declaram** via `@Throttle({ <perfil>: {...} })` — implementado pelos `skipIf` de `apps/idp/src/common/utils/throttler-profiles.ts`. Rotas sem decorator caem no perfil `default` (60 req/min por IP). Ao criar um endpoint novo, decida: perfil específico via `@Throttle` ou o `default`.

---

## 3. Ambientes: sempre ativo + kill-switch

O throttler está **ativo em todos os ambientes** (não há mais skip automático em dev).

- **Kill-switch operacional:** `IDP_RATE_LIMIT_DISABLED=true` desliga toda a contagem (lido a cada request — não precisa de restart se o runtime propagar env, mas no Railway trate como redeploy). Use apenas em load tests e emergências; **nunca** deixe ligado em produção normal.
- **Testes (jest):** as suítes e2e que fazem muitos requests desabilitam o guard no `TestingModule` (padrão do repo — `overrideGuard(ThrottlerGuard)` + `jest.spyOn(ThrottlerGuard.prototype, 'canActivate')`). A exceção é `test/rate-limit.e2e-spec.ts`, que testa o throttler de verdade.

Para exercitar o throttle localmente basta subir o IDP e martelar um endpoint — o comportamento é o mesmo de produção (com storage in-memory se não houver `REDIS_URL`).

---

## 4. Resposta ao usuário

Quando o limite é excedido, o IDP retorna:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{ "statusCode": 429, "message": "ThrottlerException: Too Many Requests" }
```

- O header **`Retry-After`** (segundos) é padrão RFC 7231 e vem em **todo** 429 — o `ClientThrottlerGuard` o normaliza (a lib, sozinha, emitiria `Retry-After-<perfil>` para perfis nomeados; esse header sufixado também está presente, junto com `X-RateLimit-Limit-<perfil>` etc. nas respostas não bloqueadas).
- Frontends devem mostrar mensagem amigável: **"Muitas tentativas. Aguarde alguns minutos."**
- Em endpoints com janela longa (`password-change` 15 min), mostre **quando** o usuário pode tentar de novo — use o `Retry-After`.

---

## 5. Chave de contagem

Por **IP** (via `req.ip`), exceto M2M com Bearer token carregando `client_id` — aí a chave é `client:<client_id>` (ver `ClientThrottlerGuard`). O `main.ts` configura `app.set('trust proxy', 1)` para que o IP real venha do header `X-Forwarded-For` (Railway/Cloudflare proxy).

> Se você está contando o IP errado em produção, verifique:
> - `trust proxy` está setado
> - Não há proxy adicional entre Railway e o IDP que sobrescreva `X-Forwarded-For`

---

## 6. Para consumidores

### CI / smoke tests
Se sua suite faz logins em sequência contra um IDP real, os buckets relevantes são `POST /login` (10/min por IP) e `POST /auth/token` (30/min por IP). Opções:
- Espaçe os logins ou reutilize a sessão entre testes (refresh em vez de login).
- Configure um IP allowlist no proxy (Cloudflare → bypass throttle por IP de CI).
- Rode contra um IDP de staging com `IDP_RATE_LIMIT_DISABLED=true`.

### Frontends
- `429` é diferente de `401`. Não trate como "credenciais erradas" **nem** como sessão morta — é falha **transitória**: aguarde o `Retry-After` e tente de novo.
- Cache o header `Retry-After` em UI ("Próxima tentativa em 42 segundos").

### M2M
Com cache de token (TTL 5min), um serviço M2M só atinge o IDP ~1 vez a cada 5min. O limite de `POST /auth/token` (30/min por IP) é amplamente suficiente. Se você está estourando, provavelmente está **não-cacheando** — ver [`m2m.md`](../integration/m2m.md) §7.

---

## 7. Eventos de log relacionados

O `ThrottlerGuard` em si não loga estruturadamente (depende do nível do Pino global). Eventos do auth flow que indicam comportamento abusivo:

| Evento | Origem | Significado |
|---|---|---|
| `user_login_failed` | `login-with-email.use-case.ts` | Combinações usuario/senha incorretas |
| `user_blocked_refresh_attempt` | `refresh-token.use-case.ts` | Refresh de usuário com `blockedAt != null` |
| `oauth_refresh_replay_detected` / `refresh.replay_detected` | use cases de refresh | Reuso de refresh token fora da grace window (sessão revogada) |
| `m2m_token_denied` | `client-credentials.use-case.ts` | Scope fora de `allowedScopes` |

Sentry captura erros não tratados; volume de `429` em si **não** vira evento por padrão.

---

## 8. Para DevOps

### Diagnóstico de "está throttle ou tá fora?"

```bash
# Bata o endpoint repetidas vezes e veja se vira 429
for i in {1..15}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://idp.overlens.com.br/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"none@none.com","password":"none"}'
done | sort | uniq -c
# Esperado: ~10× 401 + ~5× 429
```

### Reset manual (emergência)
Se Redis está armazenando contagem inflada (ex: bug do throttler), `FLUSHDB` no Redis do throttler limpa. **Cuidado:** mata o estado de todos os perfis.

```bash
redis-cli -u $REDIS_URL FLUSHDB
```

Alternativa menos destrutiva: `IDP_RATE_LIMIT_DISABLED=true` + redeploy enquanto investiga.

### Ajuste de limites
Valores por rota vivem nos decorators `@Throttle` dos controllers; fallbacks e o perfil `default` em `apps/idp/src/modules/auth/auth.module.ts`. Não há env var para sobrescrever limites individuais — alteração precisa de deploy.

---

## 9. Limites e roadmap

| Item | Status |
|---|---|
| Rate limit por usuário (não por IP) | Não implementado |
| Allowlist de IPs (bypass) | Não implementado — fazer via Cloudflare antes do Railway |
| Métricas Prometheus / contadores de 429 | Não exposto |
| Aperto dos limites pós-observabilidade | Pendente — limites atuais são deliberadamente generosos |
