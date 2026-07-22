# Área Administrativa — Guia Operacional

> **Última atualização:** 2026-07-18
>
> **Escopo atual:** Portão de autorização `/admin` + dashboard de stats + **CRUD completo de OAuth Clients com audit log** (PR #39). Gestão de Accounts (block/unblock via UI) ainda virá em epic futuro — hoje continua via API/SQL.

---

## Como funciona

A rota `/admin` em `accounts.overlens.com.br` é protegida pelo componente `<RequireAdmin>` (`apps/accounts/src/components/require-admin.tsx`). O guard consulta `GET /auth/me` e:

- **Sessão ausente / 401** → redireciona para `/login?next=/admin` (após login bem-sucedido, o usuário volta para `/admin` automaticamente).
- **Sessão válida, `role !== 'ADMIN'`** → redireciona silenciosamente para `/profile` (sem toast, sem mensagem). Esse comportamento é intencional para não revelar a existência da área admin.
- **Sessão válida, `role === 'ADMIN'`** → exibe a área admin real: dashboard de stats (`/admin`) + CRUD completo de OAuth Clients com audit log (`/admin/clients`, `/admin/clients/new`, `/admin/clients/:id`).

> ⚠️ O guard é **defesa em profundidade no frontend**, não autorização real. Toda API admin valida `role === 'ADMIN'` server-side via `AdminRoleGuard` (`apps/idp/src/common/guards/admin-role.guard.ts`). M2M tokens (`client_credentials`) são rejeitados pelo guard — admin é exclusivamente para humanos.

**Endpoints admin disponíveis hoje:**

- `GET /admin/stats` — dashboard (§seção própria abaixo)
- `POST /admin/users/:id/block` — bloquear usuário (marca `blockedAt` + revoga **todas** as sessões de refresh do usuário em `refresh_sessions`)
- `POST /admin/clients`, `GET /admin/clients`, `GET /admin/clients/:id`, `PATCH /admin/clients/:id`, `POST /admin/clients/:id/disable`, `POST /admin/clients/:id/enable`, `DELETE /admin/clients/:id`, `GET /admin/clients/:id/audit-log` — CRUD de OAuth Clients (ver [`oauth-clients.md`](./oauth-clients.md))

---

## Como promover um usuário a ADMIN

O **primeiro** ADMIN não precisa de promoção manual: ele vem do **seed do root user** (`apps/idp/prisma/seed.ts`, envs `ROOT_USER_EMAIL`/`ROOT_USER_PASSWORD`), que cria/atualiza o usuário administrativo no bootstrap. A promoção **manual via SQL** no Neon (banco `identity`) é o procedimento para admins **adicionais** — substituição por UI ainda virá. Runbook completo em [`../deploy/admin-runbook.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/admin-runbook.md) §1.

### Procedimento (4-eyes obrigatório)

1. Abra o Neon SQL Editor no projeto `identity`.
2. Confirme o usuário-alvo:

   ```sql
   SELECT id, email, name, role, blockedAt, deactivatedAt, deletedAt
   FROM identity
   WHERE email = 'pessoa@overlens.com.br';
   ```

3. Garanta que `blockedAt`, `deactivatedAt` e `deletedAt` são todos `NULL`. Não promova contas em qualquer estado de inatividade.
4. Peça revisão de outro engenheiro com acesso ao Neon antes de executar a mutação.
5. Execute:

   ```sql
   UPDATE identity
   SET role = 'ADMIN', updatedAt = NOW()
   WHERE email = 'pessoa@overlens.com.br';
   ```

6. Verifique:

   ```sql
   SELECT id, email, role, updatedAt
   FROM identity
   WHERE email = 'pessoa@overlens.com.br';
   ```

7. Comunique o usuário promovido. Ele precisa **fazer logout e login novamente** para que o `role=ADMIN` apareça no novo JWT (o cookie atual continua com `role=BASIC` até expirar em até 15 minutos).

### Rebaixar (revogar admin)

```sql
UPDATE identity
SET role = 'BASIC', updatedAt = NOW()
WHERE email = 'pessoa@overlens.com.br';
```

Nesta fase, o frontend não revalida `role` até o próximo `useProfile` refetch (F5 do usuário). Os endpoints admin revalidam server-side via `AdminRoleGuard` a cada request — então um rebaixamento bloqueia ações reais imediatamente, mesmo que a UI ainda mostre menus por alguns minutos.

---

## Telemetria

Eventos PostHog disparados pelo guard (definidos em `apps/accounts/src/lib/admin-telemetry.ts`):

| Evento | Propriedades | Quando |
|---|---|---|
| `admin.access_granted` | `userId`, `path` | Admin entra em `/admin`. Disparado uma vez por mount. |
| `admin.access_denied_role` | `userId`, `role`, `path` | Usuário autenticado mas sem `role=ADMIN` foi redirecionado para `/profile`. |
| `admin.access_denied_unauthenticated` | `path` | Anônimo bateu em `/admin` e foi redirecionado para `/login?next=...`. |

Use o painel PostHog para auditar tentativas. Volume esperado: baixo (menos de uma dezena por dia).

---

## Ordem de deploy (importante)

A entrega depende de uma mudança contratual no `GET /auth/me` que passou a expor o campo `role`. Para evitar uma janela em que o frontend não vê o `role`:

1. **Deploy primeiro:** `apps/idp/` (com `role` no `ProfileResponseDto`).
2. **Depois:** `apps/accounts/` (com a rota `/admin` e o guard).

Se a ordem for invertida, o guard verá `role === undefined` para todos os usuários e redirecionará tudo para `/profile`. Não há perda de dados — apenas a área admin fica temporariamente inacessível.

---

## `GET /admin/stats` — endpoint da dashboard

Endpoint que alimenta a dashboard inicial de `/admin`. Protegido por `AdminRoleGuard` (mesmo guard de `POST /admin/users/:id/block`).

### Request

```
GET /admin/stats
Cookie: access_token=<JWT com role=ADMIN>
```

### Response (200)

```jsonc
{
  "identities": {
    "total": 100,                                  // ativos: deletedAt IS NULL AND deactivatedAt IS NULL
    "byRole": { "BASIC": 95, "ADMIN": 3, "SYSTEM": 2 },
    "byAuthProvider": { "LOCAL": 60, "GOOGLE": 40 },
    "inactive": { "blocked": 2, "deactivated": 1, "deleted": 5 },
    // mutuamente exclusivos: deleted > deactivated > blocked
    "emailVerified": { "verified": 90, "unverified": 10 }
  },
  "growth": {
    "signups": { "last24h": 3, "last7d": 12, "last30d": 50 },
    "signupsDaily": [
      { "date": "2026-04-22", "count": 0 },
      // ... 30 entradas em ordem cronológica ascendente (UTC)
      { "date": "2026-05-21", "count": 5 }
    ]
  },
  "activity": {
    "logins": { "last24h": 20, "last7d": 80, "last30d": 150 },
    // logins via /login (entrada de credenciais), NÃO conta /token/refresh
    "activeSessions": 45 // usuários DISTINTOS com sessão ativa não-expirada em refresh_sessions (1.4.0)
  },
  "generatedAt": "2026-05-21T12:00:00.000Z"
}
```

### Erros

| Status | Quando |
|---|---|
| 401 | Cookie ausente ou JWT inválido / expirado |
| 403 | JWT válido mas `role !== 'ADMIN'` |
| 500 | Falha de banco — body genérico, detalhe nos logs |

### Cache

Response inclui `Cache-Control: private, no-store`. A dashboard refaz a query a cada visita ao `/admin` e ao clicar no botão "Atualizar".

### Performance

8 queries de agregação rodam em paralelo via `Promise.all`. P95 esperado ≤ 300ms enquanto o volume de identities for baixo. Se `signupsDaily` tornar-se lento, adicionar índice em `identity.createdAt` (atualmente não há).

### Observações

- `logins.last*` reflete somente entradas de credenciais (`lastLoginAt` é atualizado em `POST /login` e variações). Refresh de token **não** atualiza `lastLoginAt`.
- O `total` exclui contas deletadas/desativadas mas inclui as bloqueadas (bloqueio é reversível).
