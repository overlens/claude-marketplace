# Integração — Atualização de Avatar (presigned URL)

> **Público:** desenvolvedores de clients que consomem o IDP da Overlens (`accounts`, `plataforma`, `events`, mobile).
> **O que este guia cobre:** como subir, trocar, remover e renderizar o avatar global do usuário.
> **Infra (S3 + CloudFront):** [`../deploy/aws-avatar.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/aws-avatar.md) · **Base normativa:** RFC-0001 (`docs/rfc/0001-idp-autoridade-de-perfil-e-avatar.md`)
>
> **Última atualização:** 2026-07-18

---

## 1. Como o fluxo funciona

O avatar é um **atributo de identidade global** — a mesma foto vale para o usuário em qualquer app Overlens. O IDP é a autoridade, mas **o binário da imagem nunca passa por ele**: o upload vai direto do client para o S3, usando uma URL temporária assinada (*presigned URL*).

O fluxo de troca tem **três passos**:

```
┌────────┐  1. POST /auth/me/avatar/upload-url   ┌─────┐
│ Client │ ────────────────────────────────────► │ IDP │  assina a URL (deriva a chave do sub)
│        │ ◄──────────────────────────────────── │     │  { uploadUrl, key, expiresIn }
│        │            { uploadUrl }               └─────┘
│        │
│        │  2. PUT <uploadUrl>  (binário direto)  ┌─────┐
│        │ ════════════════════════════════════► │ S3  │  o IDP NÃO participa deste passo
│        │
│        │  3. PATCH /auth/me/avatar             ┌─────┐
│        │ ────────────────────────────────────► │ IDP │  HEAD confirma + grava avatarUpdatedAt
│        │ ◄──────────────────────────────────── │     │  { ok, avatar: { avatarUrl, avatarUpdatedAt } }
└────────┘                                        └─────┘
```

> **Por que três passos?** O passo 2 tira o IDP do caminho dos bytes (menos banda/latência). O passo 3 garante consistência: o `avatarUpdatedAt` só é gravado **depois** que o IDP confirma, via HEAD no S3, que o objeto existe e respeita o limite de tamanho.

**Pré-requisitos:** o usuário precisa estar autenticado. Todas as chamadas ao IDP (passos 1 e 3) usam o cookie de sessão `access_token` — no browser, envie com `credentials: 'include'`; em mobile/backend, com o header `Authorization: Bearer <access_token>`.

---

## 2. ⚠️ Regra de ouro: o `Content-Type` precisa bater

> **O presign assina o `Content-Type`.** Se o `PUT` (passo 2) enviar um `Content-Type` **diferente** do que você informou em `POST /upload-url` (passo 1), o S3 rejeita a assinatura com **`403 SignatureDoesNotMatch`**.

Concretamente:

- Se você pediu a URL com `contentType: "image/png"`, o `PUT` **tem que** mandar `Content-Type: image/png`.
- Não deixe o `fetch`/`axios` inferir um content-type diferente (ex.: `application/octet-stream` ou `multipart/form-data`). Defina o header explicitamente com o **mesmo** valor.
- Use **uma única variável** para o content-type nos dois passos, para que nunca divirjam:

```ts
const contentType = file.type; // ex.: "image/png" — fonte única de verdade
// passo 1 usa contentType; passo 2 reusa a MESMA variável
```

---

## 3. Passo a passo

### Passo 1 — Pedir a presigned URL

```
POST /auth/me/avatar/upload-url
Content-Type: application/json
Cookie: access_token=<jwt>          (ou Authorization: Bearer <jwt>)

{ "contentType": "image/png" }
```

**Resposta `200`:**

```json
{
  "uploadUrl": "https://<bucket>.s3.<region>.amazonaws.com/avatars/<sub>?X-Amz-Algorithm=...",
  "key": "avatars/<sub>",
  "expiresIn": 300
}
```

| Campo | Significado |
|---|---|
| `uploadUrl` | URL temporária para o `PUT` do binário direto no S3 |
| `key` | Chave do objeto no S3 (derivada do `sub` no servidor — informativo) |
| `expiresIn` | Validade da URL em **segundos** (300 = 5 min). Após isso, peça outra |

**`contentType` aceitos:** `image/jpeg`, `image/png`, `image/webp`. Qualquer outro valor → `400 Bad Request`.

### Passo 2 — Enviar o binário direto ao S3

```
PUT <uploadUrl>
Content-Type: image/png          ← DEVE ser idêntico ao do passo 1 (ver §2)

<bytes da imagem>
```

- **Não** envie cookies nem `Authorization` aqui — a autorização está embutida na URL assinada.
- **Não** use `FormData`/`multipart`. Envie o **arquivo cru** como corpo (`Blob`/`File`/`Buffer`).
- Sucesso = `200 OK` do S3 (sem corpo relevante).
- Tamanho máximo: **5 MB**. (O limite é validado no passo 3; uploads maiores serão rejeitados e apagados lá.)

### Passo 3 — Confirmar

```
PATCH /auth/me/avatar
Cookie: access_token=<jwt>          (ou Authorization: Bearer <jwt>)
```

(Sem corpo — a chave é derivada do `sub` do token.)

**Resposta `200`:**

```json
{
  "ok": true,
  "avatar": {
    "avatarUpdatedAt": "2026-06-10T14:32:00.000Z",
    "avatarUrl": "https://files.overlens.com.br/avatars/<sub>?v=1749566720"
  }
}
```

A partir daqui, `avatarUrl` aponta para a foto nova (com `?v=` atualizado). Use esse valor direto na UI.

**Erros do passo 3:**

| Status | Causa | O que fazer |
|---|---|---|
| `400` | Nenhum objeto encontrado no S3 (passo 2 não rodou/falhou) | Refazer os passos 1–2 antes de confirmar |
| `400` | Objeto maior que 5 MB (o IDP apaga e rejeita) | Comprimir/reduzir a imagem e refazer |
| `401` | Sessão ausente/expirada | Renovar a sessão e repetir |

---

## 4. Renderizar o avatar

Há duas formas — prefira a primeira.

### 4.1 Ler do perfil (recomendado)

`GET /auth/me` retorna `avatarUrl` e `avatarUpdatedAt` já prontos:

```json
{
  "...": "...",
  "avatarUpdatedAt": "2026-06-10T14:32:00.000Z",
  "avatarUrl": "https://files.overlens.com.br/avatars/<sub>?v=1749566720"
}
```

- `avatarUrl` **não-nulo** → renderize a imagem direto.
- `avatarUrl` **`null`** → o usuário **não tem avatar custom**. O IDP **não** serve imagem default; **cada client decide o fallback** (iniciais, placeholder, ícone). Não invente uma URL.

### 4.2 Derivar a URL a partir do `sub`

Para renderizar o avatar de **outro** usuário (ex.: lista de membros) cujo `sub` você já conhece, a URL é determinística:

```
${AVATAR_CDN_BASE_URL}/avatars/{sub}?v={epoch}
```

onde `{epoch}` vem do `avatarUpdatedAt` daquele usuário (obtido via `GET /users/:sub`, M2M). O `?v=` é **cache-busting**: garante que, após uma troca, a CDN sirva a versão nova em vez da cacheada. Sem `avatarUpdatedAt` (null), trate como "sem avatar".

> Não persista a `avatarUrl` no seu banco — ela é derivada. Guarde no máximo o `sub` e leia o `avatarUpdatedAt` quando precisar montar a URL.

---

## 5. Remover o avatar

```
DELETE /auth/me/avatar
Cookie: access_token=<jwt>          (ou Authorization: Bearer <jwt>)
```

**Resposta `200`:**

```json
{ "ok": true, "avatar": { "avatarUpdatedAt": null, "avatarUrl": null } }
```

O objeto é apagado do S3 e o usuário volta ao estado "sem avatar". A operação é **idempotente** — chamar de novo continua retornando `null`. Na UI, volte a exibir o fallback.

---

## 6. Exemplo completo (browser / TypeScript)

```ts
const IDP = "https://idp.overlens.com.br";

/** Sobe (ou troca) o avatar do usuário logado. Retorna o novo AvatarState. */
async function uploadAvatar(file: File) {
  const contentType = file.type; // fonte ÚNICA do content-type (ver §2)

  // Passo 1 — presigned URL
  const r1 = await fetch(`${IDP}/auth/me/avatar/upload-url`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType }),
  });
  if (!r1.ok) throw new Error(`upload-url falhou: ${r1.status}`);
  const { uploadUrl } = await r1.json();

  // Passo 2 — PUT direto no S3 (MESMO content-type; sem credentials; corpo = arquivo cru)
  const r2 = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType }, // ⚠️ idêntico ao passo 1
    body: file,
  });
  if (!r2.ok) throw new Error(`PUT no S3 falhou: ${r2.status}`);

  // Passo 3 — confirmar
  const r3 = await fetch(`${IDP}/auth/me/avatar`, {
    method: "PATCH",
    credentials: "include",
  });
  if (!r3.ok) throw new Error(`confirm falhou: ${r3.status}`);
  const { avatar } = await r3.json();
  return avatar; // { avatarUpdatedAt, avatarUrl }
}

