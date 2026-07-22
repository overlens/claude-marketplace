# Documentação de Integração — Overlens Identity Provider

> **Público:** times **externos** integrando um sistema ao IDP + Accounts — auth de todos
> os tipos, criação de contas, dados de usuário, frontend e backend.
> Docs de deploy/operação (para o time do IDP): [`../deploy/`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/README.md).
> Material conceitual (JWKS, rotação): [`../learning/`](../learning/README.md).
>
> **Última atualização:** 2026-07-18 (contrato **1.6.0** — ver [`CONTRACT-CHANGELOG.md`](./CONTRACT-CHANGELOG.md))

---

## O que é o Identity Provider

O **IDP** é o sistema central de autenticação da Overlens. Todo sistema
`*.overlens.com.br` — e sistemas externos via OAuth — usa o IDP para identificar
usuários, emitir JWTs e autorizar comunicação machine-to-machine.

Dois componentes:

- **IDP** (`idp.overlens.com.br`) — API NestJS JSON-only: autentica, emite tokens, JWKS, OIDC discovery.
- **Accounts** (`accounts.overlens.com.br`) — SPA React: telas de login, signup, perfil e admin.

**Modelo em uma frase:** OAuth 2.1 Authorization Code + **PKCE**. O browser redireciona
para o Accounts; o Accounts autentica via IDP; seu backend troca o `code` por JWT no
back-channel. Casos especiais: **M2M** (`client_credentials`, sem usuário) e **modo
cookie** (SPAs internas sob `*.overlens.com.br`).

---

## Trilhas — comece pelo seu caso

### Trilha 1 — App web com backend (BFF): login/signup/logout de usuários

1. [`overview.md`](./overview.md) — o modelo mental (modos A/B/C, tokens, sessões)
2. [`oauth-clients.md`](./oauth-clients.md) — registre seu client (peça a um admin)
3. [`login.md`](./login.md) — fluxo completo com código (PKCE → redirect → callback → exchange → refresh)
4. [`signup.md`](./signup.md) — delta de signup sobre o login
5. [`logout.md`](./logout.md) — os 4 caminhos de logout e o escopo de cada um
6. [`idp-testing-toolkit.md`](./idp-testing-toolkit.md) — prove que a integração está correta

### Trilha 2 — API/backend que só valida tokens (Resource Server)

1. [`backend.md`](./backend.md) — guard/strategy prontos (NestJS, Express, GraphQL)
2. [`../learning/jwks.md`](../learning/jwks.md) — o porquê das regras de validação
3. [`idp-testing-toolkit.md`](./idp-testing-toolkit.md) — kit de conformidade drop-in

### Trilha 3 — Serviço M2M (worker, cron, server-to-server)

1. [`m2m.md`](./m2m.md) — `client_credentials`, cache de token, scopes
2. [`m2m-profile-read.md`](./m2m-profile-read.md) — ler perfil global por `sub` (`profile:read`)
3. [`profile-events.md`](./profile-events.md) — webhook de mudanças de perfil (Push)

### Trilha 4 — Mobile / SPA sem backend (public client)

1. [`frontend.md`](./frontend.md) §2 — PKCE-only, sem `client_secret`, storage seguro
2. [`login.md`](./login.md) — o fluxo é o mesmo; muda a autenticação do client

### Trilha 5 — Dados do usuário (perfil global e avatar)

1. [`profile.md`](./profile.md) — `/auth/me*`: ler/editar perfil, senha, desativar/excluir
2. [`update-avatar.md`](./update-avatar.md) — upload de avatar em 3 passos (presigned PUT)
3. [`profile-events.md`](./profile-events.md) + [`profile-events-webhook-implementation.md`](./profile-events-webhook-implementation.md) — manter seu cache fresco (Push)

### Atalhos

