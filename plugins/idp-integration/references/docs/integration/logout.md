# Guia de Integração — Logout

> **Última atualização:** 2026-07-18 (contrato 1.6.0)

---

## 1. Resumo executivo

O IDP suporta **quatro caminhos** para encerrar/revogar sessões — cada um com um escopo de revogação definido (tabela completa de escopos em §8):

| Caminho | Endpoint | Quem usa | O que acontece |
|---|---|---|---|
| **Logout cookie-mode** (sessão IDP do browser) | `POST https://idp.overlens.com.br/logout` | O frontend Accounts (`accounts.overlens.com.br`) — e qualquer SPA sob `*.overlens.com.br` que dependa dos cookies emitidos pelos endpoints `/login`, `/signup`, `/token/refresh`. | Revoga **só a sessão do cookie apresentado** (`revokedAt` na linha de `refresh_sessions` — P2) e emite `Set-Cookie` com `Max-Age=0` para `access_token` e `refresh_token`. Sessões de outros apps/dispositivos **não** são afetadas. Ver §2. |
| **End-session (RP-Initiated Logout)** | `GET /auth/logout` | Consumers OAuth que querem encerrar também a **sessão SSO do IDP** — o browser navega até o IDP e é redirecionado de volta (`302`). | Revoga **por dispositivo** (cookie interno `device_id` — P26/1.6.0), com fallback per-client → global; limpa os cookies do IDP e redireciona para a `post_logout_redirect_uri` registrada. Contrato completo em §8. |
| **Revogação OAuth (RFC 7009)** | `POST /auth/revoke` | Sistemas integrados via OAuth (Next.js BFF, mobile, qualquer client que troca `code` por JWT). | Revoga **a sessão do refresh token apresentado** no IDP; você apaga sua própria sessão local. Ver §3. |
| **Revogação administrativa / lifecycle de conta** | `POST /admin/users/:id/block` · desativação · exclusão de conta | ADMIN (incidente) ou self-service ([`profile.md`](./profile.md) §7/§8). | Revoga **TODAS** as sessões do usuário. |

> ✅ **O IDP implementa o endpoint OAuth de revogação `POST /auth/revoke` (RFC 7009)** — ver §3.
> ⚠️ Continua **não existindo** `grant_type=revoke` no `POST /auth/token` — essa chamada retorna `400 unsupported_grant_type`. Use o endpoint dedicado.

---

## 2. Caminho A — Logout cookie-mode (Accounts e SPAs `*.overlens.com.br`)

Usado quando seu sistema depende dos cookies `access_token`/`refresh_token` emitidos pelo IDP em `POST /login`, `POST /signup`, `POST /login/google`, `POST /token/refresh`.

### Contrato

```
POST https://idp.overlens.com.br/logout
Cookie: refresh_token=<código> (opcional — logout funciona mesmo sem)

Response: 200 OK
Set-Cookie: access_token=;  Path=/;              Max-Age=0; Domain=.overlens.com.br
Set-Cookie: refresh_token=; Path=/token/refresh; Max-Age=0; Domain=.overlens.com.br
Body: { "ok": true }
```

Efeitos:
- Se o cookie `refresh_token` chegou ao IDP, a **sessão correspondente** em `refresh_sessions` é revogada (`revokedAt` na linha cujo hash bate) — invalidação imediata, sem tempo de propagação. **Escopo (P2): só essa sessão.** As sessões OAuth do usuário (web, admin, mobile) e as sessões cookie de outros dispositivos continuam vivas.
- O `access_token` ainda em circulação continua válido até `exp` (até 15 minutos). Não há blocklist.
- O endpoint **não exige autenticação** — é idempotente. Chamar duas vezes não falha.

### Exemplo (fetch)

```javascript
async function logout() {
  await fetch('https://idp.overlens.com.br/logout', {
    method: 'POST',
    credentials: 'include', // obrigatório para enviar/limpar cookies cross-subdomain
  });
  window.location.href = '/login';
}
```

### Quando NÃO usar este caminho

