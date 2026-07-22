# Visão Geral — Autenticação na Overlens

> Modelo mental de como o IDP funciona. Leia antes de implementar qualquer integração.
>
> **Última atualização:** 2026-07-18

---

## Arquitetura

O sistema de autenticação tem dois componentes:

| Serviço | URL | Responsabilidade |
|---|---|---|
| **IDP** (Identity Provider) | `idp.overlens.com.br` | API NestJS JSON-only. Autentica, emite tokens, expõe JWKS e OIDC discovery, gerencia OAuth clients. |
| **Accounts** (Frontend) | `accounts.overlens.com.br` | SPA React (Vite). Renderiza telas de login/signup/perfil/admin. Consome o IDP via JSON. |

O IDP **não renderiza HTML**. Telas são responsabilidade do Accounts.

---

## O IDP é a autoridade de perfil global

Além de autenticar, o IDP é a **fonte de verdade dos atributos de identidade que descrevem a mesma pessoa em qualquer app**: `email`, `name`, `username`, `phone`, `birthDate` e `avatar` (RFC-0001 / ADR-7). O critério: vai para o IDP o que é global; fica no app o que só faz sentido dentro dele (tema, título, progresso, gamificação, e papel/`role`).

Esses atributos **não viajam no JWT** (inchariam o token, que vai em todo request). Eles são lidos sob demanda:
- **perfil próprio** do usuário autenticado → `GET /auth/me` (ver [`profile.md`](./profile.md));
- **leitura M2M por `sub`** (qualquer usuário, backend confiável) → `GET /users/:sub` — **implementado** (scope `profile:read`, 600 req/min por client; ver [`m2m-profile-read.md`](./m2m-profile-read.md)).

O `avatar` é endereçado por URL determinística derivada do `sub` (`${AVATAR_CDN_BASE_URL}/avatars/{sub}` — em produção, `files.overlens.com.br`), sem URL a armazenar ou sincronizar (RFC-0001 §2.2). Ver `docs/rfc/`.

---

## Três modos de autenticação coexistem

O IDP atende três audiências, cada uma com seu fluxo:

### Modo A — OAuth 2.1 Authorization Code + PKCE (consumidores externos)

**Quem usa:** todo sistema integrado (Hodos, Events, app mobile, qualquer SPA/Next.js que precisa de SSO).

**Fluxo:**
```
Seu Sistema ──redirect──→ Accounts ──fetch──→ IDP
   (BFF)                   (SPA)              (API)
                             │
                             └──redirect com code──→ Seu Sistema
                                                       │
                                                       └──POST /auth/token──→ IDP  (back-channel)
                                                                                   │
                                                                                   └→ { access_token, refresh_token }
                                                                                      (JSON, não cookies)
```

O consumidor armazena os tokens como **preferir** (cookies próprios no seu domínio, sessão server-side, secure storage no mobile, etc.). Os tokens emitidos pelo IDP nesse modo são entregues como **JSON no body** de `POST /auth/token`, não como cookies.

Detalhes: [`login.md`](./login.md), [`signup.md`](./signup.md), [`oauth-clients.md`](./oauth-clients.md).

### Modo B — Sessão direta com cookies (interno do Accounts)

**Quem usa:** o frontend Accounts em si, e (excepcionalmente) qualquer SPA hospedada sob `*.overlens.com.br` que pode confiar nos cookies de domínio `.overlens.com.br`.

Endpoints: `POST /login`, `POST /signup`, `POST /login/google`, `POST /token/refresh`, `POST /logout`. Setam cookies `httpOnly` no domínio `.overlens.com.br` via `Set-Cookie`.

**Não use esse modo se você não é o Accounts** — consumidores externos não conseguem ler/escrever cookies em outro domínio, e mesmo sob `*.overlens.com.br` a recomendação é OAuth.

### Modo C — Client Credentials (M2M / serviço para serviço)

**Quem usa:** workers, crons, integrações server-to-server (ex: serviço de fractals chamando outra API da Overlens em nome próprio).

Endpoint: `POST /auth/token` com `grant_type=client_credentials`. Sem usuário, sem cookies, sem refresh token. Token tem TTL de 5 minutos. Autorização por **`scope`**.

