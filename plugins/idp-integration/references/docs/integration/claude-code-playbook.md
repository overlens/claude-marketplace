# Playbook — Integrar com o IDP Overlens via Claude Code

> **Para quem:** orquestradores que vão **dirigir o Claude Code** para integrar um
> sistema ao Identity Provider da Overlens. Este é o mapa estratégico — *o que
> existe, o que pedir ao agente e como saber que deu certo*. Os guias profundos
> de cada peça estão linkados ao final.
>
> Entregue pela **RFC-0005** ("DX e verificação de integrações"). A premissa que
> reordena tudo: **o integrador costuma ser o próprio Claude Code**, então cada
> artefato existe para dar ao agente um **sinal automático de "está correto"**
> (`pnpm test` → verde), determinístico e offline.
>
> **Última atualização:** 2026-07-18

---

## 1. O modelo mental: 3 movimentos

Toda integração ao IDP segue o mesmo arco. Seu trabalho como orquestrador é
apontar o Claude Code para o movimento certo e **verificar o verde** ao final.

| # | Movimento | O agente faz | Você verifica |
|---|---|---|---|
| **1. Integrar** | wirar login (cliente) **ou** validação (Resource Server) **ou** M2M | gera o código de auth (skills `idp-auth-*` / `idp-validate-token` / `idp-integrate-m2m`) | compila/sobe |
| **2. Verificar** | dropar a **suíte de conformidade** | gera testes (skill `idp-test-integration`) que provam o fluxo offline | `pnpm test` → **verde** |
| **3. Preflight** | checar config contra o ambiente real | roda o **doctor** | `idp-doctor` exit 0 |

