# Referência — `@overlens/idp-testing` (toolkit de verificação do IDP)

> Referência única e tática de **cada parte** do toolkit de teste da RFC-0005 —
> assinaturas, um exemplo curto e *quando usar*. Para o mapa estratégico (que
> peça usar em cada cenário), veja o [playbook](./claude-code-playbook.md). Para
> profundidade, os READMEs do pacote estão linkados em cada seção.
>
> Tudo é **offline, determinístico, sem Docker** (exceto `/container`): keypair de
> teste fixo, clock injetável, fixtures conhecidas, zero rede. Funciona em **Jest
> ou Vitest** (para Vitest, `test: { globals: true }`).
>
> **Última atualização:** 2026-07-18

---

## Instalação

```bash
pnpm add -D @overlens/idp-testing
```

> ⚠️ **Distribuição:** hoje o pacote é `private` e consumido via **workspace**
> dentro do monorepo do IDP. Para um repositório **externo**, ele precisa estar
> publicado num registry da Overlens (passo de publicação ainda pendente). Ver
> [playbook §7](./claude-code-playbook.md#7-pré-requisitos-e-caveats-leia-antes).

## Subpaths — visão geral

| Import | O que entrega | Use quando |
|---|---|---|
| `@overlens/idp-testing` | cunhagem de tokens, mock JWKS, casos negativos, defaults | Resource Server: matéria-prima de teste |
| `@overlens/idp-testing/conformance` | kits drop-in `runResourceServerConformance` / `runClientConformance` | provar a integração com 1 chamada |
| `@overlens/idp-testing/mock-idp` | IDP falso in-process (`startMockIdp`) | testar client/BFF (callback/refresh/logout) |
| `@overlens/idp-testing/fixtures` | usuários e clients de teste conhecidos | credenciais determinísticas |
| `@overlens/idp-testing/container` | sobe o IDP **real** containerizado | e2e contra Postgres real (precisa Docker) |
| `@overlens/idp-testing/doctor` | preflight de config + CLI `idp-doctor` | pegar drift de iss/aud/kid/clock |

---

## `@overlens/idp-testing` — toolkit (lado Resource Server)

📖 [`packages/idp-testing/README.md`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/README.md)

### Cunhagem de tokens válidos

```ts
import { mintToken, mintM2MToken } from '@overlens/idp-testing';

await mintToken({ sub: 'u1', email: 'u1@example.test' });              // access token de usuário
await mintM2MToken({ clientId: 'svc', scope: 'fractals:read' });        // token M2M
```

- `mintToken({ sub, email, name?, role?, emailVerified?, newUser?, aud?, iss?, kid?, now?, expiresAt? }) → Promise<string>`
- `mintM2MToken({ clientId, scope, aud?, iss?, kid?, now?, expiresAt? }) → Promise<string>`
- `now`/`expiresAt` são epoch **segundos** (clock injetável — nunca use `sleep`).

### Mock JWKS — objeto **ou** URL

```ts
import { getJwks, startJwksServer } from '@overlens/idp-testing';

const jwks = getJwks();                 // { keys: [{ kty, use, alg, n, e, kid }] } — para libs que aceitam objeto (jose)
const server = await startJwksServer(); // server.jwksUri — para libs que pedem URL (jwks-rsa); await server.close()
```

### Fábricas de casos negativos

Cada uma retorna um token deliberadamente inválido por um motivo. Aceitam `{ sub?, email? }`.

| Fábrica | Inválido por |
|---|---|
| `expiredToken` | `exp` vencido |
| `futureIatToken` | `iat` no futuro |
| `wrongAudToken` / `wrongIssToken` | `aud` / `iss` errado |
| `unknownKidToken` | `kid` ausente do JWKS |
| `invalidSignatureToken` | assinado com outro keypair |
| `hs256Token` / `algNoneToken` | algorithm confusion |

### Defaults do contrato

```ts
import { JWT_ISSUER_DEFAULT, JWT_AUDIENCE_DEFAULT } from '@overlens/idp-testing';
// 'http://localhost:3147'  /  ['http://localhost:3148']
```

Use para configurar a **sua** validação contra os tokens cunhados pelo kit
(mesmo `iss`/`aud`/`kid`).

---

## `@overlens/idp-testing/conformance` — kits drop-in

📖 [§ T5 do README do pacote](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/README.md)

Você pluga um **adapter** mínimo (embrulha a sua validação/cliente); o kit registra
todos os casos no runner e afirma o contrato. Métodos opcionais ausentes viram
`it.skip` (visível).

### Resource Server

```ts
import { runResourceServerConformance } from '@overlens/idp-testing/conformance';

runResourceServerConformance({
  verifyBearer: (token) => /* → { ok: true, principal: { sub, email } } | { ok: false, status } */,
  verifyCookie?: (token) => ...,                       // se a API aceita cookie access_token
  verifyScopedM2M?: (token, requiredScope) => ...,     // habilita os casos de scope/M2M (403)
}, { requiredScope?, m2mClientId?, label? });
```

Casos: token válido (Bearer+cookie) aceito; expirado, `aud`/`iss` errado,
HS256/`alg:none`, `kid` desconhecido/assinatura inválida → rejeitados; M2M sem
scope → 403; distinção user-vs-M2M.

### Client / BFF (sobre o mock IDP)

```ts
import { runClientConformance } from '@overlens/idp-testing/conformance';

runClientConformance({
  startLogin: (ctx) => /* → { state, codeChallenge } (gera PKCE + state) */,
  handleCallback: (ctx, { code, state }) => /* troca o code; → { ok, value: session } */,
  refresh?: (ctx, session) => ...,     // rotação
  logout?: (ctx, session) => ...,      // end_session
  getAccessToken?: (session) => string | undefined,
}, { config?, label? });
```

Casos: callback+PKCE estabelece sessão; `state` divergente (CSRF) e reuso de
`code` rejeitados; troca rejeitada não cria sessão; refresh rotaciona e mata o
antigo; logout respeita `post_logout_redirect_uri`. O `ctx` (issuer/clientId/
redirectUri/scope/user) vem das fixtures e é injetado pelo kit.

> Templates copy-paste prontos (Jest+Vitest) no skill `idp-test-integration`
> (`.claude/skills/idp-test-integration/templates/`).

---

## `@overlens/idp-testing/mock-idp` — IDP falso in-process

📖 [`packages/idp-testing/src/mock-idp/README.md`](https://github.com/overlens/identity-provider/blob/main/packages/idp-testing/src/mock-idp/README.md)

```ts
import { startMockIdp, s256Challenge } from '@overlens/idp-testing/mock-idp';

const mock = await startMockIdp(); // { url, issuer, jwksUri, port, scripts, stop() }
try {
  // mock.url espelha discovery/jwks/authorize/token/userinfo/logout reais (PKCE S256,
  // rotação de refresh, client_credentials). Aponte seu client para mock.url.
} finally {
  await mock.stop();
}
```

- `startMockIdp({ clients?, users?, now?, scripts? }) → Promise<MockIdp>`
- **Scripts de negativo** (objeto **vivo**, mutável entre requisições):
  `mock.scripts.failNextToken = { error, status }`, `forceInvalidGrant`,
  `http5xxOnce`, `delayMs`.
- Helpers PKCE: `s256Challenge(verifier)`, `verifyPkceS256(verifier, challenge)`.

---

## `@overlens/idp-testing/fixtures` — dados de teste conhecidos

```ts
import { TEST_USERS, TEST_CLIENTS, getTestUser, getTestClient } from '@overlens/idp-testing/fixtures';

getTestUser('ana.active@example.test'); // { id, email, password, role, ... }
getTestClient('test-web-bff');          // { clientId, clientSecret, redirectUris, allowedScopes, ... }
```

Cobre usuários (LOCAL ativo, Google-only, bloqueado, desativado, novo, admin) e
clients (confidential `test-web-bff`, public `test-public-pkce`, M2M
`test-m2m-service`). **Fonte única** semeada no mock, no container e na sandbox —
mesmos `id`/`clientId` em todos (paridade).

---

## `@overlens/idp-testing/container` — IDP real containerizado

📖 [`run-local-container.md`](./run-local-container.md) · requer **Docker** + a peer dep `testcontainers`.

```ts
import { startIdpContainer } from '@overlens/idp-testing/container';

// Repo EXTERNO (padrão): usa o compose EMBUTIDO no pacote — puxa a imagem
// publicada ghcr.io/overlens/idp-test (sem clonar o monorepo)
const idp = await startIdpContainer();

// Dentro do monorepo do IDP: builda a imagem local a partir do Dockerfile
// const idp = await startIdpContainer({ composeDir: 'apps/idp' });
try {
  // idp.url (porta mapeada, p/ requests) · idp.issuer (iss lógico, fixo) · idp.jwksUri
} finally {
  await idp.stop();
}
```

Sobe `docker-compose.test.yml` (IDP + Postgres + Redis efêmeros), migrado e
seedado. Para e2e de ponta a ponta contra banco real. Alternativa sem código:
`docker compose -f apps/idp/docker-compose.test.yml up --build`.

---

## `@overlens/idp-testing/doctor` — preflight (lib + CLI)

📖 preflight em [`run-local-container.md`](./run-local-container.md) e no skill `idp-test-integration`.

Pega o clássico drift de `IDP_ISSUER` sandbox→prod **antes** do deploy.

### CLI `idp-doctor`

```bash
idp-doctor --issuer https://idp-test.overlens.com.br \
  --audience https://api.example.com \
  --token "<access token>"          # opcional: habilita checagens de kid/aud/iss/clock
  # --clock-tolerance <seg>   --json
```

Checa: discovery alcançável + `iss` bate, JWKS alcançável, `kid` do token no JWKS,
`aud`/`iss` corretos, clock skew tolerável. **Exit ≠ 0** em qualquer falha. Saída
humana por padrão; `--json` para máquina.

### Programático

```ts
import { runPreflight } from '@overlens/idp-testing/doctor';

const report = await runPreflight({ issuer, expectedAudience, token });
// report.ok (boolean) · report.checks: [{ name, status: 'pass'|'fail'|'skip', message }]
```

---

## Resumo: qual peça para qual objetivo

| Objetivo | Peça |
|---|---|
| Provar que minha **validação de JWT** está correta | `/conformance` → `runResourceServerConformance` |
| Provar que meu **login/callback/refresh/logout** está correto | `/conformance` → `runClientConformance` (sobre `/mock-idp`) |
| Asserções **customizadas** sobre tokens | toolkit (`mintToken` + negativos + `getJwks`) |
| Simular o **fluxo OAuth** com negativos roteirizáveis | `/mock-idp` → `startMockIdp` |
| e2e contra o **IDP real** | `/container` (Docker) ou a sandbox hospedada |
| Pegar **drift de config** antes do deploy | `/doctor` → `idp-doctor` |
| Credenciais de teste **conhecidas** | `/fixtures` |
