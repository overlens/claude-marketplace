# Guia de Integração — Login Centralizado

> **Para Claude Code:** Este guia explica como integrar o login centralizado da Overlens
> em um sistema Next.js (App Router). Exemplos são funcionais e testados — copie e adapte.
>
> **Última atualização:** 2026-07-18 (contrato 1.6.0)

---

## 1. Arquitetura do fluxo

O login da Overlens envolve **três participantes**:

| Participante | URL | Papel |
|---|---|---|
| **Seu Sistema** (ex: Hodos) | `hodos.com.br` | Redireciona o usuário para login, recebe o callback com o `code` |
| **Accounts** (frontend) | `accounts.overlens.com.br` | Renderiza o formulário de login/signup, coleta credenciais |
| **IDP** (API) | `idp.overlens.com.br` | Autentica o usuário, emite authorization code e tokens JWT |

**Regra fundamental:** Seu sistema redireciona o browser para o **Accounts** (não para o IDP). O IDP é uma API JSON-only consumida internamente pelo Accounts e pelo seu backend (server-to-server).

> ⚠️ **O `authorization_endpoint` responde JSON, não 302.** `GET`/`POST /auth/authorize`
> devolvem `200` com body JSON — `{ "code": "...", "state": "..." }` quando há
> sessão/credencial válida, ou `{ "status": "login_required", ... }` quando não há.
> Quem faz o redirect do browser de volta ao seu `redirect_uri` é a **SPA Accounts**
> (`window.location.href = redirect_uri?code=...&state=...`), nunca o IDP.
>
> Consequência: **libs OIDC genéricas que esperam um 302 no `authorization_endpoint`**
> (openid-client em modo redirect, passport-openidconnect, Auth.js no passo de
> autorização) **não funcionam contra o IDP sem adaptação** — o passo de autorização
> é sempre via redirect ao Accounts. O back-channel (`token_endpoint`, `jwks_uri`,
> `userinfo_endpoint`, `revocation_endpoint`) é 100% padrão e funciona com qualquer lib.
>
> **Automação/testes:** não tente scriptar o formulário do Accounts — com
> `IDP_TEST_MODE=true` (jamais em produção), `POST /test/login` emite sessão/code
> de teste diretamente. Ver [`run-local-container.md`](./run-local-container.md) e
> [`../deploy/idp-test-sandbox.md`](../deploy/idp-test-sandbox.md).

---

## 2. Fluxo end-to-end (Login)

```
Seu Sistema (Hodos)              Accounts SPA                     IDP API
       |                              |                              |
  1. Usuário clica "Entrar"           |                              |
  2. Gera PKCE + state,              |                              |
     armazena em cookies httpOnly     |                              |
       |                              |                              |
  3. redirect browser ──────────────→ |                              |
     accounts.overlens.com.br/login   |                              |
     ?client_id=hodos                 |                              |
     &redirect_uri=hodos.com.br/cb    |                              |
     &code_challenge=XYZ              |                              |
     &code_challenge_method=S256      |                              |
     &state=ABC                       |                              |
       |                              |                              |
                                 4. Renderiza formulário             |
                                    (email + senha + Google)         |
                                      |                              |
                                 5. Usuário preenche e submete       |
                                      |                              |
                                 6. fetch POST ──────────────────→   |
                                    /auth/authorize                  |
                                    { email, password,               |
                                      client_id, redirect_uri,      |
                                      code_challenge, state }        |
                                      |                              |
                                      |  7. IDP autentica,           |
                                      |     gera authorization code  |
                                      |                              |
                                 8. ← { code: "CODE", state: "ABC" }|
                                      |                              |
                                 9. window.location.href =           |
                                    hodos.com.br/cb                  |
                                    ?code=CODE&state=ABC             |
                                      |                              |
 10. Callback recebe code ←           |                              |
     valida state, recupera           |                              |
     code_verifier do cookie          |                              |
       |                              |                              |
 11. POST /auth/token (server) ─────────────────────────────────→    |
     { grant_type: authorization_code,                               |
       code, code_verifier,                                          |
       client_id, client_secret }                                    |
       |                                                             |
 12. ← { access_token (JWT), refresh_token, expires_in: 900 }       |
       |                                                             |
 13. Cria sessão local,              |                              |
     redireciona para /dashboard      |                              |
```

