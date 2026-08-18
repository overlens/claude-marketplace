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

## [1.11.0] (2026-08-18)

**MINOR.** A recuperação de senha deixa de ser condicional: `POST
/auth/password/forgot` e `POST /auth/password/reset` existem sempre. **Nenhuma
claim, entrada de discovery, shape de erro, JWKS ou cookie muda.**

### O que sai do contrato

O `404` que as duas rotas devolviam quando `PASSWORD_RESET_ENABLED` estava
desligado. Ele era condicional a uma env var do operador, nunca a um estado do
pedido, e some junto com a env.

```
Antes:  404 (feature desligada — kill-switch PASSWORD_RESET_ENABLED)
Agora:  a rota responde normalmente; 404 só se ela realmente não existir
```

Quem trata `404` como "feature indisponível" não quebra, apenas nunca mais entra
nesse ramo. Quem usa `404` para descobrir se o IDP suporta reset de senha precisa
parar: a resposta agora é sempre a da rota.

### Por que o switch some

Ele protegia uma dependência real: sem envio de e-mail funcionando de ponta a
ponta, a pessoa pede ajuda e não recebe nada, e como a resposta é sempre `202`
nem ela nem a tela percebem. Só que essa dependência já tem dono em
`MAILER_PROVIDER`, que **falha o boot** ao declarar `resend` sem credencial. Uma
flag paralela não acrescentava garantia, só um segundo lugar onde alguém precisa
lembrar de ligar.

É a mesma remoção já feita em `BACKCHANNEL_LOGOUT_ENABLED` e
`EMAIL_RECOVERY_ENABLED`; a diferença é que estas duas rotas **estavam
publicadas** com o switch documentado desde a 1.7.0, então a mudança ganha
versão própria em vez de emenda.

### Antes de subir

Ambiente que não declarava a env tinha a feature **desligada**; ao subir esta
versão ela passa a responder. Confirme, em cada ambiente, que `MAILER_PROVIDER`,
`MAIL_FROM`, `RESEND_API_KEY` e `IDP_ACCOUNTS_BASE_URL` estão configurados —
senão o fluxo responde `202` e não entrega nada, que é exatamente o estado que o
switch existia para evitar.

**`contract-version.json`:** `version`/`updatedAt` sobem para 1.11.0. Os blocos
internos não mudam, então o `idp-contract.e2e-spec.ts` segue verde sem ajuste.

---

## [1.10.0] (2026-08-12)

**MINOR (aditivo).** Recuperação de e-mail pela própria caixa de entrada
(ADR-0015). Uma rota pública nova, para quem não lembra qual endereço usou no
cadastro. **Nenhuma claim, entrada de discovery, shape de erro, JWKS ou cookie
muda** e nenhuma integração existente precisa de ação.

> Esta entrada **substitui** uma versão anterior da 1.10.0, que descrevia
> `POST /auth/email/recover` (busca por CPF, resposta com o e-mail mascarado).
> Aquele desenho foi descartado antes de qualquer release e a rota nunca esteve
> ligada em nenhum ambiente, então nada foi removido de um contrato publicado e
> a versão continua 1.10.0.

### Novo: `POST /auth/email/forgot`

```
Request:  { "email": string }   ← um endereço CANDIDATO ("será que foi este?")
Response: 202 Accepted { "ok": true }   ← SEMPRE, sem exceção
Errors:   400 (e-mail sintaticamente inválido)
          429 (rate limit POR IP: 10 / 15 min)
```

Havendo conta acessível no endereço informado, o IDP manda **para aquela caixa**
uma mensagem confirmando a conta e levando de volta ao login. Não havendo, nada
é enviado. **A resposta HTTP é a mesma nos dois casos**, e é a mensagem, não a
resposta, que diz ao usuário que ele achou o endereço certo.

### A resposta não revela se a conta existe, e é esse o desenho

Mesma propriedade do `POST /auth/password/forgot`: endereço com conta,
desconhecido, de conta bloqueada/desativada/excluída e com cota estourada
produzem o mesmo status, o mesmo corpo e o mesmo tempo de resposta (o envio do
e-mail não é aguardado). Um cliente **não pode** usar este endpoint para
descobrir se um endereço existe; qualquer heurística nesse sentido vai falhar.

Ao integrar:

- **Não construa UI que finja saber o resultado.** A tela correta diz "se houver
  conta nesse endereço, enviamos uma mensagem para lá", que é o que o `202`
  significa.
- **Um endereço por requisição.** Quem tem três candidatos manda três pedidos.
- **A mensagem não é magic link.** Confirma a conta (endereço, nome, data de
  criação, se entra por senha ou Google) e leva ao login; não carrega token nem
  redefinição de senha, que continua sendo o `/auth/password/forgot`.