- Você é um BFF Next.js que armazena `session_token`/`session_refresh` próprios após `POST /auth/token` (fluxo OAuth). Esses cookies vivem no **seu domínio**, não no `.overlens.com.br` — o `POST /logout` do IDP não os toca. Use o Caminho B.
- Você é um app mobile ou serviço M2M. Você não tem cookies — use o Caminho B (ou nada, no caso M2M).

---

## 3. Caminho B — Logout no consumer OAuth

Você obteve `access_token` e `refresh_token` via `POST /auth/token` (fluxo Authorization Code + PKCE). Para "deslogar":

### O que fazer

1. **Revogue o `refresh_token` no IDP** via `POST /auth/revoke` (RFC 7009) — **antes** de apagar a sessão local, enquanto você ainda tem o token em mãos. Melhor esforço: falha na revogação **não deve bloquear** o logout local.
2. **Apague sua sessão local.** Os cookies/sessão que você criou no callback (`session_token`, `session_refresh`, ou equivalente) ficam só no seu domínio. Apague-os.
3. **(Opcional)** Encerre também a sessão SSO do IDP, garantindo que o próximo `/auth/authorize` peça credenciais: navegue o browser para o end-session `GET /auth/logout` (com `client_id`/`post_logout_redirect_uri` — contrato completo em §8) ou para `accounts.overlens.com.br/logout`.

### Contrato — `POST /auth/revoke` (RFC 7009)

```
POST https://idp.overlens.com.br/auth/revoke
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)   ← ou client_id/client_secret no body;
                                                          public client (PKCE) envia só client_id

token=<refresh_token>&token_type_hint=refresh_token

→ 200 {}   sempre que o client autenticou — mesmo para token desconhecido,
           já revogado ou pertencente a outro client (RFC 7009 §2.2: a
           resposta não revela existência/posse de tokens)
→ 400 { error: "invalid_request" }  token ausente
→ 401 { error: "invalid_client" }   credenciais do client inválidas
                                    (+ WWW-Authenticate: Basic, como no /auth/token)
```

Semântica:
- A autenticação do client é **exatamente a mesma** do `POST /auth/token`. Os `allowedGrantTypes` do client **não** restringem o revoke.
- A revogação só tem efeito se a **sessão** pertence ao client autenticado (mesma regra SEC-004 do refresh; sessão do fluxo cookie — `clientId` nulo — é revogável por qualquer client registrado autenticado). O par vivo da grace window (token anterior) também é aceito, e a revogação mata **a sessão inteira** — nenhum dos dois códigos volta a renovar. **Escopo (P2): só a sessão do token apresentado**; as demais sessões do usuário não são tocadas.
- `token_type_hint=access_token` → `200` **no-op**: o `access_token` é um JWT stateless sem blocklist — ele continua válido até `exp` (≤ 15 min). Revogue sempre o **refresh** token.
- O endpoint aparece no discovery (`revocation_endpoint` + `revocation_endpoint_auth_methods_supported`), então libs OIDC (Auth.js, oidc-client-ts) fazem a revogação automática no signout.

### Exemplo (Next.js Route Handler / Server Action)

