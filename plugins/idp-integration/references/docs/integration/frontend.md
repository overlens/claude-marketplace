# Guia de Integração — Frontend

> **Última atualização:** 2026-07-18
>
> ⚠️ **Decisão antes de continuar:** este guia tem três seções de público diferente. Não pule.

---

## 0. Qual seção é a sua

| Você está construindo... | Vá para |
|---|---|
| Um frontend integrado com SSO Overlens (Next.js, Vite, qualquer SPA fora `*.overlens.com.br`) | **§1. Frontends OAuth (caminho padrão)** |
| Um app mobile / SPA pública sem backend, que troca o code no próprio device | **§2. Public clients (PKCE-only)** |
| O próprio Accounts ou uma SPA hospedada sob `*.overlens.com.br` que usa os cookies do IDP diretamente | **§3. Apêndice — Modo sessão direta (uso interno)** |

> Se chamar `POST https://idp.overlens.com.br/login` direto do seu frontend não é o caminho. CORS bloqueia (regex `\.overlens\.com\.br$` em prod), cookies de outro domínio não chegam, e mesmo se chegassem, sua app não conseguiria propagá-los como autenticação para suas próprias APIs. Use OAuth.

---

## 1. Frontends OAuth (caminho padrão)

### 1.1 Modelo

```
[Browser do usuário]
   │
   │ 1. clica "Entrar"
   ▼
[Seu Frontend]                                              [Accounts]                              [IDP API]
   │                                                            │                                       │
   │ 2. (server-side) gera PKCE + state, salva em cookies tmp   │                                       │
   │ 3. redirect → accounts.overlens.com.br/login?client_id=... │                                       │
   ├───────────────────────────────────────────────────────────►│                                       │
   │                                                            │ 4. coleta credenciais                 │
   │                                                            │ 5. POST /auth/authorize ─────────────►│
   │                                                            │◄── { code, state } ───────────────────│
   │ 6. redirect → seu-frontend.com/cb?code=...&state=...       │                                       │
   │◄───────────────────────────────────────────────────────────│                                       │
   │ 7. (server-side) POST /auth/token (com client_secret) ─────────────────────────────────────────────►
   │◄────────────── { access_token, refresh_token, expires_in: 900 } ──────────────────────────────────│
   │ 8. cria sessão local no SEU domínio                                                               │
   │    (cookies httpOnly próprios)                                                                    │
   ▼
[seu frontend autenticado]
```

**Pontos centrais:**
- O frontend nunca chama o IDP diretamente. Quem chama o IDP é o seu **backend** (BFF), com `client_secret`.
- O frontend só faz **redirect** para `accounts.overlens.com.br/...` e recebe o callback.
- Os tokens emitidos pelo IDP no `POST /auth/token` voltam **como JSON**, e seu backend monta a sessão local como preferir.

### 1.2 Implementação

Implementação detalhada (Server Action + Route Handler + PKCE + state + token exchange + renovação) está em [`login.md`](./login.md) e [`signup.md`](./signup.md). Use esses guides como referência canônica de código.

### 1.3 O que o frontend (UI) precisa expor

- Botões "Entrar" e "Criar conta" que disparem Server Actions / Route Handlers que executem **passo 2-3** acima.
- Página de callback em `/api/auth/callback` que execute **passo 7-8**.
- Botão "Sair" que apague a sessão local — ver [`logout.md`](./logout.md), §3.
- Tratamento de `401` da sua própria API: tentar refresh (silencioso, `POST /auth/token` com `grant_type=refresh_token`), e em caso de falha, redirect para `/login`.

### 1.4 Comunicação com suas APIs (Resource Servers)

Suas APIs ficam atrás de seu BFF, ou são chamadas diretamente do browser? Duas formas:

**Forma A — via BFF (recomendado):** o browser chama `seu-frontend.com/api/...`, o BFF anexa `Authorization: Bearer <access_token>` na request para `api.seuapp.overlens.com.br`. Token nunca toca o browser.

**Forma B — direto do browser:** seu frontend SPA usa o `access_token` propagado por algum meio (não recomendado se sua app não está sob `*.overlens.com.br`). Se sua API e seu frontend forem o mesmo domínio raiz, pode-se usar cookies próprios.

---

## 2. Public clients (PKCE-only, sem backend)

Para apps mobile (React Native, Expo, iOS/Android nativo) e SPAs sem backend confiável.

### 2.1 Diferenças do §1

