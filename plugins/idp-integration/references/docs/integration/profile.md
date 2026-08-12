# Guia de Integração — Perfil do Usuário (`/auth/me`)

> Endpoints autenticados para que o usuário leia e gerencie a própria identidade.
>
> **Última atualização:** 2026-07-18

> **O IDP é a autoridade de perfil global (RFC-0001 / ADR-7).** Os atributos `name`, `username`, `phone`, `document`, `birthDate` e `avatar` descrevem *a mesma pessoa em qualquer app* e têm o IDP como fonte de verdade — nenhum app deve mantê-los como cópia autoritativa. Eles **não viajam no JWT**; são lidos aqui (perfil próprio) ou, para backends, via `GET /users/:sub` (M2M — **implementado**, ver [`m2m-profile-read.md`](./m2m-profile-read.md)). Papel/`role`, tema, título e progresso permanecem **contextuais de cada app**.

---

## 1. Quando usar

Estes endpoints são consumidos pelo frontend Accounts (área de perfil) e por qualquer sistema integrado que queira oferecer ao usuário:
- Visualizar o perfil (com PII mascarada por padrão)
- Editar nome, username, data de nascimento
- Gerenciar o **avatar** centralizado (ver §11)
- Trocar senha
- Desativar (reversível) ou excluir (irreversível) a própria conta
- Recuperar o e-mail completo (atualmente mascarado em `GET /auth/me`)

Todos exigem JWT de usuário válido — via cookie `access_token` **ou** `Authorization: Bearer <jwt>`. M2M tokens são rejeitados (não têm `email`/`role` esperados pelo guard).

---

## 2. Autenticação

```
Authorization: Bearer <jwt>           (preferido)
   ou
Cookie: access_token=<jwt>            (somente sob *.overlens.com.br)
```

Erros padrão: `401 Missing token`, `401 Invalid token`.

---

## 3. `GET /auth/me`

Retorna o perfil do usuário autenticado. **PII é mascarada** — use `GET /auth/me/email` para o email completo quando necessário.

### Response 200

```json
{
  "id": "ckxxx...",
  "name": "Fulana Beltrana",
  "username": "fulanab",
  "maskedEmail": "f*****@gmail.com",
  "maskedPhone": "+** ** *****-4321",
  "birthDate": "1995-08-01",
  "maskedDocument": "********725",
  "authProvider": "LOCAL",
  "emailVerified": true,
  "hasPassword": true,
  "hasGoogleLinked": false,
  "role": "BASIC",
  "avatarUpdatedAt": null,
  "avatarUrl": null,
  "createdAt": "2026-01-15T10:30:00.000Z"
}
```

| Campo | Notas |
|---|---|
| `id` | CUID2 — mesmo `sub` do JWT |
| `name` | Nome de exibição |
| `username` | `null` se nunca foi setado (legado MySQL); padrão atual gera no signup |
| `maskedEmail` | `"r*****@dominio.com"` — primeira letra + asteriscos |
| `maskedPhone` | `"+** ** *****-4321"` — últimos 4 dígitos visíveis; `null` se não tiver |
| `birthDate` | `YYYY-MM-DD` ou `null` |
| `maskedDocument` | CPF mascarado (últimos 3 dígitos) ou `null`. O valor cru sai só no `GET /users/:sub` |
| `authProvider` | `LOCAL` (signup com senha) ou `GOOGLE` (signup via Google) |
| `emailVerified` | `false` para signups novos via senha |
| `hasPassword` | `true` se tem senha local — `false` em contas só-Google |
| `hasGoogleLinked` | `true` se tem `googleId` no banco |
| `role` | `BASIC` / `ADMIN` / `SYSTEM`. **`@deprecated`** como fonte de autorização para apps (RFC-0003) — exposto aqui apenas como informação de conta |
| `avatarUpdatedAt` | ISO 8601 da última troca de avatar, ou `null` (sem avatar custom). Sinal de cache-busting (RFC-0001 §2.3) |
| `avatarUrl` | URL do avatar (`${AVATAR_CDN_BASE_URL}/avatars/{sub}?v=<epoch>`) quando há custom; **`null` quando não há avatar** — o IDP **não** serve default, o client decide o fallback (iniciais, placeholder…) |
| `createdAt` | ISO 8601 |

