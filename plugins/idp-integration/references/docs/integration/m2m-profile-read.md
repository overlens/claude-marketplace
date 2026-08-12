# Guia de Integração — Leitura de perfil M2M (`GET /users/:sub`)

> Canal **Pull** canônico para um backend ler o **perfil global** de qualquer usuário por `sub`,
> autenticado por token M2M (`client_credentials`) e autorizado pelo scope `profile:read`.
>
> **Use este guia quando:** seu serviço precisa dos atributos globais de identidade
> (`name`, `username`, `email`, `phone`, `document`, `birthDate`, `avatar`) de um usuário — que **não viajam no JWT**
> — para hidratar telas, rankings, notificações, etc.
>
> **Referências:** [RFC-0002](https://github.com/overlens/identity-provider/blob/main/docs/rfc/0002-endpoint-m2m-leitura-de-perfil.md) · base M2M em [`m2m.md`](./m2m.md) · perfil próprio em [`profile.md`](./profile.md)
>
> **Última atualização:** 2026-07-18

---

## 1. Por que este endpoint existe

Os atributos globais de identidade **não estão no token** (inchariam o JWT em todo request).
O IDP já expõe três leituras, mas nenhuma serve consumo **server-to-server por `sub`**:

| Endpoint | Auth | Limitação |
|---|---|---|
| `GET /auth/userinfo` | token do **usuário** | mínimo; sem avatar/phone/birthDate; só o próprio. Um token **M2M** é aceito, mas responde `email: null`/`name: null` — desaconselhado; use `GET /users/:sub` |
| `GET /auth/me` | token do **usuário** | perfil completo, mas só do próprio usuário |
| `GET /users/:sub` | **token M2M** | ✅ qualquer usuário, por `sub` — **este guia** |

É também o caminho de **backfill** (client novo) e **reconciliação**: o Push da [RFC-0004](https://github.com/overlens/identity-provider/blob/main/docs/rfc/0004-push-eventos-de-perfil.md) está **construído** (ver [`profile-events.md`](./profile-events.md) e a nota de status de rollout no topo daquele guia) e o evento apenas sinaliza "puxe de novo" — a verdade vem sempre deste endpoint.

---

## 2. Pré-requisitos

1. Um **OAuth client M2M** registrado (`isPublic: false`, `allowedGrantTypes: ['client_credentials']`) — ver [`m2m.md` §2](./m2m.md).
2. O scope **`profile:read`** na lista `allowedScopes` desse client (via `POST /admin/clients` ou `PATCH` — ver [`oauth-clients.md`](./oauth-clients.md)).

> **PII:** com `profile:read` o backend recebe `email`/`phone`/`document`/`birthDate` **crus**. Isso é aceitável para um client confiável (registrado, com `client_secret`). Conceda o scope apenas a serviços que realmente precisam.

---

## 3. Contrato

```
GET /users/:sub
Authorization: Bearer <access_token M2M>     # scope: profile:read
If-None-Match: "<etag>"                        # opcional — GET condicional
```

**200 OK**
```jsonc
{
  "sub": "ckxxx...",
  "name": "Fulana Beltrana",
  "username": "fulanab",            // pode ser null (legado)
  "email": "fulana@gmail.com",
  "emailVerified": true,
  "phone": "+5511999990000",        // null se não definido
  "document": "52998224725",        // CPF só com dígitos; null se não definido
  "birthDate": "1995-08-01",        // null se não definido (YYYY-MM-DD)
  "avatarUrl": "https://files.overlens.com.br/avatars/ckxxx...?v=1748606400", // null se sem avatar custom
  "avatarUpdatedAt": "2026-05-30T12:00:00.000Z"  // null se sem avatar custom
}
```
Headers: `ETag: "..."`, `Cache-Control: private, max-age=300`.

> **Avatar nulável:** sem avatar custom, `avatarUrl` **e** `avatarUpdatedAt` vêm `null` — o IDP não serve imagem default; o client decide o fallback (iniciais, placeholder). Servimos apenas a imagem original (sem resize).

### Erros

| HTTP | `error` | Causa |
|---|---|---|
| `401` | `invalid_token` | token ausente/inválido/expirado, ou um token de **usuário** (sem `client_id`/`scope`) |
| `403` | `insufficient_scope` | token válido sem o scope `profile:read` |
| `404` | `not_found` | `sub` inexistente **ou** conta com `deletedAt != null` |
| `304` | — | `If-None-Match` bate com o `ETag` atual |
| `429` | — | rate limit (600 req/min **por client**) |

> Conta **bloqueada** ou **desativada** ainda é uma identidade válida → retorna `200`. Apenas exclusão irreversível (`deletedAt`) vira `404`.

---

## 4. Fluxo recomendado (com cache local)

```
1. Obtenha um token M2M (client_credentials) — cacheie por expires_in (300s). Ver m2m.md §3.
2. GET /users/:sub com Authorization: Bearer + If-None-Match (se já tiver ETag em cache).
3. 200 → atualize o cache { profile, etag }. 304 → reuse o body em cache. 404 → trate como "sem usuário".
4. Respeite Cache-Control: max-age=300 — mantenha um cache local com TTL como rede de segurança,
   deixando o IDP fora do hot path na maioria dos requests.
```

Exemplo (TypeScript, reusando o token client do [`m2m.md`](./m2m.md)):

```ts
const cache = new Map<string, { profile: unknown; etag: string }>();

async function getUserProfile(sub: string) {
  const token = await getM2MToken(["profile:read"]); // cache de token do m2m.md
  const cached = cache.get(sub);

  const res = await fetch(`https://idp.overlens.com.br/users/${sub}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(cached ? { "If-None-Match": cached.etag } : {}),
    },
  });

  if (res.status === 304 && cached) return cached.profile;
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`profile read failed: ${res.status}`);

  const profile = await res.json();
  const etag = res.headers.get("etag");
  if (etag) cache.set(sub, { profile, etag });
  return profile;
}
```

---

## 5. Notas operacionais

- **Rate limit por client:** o tracking é por `client_id` (não por IP), então múltiplos serviços atrás do mesmo egress não competem pela mesma cota.
- **Sem batch (ainda):** leitura é unitária por `sub`. Hidratar listas grandes hoje exige N chamadas (mitigado pelo cache local). Um `GET /users?subs=a,b,c` é follow-up planejado.
- **Push disponível:** além do TTL de 300s, você pode registrar um webhook e receber uma notificação **quase-tempo-real** quando o perfil muda, encurtando a janela de staleness — o evento apenas sinaliza "puxe de novo" (este mesmo endpoint). Ver [`profile-events.md`](./profile-events.md) ([RFC-0004](https://github.com/overlens/identity-provider/blob/main/docs/rfc/0004-push-eventos-de-perfil.md)). Sem o webhook, o TTL segue sendo a defesa contra staleness.