- O OAuth Client é registrado com `isPublic: true` — **não tem** `client_secret`.
- O token exchange acontece **no próprio device/SPA**, não num backend.
- A segurança é PKCE puro: o `code_verifier` jamais sai do device, e o servidor só aceita o code se o verifier hashear no `code_challenge` previamente enviado.
- `redirectUris` para mobile usa deep link (`overlens://callback`, `com.empresa.app://...`).

### 2.2 Fluxo

```
[App Mobile]                                                 [Accounts]                              [IDP API]
   │ 1. gera code_verifier + code_challenge (S256)              │                                       │
   │ 2. abre ASWebAuthenticationSession / Custom Tab            │                                       │
   │    → accounts.overlens.com.br/login?client_id=overlens-mobile&redirect_uri=overlens://callback&...│
   ├───────────────────────────────────────────────────────────►│                                       │
   │                                                            │ 3. usuário autentica                  │
   │                                                            │ 4. POST /auth/authorize ─────────────►│
   │                                                            │◄── { code, state } ───────────────────│
   │ 5. browser → overlens://callback?code=...&state=...        │                                       │
   │◄───────────────────────────────────────────────────────────│                                       │
   │ 6. POST /auth/token (do device, sem client_secret) ─────────────────────────────────────────────────►
   │    { grant_type: authorization_code, code, code_verifier, client_id, redirect_uri }                │
   │◄───────────── { access_token, refresh_token, expires_in: 900 } ───────────────────────────────────│
   │ 7. guarda tokens em secure storage (Keychain / EncryptedSharedPreferences)                        │
```

### 2.3 Token exchange — request

```http
POST https://idp.overlens.com.br/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
code=<code>
code_verifier=<original verifier>
client_id=overlens-mobile
redirect_uri=overlens://callback
```

Sem `Authorization: Basic`. Sem `client_secret`. Se o IDP detectar que o client é público e `client_secret` foi enviado, ainda aceita; mas o caminho idiomático é omitir.

### 2.4 Refresh

```http
POST /auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
refresh_token=<token>
client_id=overlens-mobile
```

O refresh é rotacionado: cada chamada invalida o token anterior. Guarde o novo.

### 2.5 Guarda de tokens em mobile

- **iOS:** Keychain (`SecItemAdd`).
- **Android:** EncryptedSharedPreferences ou Android Keystore.
- **Nunca** `localStorage`/`AsyncStorage` em texto plano para refresh tokens.

---

## 3. Apêndice — Modo sessão direta (uso interno do Accounts)

> Não use este modo se você não é o Accounts ou outra SPA sob `*.overlens.com.br` com permissão explícita.

### 3.1 Endpoints

`POST /login`, `POST /signup`, `POST /login/google`, `POST /token/refresh`, `POST /logout`. Todos retornam `Set-Cookie` para domínio `.overlens.com.br`.

> Além de `access_token`/`refresh_token`, o IDP mantém um cookie interno `device_id` (httpOnly, ~30 dias, nunca limpo no logout), usado pelo logout por dispositivo (`GET /auth/logout` — ver [`logout.md`](./logout.md) §8). **Não leia nem envie esse cookie manualmente** — o browser cuida disso.

### 3.2 Chamadas (Accounts)

```javascript
// Toda chamada precisa de credentials: 'include' para cookies cross-subdomain
fetch('https://idp.overlens.com.br/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
```

### 3.3 Renovação silenciosa

```javascript
// Padrão de interceptor para "tentar refresh em 401"
async function tryRefresh() {
  const res = await fetch('https://idp.overlens.com.br/token/refresh', {
    method: 'POST',
    credentials: 'include',
  });
  return res.ok;
}
```

### 3.4 Logout

`POST /logout` limpa cookies via `Set-Cookie: Max-Age=0` e revoga **a sessão do cookie apresentado** em `refresh_sessions` (P2 — as sessões de outros dispositivos/apps do usuário sobrevivem). Idempotente.

### 3.5 Por que não usar fora do Accounts

- Cookies só chegam em hostnames sob `.overlens.com.br`. Domínios externos não os recebem.
- Mesmo dentro de `*.overlens.com.br`, depender desse caminho acopla seu sistema ao IDP de um jeito que não escala para mobile, M2M ou consumers externos. OAuth é o caminho padrão.
- A feature flag `idp_google-auth` controla `POST /login/google`. Sem PostHog configurado ou com a flag desativada, esse endpoint retorna **`404`** (o `FeatureFlagGuard` responde Not Found — o endpoint "não existe" enquanto a flag estiver off).