O pulo do gato da RFC-0005 é o **movimento 2**: sem ele, "integrei" é uma crença;
com ele, é um fato verde/vermelho. **Sempre peça os dois** ("integre **e** adicione
os testes de conformidade") — é o que fecha o loop do agente.

---

## 2. Decisão: "meu sistema é X → diga ao Claude Code Y"

Identifique o tipo do sistema do integrador e use o prompt correspondente. O
agente dispara o skill certo pela `description` — você não precisa nomeá-lo, mas
pode.

| O sistema do integrador… | Tipo | Peça ao Claude Code | Skill que dispara |
|---|---|---|---|
| App Next.js (App Router) que faz login | Client/BFF | "integre o login Overlens neste app Next.js **e** adicione os testes de conformidade" | `idp-auth-nextjs` → `idp-test-integration` |
| SPA Vite + backend (BFF) separado | Client/BFF | "integre o login Overlens (Vite + BFF) e prove com testes" | `idp-auth-vite-bff` → `idp-test-integration` |
| Mobile / SPA sem backend (PKCE puro) | Public client | "integre login Overlens PKCE-only e teste o fluxo" | `idp-auth-mobile` → `idp-test-integration` |
| Web com backend (NestJS/Express/Rails/Django) | Client/BFF | "integre o login Overlens neste BFF e adicione conformidade" | `idp-integrate-oauth-web` → `idp-test-integration` |
| API que **valida** o JWT (Resource Server) | Resource Server | "valide o token Overlens nesta API **e** prove a validação com testes" | `idp-validate-token` → `idp-test-integration` |
| Worker/serviço que chama outra API (sem usuário) | M2M | "configure o cliente M2M Overlens (client_credentials)" | `idp-integrate-m2m` |
| Não sei por onde começar | — | "como integro este projeto ao IDP Overlens?" | `idp-auth-guide` (roteia) |

**Quando algo quebra** (reativo, fora do fluxo de integração):

| Sintoma | Peça | Skill |
|---|---|---|
| Um token específico não valida (`kid not found`, assinatura, iss/aud) | "por que este token Overlens está falhando? `<token>`" | `idp-debug-jwt` |
| Erro HTTP (`401 invalid_client`, CORS, `redirect_uri`, `429`, cookie `Max-Age=0`) | "estou recebendo `<erro>` integrando o Overlens" | `idp-troubleshoot-auth-errors` |

---

## 3. Prompts de exemplo (copie e adapte)

```
# Integração + verificação num passo (o padrão recomendado)
"Este é um BFF Next.js. Integre o login com o IDP Overlens (Authorization Code +
 PKCE) e, em seguida, scaffolde a suíte de conformidade para provar que callback,
 refresh e logout estão corretos. Rode pnpm test e me mostre verde."

# Resource Server
"Esta API NestJS recebe um Bearer token do IDP Overlens. Construa a camada de
 validação (RS256, iss/aud, Bearer + cookie) e adicione os testes de conformidade
 de Resource Server. Quero pnpm test verde."

# Preflight antes de apontar para a sandbox/prod
"Rode o preflight (idp-doctor) contra https://idp-test.overlens.com.br com a
 audience da minha API e um access token de exemplo, e corrija qualquer drift."
```

> **Dica de orquestração:** o agente tende a enfraquecer asserções quando um teste
> falha. Reforce no prompt: *"se um teste de conformidade falhar, corrija a
> integração — nunca enfraqueça o teste."*

---

## 4. O arsenal (o que a RFC-0005 entregou)

Cinco famílias de artefato. Os detalhes de uso de cada um estão na
[referência do toolkit](./idp-testing-toolkit.md) e nos links no fim.

| Família | O que é | Quando o orquestrador usa |
|---|---|---|
| **Skills** (`.claude/skills/idp-*`) | guias acionáveis que o Claude Code dispara sozinho | sempre — é como o agente sabe integrar e testar |
| **Toolkit `@overlens/idp-testing`** | cunhagem de tokens, mock JWKS, casos negativos, **kit de conformidade** (RS + client), mock IDP, fixtures, container helper, doctor | movimento 2 (verificar) — o agente instala e dropa nos testes |
| **Ambientes** | IDP real **containerizado** (efêmero) + **sandbox dedicada** (`idp-test.overlens.com.br` — no ar) | quando precisa de um IDP de verdade (e2e/dev sem clonar) |
| **Doctor** (`idp-doctor`) | preflight client-side (issuer/jwks/kid/aud/clock) | movimento 3 — antes de apontar para um ambiente real |
| **Verdade machine-readable** | discovery OIDC, **OpenAPI** (`/docs-json`), erros com `error_hint`, **contrato versionado** | anti-alucinação — o agente lê a verdade em vez de inventar |

---

## 5. Como verificar sem um IDP real (os três pesos)

A verificação é **offline e determinística** por design (keypair de teste fixo,
clock injetável, fixtures conhecidas, zero rede). Escolha o peso pela audiência:

| Peso | Ferramenta | Para quem | Sobe IDP? |
|---|---|---|---|
| **Leve** | toolkit + `runResourceServerConformance` | Resource Server (só valida JWT) | não — in-process |
| **Médio** | mock IDP + `runClientConformance` | client/BFF (inicia login) | não — mock in-process |
| **Pesado** | container (`docker-compose.test.yml`) ou `startIdpContainer()` | e2e contra o IDP **real** + Postgres | sim — efêmero |
| **Zero-setup** | sandbox `idp-test.overlens.com.br` | dev casual, sem Docker nem clone | sim — hospedado |

Regra prática: **conformance kit** resolve 90% (rápido, sem Docker). O **container**
é para o e2e de ponta a ponta; a **sandbox** é para dev casual. Um token de
qualquer um deles é **byte-compatível** com os outros (mesmo `kid`/`iss`/`aud`).

---

## 6. Verdade machine-readable (por que o agente não alucina)

Aponte o Claude Code para estas fontes quando ele precisar da verdade do contrato:

- **OIDC Discovery** — `GET {issuer}/.well-known/openid-configuration` (endpoints, grants, PKCE S256, algs).
- **OpenAPI fetchável** — `GET {issuer}/docs-json` (UI em `/docs`).
- **Erros acionáveis** — todo erro OAuth carrega `error_hint` dizendo *como corrigir*.
- **Contrato versionado** — [`contract-version.json`](./contract-version.json) + [`CONTRACT-CHANGELOG.md`](./CONTRACT-CHANGELOG.md): se o IDP mudar o contrato, o build dele falha e o changelog avisa "regenere".

---

## 7. Pré-requisitos e caveats (leia antes)

- **Distribuição do toolkit:** `@overlens/idp-testing` e `@overlens/idp-token-core`
  são hoje `private` e consumidos via **workspace** dentro deste monorepo. Para um
  repositório **externo** rodar `pnpm add -D @overlens/idp-testing`, o pacote
  precisa estar **publicado** num registry acessível (npm privado / GitHub
  Packages da Overlens) — isso é um passo de publicação ainda **pendente** no lado
  do IDP. Enquanto não publicado: as verificações via toolkit/mock/conformance
  valem **dentro do monorepo**; para repositórios externos use o **container**
  (a imagem/compose vivem neste repo), o **doctor** e a
  **sandbox dedicada** (`idp-test.overlens.com.br`; status honesto: runbook
  aprovado, **aguardando provisionamento** — RFC-0006 D1).
- **Container/e2e real:** exige **Docker**. O e2e de demonstração é pulado por
  padrão; ligue com `IDP_CONTAINER_E2E=1`.
- **`IDP_TEST_MODE` é só para teste:** o login headless `POST /test/login` só
  existe com `IDP_TEST_MODE=true` (container/sandbox) — **nunca** em produção (o
  boot do IDP falha de propósito se `NODE_ENV=production` junto). O seed de
  fixtures tem opt-in próprio, `IDP_SEED_FIXTURES=true`, e recusa gravar num
  banco que hospede implantação real.
- **Tokens de teste são públicos:** keypair, segredos de fixtures e senhas são
  públicos por definição. Tokens da sandbox/container **não são confiáveis** por um
  Resource Server de produção (keypair e issuer diferentes).

---

## 8. Instalação via plugin (repos externos)

Fora deste monorepo, as skills `idp-*` chegam como **plugin do Claude Code** —
sem clonar este repo. Dentro do Claude Code, 2 comandos:

```
/plugin marketplace add overlens/claude-marketplace
/plugin install idp-integration@overlens
```

Depois, no projeto do integrador, o ponto de partida é o comando
`/idp-integrate` (nome completo: `/idp-integration:idp-integrate`) — ele
dispara o wizard `idp-onboarding` — ou simplesmente pedir: *"quero adicionar
login da Overlens no meu sistema"*.

Duas propriedades importam para o orquestrador:

- **Docs embutidos:** as skills instaladas carregam `docs/integration/`,
  `docs/learning/` e os guias de deploy relevantes dentro do próprio plugin
  (`references/docs/`) — nenhum ponteiro aponta para path deste repo.
- **Versão = contrato:** a versão do plugin espelha
  [`contract-version.json`](./contract-version.json) (sincronizada por
  `scripts/sync-plugin.mjs` no release). Plugin atrás do contrato? Peça
  `/plugin marketplace update overlens` e reinstale.

---

## 9. Onde aprofundar

| Tema | Doc |
|---|---|
| Referência completa do toolkit + CLI | [`idp-testing-toolkit.md`](./idp-testing-toolkit.md) |
| Rodar o IDP real local (container) / e2e em CI | [`run-local-container.md`](./run-local-container.md) |
| Sandbox hospedada (deploy, DevOps) | [`../deploy/idp-test-sandbox.md`](../deploy/idp-test-sandbox.md) |
| Contrato público (estabilidade) | [`contract-version.json`](./contract-version.json) · [`CONTRACT-CHANGELOG.md`](./CONTRACT-CHANGELOG.md) |
| Kit de conformidade (pacote) | [`../../packages/idp-testing/README.md`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/README.md) |
| Mock IDP in-process | [`../../packages/idp-testing/src/mock-idp/README.md`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/src/mock-idp/README.md) |
| Contrato de claims / signer (núcleo) | [`../../packages/idp-token-core/README.md`](https://github.com/overlens/identity-provider/blob/main/packages/idp-token-core/README.md) |
| Como integrar (por tipo de sistema) | os skills `.claude/skills/idp-*` + [`overview.md`](./overview.md) |
| Discovery / libs OIDC | [`oidc-discovery.md`](./oidc-discovery.md) |
