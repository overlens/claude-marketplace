# Rodar o IDP localmente via container (RFC-0005 / T8)

> Para integradores (humanos **ou** Claude Code) que querem um **IDP real**, com
> banco real, sem clonar/configurar este repositório nem depender de internet.
>
> Resolve dois casos:
> - **Caso A (offline):** subir o IDP localmente com um `docker compose up`.
> - **Caso B (e2e):** rodar testes de integração de ponta a ponta contra o IDP
>   real em CI — efêmero e isolado (um container por run).
>
> Não confundir com:
> - **Mock in-process** ([`@overlens/idp-testing/mock-idp`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/src/mock-idp/README.md)) — peso-pena, sem Docker, para a maioria dos testes de client.
> - **Sandbox dedicada** (`idp-test.overlens.com.br`, T9) — sempre no ar quando provisionada (runbook aprovado — RFC-0006 D1; provisionamento pendente), para dev casual. Ver [`../deploy/idp-test-sandbox.md`](../deploy/idp-test-sandbox.md).
>
> **Última atualização:** 2026-07-18

---

## O que o stack entrega

O `apps/idp/docker-compose.test.yml` sobe um stack **efêmero**:

- **IDP** (imagem do `Dockerfile` da raiz) em `http://localhost:3147`
- **Postgres 17** (em `tmpfs` — sem volume, começa limpo a cada run)
- **Redis 7** (cache do authorization-code; em `tmpfs`)

No boot, o container roda `prisma migrate deploy` e seeda o **manifesto de
fixtures T3** (clients + usuários de teste conhecidos), com:

- **keypair/issuer determinísticos** (keypair de teste T1) — `iss=http://localhost:3147`,
  `aud=http://localhost:3148`, `kid` fixo. Um token deste container é
  **byte-compatível** com um cunhado pelo toolkit (T2) ou pelo mock (T4).
- **`IDP_TEST_MODE=true`** — habilita o login headless `POST /test/login` (T6),
  que emite um authorization code para um usuário semeado **sem UI nem senha**.
- **`NODE_ENV=test`** — obrigatório: o boot do IDP **falha de propósito** se
  `NODE_ENV=production` junto de `IDP_TEST_MODE=true`.

Credenciais conhecidas (do manifesto): clients `test-web-bff` (confidential),
`test-public-pkce` (public/PKCE), `test-m2m-service` (M2M); usuários como
`ana.active@example.test`. Fonte única: [`@overlens/idp-testing/fixtures`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/src/fixtures/fixtures.ts).

> ⚠️ Tudo aqui é **público por definição** (keypair, segredos, senhas de teste).
> Nunca reutilize em produção.

---

## Caso A — subir o IDP localmente

Pré-requisito: **Docker**.

```bash
cd apps/idp
docker compose -f docker-compose.test.yml up --build      # ou: pnpm docker:test:up
```

Espere o healthcheck do serviço `idp` ficar `healthy` (checa DB + JWKS). Então:

```bash
curl http://localhost:3147/health
curl http://localhost:3147/.well-known/openid-configuration
curl http://localhost:3147/.well-known/jwks.json
```

Aponte o seu app para `IDP_ISSUER=http://localhost:3147`. Para derruba­r e limpar:

```bash
docker compose -f docker-compose.test.yml down -v          # ou: pnpm docker:test:down
```

### Login headless (sem browser)

```bash
# 1) Emite um authorization code para um usuário de teste (sem senha/UI).
curl -s -X POST http://localhost:3147/test/login \
  -H 'content-type: application/json' \
  -d '{
    "email": "ana.active@example.test",
    "clientId": "test-web-bff",
    "redirectUri": "http://localhost:3000/api/auth/callback",
    "codeChallenge": "<BASE64URL(SHA256(code_verifier))>",
    "codeChallengeMethod": "S256",
    "scope": "openid profile email",
    "state": "xyz"
  }'
# → { "code": "...", "state": "xyz" }

# 2) Troca o code por tokens (fluxo OAuth real, PKCE validado).
curl -s -X POST http://localhost:3147/auth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=...&redirect_uri=http://localhost:3000/api/auth/callback&client_id=test-web-bff&client_secret=dev-secret-test-web-bff&code_verifier=<code_verifier>'
```

---

## Caso B — e2e em CI com Testcontainers

O pacote `@overlens/idp-testing` expõe um helper que sobe o stack acima e espera
a readiness pelo healthcheck:

```ts
import { startIdpContainer } from '@overlens/idp-testing/container';

// Repo externo (padrão): compose embutido no pacote — imagem ghcr.io/overlens/idp-test
const idp = await startIdpContainer();
// Monorepo do IDP (builda a imagem local):
// const idp = await startIdpContainer({ composeDir: 'apps/idp' });
try {
  // idp.url     → http://<host>:<portaMapeada>   (use para requests)
  // idp.issuer  → http://localhost:3147          (claim iss dos tokens)
  // idp.jwksUri → ${idp.url}/.well-known/jwks.json
  const res = await fetch(`${idp.url}/test/login`, { method: 'POST', /* ... */ });
} finally {
  await idp.stop();
}
```

Requisitos: **Docker** + a peer dependency opcional `testcontainers`
(`pnpm add -D testcontainers`).

> `idp.url` (porta mapeada aleatória, para isolar runs paralelos) é o endereço de
> **conexão**; `idp.issuer` é o `iss` **lógico** dos tokens, fixo — valide o
> token contra `idp.issuer`, conecte via `idp.url`.

### E2e de demonstração no próprio repo

`apps/idp/test/container.e2e-spec.ts` exercita login headless → troca de code →
verificação RS256 do token (paridade T1). Fica **pulado por padrão** (o
`pnpm test` não exige Docker); rode-o explicitamente:

```bash
cd apps/idp
pnpm test:container        # IDP_CONTAINER_E2E=1 jest test/container.e2e-spec.ts
```

---

## Por que efêmero (e não a sandbox)

Instância compartilhada é ótima para dev casual e **ruim para teste**: poluição
de estado e flakiness em runs paralelos. O container T8 é efêmero e isolado (um
por run). A sandbox hospedada (T9) cobre o dev casual de zero-setup. Os dois
coexistem e seedam o **mesmo** manifesto, garantindo paridade.