### 3.6 Endpoints autenticados de perfil

Quando o Accounts (ou outra SPA `*.overlens.com.br`) usa esse modo, os endpoints `/auth/me*` ficam disponíveis com o cookie `access_token`. Ver [`profile.md`](./profile.md).

---

## 4. Erros comuns — referência

| Status | Endpoint | Causa | Ação |
|---|---|---|---|
| `400` | `/auth/token` | `grant_type` inválido, code expirado, PKCE não bate | Mostrar "Erro de autenticação. Tente novamente." e voltar para login |
| `400 invalid_grant` (`error_description: "Account is not accessible"`) | `/auth/token` (exchange **e** refresh) | Conta inacessível — bloqueada, desativada ou excluída (a resposta **não revela qual**, de propósito) | **Falha definitiva de sessão**: apague a sessão local e redirecione ao login. Não faça retry. |
| `400` | `/auth/authorize` | `client_id` desconhecido, `redirect_uri` não registrado, `code_challenge_method != S256` | Erro de configuração do client — não é problema do usuário |
| `400 invalid_request` | `/auth/revoke` | `token` ausente no body | Bug de integração — envie `token=<refresh_token>` |
| `401` | `/login`, `/auth/authorize` | Credenciais inválidas **ou conta inacessível** (mesma resposta genérica) | "Email ou senha incorretos." (mensagem genérica — não revele qual) |
| `401` | `/auth/token`, `/auth/revoke` | `client_secret` errado ou client desconhecido | Erro de configuração — verifique env vars |
| `401` | `/token/refresh` | Refresh expirado/usado/**conta inacessível** | **Falha definitiva de sessão**: redirect para `/login`, sem retry |
| `404` | `/login/google` | Feature flag `idp_google-auth` desativada (o `FeatureFlagGuard` retorna Not Found — não `403`) | Esconder botão Google até ativar a flag |
| `409` | `/signup`, `/auth/signup` | Email já cadastrado | "Email já cadastrado" + link "Entrar" |
| `429` | qualquer auth endpoint | Rate limit **ativo** — login/signup 10/min, token/refresh 30/min, demais 60/min, por IP (ver [`rate-limiting.md`](../deploy/rate-limiting.md)) | Falha **transitória** (≠ sessão morta): aguarde o header `Retry-After` e re-tente. UI: "Muitas tentativas. Aguarde alguns minutos." |
| `5xx` | qualquer | Erro do IDP | "Serviço indisponível. Tente novamente." |

> **Matriz conta inacessível × fluxo** (bloqueada/desativada/excluída — sempre a MESMA resposta genérica): fluxo OAuth (`/auth/token`) → `400 invalid_grant`; fluxo cookie (`/token/refresh`) → `401`; SSO (`GET /auth/authorize` com cookie de conta inacessível) → `200 { status: "login_required" }` (não é erro — trate como "sem sessão"). **Trate `400 invalid_grant` e `401` como falha definitiva**: sessão morta, sem retry. Detalhe em [`backend.md`](./backend.md) §8.

---

## 5. Checklist mínimo

### Para Frontends OAuth (§1)
- [ ] BFF/server-side faz redirect para `accounts.overlens.com.br/login?...`
- [ ] PKCE gerado server-side (`code_verifier` em cookie tmp httpOnly)
- [ ] `state` em cookie tmp httpOnly e validado no callback
- [ ] Token exchange acontece server-side (`client_secret` nunca no browser)
- [ ] Sessão local em cookies httpOnly do **seu domínio** (não `.overlens.com.br`)
- [ ] Refresh silencioso ao receber 401 da sua própria API
- [ ] Logout apaga sessão local (ver [`logout.md`](./logout.md))

### Para Public clients (§2)
- [ ] Client registrado com `isPublic: true`
- [ ] PKCE S256 obrigatório
- [ ] Deep link como `redirect_uri`
- [ ] Tokens em secure storage (Keychain / EncryptedSharedPreferences)
- [ ] Token exchange feito do device, sem `client_secret`

### Para SPAs sob `*.overlens.com.br` (§3 — uso interno)
- [ ] Todas as chamadas usam `credentials: 'include'`
- [ ] Nenhum token guardado em `localStorage`/`sessionStorage`
- [ ] Refresh via `POST /token/refresh` no 401
- [ ] Mensagens de erro genéricas (não revelam se email existe)
