# Guia de Integração — OIDC Discovery

> O IDP é compatível com OpenID Connect Discovery (RFC 8414) e expõe um documento que permite a libs OIDC se auto-configurarem.
>
> **Última atualização:** 2026-07-18

---

## 1. Endpoint

```
GET https://idp.overlens.com.br/.well-known/openid-configuration
Cache-Control: public, max-age=86400
```

Sem autenticação. Cache de 24h (mude apenas em redeploy ou alteração de `IDP_BASE_URL` / `IDP_ISSUER`).

### Response 200

```jsonc
{
  "issuer": "https://idp.overlens.com.br",
  "authorization_endpoint": "https://idp.overlens.com.br/auth/authorize",
  "token_endpoint": "https://idp.overlens.com.br/auth/token",
  "jwks_uri": "https://idp.overlens.com.br/.well-known/jwks.json",
  "userinfo_endpoint": "https://idp.overlens.com.br/auth/userinfo",
  "end_session_endpoint": "https://idp.overlens.com.br/auth/logout",
  "revocation_endpoint": "https://idp.overlens.com.br/auth/revoke",
  "revocation_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
  "scopes_supported": ["openid", "profile", "email"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
  "claims_supported": ["sub", "email", "name", "email_verified", "iss", "aud", "iat", "exp"],
  "code_challenge_methods_supported": ["S256"]
}
```

| Campo | Valor / Significado |
|---|---|
| `issuer` | Igual ao claim `iss` dos JWTs. Configurável via `IDP_ISSUER`. |
| `authorization_endpoint` | Onde redirecionar para iniciar code flow. |
| `token_endpoint` | Onde trocar code por tokens / fazer refresh / pedir M2M. |
| `jwks_uri` | Chaves públicas (RFC 7517). |
| `userinfo_endpoint` | Endpoint Bearer-only — retorna claims do token. |
| `end_session_endpoint` | RP-Initiated Logout (encerra a sessão SSO). Ver [`logout.md`](./logout.md). |
| `revocation_endpoint` | `POST /auth/revoke` (RFC 7009) — revoga refresh tokens. Ver [`logout.md`](./logout.md) §3. |
| `revocation_endpoint_auth_methods_supported` | Mesmos métodos do token endpoint: `client_secret_basic`, `client_secret_post`, `none`. |
| `scopes_supported` | Scopes padrão OIDC. Scopes M2M custom (ex: `fractals:debit`) **não** são listados aqui — são per-client. |
| `response_types_supported` | Apenas `code` (sem implicit, sem hybrid). |
| `grant_types_supported` | `authorization_code`, `refresh_token`, `client_credentials`. **Sem** `password`, **sem** `revoke` (revogação é via `revocation_endpoint`, não via grant). |
| `token_endpoint_auth_methods_supported` | `client_secret_basic` (Authorization header), `client_secret_post` (body), `none` (PKCE-only para public clients). |
| `id_token_signing_alg_values_supported` | Apenas `RS256`. |
| `code_challenge_methods_supported` | Apenas `S256`. |
| `claims_supported` | Claims expostos em user JWT. M2M tem `client_id` e `scope` adicionalmente (não listados — fora do escopo OIDC padrão). |

> ### ⚠️ O `authorization_endpoint` responde JSON — não 302
>
> Diferente de um OIDC Provider clássico, `GET`/`POST /auth/authorize` **não redirecionam**:
> respondem `200` com JSON — `{ "code": "...", "state": "..." }` (sessão SSO válida ou
> credenciais aceitas) ou `{ "status": "login_required", ... }` (sem sessão). O redirect do
> browser de volta ao `redirect_uri` é responsabilidade da **SPA Accounts**
> (`accounts.overlens.com.br`), que consome esses JSONs.
>
> **Impacto:** libs OIDC genéricas que tratam o `authorization_endpoint` como um endpoint de
> redirect (openid-client, oidc-client-ts, Auth.js, passport-openidconnect, Spring Security)
> **não completam o passo de autorização sem adaptação** — aponte o browser para o Accounts
> (`accounts.overlens.com.br/login?client_id=...`) em vez do `authorization_endpoint`, e use a
> lib apenas no back-channel (`token_endpoint`, `jwks_uri`, `userinfo_endpoint`,
> `revocation_endpoint` — todos 100% padrão). Fluxo completo: [`login.md`](./login.md) §1–§2.
>
> **Automação/e2e:** com `IDP_TEST_MODE=true` (nunca em produção), `POST /test/login` emite
> sessão/code de teste sem passar pelo Accounts — ver [`run-local-container.md`](./run-local-container.md).