```typescript
'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function logout() {
  const store = await cookies();

  // 1. Revoga o refresh token no IDP (RFC 7009) — melhor esforço:
  //    falha aqui NÃO deve impedir o logout local.
  const refreshToken = store.get('session_refresh')?.value;
  if (refreshToken) {
    try {
      await fetch('https://idp.overlens.com.br/auth/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env.IDP_CLIENT_ID}:${process.env.IDP_CLIENT_SECRET}`,
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }),
      });
    } catch {
      // best-effort: segue com o logout local
    }
  }

  // 2. Apaga sessão local do seu sistema (cookies do seu domínio)
  store.delete('session_token');
  store.delete('session_refresh');

  // 3. (Opcional) Redireciona o browser para também encerrar a sessão SSO do
  //    IDP — garante que um próximo `/auth/authorize` peça credenciais.
  redirect('https://accounts.overlens.com.br/logout?next=/');
}
```

### Limites conhecidos

| Cenário | Comportamento |
|---|---|
| `refresh_token` perdido em dispositivo do usuário (você ainda o tem persistido) | Revogue via `POST /auth/revoke`. |
| `refresh_token` vazado e você NÃO o tem mais | Bloquear o usuário inteiro via `POST /admin/users/:id/block` — revoga **todas** as sessões e impede novas rotações. |
| Revocação seletiva **por dispositivo** (múltiplas sessões simultâneas) | ✅ Suportado (P2): cada login/exchange é uma sessão independente em `refresh_sessions`; o revoke mata só a sessão do token apresentado. |
| `access_token` ativo após logout/revoke | Aguardar `exp` (≤ 15 min) — JWT stateless, sem blocklist. |

---

## 4. Logout passivo (expiração natural)

Quando o usuário simplesmente fecha o browser sem clicar "Sair":

| Token | Expiração | Resultado |
|---|---|---|
| `access_token` (JWT, RS256) | 15 minutos | Requests autenticadas começam a retornar `401`. |
| `refresh_token` (cookie ou body OAuth) | 30 dias | Tentativa de refresh retorna `401`; usuário é forçado a re-logar. |
| M2M `access_token` | 5 minutos | Próxima request M2M precisa pegar novo token via `client_credentials`. |

---

## 5. Botão "Sair" no frontend

### React (SPA pública sob `*.overlens.com.br` — Caminho A)

```jsx
function LogoutButton() {
  async function handleClick() {
    await fetch('https://idp.overlens.com.br/logout', {
      method: 'POST',
      credentials: 'include',
    });
    window.location.href = '/login';
  }
  return <button onClick={handleClick}>Sair</button>;
}
```

### Next.js BFF (Caminho B)

```tsx
import { logout } from '@/lib/auth-actions';

export function LogoutButton() {
  return (
    <form action={logout}>
      <button type="submit">Sair</button>
    </form>
  );
}
```

> Use `<form action={...}>` (POST), não `<a href>` — logout altera estado e nunca deve ser idempotentemente cacheável pelo browser.

---

## 6. Checklist de integração

### Caminho A (cookie-mode)
- [ ] `POST /logout` chamado com `credentials: 'include'`
- [ ] Redirecionamento para `/login` após sucesso
- [ ] Estado local do app (Redux/Zustand/Context) limpo após logout

### Caminho B (OAuth consumer)
- [ ] `POST /auth/revoke` chamado com o `refresh_token` **antes** de apagar a sessão local (melhor esforço — falha não bloqueia o logout)
- [ ] Cookies de sessão **do seu domínio** apagados
- [ ] `refresh_token` recebido do IDP descartado da sua persistência
- [ ] (Recomendado) Redirect para `accounts.overlens.com.br/logout` para também encerrar sessão IDP
- [ ] **Nunca** envie `grant_type=revoke` para `/auth/token` — não existe (`400 unsupported_grant_type`); use `POST /auth/revoke`

---

## 7. Referência rápida — o que NÃO existe

| Endpoint / parâmetro | Status |
|---|---|
| `POST /auth/token` com `grant_type=revoke` | ❌ Não implementado. Retorna `400 unsupported_grant_type`. Use `POST /auth/revoke` (§3). |
| `GET /logout` (sem o prefixo `/auth`) | ❌ Não existe. O logout cookie-mode é sempre `POST /logout`. O GET que existe é o end-session **`GET /auth/logout`** (§8). |
| Revogação de `access_token` (blocklist de JWT) | ❌ Não suportado. `POST /auth/revoke` com `token_type_hint=access_token` é no-op `200`; o JWT expira naturalmente (≤ 15 min). |
| Back-channel / front-channel logout (OIDC spec) | ❌ Não implementado — a revogação server-side é imediata, mas os apps só percebem no próximo silent refresh (≤ 15 min). |

Para invalidar **todas** as sessões de um usuário em qualquer dispositivo (caso de incidente), use `POST /admin/users/:id/block` — exige role `ADMIN` e revoga todas as linhas de `refresh_sessions` do usuário.

---

## 8. Escopo de revogação por caminho (P2 — multi-sessão; P26 — device-scoped)

> ⚠️ **Desde o contrato 1.4.0 o logout NÃO é mais global** e **desde o 1.6.0 o
> `GET /auth/logout` é POR DISPOSITIVO** (P26). Cada caminho tem um escopo definido:

| Caminho | Escopo da revogação server-side |
|---|---|
| `POST /logout` (cookie) | **Só a sessão do cookie `refresh_token` apresentado** (best-effort; sem cookie, só limpa cookies). |
| `GET /auth/logout` (end-session) **com cookie `device_id`** (padrão pós-P26) | **TODAS as sessões DAQUELE dispositivo** — a sessão SSO cookie-mode do Accounts **e** as sessões OAuth de todos os apps do mesmo browser (que herdam o `device_id` via o `authorization_code`). As sessões de **outros dispositivos** do usuário sobrevivem. Precede o escopo per-client abaixo. |
| `GET /auth/logout` **sem `device_id`** (sessão legada pré-P26) com `client_id`/`id_token_hint` resolvível | **As sessões daquele client** para o usuário (fallback 1.4.0). A sessão cookie SSO e as sessões de outros clients sobrevivem. |
| `GET /auth/logout` **sem `device_id`** e sem client resolvível | **TODAS as sessões do usuário** — fallback que preserva a semântica global antiga. |
| `POST /auth/revoke` (RFC 7009) | **A sessão do token apresentado**, se pertencer ao client autenticado. |
| `POST /admin/users/:id/block`, desativação e exclusão de conta | **TODAS as sessões do usuário.** |

> **`device_id` (P26):** cookie interno do IDP (opaco, `HttpOnly`, `Secure`,
> `SameSite=Lax`, `Domain=.overlens.com.br`, `Path=/`, ~30d), setado no
> login/authorize e **estável** — NÃO é limpo no logout (é o anchor que mantém o
> dispositivo reconhecível entre um logout e o login seguinte). Nenhum consumidor
> precisa lê-lo ou enviá-lo: o browser o envia automaticamente ao `GET /auth/logout`
> (Path=/). **Limitação:** os apps do dispositivo deslogam no próximo silent
> refresh (≤ 15 min), não instantaneamente — não há back-channel logout.

### Contrato completo — `GET /auth/logout` (end-session)

```
GET https://idp.overlens.com.br/auth/logout
  ?id_token_hint=<jwt>             (opcional)
  &client_id=<id>                  (opcional — mecanismo primário de resolução do client)
  &post_logout_redirect_uri=<uri>  (opcional)
  &state=<opaque>                  (opcional — ecoado de volta)