- **A cota por destinatário (3/hora) também responde `202`**, não `429`. Um 429
  ali confirmaria o endereço.
- **O `429` é por IP e transitório.** Respeite o `Retry-After` em vez de tratar
  como "não achei" (ver [`rate-limiting.md`](../deploy/rate-limiting.md) §4).
- **O `400` fala do formato do endereço digitado**, nunca do cadastro.

O que segue valendo: `/auth/password/forgot` continua não-enumerável, e agora as
duas rotas de recuperação seguem exatamente a mesma regra.

### Rollout

Sem kill-switch: a rota existe sempre. Uma versão anterior desta entrada a
descrevia atrás de `EMAIL_RECOVERY_ENABLED`, respondendo `404` enquanto
desligado; a flag foi removida antes de qualquer release, e como ela nunca
esteve ligada em nenhum ambiente, nada saiu de um contrato publicado e a versão
continua 1.10.0. O que a flag protegia continua protegido em outro lugar: sem
envio de e-mail configurado, o boot falha em `MAILER_PROVIDER=resend` sem
credencial. Envs em
[`environment-variables.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/environment-variables.md) §3, limites em
[`rate-limiting.md`](../deploy/rate-limiting.md) §2.

**`contract-version.json`:** `version`/`updatedAt` sobem para 1.10.0. Os blocos
internos (claims do JWT, discovery, JWKS, shapes de erro, cookies) **não mudam**,
como na 1.8.0, então o `idp-contract.e2e-spec.ts` segue verde sem ajuste. O bump
importa porque dois consumidores automatizados leem esse `version`: a tag da
imagem de sandbox (`publish-idp-test-image.yml`) e a versão do plugin
`idp-integration` (ADR-0013).

---

## [1.9.0] (2026-08-12)

**MINOR (aditivo).** Back-channel logout OIDC (ADR-0014). Nada é removido nem
renomeado: duas capacidades novas no discovery, uma claim nova no id_token e um
campo novo no OAuth client. **Quem não fizer nada continua funcionando
exatamente como hoje**, no piso de até 15 min descrito na 1.6.0.

### Discovery: duas capacidades novas

```jsonc
// GET /.well-known/openid-configuration
{
  "backchannel_logout_supported": true,
  "backchannel_logout_session_supported": true,
  "claims_supported": ["sub", "email", "name", "email_verified", "sid", "iss", "aud", "iat", "exp"]
}
```

A segunda entrada é a promessa de que o `logout_token` carrega `sid`, e é o que
faz libs OIDC (Auth.js, oidc-client-ts) casarem o logout com **uma** sessão em
vez de com o usuário inteiro. `claims_supported` ganha `sid`; nenhum valor foi
retirado da lista.

### id_token ganha `sid`

O `sid` é o identificador opaco da sessão de refresh que originou aquele login.
**Persista o `sid` junto da sua sessão local no callback**: é a chave que o
`logout_token` usa depois para dizer *qual* sessão morreu. O access token **não**
ganhou `sid`, e o `aud` do id_token continua string (não normalize, ver 1.3.0).

### Novo: `POST {backchannelLogoutUri}` (aqui o IDP chama VOCÊ)

```
POST https://api.seuapp.com.br/backchannel-logout
Content-Type: application/x-www-form-urlencoded

logout_token=<jwt RS256>

→ 200        processado (ou já visto antes: dedupe conta como sucesso)
→ não-2xx    o IDP reagenda com backoff exponencial até MAX_ATTEMPTS, depois dead-letter
```

O `logout_token` é assinado com o **mesmo keypair e `kid` do JWKS** que você já
usa para validar o access token. Header `typ: logout+jwt`; payload com `iss`,
`aud` (= seu `client_id`), `sub`, `sid`, `iat`, `jti` e:

```jsonc
"events": { "http://schemas.openid.net/event/backchannel-logout": {} }
```

**Sem `nonce`** (proibido pela spec) e **sem `exp`**: um prazo curto brigaria com
o retry, então a janela de frescor é imposta pelo receiver a partir do `iat`.

Obrigações do receiver, todas com contrato e exemplo em
[`logout.md`](./logout.md) §9: validar assinatura, `iss`, `aud` e a claim
`events`; **recusar** token que traga `nonce` (é id_token reaproveitado); limitar
a idade pelo `iat`; **deduplicar por `jti`** (a entrega é at-least-once e o retry
repete o `jti`); derrubar a sessão local casada pelo `sid`; responder 200.

### Campo novo no client: `backchannelLogoutUri`

Registrado via `POST`/`PATCH /admin/clients` com as mesmas regras de URI do
`webhookUrl` (HTTPS obrigatório, anti-SSRF, `""` limpa) e exposto na projeção
pública. `null` (o default) significa **sem push**: o client não entra no
fan-out e mantém o comportamento atual. Ver
[`oauth-clients.md`](./oauth-clients.md).

### Escopo do push e o que ele não muda

- O push **espelha** a revogação do `GET /auth/logout`: por dispositivo, com
  fallback per-client e global (precedência da 1.6.0). Um logout que revoga três
  sessões gera três `logout_token`, um por `sid`.
- **A revogação server-side continua sendo a fonte de verdade.** O push é
  aceleração. Nunca leia "não recebi `logout_token`" como "a sessão está viva":
  se a entrega falhar, o comportamento é o de antes desta versão.
- **Ainda sem push:** bloqueio, desativação, exclusão de conta e reset de senha
  revogam sessões e continuam no piso de até 15 min (ADR-0014, fora de escopo).

### Rollout

Sem kill-switch global: quem decide se recebe o push é você, registrando (ou
não) o `backchannelLogoutUri` do seu client. Sem endpoint registrado nada é
enfileirado e o logout se comporta como na 1.8.0, que é o mesmo degradado que uma
flag global daria, só que por client. Uma versão anterior desta entrada
descrevia um `BACKCHANNEL_LOGOUT_ENABLED` (default `false`); a flag foi removida
antes de qualquer release e nunca esteve ligada em nenhum ambiente, então nada
saiu de um contrato publicado e a versão continua 1.9.0. Registre seu endpoint e
valide em staging antes de contar com o push. Env vars em
[`environment-variables.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/environment-variables.md) §3.

