# Changelog do Contrato do IDP

> Histórico das mudanças no **contrato público** do Overlens IDP — a superfície
> que integradores (Resource Servers, clients, M2M) dependem. Legível por humano;
> o par legível por máquina é [`contract-version.json`](./contract-version.json).
>
> **Por que existe (RFC-0005 / T11):** se o IDP mudar uma claim, um campo do
> discovery, o shape de um erro ou uma regra de cookie sem intenção, integrações
> geradas por agente quebram **silenciosamente**. O contract test
> `apps/idp/test/idp-contract.e2e-spec.ts` fixa esta superfície contra a fonte
> única (`@overlens/idp-token-core`) e contra `contract-version.json`, e **falha o
> build** até a mudança ser registrada aqui — tornando-a uma decisão consciente.
>
> **Regras:** adicionar campo/claim é **aditivo** (minor). Remover, renomear ou
> trocar o tipo de algo público é **breaking** (major) e exige aviso. `role` está
> `@deprecated` (ADR-0008) — deprecar ≠ remover; o teste protege contra remoção
> acidental.
>
> **Checklist de release (RFC-0006 / ADR-0013):** depois de atualizar
> `contract-version.json` + este CHANGELOG + `docs/integration/`, rodar
> `node scripts/sync-plugin.mjs` — sincroniza docs e skills no plugin
> `idp-integration` do repo `overlens/claude-marketplace` — e dar bump na
> versão do plugin espelhando a versão do contrato.