Detalhes: [`m2m.md`](./m2m.md).

---

## Tokens emitidos

### Access token (JWT RS256)

Em todos os modos. Assinado com chave privada RSA do IDP, verificável por qualquer parte com acesso ao JWKS público.

| Modo | Payload | TTL |
|---|---|---|
| User (A ou B) | `sub`, `email`, `name`, `role`, `email_verified`, opcionalmente `new_user` | 15 min |
| M2M (C) | `sub` (= clientId), `client_id`, `scope` | 5 min |

Comuns: `iss`, `aud` (array), `iat`, `exp`. Header: `alg=RS256`, `kid=<RSA_KID>`.

### Refresh token

| Modo | Forma | TTL | Onde vive |
|---|---|---|---|
| A (OAuth) | Código opaco no body de `POST /auth/token` | 30 dias | Onde o consumer guardar (cookie próprio, etc.) |
| B (cookie-mode) | Código opaco em cookie `refresh_token` (httpOnly, `Path=/token/refresh`) | 30 dias | Browser do usuário, domínio `.overlens.com.br` |
| C (M2M) | — | — | Não existe; basta repetir a chamada |

Refresh é **opaco** (não JWT), armazenado como **sessão** na tabela `refresh_sessions` (uma linha por client × dispositivo — P2/ADR-0010; o banco guarda apenas o **sha256** do código, nunca plaintext), **rotacionado a cada uso** (single-use, a rotação atualiza a própria linha). Permite revogação imediata e **seletiva**: marcar `revokedAt` na linha invalida aquela sessão na próxima rotação, sem tocar as demais. A renovação só funciona para conta acessível (`blockedAt`/`deactivatedAt`/`deletedAt` nulos). TTL absoluto de **30 dias, renovado a cada rotação** (sliding — paridade com o `Max-Age` do cookie do modo B).

**Grace window na rotação (P1, agora POR SESSÃO):** reuso do código *anterior* daquela sessão dentro de `REFRESH_ROTATION_GRACE_MS` (default 60s; `0` desliga) é tolerado e devolve um novo access token + o refresh token **vivo atual da sessão** — corridas benignas (duas abas, duas instâncias serverless do BFF) não derrubam a sessão. Reuso **fora** da janela é replay real: **aquela sessão** é revogada antes do erro (`invalid_grant` no modo A; `401` no modo B) — as demais sessões do usuário sobrevivem.

**Binding por sessão (SEC-004):** cada sessão pertence ao caminho/client que a emitiu. Sessão OAuth só renova via `POST /auth/token` **pelo mesmo `client_id`**; sessão cookie (modo B) só renova via `POST /token/refresh`. Apresentar o token no caminho errado → falha (`invalid_grant`/`401`) sem afetar a sessão.

---

## Semântica de sessão e concorrência

> ✅ **Multi-sessão AGORA** (P2 / ADR-0010, contrato 1.4.0). Cada login/exchange cria uma **sessão de refresh independente** na tabela `refresh_sessions` — uma linha por client × dispositivo, para os modos A (OAuth) e B (cookie).

Consequências práticas:

1. **Login ou exchange em qualquer client/dispositivo NÃO derruba mais os demais.** Web + admin + Accounts (e múltiplos dispositivos do mesmo app) coexistem, cada um rotacionando a própria sessão. Cap de **10 sessões ativas por usuário**: ao criar a 11ª, a mais antiga (por último uso) é revogada.
2. **A grace window é POR SESSÃO.** `REFRESH_ROTATION_GRACE_MS` tolera corridas do **mesmo** token daquela sessão (duas abas/instâncias do mesmo consumer). Replay fora da janela revoga **só aquela sessão** — os outros apps/dispositivos do usuário não são afetados.
3. **Logout deixou de ser global — o escopo depende do caminho:**
   - `POST /logout` (cookie) revoga **só a sessão do cookie apresentado**;
   - `GET /auth/logout` (end-session) é **POR DISPOSITIVO desde o contrato 1.6.0** (P26 / ADR-0011): com o cookie interno `device_id` presente, revoga **todas as sessões daquele dispositivo** — a sessão SSO cookie-mode **e** os apps OAuth do mesmo browser (que herdam o `device_id` via o `authorization_code`) — deixando **os outros dispositivos** logados. Sem `device_id` (sessão legada pré-P26): fallback para **as sessões do client** resolvido (`client_id`/`id_token_hint`) ou, sem client, **TODAS** (semântica antiga);
   - `POST /auth/revoke` (RFC 7009) revoga **a sessão do token apresentado** (respeitando o binding de client);
   - **bloqueio/desativação/exclusão de conta revogam TODAS as sessões** do usuário.
   Detalhes por caminho: [`logout.md`](./logout.md).