**`contract-version.json`:** `version`/`updatedAt` sobem para 1.9.0 e o bloco
`discovery` ganha as duas flags booleanas e o `sid` em `claims_supported`. O
`idp-contract.e2e-spec.ts` compara esse bloco campo a campo com o que o
`DiscoveryService` devolve, então o JSON e o discovery mudam sempre no mesmo
commit.

---

## [1.8.0] — 2026-08-05

**MINOR (aditivo)** — CPF no perfil global (RFC-0001). Um atributo novo,
`document`, editável pelo dono e legível por backend confiável. **Nenhuma claim,
entrada de discovery, shape de erro, JWKS ou cookie muda** — integrações
existentes não precisam de nenhuma ação.

### `PATCH /auth/me` aceita `document`

```
Request:  { "document": "529.982.247-25" | "52998224725" | null }
Response: 200 (ProfileResponseDto)
Errors:   400 formato fora de 11 dígitos (com ou sem máscara)
          400 "CPF inválido" quando os dígitos verificadores não fecham
```

Aceita com ou sem máscara e persiste apenas os dígitos. `null` limpa o valor.
A validação de dígito verificador é do servidor: um CPF bem formatado ainda pode
ser inválido, e sequências repetidas (`11111111111`) são recusadas mesmo passando
na conta dos verificadores.

### `GET /auth/me` responde `maskedDocument`

O perfil do próprio usuário **nunca** devolve o CPF cru, seguindo a mesma regra
já aplicada a e-mail e telefone. `"52998224725"` sai como `"********725"`, e o
campo é `null` quando não há documento cadastrado. Serve para a interface dizer
"está cadastrado" sem trafegar o número.

### `GET /users/:sub` (M2M, scope `profile:read`) inclui `document`

Aqui o valor sai **cru**, como `email`, `phone` e `birthDate` já saem, porque o
consumidor é um backend registrado com `client_secret`. Conceda `profile:read`
apenas a serviços que precisam.

### `profile-updated` aceita `document` no hint `changed`

O vocabulário de `ProfileChangedField` ganha `'document'`. O payload do SET
continua sem valores, apenas o hint, então nenhum dado pessoal viaja no fan-out.

**`contract-version.json`:** o `version`/`updatedAt` sobem para 1.8.0, como nas
entradas anteriores que também não acrescentaram claim nem endpoint (ver 1.6.0).
Os blocos internos do arquivo (claims do JWT, discovery, JWKS, shapes de erro,
cookies) **não mudam**, porque o payload do perfil não está entre eles: o
`idp-contract.e2e-spec.ts` continua verde sem ajuste. O bump importa porque dois
consumidores automatizados leem esse `version`: a tag da imagem de sandbox
(`publish-idp-test-image.yml`) e a versão do plugin `idp-integration` (ADR-0013).

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

Ambas as rotas ficaram atrás de `PASSWORD_RESET_ENABLED` (default **`false`**),
respondendo `404` enquanto desligadas. **Isso valeu até a 1.11.0**, que removeu o
switch: hoje as duas rotas existem sempre. Ver a entrada da 1.11.0 no topo.

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