> **Sessão SSO do IDP (contrato 1.5.0):** no passo 7-8, o IDP também seta os
> cookies httpOnly `access_token`/`refresh_token` no domínio do IDP — é essa
> sessão que habilita o SSO silencioso (`GET /auth/authorize` responde `{ code }`
> sem credenciais no próximo app). Desde a 1.5.0 **todos** os caminhos de
> autenticação do fluxo OAuth estabelecem essa sessão: e-mail+senha
> (`POST /auth/authorize`), **Google** (`POST /auth/authorize/google`) e
> **signup** (`POST /auth/signup[/google]` — ver [`signup.md`](./signup.md)).
> Antes, apenas o caminho e-mail setava os cookies — usuários Google e
> recém-cadastrados ficavam sem SSO.
>
> **`allowSignup=false` também vale no login Google (1.5.0):** o
> `POST /auth/authorize/google` é upsert — se o e-mail do id_token **não tem
> conta**, ele criaria uma. Para clients com `allowSignup=false` esse caso é
> rejeitado com `400 unauthorized_client` ("Signup is not allowed for this
> client"), sem criar identidade nem sessão. Contas existentes (inclusive
> account-linking de conta LOCAL com o mesmo e-mail) seguem logando
> normalmente. Ver [`signup.md`](./signup.md) §5.
>
> **Silent SSO (login sem formulário):** se o usuário já tem sessão SSO no IDP
> (cookies), o Accounts obtém o `code` **sem exibir formulário**: um probe
> `GET /auth/authorize` (com `response_type=code`) responde `{ code, state }` e o
> Accounts redireciona imediatamente de volta ao seu `redirect_uri`. Se o
> `access_token` da sessão SSO estiver expirado, o Accounts tenta um
> `POST /token/refresh` **uma única vez** e repete o probe. Tudo isso é
> **transparente para o seu sistema** — o fluxo do consumer (callback + token
> exchange) é idêntico ao do login com credenciais.

**O que seu sistema precisa implementar:**
- Passo 2-3: Server Action que gera PKCE + state e redireciona para `accounts.overlens.com.br/login`
- Passo 10-13: Route Handler de callback que troca `code` por JWT via `POST /auth/token` (server-side)
- Renovação silenciosa via `POST /auth/token` com `grant_type=refresh_token`

**O que seu sistema NÃO implementa:**
- Formulário de login (o Accounts faz isso)
- Coleta de credenciais (o Accounts + IDP fazem isso)
- Validação de Google OAuth (o Accounts + IDP fazem isso)

---

## 3. Pré-requisitos

### Variáveis de ambiente

```env
# URL do frontend de autenticação
ACCOUNTS_URL=https://accounts.overlens.com.br

# URL da API do IDP (usado apenas server-side, para token exchange e refresh)
IDP_BASE_URL=https://idp.overlens.com.br

# Credenciais do seu sistema (solicitar ao time de plataforma)
IDP_CLIENT_ID=hodos
IDP_CLIENT_SECRET=<seu_client_secret>

# URL de callback do seu sistema (deve estar registrada no IDP)
IDP_REDIRECT_URI=https://hodos.com.br/api/auth/callback
```

### Exemplos de clients registrados

Clients OAuth de produção **não são semeados** — são cadastrados manualmente por um ADMIN via `POST /admin/clients` ou pela UI `accounts.overlens.com.br/admin/clients` (ver [`oauth-clients.md`](./oauth-clients.md)). Exemplos **ilustrativos** de registro:

| `client_id` | `display_name` | Tipo | `allowedGrantTypes` | `redirect_uris` |
|---|---|---|---|---|
| `plataforma` | Plataforma da Overlens | Confidencial | `authorization_code`, `refresh_token` | `https://plataforma.overlens.com.br/api/auth/callback`, `http://localhost:3000/api/auth/callback` |
| `events` | Events | Confidencial | `authorization_code`, `refresh_token` | `https://events.overlens.com.br/api/auth/callback`, `http://localhost:3001/api/auth/callback` |
| `overlens-mobile` | Overlens App | Público | `authorization_code` | `overlens://callback` |

Para desenvolvimento local (container/sandbox), existem os fixtures de teste `test-web-bff` (confidencial), `test-public-pkce` (público) e `test-m2m-service` (M2M), semeados **apenas** com `IDP_SEED_FIXTURES=true` (nunca em produção) — ver [`run-local-container.md`](./run-local-container.md).

> O `POST /auth/token` rejeita grant types fora de `allowedGrantTypes` do client com `400 unauthorized_client`. Configure o client corretamente antes de integrar.

---

## 4. Geração do PKCE

### `lib/pkce.ts`

```typescript
import { randomBytes, createHash } from 'node:crypto';

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}
```

---

## 5. Redirect para o Accounts (login)

### `lib/auth-actions.ts`

```typescript
'use server';

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { generateCodeVerifier, generateCodeChallenge } from '@/lib/pkce';

const ACCOUNTS_URL = process.env.ACCOUNTS_URL!;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_REDIRECT_URI = process.env.IDP_REDIRECT_URI!;

export async function redirectToLogin() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(32).toString('hex');

  const cookieStore = await cookies();

  cookieStore.set('pkce_code_verifier', codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth/callback',
    maxAge: 600,
  });

  cookieStore.set('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth/callback',
    maxAge: 600,
  });

  // Redireciona para o ACCOUNTS (frontend), não para o IDP
  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    redirect_uri: IDP_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  redirect(`${ACCOUNTS_URL}/login?${params.toString()}`);
}

export async function redirectToSignup() {
  // Idêntico ao login, mas redireciona para /signup
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(32).toString('hex');

  const cookieStore = await cookies();

  cookieStore.set('pkce_code_verifier', codeVerifier, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth/callback',
    maxAge: 600,
  });

  cookieStore.set('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth/callback',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    redirect_uri: IDP_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  redirect(`${ACCOUNTS_URL}/signup?${params.toString()}`);
}
```

### Parâmetros na URL do Accounts

| Parâmetro | Obrigatório | Descrição |
|---|---|---|
| `client_id` | Sim | Identificador do seu sistema registrado no IDP |
| `redirect_uri` | Sim | URL de callback do seu sistema (registrada no IDP) |
| `code_challenge` | Sim | SHA-256 do `code_verifier` em base64url |
| `code_challenge_method` | Sim (`S256`) | Único método suportado |
| `state` | Sim | Valor aleatório para proteção CSRF do fluxo |

O Accounts repassa esses parâmetros ao IDP quando o usuário submete o formulário.

---

## 6. Route Handler de callback

Quando o Accounts completa a autenticação, redireciona o browser de volta para a `redirect_uri` do seu sistema com `?code=CODE&state=STATE`. O Route Handler troca o `code` por um JWT via chamada server-side ao IDP.

### `app/api/auth/callback/route.ts`