4. **Para o seu error handling (inalterado):** trate `400 invalid_grant`/`401` no refresh como **falha definitiva daquela sessão** (revogada, expirada ou replay) — reautentique via redirect ao Accounts; o SSO cookie do IDP pode reautenticar sem fricção se ainda existir.

**Storage:** o banco guarda apenas `sha256(token)` — os códigos opacos crus só existem no cookie/consumer. Os campos legados `identity.refreshCode`/`refreshClientId` estão **deprecados** (serão dropados em release futura; ver CONTRACT-CHANGELOG 1.4.0).

---

## Payload JWT — referência

### Token de usuário

```json
{
  "sub": "cm7x2k3v40000abc123def456",
  "email": "usuario@exemplo.com",
  "name": "Fulana Beltrana",
  "role": "BASIC",
  "email_verified": true,
  "new_user": true,
  "iss": "https://idp.overlens.com.br",
  "aud": ["https://api.overlens.com.br"],
  "iat": 1748275200,
  "exp": 1748276100
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `sub` | CUID2 | ID único do usuário. Igual ao `id` na tabela `identity`. Use como chave em qualquer DB do ecossistema (correlação cross-service por valor, não por FK). |
| `email` | string | Email canônico (lowercase). |
| `name` | string | Nome de exibição. |
| `role` | `BASIC` \| `ADMIN` \| `SYSTEM` | **`@deprecated`** como fonte de autorização (RFC-0003). Reflete `identity.role`; não use para autorizar no seu app — mapeie `sub` → papel local. |
| `email_verified` | boolean | Verificação de email. |
| `new_user` | `true` \| ausente | `true` somente no JWT imediatamente após signup; ausente em logins seguintes. Use para roteamento de onboarding. |
| `iss` | URL | Issuer (configurável via `IDP_ISSUER`). |
| `aud` | string[] | Audiences (configurável via `IDP_AUDIENCE` CSV). |

### Token M2M

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

Diferenças do token de usuário: **sem** `email`/`name`/`role`/`email_verified`/`new_user`; **com** `client_id` e `scope`.

> Para distinguir no Resource Server: `payload.client_id && !payload.email` ⇒ M2M.

---

## Cookies

O IDP emite cookies httpOnly no **seu próprio domínio** em dois contextos:

- **Modo B (sessão direta):** `POST /login`, `POST /signup`, `POST /login/google`, `POST /token/refresh` — o caso clássico.
- **Fluxo OAuth (desde o contrato 1.5.0):** `POST /auth/authorize`, `POST /auth/authorize/google`, `POST /auth/signup` e `POST /auth/signup/google` **também** setam os cookies SSO httpOnly no domínio do IDP — é essa sessão SSO que habilita o login silencioso no próximo app. Os tokens do **consumer** continuam sendo entregues como JSON no `POST /auth/token` (nada muda no modo A do seu lado).

Atributos dos cookies:

| Atributo | Valor | Observação |
|---|---|---|
| `Domain` | `.overlens.com.br` (configurável via `IDP_COOKIE_DOMAIN`) | Cookie chega em todos os subdomínios. Em dev local, `IDP_COOKIE_DOMAIN=localhost` faz host-only. |
| `HttpOnly` | `true` | JS não lê. Protege contra XSS. |
| `Secure` | `true` (em prod; configurável via `IDP_COOKIE_SECURE`) | HTTPS only. |
| `SameSite` | `Lax` | Cross-subdomain mesmo registrable domain. Validado no SP001. |
| `Path` (access_token) | `/` | Enviado em toda request. |
| `Path` (refresh_token) | `/token/refresh` | Só viaja para o refresh. |
| `Max-Age` | 900 (access) / 2592000 (refresh) | Em segundos no header; em ms no Express. |

> **Cookie interno `device_id` (contrato 1.6.0):** além de `access_token`/`refresh_token`, o IDP mantém um cookie httpOnly `device_id` (`Path=/`, ~30 dias, **nunca limpo no logout**) que ancora o logout por dispositivo do `GET /auth/logout`. **Nenhum consumidor o lê** — o browser o envia automaticamente ao IDP. Ver [`logout.md`](./logout.md) §8.

---

## OIDC Discovery

O IDP expõe `GET /.well-known/openid-configuration` (RFC 8414). Permite que libs OIDC (Auth.js, oidc-client-ts, passport-openidconnect) auto-configurem `issuer`, `token_endpoint`, `authorization_endpoint`, `jwks_uri`, `userinfo_endpoint`, scopes/grants/algs suportados.

Detalhes: [`oidc-discovery.md`](./oidc-discovery.md).

---

## Fluxo Modo A — diagrama de sequência

```
Browser           Seu BFF                  Accounts SPA              IDP API
   |                |                           |                       |
   |── GET /login ─>|                           |                       |
   |                |── gera PKCE+state, set cookies tmp                |
   |<─302 redirect──|                           |                       |
   |                                            |                       |
   |── GET accounts.overlens.com.br/login?... ─>|                       |
   |                                            |── GET /auth/signup    |
   |                                            |   (ou prompt)         |
   |                                            |                       |
   |   Usuário preenche email+senha             |                       |
   |                                            |── POST /auth/authorize ─>
   |                                            |   { email, password, client_id, redirect_uri, code_challenge, state }
   |                                            |<─ { code, state } ────|
   |                                            |                       |
   |<───── window.location = seu-bff.com/cb?code=...&state=... ────────|
   |                                                                    |
   |── GET /cb?code=...&state=... ──> Seu BFF                           |
   |                | (valida state, lê code_verifier do cookie)        |
   |                |── POST /auth/token (server-to-server) ────────────>
   |                |   { grant_type: authorization_code,               |
   |                |     code, code_verifier, redirect_uri }           |
   |                |   Authorization: Basic <client_id:client_secret>  |
   |                |<─ { access_token, refresh_token,                  |
   |                |     token_type: "Bearer", expires_in: 900 } ──────|
   |                | (cria cookies de sessão no seu domínio)           |
   |<─ 302 /dashboard|                                                  |