| Preciso de… | Leia |
|---|---|
| **Orquestrar o Claude Code** para integrar | [`claude-code-playbook.md`](./claude-code-playbook.md) ⭐ |
| Lib OIDC genérica (Auth.js, openid-client) | [`oidc-discovery.md`](./oidc-discovery.md) |
| Rodar o IDP real localmente (container/e2e) | [`run-local-container.md`](./run-local-container.md) |
| Saber se/quando o contrato mudou | [`CONTRACT-CHANGELOG.md`](./CONTRACT-CHANGELOG.md) + [`contract-version.json`](./contract-version.json) |
| OpenAPI da API | `GET https://idp.overlens.com.br/docs-json` (UI em `/docs`) |
| Área admin (stats, clients) — time interno | [`admin-area.md`](./admin-area.md) + [`../deploy/admin-runbook.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/admin-runbook.md) |

---

## URLs de produção

| Recurso | URL | Canal |
|---|---|---|
| Accounts — login/signup | `https://accounts.overlens.com.br/login?…` / `/signup?…` | Front-channel (redirect) |
| IDP — token endpoint | `https://idp.overlens.com.br/auth/token` | Back-channel |
| IDP — JWKS | `https://idp.overlens.com.br/.well-known/jwks.json` | Back-channel (boot do RS) |
| IDP — OIDC Discovery | `https://idp.overlens.com.br/.well-known/openid-configuration` | Back-channel |
| IDP — UserInfo | `https://idp.overlens.com.br/auth/userinfo` | Back-channel (Bearer) |
| IDP — end-session | `https://idp.overlens.com.br/auth/logout` | Front-channel (navegação) |

> **Sem CORS direto do seu frontend ao IDP** — em produção o
> `Access-Control-Allow-Origin` é restrito a `*.overlens.com.br`. Toda chamada do
> consumer ao IDP é server-to-server (ou navegação de browser no front-channel).

---

## Índice completo (A–Z)

| Doc | Assunto |
|---|---|
| [`admin-area.md`](./admin-area.md) | Área `/admin` do Accounts + endpoints admin do IDP |
| [`backend.md`](./backend.md) | Resource Server: validar JWTs localmente |
| [`claude-code-playbook.md`](./claude-code-playbook.md) | Orquestrar o Claude Code (skills `idp-*`, toolkit, sandbox) |
| [`CONTRACT-CHANGELOG.md`](./CONTRACT-CHANGELOG.md) | Histórico versionado do contrato público |
| [`frontend.md`](./frontend.md) | Frontends OAuth, public clients PKCE, modo cookie |
| [`idp-testing-toolkit.md`](./idp-testing-toolkit.md) | `@overlens/idp-testing` — mint, mock IDP, conformidade |
| [`login.md`](./login.md) | Login OAuth completo (PKCE, callback, exchange, refresh, silent SSO) |
| [`logout.md`](./logout.md) | Logout: cookie-mode, end-session por dispositivo, RFC 7009 |
| [`m2m.md`](./m2m.md) | `client_credentials` — serviços autenticando como si mesmos |
| [`m2m-profile-read.md`](./m2m-profile-read.md) | `GET /users/:sub` — perfil global via M2M |
| [`oauth-clients.md`](./oauth-clients.md) | Registro e ciclo de vida de OAuth Clients |
| [`oidc-discovery.md`](./oidc-discovery.md) | Discovery, `/auth/userinfo`, limites de conformidade OIDC |
| [`overview.md`](./overview.md) | Modelo mental: modos de auth, tokens, sessões, cookies |
| [`profile.md`](./profile.md) | `/auth/me*` — perfil próprio do usuário |
| [`profile-events.md`](./profile-events.md) | Webhook de eventos de perfil (SET) — contrato |
| [`profile-events-webhook-implementation.md`](./profile-events-webhook-implementation.md) | Webhook — handbook de implementação (Express/NestJS) |
| [`run-local-container.md`](./run-local-container.md) | IDP real em container local / Testcontainers |
| [`signup.md`](./signup.md) | Signup OAuth-aware |
| [`update-avatar.md`](./update-avatar.md) | Avatar: presigned PUT em 3 passos |

Deploy/operação (time do IDP): [`../deploy/README.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/README.md) ·
Conceitos: [`../learning/README.md`](../learning/README.md) ·
Decisões: [`../adr/README.md`](https://github.com/overlens/identity-provider/blob/main/docs/adr/README.md) · Propostas: [`../rfc/README.md`](https://github.com/overlens/identity-provider/blob/main/docs/rfc/README.md)