O versionamento segue [SemVer](https://semver.org/lang/pt-BR/) sobre o contrato
(não sobre o código): `MAJOR` = breaking, `MINOR` = aditivo, `PATCH` = correção
sem impacto de integração.

---

## [1.7.0] — 2026-07-20

**MINOR (aditivo)** — Recuperação de senha por token de uso único (ADR-0012).
Duas rotas públicas novas. **Nenhuma claim, entrada de discovery, shape de erro,
JWKS ou cookie de sessão muda de forma** — integrações existentes não precisam
de nenhuma ação.

### Novo: `POST /auth/password/forgot`

```
Request:  { "email": string }
Response: 202 Accepted { "ok": true }   ← SEMPRE, sem exceção
Errors:   400 (e-mail sintaticamente inválido)
          429 (rate limit POR IP: 3 / 15 min)
          404 (feature desligada — kill-switch PASSWORD_RESET_ENABLED)
```

**A resposta é deliberadamente indistinguível** entre e-mail cadastrado,
desconhecido, de conta bloqueada/desativada/excluída e com cota por identidade
estourada — mesmo status, mesmo corpo e mesmo tempo de resposta (o envio do
e-mail não é aguardado). Um cliente **não pode** usar este endpoint para
descobrir se um endereço existe; qualquer heurística nesse sentido vai falhar.

O limite **por identidade** (3/hora) responde `202`, não `429` — um 429 nesse
ramo confirmaria a existência do e-mail.

### Novo: `POST /auth/password/reset`

```
Request:  { "token": string, "newPassword": string }   (newPassword: mínimo 8)
Response: 200 OK { "ok": true }
Errors:   400 (link inválido | expirado | já usado | conta inacessível — MENSAGEM ÚNICA)
          400 (newPassword abaixo do mínimo)
          429 (rate limit POR IP: 10 / 15 min)
          404 (feature desligada)
```

**Não emite cookie algum** — um reset bem-sucedido NÃO autentica o usuário. O
cliente deve mandá-lo para o login. Os quatro motivos de rejeição do token
compartilham uma única mensagem, de propósito: discriminar "já usado"
confirmaria a terceiros que um reset ocorreu.

Efeitos de um reset bem-sucedido, relevantes para integradores:

- **TODAS as sessões de refresh do usuário são revogadas.** Apps com sessão
  ativa daquele usuário passam a falhar no próximo silent refresh (≤ 15 min,
  quando o access token expira) e devem tratar isso como logout.
- `email_verified` passa a `true` (consumir o link prova posse do e-mail).
- Os demais links de reset vivos do mesmo usuário param de valer.

### ⚠️ Mudança de comportamento: `POST /auth/me/password`

A troca de senha autenticada **não revogava sessão nenhuma** — um usuário que
trocasse a senha por suspeita de comprometimento mantinha o invasor logado por
até 30 dias. Corrigido: agora revoga as sessões de **todos os outros
dispositivos** do usuário, preservando o dispositivo corrente (via o anchor
`device_id` do ADR-0011), para não deslogar quem acabou de trocar a senha.

Request e response são **idênticos**; o que muda é o efeito colateral. Clientes
com sessão do mesmo usuário em outro dispositivo devem esperar um logout ali.

### Rollout

Ambas as rotas ficam atrás de `PASSWORD_RESET_ENABLED` (default **`false`**) e
respondem `404` enquanto desligadas — não `503`, para não anunciar a superfície
antes de ela estar pronta. Ligar depois de validar o envio de e-mail em staging.

---

## [1.6.0] — 2026-07-16

**MINOR (aditivo)** — Logout por dispositivo (device-scoped global logout;
P26 — ADR-0011). O único efeito observável é uma **mudança de semântica do
`GET /auth/logout`**: passa de per-client (1.4.0) para **per-device**. Nenhuma
claim, endpoint de discovery, shape de erro, JWKS ou cookie de sessão
(`access_token`/`refresh_token`) muda de forma.

### **⚠️ `GET /auth/logout` passa de per-client para PER-DEVICE**

- **Antes (1.4.0):** com um client resolvido (via `client_id`/`id_token_hint`),
  o end-session revogava só as sessões DAQUELE client; as sessões dos outros
  apps do mesmo dispositivo (e a sessão SSO cookie-mode) sobreviviam. Sem client
  resolvível, revogava TODAS as sessões do usuário (global).
- **Agora (1.6.0):** o IDP mantém um cookie interno **`device_id`** (opaco,
  `HttpOnly`, `Secure`, `SameSite=Lax`, `Domain=.overlens.com.br`, `Path=/`,
  ~30d) setado no login/authorize e **estável** (não é limpo no logout). Toda
  sessão de refresh — SSO cookie-mode **e** as sessões OAuth dos apps (que
  herdam o `device_id` via o `authorization_code`) — nasce carimbada com o
  `device_id` do browser. **`GET /auth/logout`, ao receber o cookie `device_id`,
  revoga TODAS as sessões DAQUELE dispositivo** (SSO + todos os apps), enquanto
  **os outros dispositivos do usuário continuam logados**. Objetivo: deslogar em
  um app encerra todos os apps do MESMO dispositivo.
- **Precedência da revogação** (mais específica → mais ampla): (1) com cookie
  `device_id` (e `sub` resolvível) → **per-device**; (2) sem `device_id` (sessão
  legada pré-P26) mas com client resolvido → **per-client** (semântica 1.4.0);
  (3) sem `device_id` e sem client → **global** (revoga todas).
- **`device_id` é um cookie INTERNO** do IDP: opaco, `HttpOnly`, sem PII, nenhum
  consumidor o lê ou o envia manualmente. Não faz parte da superfície de token
  (não é claim, não viaja no JWT). Por isso não entra na seção `cookies` do
  `contract-version.json` (que fixa só os cookies de sessão consumíveis). Fica
  registrado aqui por completude e porque o **comportamento observável do
  logout** muda.
- **Limitação aceita (mesma do RP-Initiated Logout):** não há revogação dura por
  request — os apps do dispositivo deslogam no **próximo silent refresh** (que
  falha com a sessão revogada), em **≤ 15 min**. Coerente com o ADR-0003 do
  Odyssey; back-channel logout OIDC (revogação imediata) fica fora de escopo.
- **Migração aditiva e rollback-safe:** colunas `refresh_sessions.deviceId` e
  `authorization_codes.deviceId` nullable, sem backfill — sessões/codes legados
  ficam `deviceId=null` e caem no fallback per-client/global (comportamento
  1.4.0 preservado). Nenhum consumidor precisa mudar; Odyssey NÃO muda.

---

## [1.5.0] — 2026-07-15

**MINOR (aditivo)** — Sessão SSO do IDP nos caminhos Google e signup do fluxo
OAuth (P22 — fix dos achados A2/A3) + enforcement de `allowSignup`
(P23 — fix do A4; P25 — fechamento do bypass no login Google).

### Sessão SSO em Google e signup (aditivo — bodies e status INALTERADOS)

- **`POST /auth/authorize/google`, `POST /auth/signup` e `POST /auth/signup/google`
  passam a setar os cookies de sessão do IDP** (`Set-Cookie: access_token` JWT
  15 min + `refresh_token` código opaco 30d) no sucesso — exatamente os mesmos
  cookies (e atributos) que o caminho e-mail do `POST /auth/authorize` já
  setava. Os bodies (`{ code, state }`) e status (200/201) não mudam.
- Cada um desses caminhos cria uma **sessão de refresh cookie-mode**
  (`clientId=null`) em `refresh_sessions` — separada da sessão que o exchange
  do client criará (comportamento esperado do multi-sessão 1.4.0; o cap de 10
  ativas por usuário administra o acúmulo).
- Consequência para consumidores: usuários que logam com **Google** ou que
  **acabam de se cadastrar** via fluxo OAuth passam a ter SSO silencioso no
  `GET /auth/authorize` (antes, só o login e-mail estabelecia a sessão IDP).
  Puramente aditivo — nenhum consumidor precisa mudar.

### `allow_signup` no `login_required` (aditivo)

- A resposta `200 { status: "login_required", client_id, display_name }` do
  `GET /auth/authorize` ganha o campo **`allow_signup`** (boolean, espelho do
  `allowSignup` do client) — a UI do Accounts o usará para esconder
  "Criar conta" quando o client não permite signup (A8, próxima fase).

### **⚠️ `allowSignup=false` passa a ser APLICADO no signup e no login Google**

- **`POST /auth/signup` e `POST /auth/signup/google` rejeitam com
  `400 { error: "unauthorized_client", error_description: "Signup is not
  allowed for this client" }`** quando o client foi registrado com
  `allowSignup=false` — **antes de criar qualquer identidade**. Até então o
  flag era decorativo (apenas exposto no `GET /auth/signup`); requests que
  antes **indevidamente** sucediam passam a falhar — enforcement intencional
  (mesmo espírito da correção de segurança da 1.2.0).
- **O enforcement cobre também o `POST /auth/authorize/google` (LOGIN do
  fluxo OAuth) para contas INEXISTENTES** (P25): como o endpoint é upsert, um
  id_token de e-mail sem conta criaria identidade — signup disfarçado de
  login, bypass do gate acima. Com `allowSignup=false`, esse caso responde o
  **mesmo `400 unauthorized_client`** acima, sem criar identidade/sessão/
  cookies. **Contas existentes seguem logando normalmente** — inclusive o
  account-linking (conta LOCAL com o mesmo e-mail ganhando `googleId`), que
  não é criação de conta. A resposta distinta não é enumeração relevante: o
  chamador provou posse da conta Google com um id_token válido.
- Nova sub-causa de `unauthorized_client` na taxonomia de `error_hint`
  (casada pela `error_description` de signup); sem descrição reconhecível, a
  dica estática de grant types permanece.

[1.5.0]: #150--2026-07-15

## [1.4.0] — 2026-07-14

**MINOR (aditivo)** — Multi-sessão de refresh: tabela `refresh_sessions`
(P2 — fix definitivo do RC-1; ADR-0010).

### Multi-sessão (aditivo — shape do `POST /auth/token` INALTERADO)

- Cada login/exchange passa a criar uma **sessão de refresh independente**
  (uma linha por client × dispositivo) em vez de sobrescrever o slot único
  `identity.refreshCode`. **Web + admin + Accounts + múltiplos dispositivos
  coexistem sem se derrubar** — requests que antes falhavam com
  `invalid_grant`/`401` após um login em outro app passam a suceder
  (comportamento puramente aditivo para consumidores).
- A grace window do P1 passa a operar **por sessão**; replay fora da janela
  revoga **só a sessão atacada** (antes: o usuário inteiro).
- SEC-004 por sessão: sessão OAuth só renova pelo `client_id` emissor via
  `POST /auth/token`; sessão cookie só renova via `POST /token/refresh`
  (antes, uma sessão cookie era renovável por qualquer client OAuth — correção
  de segurança intencional, sem consumidor conhecido afetado).
- TTL absoluto de 30 dias **renovado a cada rotação** (sliding — paridade com o
  `Max-Age` do cookie). Cap de **10 sessões ativas por usuário** (ao criar a
  11ª, a mais antiga por último uso é revogada).
- Storage: o banco guarda apenas `sha256(token)`; os códigos opacos crus
  continuam viajando como antes (cookie httpOnly no modo B; body JSON no modo A).

### **⚠️ Mudança observável de semântica: logout deixou de ser GLOBAL**

- **`POST /logout` (cookie) agora revoga SÓ a sessão do cookie apresentado.**
- **`GET /auth/logout` (end-session) revoga as sessões DO CLIENT resolvido**
  (`client_id`/`id_token_hint`); **sem client resolvível, revoga TODAS**
  (fallback que preserva a semântica antiga).
- **`POST /auth/revoke` revoga só a sessão do token apresentado.**
- **Bloqueio/desativação/exclusão de conta continuam revogando TODAS as
  sessões.**
- Consumidores que dependiam do logout de um app derrubar os demais devem
  passar a chamar `POST /auth/revoke` com o próprio token e/ou orientar o
  usuário ao end-session sem escopo. Matriz completa: `logout.md` §8.

### Migração / deprecações

- Colunas legadas `identity.refreshCode` e `refreshClientId` estão
  **deprecadas** (o código lê e escreve somente `refresh_sessions`; o backfill
  da migration converteu as sessões vivas). O **drop** das colunas (fase
  *contract* do expand/contract) virá em release futura — será registrado aqui.
- `GET /admin/stats`: `activity.activeSessions` passa a contar **usuários
  distintos com sessão ativa não-expirada** na tabela (mesmo significado do
  painel de antes, quando 1 usuário = 1 sessão).

[1.4.0]: #140--2026-07-14

## [1.3.0] — 2026-07-14

**MINOR (aditivo)** — Rate limiting religado + correções de drift docs×código (P4).

### Rate limiting religado (comportamento observável — não fixado pelo contract test)

O throttler estava **desligado em todos os ambientes** (`skipIf: () => true`)
desde antes da baseline 1.0.0, apesar de documentado como ativo. Passou a valer,
com limites **generosos** por rota e por IP (por client no M2M):

- `POST /login`, `/login/google`, `/auth/authorize`, `/auth/authorize/google` —
  **10 req/min**; `POST /token/refresh` e `POST /auth/token` (todos os grants) —
  **30 req/min**; `POST /signup` e `POST /auth/signup` — **10 req/min** (antes
  documentado como 5/h); demais rotas — **60 req/min** (perfis de perfil/senha/M2M
  inalterados). Tabela completa: `docs/deploy/rate-limiting.md`.
- Excedente → `429` com header padrão **`Retry-After`** (segundos) em todo 429.
  Shape do body: `{ "statusCode": 429, "message": "ThrottlerException: Too Many
  Requests" }` (formato NestJS, **não** o shape de erro OAuth — 429 não entra em
  `errors.codes` do contrato).
- **Consumidores devem tratar `429` como falha TRANSITÓRIA** (retry após
  `Retry-After`) — nunca como sessão morta/credencial inválida.
- A contagem é por rota × IP; ativo em **todos os ambientes** (kill-switch
  operacional: `IDP_RATE_LIMIT_DISABLED=true`).
- Nenhuma mudança de shape em claims/discovery/JWKS/cookies/erros OAuth — por
  isso não há campo novo em `contract-version.json`; o registro aqui é a
  decisão consciente exigida pelo processo.

### Correções de documentação (drift docs×código, sem mudança de código)

- `CLAUDE.md` §4: cookie `refresh_token` documentado com `Path=/refresh` →
  corrigido para **`/token/refresh`** (o real desde sempre; o contract test já
  fixava o valor correto).
- `CLAUDE.md` §5: interface JWT documentada omitia `name`, `email_verified` e
  `new_user?` → alinhada à fonte canônica
  `packages/idp-token-core/src/claims/user-jwt-payload.ts` (claims emitidos não
  mudaram).
- **`id_token.aud` é string** (= `client_id`), enquanto access/M2M usam `aud`
  array — assimetria (OIDC Core) agora documentada em `oidc-discovery.md` e
  `login.md`, com aviso para não normalizar.
- **`/auth/authorize` responde JSON, não 302** — agora documentado com destaque
  (`login.md`, `oidc-discovery.md`): o redirect é da SPA Accounts; libs OIDC
  que esperam 302 no `authorization_endpoint` precisam de adaptação;
  `POST /test/login` (`IDP_TEST_MODE`) para automação.
- **Semântica de sessão** documentada (`overview.md`): UMA sessão de refresh por
  usuário no ecossistema; login/exchange em outro client/dispositivo substitui a
  sessão anterior; logout é global; grace window ≠ multi-sessão; multi-sessão é
  roadmap (P2).
- `CLAUDE.md` §2 Regra 5 e ADR-0002 emendados com a grace window (1.1.0).

[1.3.0]: #130--2026-07-14

## [1.2.0] — 2026-07-14

**MINOR (aditivo)** — `POST /auth/revoke` (RFC 7009) + estado de conta
unificado nos fluxos OAuth (P3).

### Entrega B — Revogação de tokens (aditivo)

- **Novo endpoint `POST /auth/revoke`** (RFC 7009,
  `application/x-www-form-urlencoded`): params `token` (obrigatório) e
  `token_type_hint` (opcional: `refresh_token` | `access_token`). Autenticação
  do client **idêntica** ao `POST /auth/token` (Basic OU
  `client_id`/`client_secret` no body; public client sem secret).
  - Client autenticado → `200 {}` **sempre** — mesmo para token
    desconhecido, já revogado ou pertencente a outro client (RFC 7009 §2.2,
    privacidade: a resposta não vaza existência/posse de tokens).
  - Revoga somente se o token (o atual OU o anterior do par da grace window)
    pertence ao client autenticado (binding ao client emissor; sessões do
    fluxo cookie têm binding nulo). A revogação encerra a sessão de refresh
    correspondente.
  - `token` ausente → `400 invalid_request`. Credenciais de client inválidas →
    `401 invalid_client` (+ `WWW-Authenticate`, como no `/auth/token`).
  - `token_type_hint=access_token` → `200` no-op: access tokens são JWTs
    stateless sem blocklist (expiram em ≤15 min).
  - Os `allowedGrantTypes` do client **não** restringem o revoke.
- **Discovery**: novos campos `revocation_endpoint` (`${base}/auth/revoke`) e
  `revocation_endpoint_auth_methods_supported`
  (`["client_secret_basic","client_secret_post","none"]`) — libs OIDC
  (Auth.js, oidc-client-ts) passam a descobrir a revogação automaticamente.

### Entrega A — Estado de conta unificado (correção de segurança, sem mudança de shape)

- Os fluxos OAuth `authorization_code` (exchange), `refresh_token` e o caminho
  SSO do `GET /auth/authorize` agora aplicam a **mesma checagem de
  elegibilidade de conta** do fluxo cookie: `blockedAt` + `deactivatedAt` +
  `deletedAt` (antes, o refresh OAuth só checava bloqueio e o exchange/SSO não
  checavam nada — conta desativada/excluída conseguia renovar/emitir tokens).
- **Matriz fluxo × status** (documentada em `backend.md` §8 e `frontend.md`
  §4): OAuth (`POST /auth/token`) → `400 invalid_grant`; sessão cookie
  (`POST /token/refresh`) → `401`; SSO (`GET /auth/authorize` com cookie de
  conta inelegível) → `200 { status: "login_required" }` (cookie ignorado, não
  é erro). Consumidores devem tratar `400 invalid_grant` e `401` como **falha
  definitiva de sessão**.
- A `error_description` para conta inelegível é **única e genérica**
  (`"Account is not accessible"`) para os 3 estados — a resposta nunca revela
  qual; o estado real vai apenas para log estruturado. Novo `error_hint`
  correspondente na taxonomia de `invalid_grant` (substitui a dica antiga que
  citava bloqueio).
- Nenhuma mudança de shape: códigos de erro, claims e cookies permanecem
  idênticos. Requests que antes **indevidamente** sucediam (conta
  desativada/excluída) passam a falhar — correção de segurança intencional.

[1.2.0]: #120--2026-07-14

## [1.1.0] — 2026-07-14

**MINOR (aditivo)** — Grace window na rotação do refresh token (P1).

- A rotação do refresh token (fluxos `grant_type=refresh_token` e
  `POST /token/refresh`) passa a tolerar o reuso do código **imediatamente
  anterior** dentro de uma janela curta (`REFRESH_ROTATION_GRACE_MS`, default
  60s; `0` desliga = single-use estrito). Dentro da janela, o IDP devolve um
  novo access token + o refresh token **vivo atual** — requests concorrentes
  com o mesmo token convergem para o mesmo par válido, sem erro.
- **Endurecimento:** reuso do código anterior **fora** da janela é replay real —
  a sessão inteira é revogada antes do `invalid_grant` (OAuth) / `401` (cookie).
- Checagens de conta (bloqueio) e o binding do token ao client emissor
  (SEC-004) aplicam-se igualmente dentro da janela.
- Nenhuma mudança de shape: requests/responses, claims, cookies e códigos de
  erro permanecem idênticos. Nenhum consumidor precisa mudar — comportamento
  puramente aditivo (requests que antes falhavam com `invalid_grant`/`401`
  passam a suceder dentro da janela).
- Observabilidade: novos logs estruturados `oauth_refresh_grace_hit`,
  `oauth_refresh_replay_detected` (OAuth) e `refresh.grace_hit`,
  `refresh.replay_detected` (cookie).

[1.1.0]: #110--2026-07-14

## [1.0.0] — 2026-06-24

Linha de base do contrato, extraída do estado atual do IDP e fixada por contract
tests (RFC-0005 / T11). Cobre cinco superfícies:

- **JWT claims** — access token de usuário (`sub, email, name, role,
  email_verified, iss, aud[], iat, exp`, opcional `new_user`) e M2M (`sub,
  client_id, scope, iss, aud[], iat, exp`); `alg=RS256`, `kid` no header. Fonte
  única: `@overlens/idp-token-core` (RFC-0005 / T1). `role` emitido porém
  `@deprecated` como fonte de autorização (ADR-0008).
- **Discovery** (`/.well-known/openid-configuration`) — endpoints e capacidades
  (`grant_types_supported`, `code_challenge_methods_supported: ["S256"]`,
  `id_token_signing_alg_values_supported: ["RS256"]`, `scopes_supported`, etc.).
- **JWKS** (`/.well-known/jwks.json`) — shape `{ keys: [{ kty, use, alg, n, e,
  kid }] }`.
- **Erros** — formato OAuth `{ error, error_description, error_hint }` (o
  `error_hint` acionável veio na RFC-0005 / T7a) e o conjunto de códigos.
- **Set-Cookie** dos fluxos de sessão — `SameSite=Lax`, `HttpOnly`, `Secure`,
  `maxAge` em **ms**, paths `/` (access) e `/token/refresh` (refresh) — regras
  críticas do `CLAUDE.md §2`.

[1.0.0]: #100--2026-06-24