```

Detalhamento de cada passo: [`login.md`](./login.md).

---

## Roles de usuário

| Role | Quem | Permissões |
|---|---|---|
| `BASIC` | Default em signup | Funcionalidades padrão |
| `ADMIN` | Promovido manualmente (SQL hoje) | Endpoints `/admin/*` no IDP; áreas admin nos consumers |
| `SYSTEM` | Reservado | Contas técnicas |

O `role` do JWT reflete `identity.role` e governa apenas os endpoints `/admin/*` do **próprio IDP**.

> ⚠️ **`role` está `@deprecated` como fonte de autorização para consumidores (RFC-0003 / ADR-8).** Papel/permissão é **contextual de app**: o IDP autentica, **cada app autoriza**. Não use `role` do token para autorizar no seu Resource Server — mapeie `sub` → papel local no seu domínio. O claim continua presente (sem breaking change) e será removido em versão major futura.

---

## Endpoints — visão completa

### Públicos (sem autenticação)
| Endpoint | Uso |
|---|---|
| `GET /health` | Healthcheck Railway |
| `GET /.well-known/jwks.json` | Chave pública para Resource Servers |
| `GET /.well-known/openid-configuration` | OIDC discovery |
| `GET /auth/authorize` | Início do code flow (valida client/redirect/PKCE) |
| `POST /auth/authorize` | Submissão de email+senha → code |
| `POST /auth/authorize/google` | Submissão de id_token Google → code |
| `GET /auth/signup` | Validação preliminar do client para signup |
| `POST /auth/signup` | Signup OAuth-aware → code |
| `POST /auth/signup/google` | Signup Google OAuth-aware → code |
| `POST /auth/token` | Troca de code, refresh, ou client_credentials |
| `POST /auth/revoke` | Revogação de refresh token (RFC 7009; exige autenticação do client — ver [`logout.md`](./logout.md) §3) |
| `GET /auth/logout` | End-session (RP-Initiated Logout) — `302`, limpa cookies e revoga por dispositivo (ver [`logout.md`](./logout.md) §8) |
| `POST /login` | Login modo cookie (Accounts) |
| `POST /signup` | Signup modo cookie (Accounts) |
| `POST /login/google` | Login Google modo cookie (Accounts; feature flag `idp_google-auth` — flag desligada → `404`) |
| `POST /token/refresh` | Refresh modo cookie |
| `POST /logout` | Logout modo cookie |
| `GET /docs` / `GET /docs-json` | Swagger UI / documento OpenAPI (machine-readable) |
| `POST /test/login` | Login headless de teste — existe **somente** com `IDP_TEST_MODE=true` (nunca em produção; ver [`run-local-container.md`](./run-local-container.md)) |

### Autenticados (cookie `access_token` ou `Authorization: Bearer`)
| Endpoint | Quem pode |
|---|---|
| `GET /auth/me` | Qualquer usuário autenticado |
| `GET /auth/me/email` | Qualquer usuário autenticado (rate-limited) |
| `PATCH /auth/me` | Qualquer usuário autenticado |
| `POST /auth/me/password` | Qualquer usuário autenticado |
| `POST /auth/me/deactivate` | Qualquer usuário autenticado |
| `DELETE /auth/me` | Qualquer usuário autenticado |
| `POST /auth/me/avatar/upload-url` | Qualquer usuário autenticado (presigned PUT S3 — ver [`update-avatar.md`](./update-avatar.md)) |
| `PATCH /auth/me/avatar` | Qualquer usuário autenticado (confirma o upload) |
| `DELETE /auth/me/avatar` | Qualquer usuário autenticado (remove o avatar) |
| `GET /auth/userinfo` | Qualquer Bearer válido (OIDC) |

### M2M (Bearer `client_credentials`)
| Endpoint | Uso |
|---|---|
| `GET /users/:sub` | Perfil global de qualquer usuário — scope `profile:read`, 600 req/min por client (ver [`m2m-profile-read.md`](./m2m-profile-read.md)) |

### Admin (cookie/Bearer com `role=ADMIN` — M2M rejeitado)
| Endpoint | Uso |
|---|---|
| `GET /admin/stats` | Dashboard de identidades e atividade |
| `POST /admin/users/:id/block` | Bloquear usuário (revoga todas as sessões de refresh do usuário em `refresh_sessions`) |
| `POST /admin/clients` + CRUD (incl. `GET /admin/clients/:id/audit-log`) | Gerenciar OAuth Clients (referência completa em [`oauth-clients.md`](./oauth-clients.md)) |

---

## Glossário

| Termo | Definição |
|---|---|
| **JWT** | JSON Web Token, assinado RS256. |
| **RS256** | Algoritmo assimétrico: chave privada assina, chave pública verifica. |
| **JWKS** | JSON Web Key Set (RFC 7517) — endpoint público com a chave pública. |
| **OIDC Discovery** | Documento `/.well-known/openid-configuration` (RFC 8414) com URLs e capabilities. |
| **PKCE** | Proof Key for Code Exchange (RFC 7636). Protege code flow contra interceptação. Sempre S256. |
| **Authorization Code** | Token efêmero (5min, single-use) trocado por access+refresh em `/auth/token`. Armazenado em `authorization_codes`. |
| **Confidential client** | Tem `client_secret`. Tipicamente web BFF, M2M. |
| **Public client** | Sem secret; segurança via PKCE. Mobile, SPA-only. |
| **Scope** | Permissão de granularidade fina (ex: `fractals:debit`). Validado no Resource Server. |
| **Resource Server** | Backend que aceita JWT do IDP via cookie ou Bearer. |
| **httpOnly** | Atributo de cookie que impede leitura via JS. |
| **SameSite=Lax** | Restrição de envio cross-site. Permite top-level navigation, bloqueia POSTs cross-site. |
| **CUID2** | ID gerado: `cm7x2k3v40000abc123def456`. Compartilhado entre `identity` (IDP) e `plataforma`. |
