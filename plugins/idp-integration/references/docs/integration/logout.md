# Guia de Integração — Logout

> **Última atualização:** 2026-08-12 (contrato 1.9.0)

---

## 1. Resumo executivo

O IDP suporta **quatro caminhos** para encerrar/revogar sessões (escopo de cada um em §8) e, desde o contrato **1.9.0**, um **caminho de notificação**: o back-channel logout, pelo qual o IDP avisa o seu backend no instante em que uma sessão é revogada, em vez de você descobrir no próximo silent refresh (§9).

| Caminho | Endpoint | Quem usa | O que acontece |
|---|---|---|---|
| **Logout cookie-mode** (sessão IDP do browser) | `POST https://idp.overlens.com.br/logout` | O frontend Accounts (`accounts.overlens.com.br`) — e qualquer SPA sob `*.overlens.com.br` que dependa dos cookies emitidos pelos endpoints `/login`, `/signup`, `/token/refresh`. | Revoga **só a sessão do cookie apresentado** (`revokedAt` na linha de `refresh_sessions` — P2) e emite `Set-Cookie` com `Max-Age=0` para `access_token` e `refresh_token`. Sessões de outros apps/dispositivos **não** são afetadas. Ver §2. |
| **End-session (RP-Initiated Logout)** | `GET /auth/logout` | Consumers OAuth que querem encerrar também a **sessão SSO do IDP** — o browser navega até o IDP e é redirecionado de volta (`302`). | Revoga **por dispositivo** (cookie interno `device_id` — P26/1.6.0), com fallback per-client → global; limpa os cookies do IDP e redireciona para a `post_logout_redirect_uri` registrada. Contrato completo em §8. |
| **Revogação OAuth (RFC 7009)** | `POST /auth/revoke` | Sistemas integrados via OAuth (Next.js BFF, mobile, qualquer client que troca `code` por JWT). | Revoga **a sessão do refresh token apresentado** no IDP; você apaga sua própria sessão local. Ver §3. |
| **Revogação administrativa / lifecycle de conta** | `POST /admin/users/:id/block` · desativação · exclusão de conta | ADMIN (incidente) ou self-service ([`profile.md`](./profile.md) §7/§8). | Revoga **TODAS** as sessões do usuário. |
| **Back-channel logout (OIDC)** ← notificação, não revogação | `POST {backchannelLogoutUri}` (o **IDP chama você**) | Qualquer client OAuth que queira encerrar a sessão local no mesmo instante em que o usuário sai em outro app do dispositivo. | O IDP entrega um `logout_token` assinado (RS256/JWKS) por sessão revogada, com a claim `sid`; você derruba a sessão local correspondente. **Sem endpoint registrado, nada muda:** você segue no piso de ≤ 15 min. Ver §9. |

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
- [ ] (Recomendado, 1.9.0) `backchannelLogoutUri` registrada + `sid` do id_token persistido, para deslogar no mesmo instante em que o usuário sai em outro app (§9)
- [ ] **Nunca** envie `grant_type=revoke` para `/auth/token` — não existe (`400 unsupported_grant_type`); use `POST /auth/revoke`

---

## 7. Referência rápida — o que NÃO existe

| Endpoint / parâmetro | Status |
|---|---|
| `POST /auth/token` com `grant_type=revoke` | ❌ Não implementado. Retorna `400 unsupported_grant_type`. Use `POST /auth/revoke` (§3). |
| `GET /logout` (sem o prefixo `/auth`) | ❌ Não existe. O logout cookie-mode é sempre `POST /logout`. O GET que existe é o end-session **`GET /auth/logout`** (§8). |
| Revogação de `access_token` (blocklist de JWT) | ❌ Não suportado. `POST /auth/revoke` com `token_type_hint=access_token` é no-op `200`; o JWT expira naturalmente (≤ 15 min). |
| Back-channel logout (OIDC spec) | ✅ Implementado desde o contrato 1.9.0 (§9), para clients com `backchannelLogoutUri` registrado. Sem endpoint registrado, o comportamento é o antigo: a revogação server-side é imediata, mas você só percebe no próximo silent refresh (≤ 15 min). |
| Front-channel logout (iframe) e Session Management (`check_session_iframe`) | ❌ Não implementados, e não estão no roadmap: dependem de cookie de terceiro, bloqueado fora de `*.overlens.com.br`. Use o back-channel (§9). |

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
> (Path=/). **Propagação (1.9.0):** clients com `backchannelLogoutUri` registrado
> recebem o push e deslogam no mesmo instante (§9); os demais continuam deslogando
> no próximo silent refresh, em ≤ 15 min.

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