Cookie: access_token=<jwt>   (Path=/ — enviado; usado para resolver o `sub`)
Cookie: device_id=<hex>      (Path=/ — enviado; âncora do escopo por dispositivo)
(o cookie refresh_token tem Path=/token/refresh e NÃO chega a este endpoint)

Response: 302 Found
Set-Cookie: access_token=;  Domain=.overlens.com.br; Max-Age=0; Path=/
Set-Cookie: refresh_token=; Domain=.overlens.com.br; Max-Age=0; Path=/token/refresh
(`device_id` NUNCA é limpo — é o anchor estável do dispositivo)
Location: <post_logout_redirect_uri registrada>?state=<state>   (se válida)
          <IDP_DEFAULT_POST_LOGOUT_URI>                          (fallback)
```

Semântica dos parâmetros:

- **`client_id`** — mecanismo **primário** de resolução do client.
- **`id_token_hint`** — alternativa aceita: o JWT é validado (assinatura RS256 + `iss`), a **expiração é ignorada** (um id_token vencido ainda serve como hint) e o client é lido do claim `aud`.
- **`post_logout_redirect_uri`** — validada por **exact-match** contra a allowlist `postLogoutRedirectUris` do client resolvido (ver [`oauth-clients.md`](./oauth-clients.md)). URI ausente **ou não registrada** → redirect para o fallback `IDP_DEFAULT_POST_LOGOUT_URI` (produção: `https://accounts.overlens.com.br/logged-out`); a URI rejeitada **nunca é refletida** no redirect (proteção anti open-redirect).
- **`state`** — ecoado de volta na URL de redirect quando o destino é a URI registrada.

Revogação server-side: o usuário é identificado pelo `sub` do cookie `access_token` (ou do `id_token_hint`, se o cookie estiver ausente), já que o cookie opaco `refresh_token` não chega a este path. A precedência do escopo é **device → per-client → global** (tabela acima). Sem nenhum token que identifique o usuário, apenas os cookies são limpos.
