# Deploy da Sandbox de Teste do IDP (RFC-0005 / T9)

> **Público:** time de DevOps.
> **Status (2026-07-23): NO AR** — provisionada e validada (WS0.10: fluxo headless
> `/test/login` → exchange → token RS256 com kid de teste; `idp-doctor` 6/6 PASS).
> `IDP_AUDIENCE` alinhado em 2026-07-23: os tokens da sandbox saem com
> `aud: ["https://api-test.overlens.com.br"]` — é este o valor que integradores que
> validam audience devem usar contra a sandbox (verificado por token real).
> **Histórico do naming:** o domínio originalmente proposto, `idp.dev` (dois níveis
> de subdomínio), foi **abandonado** — dois níveis quebram o certificado universal
> da Cloudflare. A sandbox é uma implantação **nova e dedicada** em
> **`idp-test.overlens.com.br`**. ⚠️ Não confundir com `idp-dev.overlens.com.br`:
> aquela é (e continua sendo) a instância de dev *comum* — test-mode **desligado**,
> keypair próprio, consumida pelo Accounts dev (ver [`railway.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/railway.md)) —
> e **NÃO é a sandbox**.
>
> **Objetivo:** colocar no ar uma instância **sempre-disponível** do IDP, com
> dados de dev seedados, para que qualquer integrador (humano **ou** Claude Code)
> aponte o app dele para um IDP que já existe — **zero-setup, sem clonar este
> repositório, sem Docker local**.
>
> Esta sandbox **reusa a mesma imagem** do container efêmero de T8
> (`Dockerfile` da raiz). A diferença é operacional: aqui o Postgres é
> **persistente** e o serviço fica **sempre no ar**. O passo a passo de T8 (uso
> efêmero/local e e2e) está em [`../integration/run-local-container.md`](../integration/run-local-container.md).
>
> **Última atualização:** 2026-07-22

---

## ⚠️ Modelo de segurança — leia antes de tudo

A sandbox roda com **`IDP_TEST_MODE=true`**, ou seja, o endpoint **`POST /test/login`
é público**: qualquer um na rede emite um authorization code para qualquer usuário
de teste **sem senha**. Isso é **intencional** (é o que dá o loop fechado ao agente),
mas implica regras rígidas:

1. **Keypair de teste é público.** A sandbox assina com o keypair de teste
   versionado (RFC-0005 / T1), que é público por definição. **Tokens da sandbox
   NÃO são confiáveis por nenhum Resource Server de produção** — produção usa
   outro keypair (`kid` diferente) e outro `issuer`/`audience`. Um token da
   sandbox só vale contra serviços que confiam explicitamente no JWKS da sandbox.
2. **Nada de dado real.** Banco isolado, só fixtures de dev (T3). **Nunca**
   conectar a sandbox ao Postgres `identity` de produção (Neon `main`).
3. **`NODE_ENV` ≠ `production`.** O boot do IDP **falha de propósito** se
   `NODE_ENV=production` && `IDP_TEST_MODE=true` (salvaguarda de T6). Use
   `NODE_ENV=development` na sandbox.
4. **Acesso aberto — por decisão (RFC-0006 / WS0.6).** A sandbox fica exposta
   **sem** Cloudflare Access/allowlist: só há fixtures (nenhum dado real), o
   banco é isolado e o rate limit fica **ativo**. Colocar um controle de acesso
   na frente anularia o **zero-setup** para integradores externos — que é a
   razão de existir da sandbox. Ver "Decisões" ao final.

---

## Arquitetura

```
            ┌──────────────────────────── Cloudflare (DNS + TLS) ─────────────────────┐
            │                                                                          │
 dev/agent ─┼─ https://idp-test.overlens.com.br ─► [ IDP (imagem T8) ] ─► [ Postgres sandbox (persistente) ]
            │                                              │             └► [ Redis (cache auth-code) ]
            └──────────────────────────────────────────────┴───────────────────────────┘
```

- **IDP:** a imagem do `Dockerfile` da raiz (a mesma de produção/T8), com env de
  sandbox.
- **Postgres sandbox (persistente):** um banco isolado — Neon branch `sandbox`
  **dedicada à sandbox** ou um Postgres do provedor (Railway). **Não** é o banco
  de produção nem o de dev.
- **Redis:** cache do authorization-code (recomendado para fidelidade; o IDP cai
  para memory-cache sem `REDIS_URL`, mas aí múltiplas instâncias divergem).

---

## Pré-requisitos

- Acesso ao provedor de deploy (este guia assume **Railway**, como produção — ver
  [`railway.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/railway.md); adapte para o provedor escolhido).
