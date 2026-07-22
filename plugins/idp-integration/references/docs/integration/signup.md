# Guia de Integração — Signup Centralizado

> Como integrar o signup centralizado da Overlens em sistemas externos. O fluxo é quase idêntico ao login — leia [`login.md`](./login.md) primeiro.
>
> **Última atualização:** 2026-07-18 (contrato 1.6.0)

---

## 0. Dois endpoints de signup — não confunda

| Endpoint | Quem deve usar | Fluxo |
|---|---|---|
| `POST /auth/signup` (e variante `/auth/signup/google`) | Sistemas integrados via OAuth (Hodos, Events, mobile, etc.) | OAuth-aware — retorna `{ code, state }` para troca em `/auth/token` |
| `POST /signup` (sem `/auth`) | **Uso interno do Accounts** apenas | Modo sessão direta — retorna cookies, sem OAuth code |

Este guia cobre apenas o primeiro. Não use `POST /signup` em sistemas integrados — você não consegue receber/usar os cookies emitidos.

---

## 1. Diferença entre login e signup

O login e o signup usam a **mesma infraestrutura**: PKCE, callback, token exchange e sessão local. A única diferença é a URL de redirect inicial e o conteúdo do JWT:

| | Login | Signup |
|---|---|---|
| URL do Accounts | `accounts.overlens.com.br/login?...` | `accounts.overlens.com.br/signup?...` |
| Formulário exibido | Email + senha (+ Google) | Email + senha + confirmação (+ Google) |
| Endpoint do IDP chamado pelo Accounts | `POST /auth/authorize` | `POST /auth/signup` |
| `new_user` no JWT | Ausente | `true` |
| Callback do seu sistema | Idêntico | Idêntico |
| Token exchange | Idêntico | Idêntico |

**Você reutiliza 100% do código de callback e token exchange.** A única diferença está na Server Action que gera a URL de redirect.

---

## 2. Fluxo end-to-end (Signup)

```
Seu Sistema (Hodos)              Accounts SPA                     IDP API
       |                              |                              |
  1. Usuário clica "Criar conta"      |                              |
  2. Gera PKCE + state,              |                              |
     armazena em cookies httpOnly     |                              |
       |                              |                              |
  3. redirect browser ──────────────→ |                              |
     accounts.overlens.com.br/signup  |                              |
     ?client_id=hodos                 |                              |
     &redirect_uri=hodos.com.br/cb    |                              |
     &code_challenge=XYZ              |                              |
     &code_challenge_method=S256      |                              |
     &state=ABC                       |                              |
       |                              |                              |
                                 4. Renderiza formulário             |
                                    "Criar conta para acessar        |
                                     o Hodos"                        |
                                    (email + senha + confirmação     |
                                     + Google)                       |
                                      |                              |
                                 5. Usuário preenche e submete       |
                                      |                              |
                                 6. fetch POST ──────────────────→   |
                                    /auth/signup                     |
                                    { email, password,               |
                                      passwordConfirmation,          |
                                      client_id, redirect_uri,      |
                                      code_challenge, state }        |
                                      |                              |
                                      |  7. IDP cria identidade,     |
                                      |     cria sessão SSO cookie-  |
                                      |     mode + gera authorization|
                                      |     code                     |
                                      |                              |
                                 8. ← { code: "CODE", state: "ABC" }|
                                    + Set-Cookie: access_token,      |
                                      refresh_token (sessão SSO IDP) |
                                      |                              |
                                 9. window.location.href =           |
                                    hodos.com.br/cb                  |
                                    ?code=CODE&state=ABC             |
                                      |                              |
 10. Callback recebe code ←           |                              |
     (MESMO callback do login)        |                              |
       |                              |                              |
 11. POST /auth/token (server) ─────────────────────────────────→    |
       |                                                             |
 12. ← { access_token (JWT com new_user:true), ... }                |
       |                                                             |
 13. Detecta new_user:true,          |                              |
     redireciona para /onboarding     |                              |
```

> **Sessão SSO do IDP (contrato 1.5.0):** no passo 8, `POST /auth/signup` (e
> `/auth/signup/google`) também setam os cookies httpOnly `access_token` (JWT,
> 15 min) e `refresh_token` (código opaco, 30 dias) no browser — os mesmos que o
> `POST /auth/authorize` do login seta. O usuário recém-cadastrado nasce **com**
> sessão SSO: o próximo app que iniciar o fluxo OAuth autentica silenciosamente
> via o probe `GET /auth/authorize` (silent SSO — ver a nota em
> [`login.md`](./login.md) §2), sem pedir credenciais de novo. Seu sistema não
> precisa fazer nada — os cookies pertencem ao domínio do IDP e só são usados
> pelo Accounts/IDP.