> ### ⚠️ `aud` do `id_token` é string; `aud` do access token é array
>
> Assimetria deliberada (OpenID Connect Core 1.0): no **`id_token`**, `aud` é a **string**
> `client_id` (ex.: `"hodos"`); no **access token** (user e M2M), `aud` é **array** de
> audiences (ex.: `["https://api.overlens.com.br"]`). Consumidores OIDC genéricos **não devem
> normalizar** um para o formato do outro — validação de `id_token` espera a string; validação
> de access token espera o array. Fontes canônicas: `packages/idp-token-core/src/claims/id-token-payload.ts`
> e `user-jwt-payload.ts`.

---

## 2. Quando usar

Use o documento de discovery quando:

- Você integra com uma lib OIDC genérica (Auth.js, openid-client, oidc-client-ts, passport-openidconnect, Spring Security OAuth, etc.).
- Você quer evitar hardcoded URLs no seu Resource Server — basta apontar para o `issuer`.
- Você precisa adaptar automaticamente caso URLs mudem (ex: staging vs prod).

Não use quando:

- Você está debugando manualmente — neste caso, ler [`login.md`](./login.md) direto é mais didático.
- Você é um cliente M2M (`client_credentials`) — Discovery não acrescenta nada além do `token_endpoint`, que você já conhece.

---

## 3. `GET /auth/userinfo`

Endpoint do OIDC para obter claims do usuário a partir de um Bearer token. **Stateless** — decodifica o JWT e retorna; zero acesso ao DB.

### Request

```
GET https://idp.overlens.com.br/auth/userinfo
Authorization: Bearer <user access token>
```

### Response 200

```json
{
  "sub": "ckxxx...",
  "email": "usuario@exemplo.com",
  "name": "Fulana Beltrana",
  "email_verified": true
}
```

### Erros

| HTTP | `error` | Causa |
|---|---|---|
| `401` | `invalid_token` | Header Bearer ausente, JWT inválido, expirado, issuer/aud errados |

Headers de erro incluem `WWW-Authenticate: Bearer error="invalid_token"`.

### M2M no `/auth/userinfo`

Tokens M2M aceitam neste endpoint, mas a resposta terá apenas:
```json
{ "sub": "fractals-service", "email": null, "name": null, "email_verified": false }
```
porque M2M não tem `email`/`name`. Em geral, **não chame `/auth/userinfo` com token M2M** — não é semanticamente útil. Use o claim `client_id` direto do token.

---

## 4. Receitas

> ⚠️ **Antes de copiar:** as receitas abaixo configuram o **back-channel** corretamente, mas o
> passo de **autorização** não funciona out-of-the-box — o `authorization_endpoint` do IDP
> responde JSON, não 302 (ver aviso na §1). Em todas elas você precisa apontar o redirect
> inicial do browser para o **Accounts** (`accounts.overlens.com.br/login?...`) em vez de
> deixar a lib montar a URL do `authorization_endpoint`. O padrão recomendado continua sendo o
> BFF manual de [`login.md`](./login.md).

### 4.1 Auth.js (NextAuth)

```ts
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';

const handler = NextAuth({
  providers: [{
    id: 'overlens',
    name: 'Overlens',
    type: 'oauth',
    wellKnown: 'https://idp.overlens.com.br/.well-known/openid-configuration',
    clientId: process.env.IDP_CLIENT_ID!,
    clientSecret: process.env.IDP_CLIENT_SECRET!,
    authorization: { params: { scope: 'openid profile email' } },
    idToken: false,                  // o IDP emite access_token; idToken só sai se você pedir explicitamente
    checks: ['pkce', 'state'],
    profile(profile) {
      return { id: profile.sub, email: profile.email, name: profile.name };
    },
  }],
});

export { handler as GET, handler as POST };
```

A lib resolve `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, `jwks_uri` automaticamente.

### 4.2 openid-client (Node)

```ts
import { Issuer } from 'openid-client';

const issuer = await Issuer.discover('https://idp.overlens.com.br');
const client = new issuer.Client({
  client_id: process.env.IDP_CLIENT_ID!,
  client_secret: process.env.IDP_CLIENT_SECRET!,
  redirect_uris: [process.env.IDP_REDIRECT_URI!],
  response_types: ['code'],
});

// ... use client.authorizationUrl(), client.callback(), client.refresh(), client.userinfo(token)
```

### 4.3 Passport OpenID Connect

```ts
import { Strategy as OidcStrategy } from 'passport-openidconnect';