- Acesso ao DNS de `overlens.com.br` (Cloudflare) — ver [`cloudflare.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/cloudflare.md).
- Um Postgres **persistente e isolado** para a sandbox (Neon branch dedicada ou
  Postgres do provedor).
- O valor base64 do keypair de **teste** (público) — já versionado em
  [`apps/idp/docker/test.env`](https://github.com/overlens/identity-provider/blob/main/apps/idp/docker/test.env). Para regenerar:
  ```bash
  node -e "import('@overlens/idp-token-core/test-keys').then(m=>console.log(Buffer.from(m.TEST_RSA_PRIVATE_KEY_PEM).toString('base64')))"
  ```

---

## Passo a passo

### 1. Provisionar o Postgres persistente (isolado)

- **Opção A — Neon:** criar uma branch `sandbox` (ou um projeto separado)
  **distinta** da branch `main` de produção. Pegar a connection string
  (`?sslmode=require`).
- **Opção B — Railway Postgres:** adicionar um plugin Postgres ao projeto da
  sandbox; usar a `DATABASE_URL` interna.

> Persistente (com volume) — ao contrário do T8 efêmero. É o que permite "já estou
> logado / meu client já existe" entre sessões de dev.

### 2. Criar o serviço do IDP (sandbox)

No Railway (ou equivalente), crie um **serviço separado** do de produção e do
`idp-dev`, apontando para este repositório/`Dockerfile`:

```toml
# railway.toml já existe e serve: builder DOCKERFILE, healthcheckPath "/health".
# Crie um AMBIENTE/serviço "sandbox" com as env vars abaixo.
```

A imagem é a mesma; o que muda é o **env** e o **comando** (migrate + seed + start).
O `CMD` padrão do `Dockerfile` só faz `migrate deploy && node dist/main` — a
sandbox precisa **também seedar**. Configure o start command do serviço para:

```sh
sh -c "cd apps/idp && pnpm prisma migrate deploy && pnpm db:seed:ci && node dist/main"
```

> ⚠️ O wrapper `sh -c "..."` é obrigatório: o Custom Start Command do Railway em
> deploys via Dockerfile executa em **exec form (sem shell)** — sem o wrapper,
> `cd` falha com "The executable `cd` could not be found" (`cd` é builtin de
> shell, não executável; verificado em 2026-07-23). O `CMD` do Dockerfile não
> sofre disso porque a shell-form já embute `/bin/sh -c`.

> `db:seed:ci` roda `tsx prisma/seed.ts` sem Infisical. Com `IDP_TEST_MODE=true`,
> ele semeia o usuário root **e** as fixtures (3 clients + 6 usuários de teste de
> T3). O seed é **idempotente** (upsert) — seguro rodar a cada deploy.

### 3. Variáveis de ambiente da sandbox

| Variável | Valor | Notas |
|---|---|---|
| `NODE_ENV` | `development` | **NÃO** `production` (senão o boot falha com `IDP_TEST_MODE=true`). |
| `IDP_TEST_MODE` | `true` | Habilita `POST /test/login`. Ver modelo de segurança acima. |
| `PORT` | (injetado pelo Railway) | O IDP lê `PORT`. |
| `DATABASE_URL` | conn string do Postgres **sandbox** | Isolado de produção e de dev. |
| `REDIS_URL` | `redis://…` | Recomendado. |
| `RSA_PRIVATE_KEY` | base64 do keypair de **teste** | Público (T1). Ver `docker/test.env`. |
| `RSA_KID` | `e9e594c8f37e68d4330fa55c2857f4401478ed1e922654e890b6cfb34877e3f5` | kid fixo do keypair de teste. |
| `IDP_ISSUER` | `https://idp-test.overlens.com.br` | `iss` dos tokens da sandbox. ⚠️ **Sem barra final** — barra final gera URLs com `//` no discovery (bug real já observado no `idp-dev`). |
| `IDP_BASE_URL` | `https://idp-test.overlens.com.br` | Base do discovery. ⚠️ **Sem barra final** (mesmo motivo acima). |
| `IDP_AUDIENCE` | `https://api-test.overlens.com.br` (sugestão — ajustável) | Audiences aceitos; ajuste ao(s) consumidor(es) reais da sandbox (CSV para múltiplos). |
| `IDP_COOKIE_DOMAIN` | **omitir** (host-only) | Não há SSO cross-subdomain na sandbox — cookie host-only basta. Ver caveat de cookie abaixo. |
| `IDP_COOKIE_SECURE` | `true` | A sandbox é HTTPS (Cloudflare). |
| `IDP_DEFAULT_POST_LOGOUT_URI` | uma URL estável qualquer (ex.: página "logged out" genérica) | Fallback do RP-logout — na sandbox, qualquer URL estável serve. |
| `ROOT_USER_EMAIL` / `ROOT_USER_PASSWORD` | credenciais de dev | Usuário admin semeado. |
| `LOG_LEVEL` | `info` | |

Opcionais (deixe vazio se não usar a feature): `GOOGLE_CLIENT_ID`,
`POSTHOG_API_KEY`/`POSTHOG_HOST`, `AVATAR_S3_*`/`AWS_*`, `SENTRY_DSN`.

> **Por que `IDP_ISSUER` = a URL pública (e não `localhost:3147`):** diferente do
> container T8 (que fixa `localhost` para paridade com o mock), a sandbox é
> alcançada pela URL pública, então `iss`/discovery devem apontar para ela.

### 4. `redirect_uris` de localhost/loopback (já vêm das fixtures)

Os clients de dev seedados (T3) **já incluem** `redirect_uris` de
`http://localhost:*` e `http://127.0.0.1:*` (ex.: `test-web-bff` →
`http://localhost:3000/api/auth/callback`). Isso é o que permite um dev rodando o
app em `localhost` completar o fluxo contra a sandbox remota. Para adicionar
outros, edite o manifesto ([`@overlens/idp-testing/fixtures`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/src/fixtures/fixtures.ts))
e refaça o deploy (o seed é idempotente), **ou** cadastre o client via a área
administrativa do IDP.

### 5. DNS + TLS (Cloudflare)

- Criar o registro `idp-test` → serviço da sandbox (CNAME para o domínio do
  Railway), **proxied** (laranja) para TLS automático. Um único nível de
  subdomínio — sem o problema de certificado que matou o `idp.dev`. Ver
  [`cloudflare.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/cloudflare.md).
- **Sem Cloudflare Access** — o acesso é aberto por decisão (WS0.6; ver modelo
  de segurança item 4 e "Decisões" ao final).

### 6. Validar

```bash
curl https://idp-test.overlens.com.br/health
# {"status":"ok","checks":{"database":{"status":"ok"},"jwks":{"status":"ok"}}}

curl https://idp-test.overlens.com.br/.well-known/openid-configuration
curl https://idp-test.overlens.com.br/.well-known/jwks.json
```

Fluxo headless de ponta a ponta (deve devolver tokens RS256):

```bash
# code_challenge = BASE64URL(SHA256(code_verifier))
curl -X POST https://idp-test.overlens.com.br/test/login \
  -H 'content-type: application/json' \
  -d '{"email":"ana.active@example.test","clientId":"test-web-bff","redirectUri":"http://localhost:3000/api/auth/callback","codeChallenge":"<challenge>","codeChallengeMethod":"S256","scope":"openid profile email","state":"x"}'
# → { "code": "...", "state": "x" } → troque em POST /auth/token
```

---

## Operação contínua

### Reset agendado semanal (decidido — RFC-0006 / WS0.7)

Postgres persistente compartilhado **convida poluição**: o `username` é único
global (RFC-0001), então testes que criam usuários podem colidir; estado de
sessão/refresh acumula. Como a sandbox é **dedicada** (sem conflito com o
Accounts dev), a política é:

- **Reset agendado semanal:** job que dropa o schema e re-roda
  `migrate deploy` + `db:seed:ci`. Simples e previsível.
- **Reset sob demanda:** `railway run` manual com o mesmo procedimento, quando
  a poluição atrapalhar antes da janela semanal.

> O seed é **idempotente** (upsert por email/clientId), então re-seedar não
> duplica; o reset serve para **limpar** dados criados por testes, não para
> recriar as fixtures.

### Caveat de cookie / sessão SSO em dev (RFC-0005 §7)

No fluxo BFF, o **cookie de sessão é setado no domínio do app** (ex.: `localhost`),
não no domínio do IDP. Logo, a sessão SSO ("já estou logado") **não persiste**
entre apps em dev contra a sandbox — é aceitável **re-logar** a cada vez. É por
isso que `IDP_COOKIE_DOMAIN` fica **host-only** (omitida): não há SSO
cross-subdomain para cobrir. Se a persistência de SSO em dev virar requisito,
avaliar DNS de loopback (`*.lvh.me` / `sslip.io`) + `IDP_COOKIE_DOMAIN`
ajustável — fora do escopo deste deploy inicial.

### Observabilidade

- Healthcheck: `/health` (DB + JWKS) — o Railway já reinicia em falha
  (`railway.toml`).
- Logs: `pino` em stdout (LOG_LEVEL=info). Sem Infisical/secret real para vazar.

---

## Decisões (fechadas na RFC-0006, 2026-07-22)

- **Naming — decidido: `idp-test.overlens.com.br`.** O `idp.dev` original foi
  abandonado (dois níveis de subdomínio quebram o certificado universal da
  Cloudflare); `idp-dev` segue como instância de dev comum e nunca vira sandbox.
- **Reset — decidido: agendado semanal** (job: drop schema + `migrate deploy` +
  `db:seed:ci`) + reset sob demanda via `railway run`. Viável agora que a
  sandbox é dedicada e ninguém depende do estado dela.
- **Controle de acesso — decidido: aberto.** Só fixtures, nenhum dado real,
  banco isolado e rate limit ativo. Cloudflare Access (allowlist) anularia o
  **zero-setup** — integradores externos não têm conta na Cloudflare da
  Overlens, e o objetivo da sandbox é justamente "aponte e use".

Ainda em aberto (RFC-0005 §7):

- **Persistência de SSO em dev:** aceitar re-login vs DNS de loopback +
  `IDP_COOKIE_DOMAIN` — ver caveat de cookie acima.

> A sandbox compartilhada é ótima para **dev casual** e ruim para **teste
> determinístico** — para teste, prefira o container efêmero de T8
> (um por run, sem estado compartilhado). Os dois coexistem e seedam o **mesmo**
> manifesto (T3), garantindo paridade.