---

## 9. Back-channel logout (o IDP avisa o seu backend)

> Contrato **1.9.0** / [ADR-0014](https://github.com/overlens/identity-provider/blob/main/docs/adr/0014-back-channel-logout.md). Opcional e
> aditivo: **sem `backchannelLogoutUri` registrado você não recebe nada e nada
> muda** no seu app, que segue descobrindo a revogação no próximo silent refresh
> (≤ 15 min). Não há flag global no IDP: registrar o endpoint é o que liga o
> push para o seu client, e desregistrar é o que desliga.

### 9.1 Modelo mental

O `GET /auth/logout` já revoga as sessões do dispositivo **na hora**, no banco. O
que demorava era a sua descoberta: sua sessão local continuava servindo páginas
até o access token expirar. O back-channel fecha essa janela empurrando o aviso.

```
[1] Usuário clica "Sair" no app A (ou no Accounts)
[2] IDP revoga as sessões daquele dispositivo (banco, imediato)
[3] IDP → POST logout_token (um por sessão revogada) → seu backend   ◄── §9.4
[4] Você derruba a sessão local casada pelo `sid`
[5] Seu backend → aba viva do browser (SSE / refetch)                ◄── seu, não do IDP
```

O IDP entrega até o **seu backend**. O último salto até a aba aberta é seu, como
no push de perfil ([`profile-events.md`](./profile-events.md) §6).

### 9.2 Registrar o endpoint

Peça ao admin do IDP, via [`PATCH /admin/clients/:id`](./oauth-clients.md):

```jsonc
{ "backchannelLogoutUri": "https://api.seuapp.com.br/backchannel-logout" }
```

HTTPS obrigatório, sem host loopback/privado/link-local/metadata (anti-SSRF, as
mesmas regras do `webhookUrl`). `""` remove o endpoint e o tira do fan-out.

### 9.3 Guardar o `sid` no login

O id_token passou a carregar **`sid`** (identificador opaco da sessão). **Guarde-o
junto da sua sessão local** no callback do `POST /auth/token`: é a chave que o
`logout_token` vai usar para dizer *qual* sessão morreu.

Sem persistir o `sid`, sua única reação possível ao push é derrubar todas as
sessões daquele `sub`, o que desloga o celular do usuário quando ele sai no
desktop. É exatamente o que o `sid` existe para evitar.

### 9.4 O que chega no seu endpoint

```
POST https://api.seuapp.com.br/backchannel-logout
Content-Type: application/x-www-form-urlencoded

logout_token=eyJhbGciOiJSUzI1NiIsInR5cCI6ImxvZ291dCtqd3QiLCJraWQiOiI...
```

```jsonc
// header
{ "alg": "RS256", "kid": "<kid do JWKS>", "typ": "logout+jwt" }
// payload
{
  "iss": "https://idp.overlens.com.br",
  "aud": "seu-client-id",          // string, igual ao id_token
  "sub": "cm9x...",                // identity.id (o mesmo `sub` do access token)
  "sid": "cma7...",                // a sessão revogada; case a sua sessão local por ele
  "jti": "cmb2...",                // estável entre retries: use para deduplicar
  "iat": 1770000000,               // não há `exp`: a janela de frescor é sua (§9.5.7)
  "events": { "http://schemas.openid.net/event/backchannel-logout": {} }
}
```

> **Não há `nonce`** (proibido) e **não há `exp`**. O `exp` fica de fora porque um
> prazo curto brigaria com o retry: uma entrega reagendada por 10 minutos chegaria
> vencida e seria recusada justamente quando o push mais precisa completar. O
> frescor você impõe pelo `iat` (§9.5), e o dedupe por `jti` cobre o replay.

Cada sessão OAuth revogada de um client com endpoint registrado gera **um POST**,
com o seu próprio `sid` e `jti`: um logout que derruba dois apps do dispositivo
produz dois POSTs. A sessão SSO cookie-mode do Accounts não pertence a client
nenhum, então não gera POST.

### 9.5 Contrato do receiver (o que você implementa)

1. **Verifique a assinatura** com o JWKS do IDP (`GET /.well-known/jwks.json`,
   RS256): a **mesma** chave pública que você já usa no access token. Nenhum
   segredo novo.
2. Cheque `iss == https://idp.overlens.com.br` e `aud == seu client_id`.
3. Exija a claim **`events`** com o membro
   `http://schemas.openid.net/event/backchannel-logout`. É o que distingue um
   `logout_token` de qualquer outro JWT assinado pelo IDP.
4. **RECUSE o token se ele tiver `nonce`.** `nonce` só existe em id_token: um
   token de logout com `nonce` é um id_token sendo reaproveitado como ordem de
   logout. Exigido pela spec.
5. **Deduplique por `jti`** (janela sugerida: 24h). A entrega é **at-least-once**
   e o retry reenvia o **mesmo** `jti`.
6. **Mapeie `sid` → sessão local** e derrube só ela. Sem `sid` reconhecido (login
   anterior à 1.9.0, sessão já encerrada), trate como no-op e responda 200.
7. **Imponha uma janela de frescor pelo `iat`** (sugestão: recuse `iat` mais velho
   que 1 hora). O token não tem `exp`, então essa janela é sua; ela é o teto de
   quanto tempo um `logout_token` capturado continua utilizável, e o dedupe por
   `jti` cuida do resto.
8. **Responda 200** com `Cache-Control: no-store`. Token inválido: `400`.

> Um `400` também é reagendado pelo IDP (a fila só distingue 2xx de não-2xx) e
> termina em dead-letter depois de `BACKCHANNEL_LOGOUT_MAX_ATTEMPTS`. Isso é
> esperado: o dead-letter é o alerta de que a integração está quebrada.

### 9.6 Exemplo (TypeScript, Express + `jose`)

```ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://idp.overlens.com.br/.well-known/jwks.json'));
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

app.post('/backchannel-logout', express.urlencoded({ extended: false }), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(String(req.body.logout_token ?? ''), JWKS, {
      issuer: 'https://idp.overlens.com.br',
      audience: process.env.OVERLENS_CLIENT_ID,
      typ: 'logout+jwt',
      maxTokenAge: '1h', // janela de frescor: o logout_token não tem exp
    }));
  } catch {
    return res.status(400).end();
  }

  const events = payload.events as Record<string, unknown> | undefined;
  if (!events?.[LOGOUT_EVENT]) return res.status(400).end();
  if ('nonce' in payload) return res.status(400).end(); // id_token reaproveitado
  const { jti, sid } = payload;
  if (typeof jti !== 'string' || typeof sid !== 'string') return res.status(400).end();

  if (await seenBefore(jti)) return res.status(200).end(); // dedupe (Redis, TTL 24h)
  await markSeen(jti);

  await destroyLocalSessionBySid(sid); // só a sessão daquele dispositivo
  return res.status(200).end();
});
```

O trabalho aqui é curto (apagar uma linha de sessão), então processar dentro do
request é aceitável. Se o seu handler fizer mais que isso, dê o `200` antes e
processe async, como no webhook de perfil.

### 9.7 Garantias de entrega

- **A primeira tentativa sai junto do logout**, fire-and-forget, então o normal é
  o POST chegar em menos de um segundo. A fila é a rede de segurança: o que falhar
  ali o worker repesca no próximo tick.
- **At-least-once** com `jti` estável: o mesmo evento pode chegar mais de uma
  vez, sempre com o mesmo `jti`. O dedupe é obrigatório.
- **Retry com backoff exponencial** e **dead-letter** após
  `BACKCHANNEL_LOGOUT_MAX_ATTEMPTS`. Não há replay depois do dead-letter.
- **Sem circuit-breaker**, ao contrário do webhook de perfil: um endpoint que
  falha não é desativado. O evento é o próprio sinal de segurança, e não há canal
  de reposição a não ser a expiração do access token.
- **A revogação em banco é a fonte de verdade.** Se a entrega falhar, sua sessão
  local sobrevive até o próximo silent refresh, que falha e desloga: o piso de
  ≤ 15 min. **Nunca** interprete "não recebi `logout_token`" como "a sessão está
  viva".
- **Ainda sem push:** bloqueio, desativação, exclusão de conta e reset de senha
  revogam sessões sem notificar (ADR-0014, fora de escopo). Continue tratando
  falha de refresh como logout.

### 9.8 Checklist

- [ ] `backchannelLogoutUri` HTTPS registrada no client.
- [ ] `sid` do id_token persistido junto da sessão local, no callback.
- [ ] Assinatura verificada via JWKS + `iss` + `aud` + claim `events`.
- [ ] Token com `nonce` recusado.
- [ ] Janela de frescor por `iat` (o token não tem `exp`).
- [ ] Dedupe por `jti` (TTL 24h).
- [ ] Sessão derrubada **por `sid`**, não por `sub`.
- [ ] `200` + `Cache-Control: no-store`; `400` só para token inválido.
- [ ] Falha de silent refresh continua tratada como logout (o push é aceleração).