```typescript
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

const IDP_BASE_URL = process.env.IDP_BASE_URL!;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_CLIENT_SECRET = process.env.IDP_CLIENT_SECRET!;
const IDP_REDIRECT_URI = process.env.IDP_REDIRECT_URI!;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  /** @deprecated como fonte de autorização (RFC-0003) — autorize por papel local mapeado do `sub`. */
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  new_user?: true;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');

  if (!code || !state) {
    redirect('/login?error=missing_params');
  }

  const cookieStore = await cookies();

  // 1. Validar state (CSRF do fluxo OAuth)
  const savedState = cookieStore.get('oauth_state')?.value;
  if (!savedState || savedState !== state) {
    redirect('/login?error=invalid_state');
  }

  // 2. Recuperar code_verifier
  const codeVerifier = cookieStore.get('pkce_code_verifier')?.value;
  if (!codeVerifier) {
    redirect('/login?error=missing_verifier');
  }

  // 3. Trocar code por tokens (server-to-server, via IDP direto)
  let tokenData: TokenResponse;
  try {
    const credentials = Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64');

    const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: IDP_REDIRECT_URI,
      }),
    });

    if (!res.ok) redirect('/login?error=token_exchange_failed');
    tokenData = await res.json();
  } catch {
    redirect('/login?error=token_exchange_failed');
  }

  // 4. Decodificar JWT para extrair claims
  const [, payloadBase64] = tokenData.access_token.split('.');
  const payload: JwtPayload = JSON.parse(
    Buffer.from(payloadBase64, 'base64url').toString('utf-8'),
  );

  // 5. Criar sessão local
  cookieStore.set('session_token', tokenData.access_token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: tokenData.expires_in,
  });

  cookieStore.set('session_refresh', tokenData.refresh_token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth', maxAge: 30 * 24 * 60 * 60,
  });

  // 6. Cleanup
  cookieStore.delete('pkce_code_verifier');
  cookieStore.delete('oauth_state');

  // 7. Redirect condicional
  if (payload.new_user) {
    redirect('/onboarding/profile');
  }
  redirect('/dashboard');
}
```

**Nota:** Este callback é **idêntico para login e signup**. O mesmo Route Handler lida com ambos os fluxos — a diferença está apenas na URL inicial (passo 3 do diagrama).

**Sobre `client_secret_post`:** o IDP aceita credenciais tanto via `Authorization: Basic ...` (mostrado acima) quanto via body (`client_id` + `client_secret` no `application/x-www-form-urlencoded`). Use Basic quando possível — é o canônico. Body é fallback para libs que não montam Basic header facilmente.

**Sobre `expires_in`:** o IDP emite `expires_in: 900` (15min) para todo `authorization_code` / `refresh_token` grant. Não é configurável hoje.

**Sobre `id_token` — ⚠️ `aud` é STRING, não array:** quando o scope inclui `openid`, a resposta do exchange traz também `id_token`. Há uma **assimetria deliberada** entre os tokens:

| Token | `aud` | Exemplo |
|---|---|---|
| `access_token` (user) e M2M | **array** | `["https://api.overlens.com.br"]` |
| `id_token` (OIDC) | **string** (= seu `client_id`) | `"hodos"` |

É o formato do OpenID Connect Core 1.0 (aud = client_id). **Não normalize o `aud` do `id_token` para array** (nem o do access token para string) — validadores OIDC genéricos esperam a string e quebrariam. Fonte canônica: `packages/idp-token-core/src/claims/id-token-payload.ts` vs `user-jwt-payload.ts`.

---

## 7. Renovação silenciosa de sessão

O access token expira em **15 minutos**. Use o refresh token para renová-lo.

### `app/api/auth/refresh/route.ts`

```typescript
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const IDP_BASE_URL = process.env.IDP_BASE_URL!;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID!;
const IDP_CLIENT_SECRET = process.env.IDP_CLIENT_SECRET!;

export async function POST() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('session_refresh')?.value;

  if (!refreshToken) {
    return NextResponse.json({ error: 'no_refresh_token' }, { status: 401 });
  }

  const credentials = Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    cookieStore.delete('session_token');
    cookieStore.delete('session_refresh');
    return NextResponse.json({ error: 'refresh_failed' }, { status: 401 });
  }

  const data = await res.json();

  cookieStore.set('session_token', data.access_token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: data.expires_in,
  });

  cookieStore.set('session_refresh', data.refresh_token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth', maxAge: 30 * 24 * 60 * 60,
  });

  return NextResponse.json({ ok: true });
}
```

O IDP **rotaciona o refresh token** a cada uso — guarde sempre o novo valor.

### Janela de tolerância na rotação (grace window)