---

## 3. Implementação

### Server Action para redirect (a única coisa nova)

A função `redirectToSignup` já está em [`login.md` seção 5](./login.md#5-redirect-para-o-accounts-login). A diferença é apenas a URL:

```typescript
// login → accounts.overlens.com.br/login?...
redirect(`${ACCOUNTS_URL}/login?${params.toString()}`);

// signup → accounts.overlens.com.br/signup?...
redirect(`${ACCOUNTS_URL}/signup?${params.toString()}`);
```

### Callback e token exchange

**Idênticos ao login.** O mesmo Route Handler (`app/api/auth/callback/route.ts`) lida com ambos. Ver [`login.md` seção 6](./login.md#6-route-handler-de-callback).

### Detecção de primeiro acesso

O JWT emitido após o signup contém `new_user: true`. O callback já trata isso:

```typescript
if (payload.new_user) {
  redirect('/onboarding/profile');  // Novo usuário → onboarding
}
redirect('/dashboard');              // Usuário existente → dashboard
```

---

## 4. Erros específicos do signup

Estes erros são tratados pelo Accounts (o usuário vê mensagens amigáveis no formulário). Seu sistema **não precisa tratar** esses erros — eles nunca chegam ao seu callback.

| HTTP | `error` | Quando |
|---|---|---|
| 400 | `validation_error` | Email inválido, senha < 8 chars, senhas não coincidem |
| 400 | `invalid_client` | `client_id` desconhecido |
| 400 | `invalid_redirect_uri` | `redirect_uri` não registrado para o client |
| 400 | `unauthorized_client` | Client registrado com `allowSignup=false` — signup rejeitado ANTES de criar identidade (contrato 1.5.0, ver §5) |
| 401 | `invalid_token` | id_token Google inválido (em `/auth/signup/google`) |
| 409 | `email_exists` | Email já cadastrado (Accounts mostra link para login) |
| 429 | — | Throttler `signup` (10 req/min por IP — ver [`rate-limiting.md`](../deploy/rate-limiting.md)) |

O único erro que pode chegar ao seu callback é no **token exchange** (`POST /auth/token`) — ver [`login.md` seção 10](./login.md#10-referência-rápida).

## 4.1 `GET /auth/signup`

Endpoint opcional usado pelo Accounts para validar antes de renderizar o formulário. Retorna `200 { status: 'signup_available', client_id, display_name, allow_signup }` ou `400 invalid_client`/`invalid_redirect_uri`. Não é chamado diretamente por sistemas integrados.

---

## 5. Controle de signup por client (`allowSignup`)

Cada OAuth client registrado no IDP tem um campo `allowSignup` (default: `true`).
Desde o contrato **1.5.0** ele é **aplicado no servidor** — deixou de ser
informativo:

| `allowSignup` | Comportamento |
|---|---|
| `true` | `POST /auth/signup` e `POST /auth/signup/google` aceitam cadastros; a tela de login no Accounts exibe link "Criar conta" |
| `false` | **`POST /auth/signup` e `POST /auth/signup/google` rejeitam com `400 unauthorized_client`** ("Signup is not allowed for this client") antes de criar qualquer identidade — apenas contas pré-cadastradas |

O enforcement cobre também o **login Google** (`POST /auth/authorize/google`):
por ser upsert, um id_token de e-mail **sem conta** criaria identidade — signup
disfarçado de login. Com `allowSignup=false` esse caso responde o **mesmo
`400 unauthorized_client`**, sem criar identidade nem sessão. **Contas
existentes seguem logando normalmente** — inclusive o account-linking (conta
LOCAL com o mesmo e-mail ganhando `googleId`), que não é criação de conta.

O `GET /auth/authorize` (resposta `login_required`) e o `GET /auth/signup`
expõem `allow_signup` para a UI esconder o link de cadastro.

Para alterar, use `PATCH /admin/clients/:id` (ver [`oauth-clients.md`](./oauth-clients.md)) com `{ "allowSignup": false }`. Não exige redeploy.

---

## 6. Checklist de integração (incremental ao login)

Se você já integrou o login (ver [`login.md` checklist](./login.md#11-checklist-de-integração)), para adicionar signup basta:

- [ ] Criar Server Action `redirectToSignup` apontando para `accounts.overlens.com.br/signup`
- [ ] Adicionar botão "Criar conta" na sua página de login
- [ ] Implementar página de onboarding (`/onboarding/profile`) para novos usuários
- [ ] Tratar `new_user: true` no callback (redirect para onboarding)
- [ ] Testar fluxo completo: botão → Accounts → formulário → callback → onboarding