passport.use(new OidcStrategy({
  issuer: 'https://idp.overlens.com.br',
  authorizationURL: 'https://idp.overlens.com.br/auth/authorize',
  tokenURL: 'https://idp.overlens.com.br/auth/token',
  userInfoURL: 'https://idp.overlens.com.br/auth/userinfo',
  clientID: process.env.IDP_CLIENT_ID!,
  clientSecret: process.env.IDP_CLIENT_SECRET!,
  callbackURL: process.env.IDP_REDIRECT_URI!,
  scope: ['openid', 'profile', 'email'],
}, /* verify callback */));
```

Algumas versões mais novas aceitam só `issuer` e fazem discovery automático.

---

## 5. ⚠️ Limites de conformidade OIDC

O IDP **não é** um OIDC Provider 100% conformante. Diferenças importantes:

| Feature OIDC padrão | Status no IDP |
|---|---|
| `authorization_endpoint` com redirect 302 | **Não** — `GET`/`POST /auth/authorize` respondem **JSON** (`{code,state}` ou `{status:"login_required"}`); o redirect é feito pela SPA Accounts. Libs que esperam 302 precisam de adaptação (ver §1). |
| `id_token` no `POST /auth/token` | Emitido **somente** se o client pedir `openid` no `scope` E o `ExchangeCodeUseCase` produzir. Verifique campo `id_token` no response. |
| `aud` do `id_token` | **String** (= `client_id`), conforme OIDC Core — enquanto access/M2M tokens usam `aud` **array**. Não normalizar (ver §1). |
| `nonce` parameter | Não validado (não aceita). |
| `response_type=id_token` (implicit) | Não suportado — apenas `code`. |
| `prompt=none` (silent auth) | O parâmetro literal `prompt=none` **não é parseado** — mas o **silent SSO front-channel existe**: o probe `GET /auth/authorize` responde JSON `{ code, state }` (sessão SSO válida) ou `{ status: "login_required" }` (sem sessão), e é assim que o Accounts faz o SSO silencioso (com um `POST /token/refresh` único se o access token da sessão expirou). Consumers que usam o Accounts como front **não precisam** de `prompt=none`. Ver [`login.md`](./login.md) §2. |
| `acr_values`, `max_age` | Não suportados. |
| Refresh token rotation | Suportado (single-use, rotacionado em todo refresh; janela de tolerância `REFRESH_ROTATION_GRACE_MS` para corridas benignas). |
| Endpoint `/auth/revoke` (RFC 7009) | ✅ **Implementado** — revoga refresh tokens; `access_token` hint é no-op (JWT sem blocklist). Ver [`logout.md`](./logout.md) §3. |
| Dynamic Client Registration (RFC 7591) | Não suportado — registro via API admin (`/admin/clients`). |
| RP-Initiated Logout | ✅ **Suportado** — `end_session_endpoint` = `GET /auth/logout` (anunciado no discovery). Ver [`logout.md`](./logout.md) §8. |
| Session Management por iframe (`check_session_iframe`) / back-channel e front-channel logout (specs OIDC) | Não suportados — a revogação server-side do end-session é imediata, mas os apps só percebem no próximo silent refresh (≤ 15 min). |

Para libs estritamente compliant, essas lacunas podem causar warnings ou erros — verifique a config da lib para flexibilizar (ex: Auth.js: `checks: ['pkce', 'state']` em vez de `['nonce']`).

---

## 6. Validação rápida

```bash
# Discovery doc bem formado e issuer canônico
curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq '.issuer'

# Endpoints corretos
curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq '{authorization_endpoint, token_endpoint, jwks_uri, userinfo_endpoint}'

# JWKS bate com o discovery
JWKS=$(curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq -r .jwks_uri)
curl -s "$JWKS" | jq '.keys[0] | {kty, alg, use, kid}'

# userinfo com Bearer real
curl -s -H "Authorization: Bearer <jwt>" https://idp.overlens.com.br/auth/userinfo | jq .
```

---

## 7. Checklist

- [ ] Sua lib OIDC aponta para `https://idp.overlens.com.br` (issuer) — não para URLs hardcoded
- [ ] `scope` requisitado contém apenas `openid`, `profile`, `email` (scopes custom existem só para M2M)
- [ ] PKCE habilitado (S256) — obrigatório no IDP
- [ ] Sem `nonce` parameter (não validado)
- [ ] Sem `response_type=id_token` (não suportado — use code flow)
- [ ] Cache do discovery doc no client com TTL ≤ 24h