/** Remove o avatar custom. */
async function removeAvatar() {
  const r = await fetch(`${IDP}/auth/me/avatar`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(`delete falhou: ${r.status}`);
  const { avatar } = await r.json();
  return avatar; // { avatarUpdatedAt: null, avatarUrl: null }
}
```

> **Mobile / backend:** troque `credentials: "include"` por `headers: { Authorization: "Bearer <access_token>" }` nas chamadas ao IDP (passos 1 e 3 e delete). O passo 2 (PUT no S3) é igual em qualquer plataforma — só a URL assinada e o `Content-Type` casado.

---

## 7. Resumo das restrições

| Restrição | Valor |
|---|---|
| Formatos aceitos | `image/jpeg`, `image/png`, `image/webp` |
| Tamanho máximo | 5 MB |
| Validade da presigned URL | 300 s (5 min) |
| Rate limit (endpoints do IDP) | 20 req/min por IP (perfil `profile` — ver [`rate-limiting.md`](../deploy/rate-limiting.md)) |
| `Content-Type` do PUT | **idêntico** ao informado em `POST /upload-url` (senão `403`) |
| Autenticação | cookie `access_token` (browser) ou `Authorization: Bearer` (mobile/backend) |
| Fallback sem avatar | responsabilidade do client — IDP retorna `avatarUrl: null` |

---

## 8. Checklist de integração

- [ ] Usar **uma única variável** de `contentType` nos passos 1 e 2 (evita o `403 SignatureDoesNotMatch`)
- [ ] No PUT do passo 2: enviar o arquivo **cru** (não `FormData`), **sem** cookies/Authorization
- [ ] Tratar `expiresIn` — se o upload demorar mais que 5 min, pedir nova URL
- [ ] Após o passo 3, usar a `avatarUrl` retornada (já vem com `?v=` novo)
- [ ] Tratar `avatarUrl: null` com fallback próprio (iniciais/placeholder)
- [ ] Não persistir a `avatarUrl`; derivar a partir do `sub` + `avatarUpdatedAt` quando precisar
- [ ] Tratar `400` (objeto ausente / > 5 MB) e `401` (sessão) no passo 3