A rotação é single-use, mas com uma **janela curta de tolerância** (`REFRESH_ROTATION_GRACE_MS`, default **60s**; `0` desliga) para absorver corridas benignas — duas abas, bootstrap concorrente ou duas instâncias serverless do seu BFF usando o mesmo refresh token:

- **Reuso do token anterior DENTRO da janela** → `200` com um novo `access_token` e o refresh token **vivo atual** (o mesmo par que o request vencedor recebeu). Requests concorrentes convergem para o mesmo par válido — nenhum deles recebe erro e todos os tokens devolvidos seguem renováveis.
- **Reuso FORA da janela** → replay real: `400 invalid_grant` e a **sessão inteira é revogada** (o refresh token atual também deixa de funcionar). Trate como falha definitiva → reautenticação.

Checagens de conta (usuário bloqueado) e o binding do token ao `client_id` que o emitiu aplicam-se igualmente dentro da janela. Nenhuma mudança é necessária no consumer: continue guardando sempre o `refresh_token` da última resposta.

---

## 8. Exemplo: botões "Entrar" e "Criar conta"

### `app/(auth)/login/page.tsx`

```typescript
import { redirectToLogin, redirectToSignup } from '@/lib/auth-actions';

export default function LoginPage() {
  return (
    <main>
      <h1>Bem-vindo ao Hodos</h1>
      <form action={redirectToLogin}>
        <button type="submit">Entrar</button>
      </form>
      <form action={redirectToSignup}>
        <button type="submit">Criar conta</button>
      </form>
    </main>
  );
}
```

---

## 9. Detecção de primeiro acesso (`new_user`)

O JWT emitido após o **primeiro registro** contém `new_user: true`. Em logins subsequentes, essa claim está **ausente**.

| Cenário | `new_user` no JWT | Ação |
|---|---|---|
| Primeiro registro (email ou Google) | `true` | Redirect para onboarding |
| Login subsequente | ausente | Redirect para dashboard |

---

## 10. Referência rápida

### URLs usadas pelo seu sistema

| Destino | URL | Quando | Canal |
|---|---|---|---|
| Accounts — Login | `accounts.overlens.com.br/login?...` | Redirect do browser | Front-channel |
| Accounts — Signup | `accounts.overlens.com.br/signup?...` | Redirect do browser | Front-channel |
| IDP — Token exchange | `idp.overlens.com.br/auth/token` | Server-to-server | Back-channel |
| IDP — JWKS | `idp.overlens.com.br/.well-known/jwks.json` | Backend valida JWT | Back-channel |

### Erros possíveis no token exchange

| HTTP | `error` | Causa |
|---|---|---|
| 400 | `invalid_grant` | Code expirado (5min), já usado, ou PKCE inválido |
| 401 | `invalid_client` | `client_id` desconhecido ou `client_secret` incorreto |
| 429 | — | Rate limit do `POST /auth/token` (30 req/min por IP) — transitório; respeite o `Retry-After`. Ver [`rate-limiting.md`](../deploy/rate-limiting.md) |

---

## 11. Checklist de integração

- [ ] `ACCOUNTS_URL`, `IDP_BASE_URL`, `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_REDIRECT_URI` configurados
- [ ] `redirect_uri` registrada no client do IDP (via `POST /admin/clients` ou UI admin)
- [ ] PKCE implementado (`code_verifier` + `code_challenge` S256)
- [ ] `code_verifier` e `state` em cookies `httpOnly; SameSite=Lax`
- [ ] Redirect para `accounts.overlens.com.br/login` (não para o IDP diretamente)
- [ ] Route Handler de callback implementado
- [ ] Validação de `state` no callback
- [ ] Token exchange via `POST /auth/token` server-side
- [ ] Cookies de sessão `httpOnly` setados
- [ ] Cleanup de cookies temporários após callback
- [ ] Renovação silenciosa implementada (`grant_type=refresh_token`)
- [ ] Detecção de `new_user: true` para onboarding
- [ ] Nenhum `client_secret` exposto no browser