### Quando dá `401`
- Token inválido/expirado.
- Conta inacessível (`deactivatedAt != null` ou `deletedAt != null` ou `blockedAt != null`) — sessão deve ser encerrada no client.

---

## 4. `GET /auth/me/email`

Retorna o email **completo** (sem mascaramento). Rate-limited mais agressivamente que o `/auth/me` por ser endpoint de "reveal".

### Response 200

```json
{ "email": "fulana@gmail.com" }
```

### Throttle
Profile `profile-reveal`: 10 requisições / 60s por IP (ativo em todos os ambientes). Ver [`rate-limiting.md`](../deploy/rate-limiting.md).

---

## 5. `PATCH /auth/me`

Atualiza campos editáveis. Todos os campos do body são opcionais; campos não enviados ficam inalterados.

### Request

```json
{
  "name": "Fulana B. Souza",
  "username": "fulana_souza",
  "birthDate": "1995-08-01",
  "document": "529.982.247-25"
}
```

| Campo | Validação |
|---|---|
| `name` | string 1-100 chars, trim aplicado |
| `username` | regex `^[a-zA-Z0-9_]{3,30}$` (lowercased server-side antes de persistir) |
| `birthDate` | `"YYYY-MM-DD"` ou `null` para limpar. Ano ≥ 1900, não pode ser futuro. |
| `document` | CPF com ou sem máscara, ou `null` para limpar. Persistido só com os dígitos; dígitos verificadores validados no servidor (`400 CPF inválido`). |

Pelo menos **um** campo precisa estar presente — `{}` retorna `400 Nenhum campo a atualizar`.

### Response 200

```json
{
  "ok": true,
  "profile": { /* ProfileResponseDto completo, igual ao /auth/me */ }
}
```

### Erros

| HTTP | Causa |
|---|---|
| `400` | Body vazio, formato inválido (regex, data) |
| `409` | `username` já em uso (constraint unique) |

### Throttle
`profile`: 20 req/min por IP.

---

## 6. `POST /auth/me/password`

Troca a senha. Para contas **LOCAL** com senha atual, `currentPassword` é exigida. Para contas **GOOGLE** sem senha (`hasPassword=false`), `currentPassword` pode ser omitida — o caso é "criar senha pela primeira vez na conta Google".

### Request

```json
{
  "currentPassword": "atual_se_aplicavel",
  "newPassword": "no minimo 8 chars"
}
```

| Campo | Validação |
|---|---|
| `currentPassword` | string opcional (obrigatória se `hasPassword=true`) |
| `newPassword` | string ≥ 8 chars |

### Response 200

```json
{ "ok": true }
```

### Erros típicos

| HTTP | Causa |
|---|---|
| `400` | `newPassword` muito curta |
| `401` | `currentPassword` incorreta |
| `409` | Conta sem `hasPassword` enviou `currentPassword` (ou vice-versa) |

### Throttle
`password-change`: 5 req / 15min por IP.

---

## 7. `POST /auth/me/deactivate`

Desativação **reversível**: marca `deactivatedAt`, revoga **TODAS as sessões de refresh** do usuário (`refresh_sessions` — 1.4.0) e limpa cookies. O usuário pode pedir reativação no suporte. Conta fica oculta do dia-a-dia.

### Request

```json
{ "confirmation": "DESATIVAR" }
```

Confirmação literal `DESATIVAR` é obrigatória. Qualquer outro valor → `400 Confirmação incorreta`.

### Response 200

```json
{ "ok": true }
```

Headers de resposta limpam os cookies de sessão (`access_token` e `refresh_token` recebem `Max-Age=0`).

### Throttle
`profile`: 20 req/min.

---

## 8. `DELETE /auth/me`

Exclusão **irreversível**: marca `deletedAt` e revoga **TODAS as sessões de refresh** do usuário (`refresh_sessions` — 1.4.0). O `id` persiste no banco para integridade referencial com outros serviços que correlacionam por CUID2.

### Request

```json
{ "confirmation": "EXCLUIR" }
```

Confirmação literal `EXCLUIR`. Qualquer outro valor → `400 Confirmação incorreta`.

### Response 200

```json
{ "ok": true }
```

Cookies de sessão são limpos.

### Cenários pós-exclusão
- Próximo login: o IDP rejeita (`401`, conta inacessível) — não há recuperação por self-service.
- Dados em serviços downstream (`plataforma`, etc.) seguem suas próprias políticas de retenção.

### Throttle
`profile`: 20 req/min.

---

## 9. Tabela rápida — endpoints `/auth/me*`

| Método | Path | Auth | Throttle | Idempotente |
|---|---|---|---|---|
| `GET` | `/auth/me` | sim | `default` (60/min) | sim |
| `GET` | `/auth/me/email` | sim | `profile-reveal` | sim |
| `PATCH` | `/auth/me` | sim | `profile` | não |
| `POST` | `/auth/me/password` | sim | `password-change` | não |
| `POST` | `/auth/me/deactivate` | sim | `profile` | sim* |
| `DELETE` | `/auth/me` | sim | `profile` | sim* |

> *Idempotente no sentido de "chamar duas vezes não causa estado adicional" — mas a primeira chamada já fez o efeito.

---

## 10. Checklist consumer

- [ ] Authorization via cookie OU Bearer (não dependa de só uma forma se a SPA pode rodar fora `*.overlens.com.br`)
- [ ] UI mostra `maskedEmail`/`maskedPhone` por padrão, com botão "mostrar email" → `GET /auth/me/email`
- [ ] Validação client-side de `username` (regex `^[a-zA-Z0-9_]{3,30}$`) antes de bater no `PATCH`
- [ ] Confirmação literal "DESATIVAR" / "EXCLUIR" via input do usuário (não autocomplete)
- [ ] Após `POST /auth/me/deactivate` ou `DELETE /auth/me`: limpar sessão local e redirecionar para `/login`
- [ ] Tratar `429` com mensagem amigável (rate limit) — especialmente em `password-change`

---

## 11. Avatar centralizado (RFC-0001)

> **Status:** **implementado** (endpoints disponíveis). Migration aplicada; infra de **dev** provisionada (bucket S3 + CloudFront — ver [`../deploy/aws-avatar.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/aws-avatar.md)); a infra de storage de **produção** ainda está pendente. Fluxo detalhado de upload/troca/remoção: [`update-avatar.md`](./update-avatar.md).

O avatar é um atributo de identidade **global**: uma única imagem do usuário, refletida em todo o ecossistema. O desenho:

- **Endereço determinístico:** `${AVATAR_CDN_BASE_URL}/avatars/{sub}` — o host vem de env var (dinâmico, decidido na infra) e o caminho é fixo. O client usa o campo `avatarUrl` do perfil ou monta a URL a partir do `sub`. **Nada a armazenar ou sincronizar.**
- **Sem default no IDP:** quando não há avatar custom, `avatarUrl` (e `avatarUpdatedAt`) vêm **`null`** — sinal explícito de "sem avatar". **O client decide o fallback** (iniciais, placeholder…); o IDP não gera nem serve imagem default. Trocar o avatar troca o *conteúdo* da mesma chave no S3.
- **Cache-busting:** o campo `avatarUpdatedAt` (timestamp; `null` = sem custom) é exposto no perfil; com custom, a URL inclui `?v={epoch}` para forçar revalidação de CDN/browser. **Não** viaja no JWT.
- **Sem extensão / sem resize:** a chave é extensionless e o formato vem do header `Content-Type` (não da URL). Por hora servimos **apenas a imagem original** (sem `?size=`).
- **Gestão pelo usuário — padrão presigned URL (AWS S3):** o binário vai **direto do client para o S3**, nunca pelo IDP. Três passos:
  1. `POST /auth/me/avatar/upload-url` → o IDP devolve um **presigned PUT** (`{ uploadUrl, key, expiresIn }`) para uma chave derivada do `sub` no servidor. Não altera `avatarUpdatedAt`.
  2. O client faz `PUT <uploadUrl>` enviando a imagem **direto ao S3** (respeitando o content-type/tamanho da política).
  3. `PATCH /auth/me/avatar` → o IDP **confirma o objeto no S3 (HEAD)** e só então grava `avatarUpdatedAt = now()`.
  - `DELETE /auth/me/avatar` → remove o custom e zera `avatarUpdatedAt` (volta a `avatarUrl = null`).

Detalhes e regras de segurança do presigned: `docs/rfc/0001-idp-autoridade-de-perfil-e-avatar.md` §2.4.
