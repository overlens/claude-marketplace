# Guia de Integração — Push de eventos de perfil (webhook / RFC-0004)

> Notificação **quase-tempo-real** de que o perfil global de um usuário mudou, para o
> backend do seu client invalidar o cache e **re-puxar** a verdade — sem baixar o TTL
> do Pull nem colocar o IDP no hot path.
>
> **Use este guia quando:** você cacheia atributos globais (`name`, `username`, `avatar`,
> `phone`, `birthDate`) lidos via [`GET /users/:sub`](./m2m-profile-read.md) e quer que
> uma edição no IDP apareça no seu app **em segundos**, não em até 5 min.
>
> **Quer o passo a passo completo com código de referência (Express/NestJS), testes e operação?**
> Veja o handbook [`profile-events-webhook-implementation.md`](./profile-events-webhook-implementation.md). Este guia aqui é o **contrato resumido**.
>
> **Referências:** [RFC-0004](https://github.com/overlens/identity-provider/blob/main/docs/rfc/0004-push-eventos-de-perfil.md) · Pull em [`m2m-profile-read.md`](./m2m-profile-read.md) · validação de JWT em [`backend.md`](./backend.md)
>
> **Última atualização:** 2026-07-18

> ⚠️ **Status de rollout:** a implementação no IDP está **completa**, mas a **entrega dos eventos é controlada pelo kill-switch `PROFILE_EVENTS_ENABLED` (default: desligado)** — o outbox grava sempre, o worker só entrega com a flag ligada. **Confirme com o time do IDP se o Push está ativo no ambiente** antes de depender dele; o fallback é o Pull com TTL de 300s (ADR-0009).

---

## 1. Modelo mental (leia primeiro)

O evento é **uma notificação, não uma transferência de estado**. Ele diz *"o usuário `sub` mudou (versão N, campos X)"* — **nunca** carrega o novo valor nem PII. Ao receber, você **re-puxa** a verdade via `GET /users/:sub` (RFC-0002).

Por quê: perder um evento **não corrompe** nada — o TTL do Pull (300s) é o fallback. E o payload é minúsculo e sem PII em fan-out.

**Fronteira:** o IDP entrega até o **backend** do seu client. O último salto — do seu backend até a **aba viva do browser** — é seu (SSE / WebSocket / refetch-on-focus). Ver §6.

```
[1] Usuário edita perfil no IDP (PATCH /auth/me)
[2] IDP → POST SET (secevent+jwt) → webhook do seu backend   ◄── o que este guia cobre
[3] Seu backend: verifica SET → invalida cache(sub) → GET /users/:sub
[4] Seu backend → browser (SSE/refetch)                        ◄── responsabilidade sua (§6)
```

## 2. Registrar o webhook

Peça ao admin do IDP para registrar, no seu OAuth client, via [`PATCH /admin/clients/:id`](./oauth-clients.md):

```jsonc
{
  "webhookUrl": "https://api.seuapp.com.br/webhooks/idp", // HTTPS obrigatório
  "webhookSecret": "um-segredo-forte-opcional"            // opcional (pré-filtro HMAC)
}
```

Pré-requisitos:
- O client precisa do scope **`profile:read`** em `allowedScopes` — **só recebe evento de perfil quem já pode ler perfil**.
- `webhookUrl` deve ser **HTTPS** e não pode apontar para host loopback/privado/link-local/metadata (rejeitado no registro — anti-SSRF).
- `webhookSecret` é opcional: quando definido, o IDP envia `X-Overlens-Signature: sha256=<hmac>` do corpo. É só um **pré-filtro** — a autenticidade real é a assinatura RS256 do SET (§4).

> Passar `webhookUrl: ""` remove o webhook. Definir uma URL nova **re-arma** o circuit-breaker (ver §5).

## 3. O que chega no seu endpoint

`POST {webhookUrl}` com `Content-Type: application/secevent+jwt` e corpo = um **Security Event Token (SET, RFC 8417)** assinado em RS256:

```jsonc
// header: { "alg": "RS256", "kid": "<kid do JWKS>", "typ": "secevent+jwt" }
{
  "iss": "https://idp.overlens.com.br",
  "aud": "seu-client-id",                                  // = seu clientId
  "iat": 1751990400,
  "jti": "<id da entrega>",                                 // idempotency key (estável entre retries)
  "sub_id": { "format": "opaque", "id": "ckuser..." },      // o sub afetado
  "events": {
    "https://schemas.overlens.com.br/events/profile-updated": {
      "version": 1751990400000,                             // monotônico por sub
      "changed": ["avatar", "name"],                         // hint (ausente em lifecycle)
      "occurred_at": 1751990400
    }
  }
}
```

Tipos de evento (sufixo da URI em `https://schemas.overlens.com.br/events/`):

| Tipo | Significado | Ação no seu cache |
|---|---|---|
| `profile-updated` | um atributo global mudou (ver `changed`) | invalida `sub` → re-puxa |
| `account-deactivated` | conta desativada | invalida `sub` (pode ocultar) |
| `account-deleted` | exclusão irreversível (Pull passa a dar 404) | **evict** `sub` |

## 4. Contrato do receiver (o que você implementa)

1. **Verifique** a assinatura do SET via o JWKS do IDP (`GET /.well-known/jwks.json`, RS256) — a **mesma** chave que você já usa para validar o access token. Cheque `iss == https://idp.overlens.com.br` e `aud == seu clientId`.
2. **Deduplique** por `jti` (janela sugerida: 24h). Retries reusam o mesmo `jti`.
3. **Ordering:** ignore se `version` for **menor** que a última vista para aquele `sub`.
4. **Invalide** o cache local daquele `sub`.
5. **Re-puxe** `GET /users/:sub` (RFC-0002) quando precisar do dado — lazy, ou proativo para já empurrar ao browser (§6).
6. Responda **2xx rápido** (idealmente processe async depois do ack). Não-2xx = o IDP re-tenta com backoff.

Exemplo (TypeScript, Express + `jose`):

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://idp.overlens.com.br/.well-known/jwks.json'));
const seen = new Map<string, number>(); // jti -> ts (troque por Redis com TTL em produção)
const lastVersion = new Map<string, number>(); // sub -> version

app.post('/webhooks/idp', express.text({ type: 'application/secevent+jwt' }), async (req, res) => {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(req.body, JWKS, {
      issuer: 'https://idp.overlens.com.br',
      audience: process.env.OVERLENS_CLIENT_ID, // seu clientId
    }));
  } catch {
    return res.status(401).end(); // assinatura/iss/aud inválidos
  }

  const jti = payload.jti as string;
  if (seen.has(jti)) return res.status(200).end(); // dedupe
  seen.set(jti, Date.now());

  const sub = (payload.sub_id as { id: string }).id;
  const events = payload.events as Record<string, { version: number }>;
  const version = Object.values(events)[0]?.version ?? 0;
  if (version < (lastVersion.get(sub) ?? 0)) return res.status(200).end(); // stale
  lastVersion.set(sub, version);

  res.status(200).end(); // ack primeiro

  // ...async: invalide o cache de `sub` e re-puxe GET /users/:sub (RFC-0002).
  await refreshProfileCache(sub);
});
```

> O SET **não** traz o novo valor de propósito (§1). Nunca confie no payload para dados — a verdade vem sempre do `GET /users/:sub`.

## 5. Garantias de entrega

- **At-least-once:** o IDP pode reentregar o mesmo evento (mesmo `jti`) — por isso o dedupe é obrigatório.
- **Retry + backoff + DLQ:** falhas (não-2xx / timeout) são reagendadas com backoff exponencial; após N tentativas o evento vai para dead-letter.
- **Circuit-breaker:** dead-letter recorrente **desativa** seu webhook (`webhookDisabledAt`) para não martelar um endpoint morto. Re-registrar a `webhookUrl` re-arma.
- **Cold start / offline:** não há replay histórico — ao voltar, seu TTL do Pull expira e o `GET /users/:sub` traz o estado atual. Eventos perdidos não causam dano permanente.

## 6. Último salto até o browser (seu, não do IDP)

Para o usuário ver "na hora", depois de re-puxar (§4.5) empurre ao browser:

- **SSE / WebSocket:** o backend notifica a aba viva daquele `sub` → o front invalida sua query (`queryClient.invalidateQueries(['profile', sub])`).
- **Refetch-on-focus / SWR:** sem canal persistente, revalide o perfil ao focar a aba (React Query/SWR já fazem) — chega perto de "na hora" com custo zero.

O IDP não participa deste salto — ele só garante que seu backend soube em segundos.

## 7. Checklist

- [ ] `webhookUrl` HTTPS registrada + scope `profile:read`.
- [ ] Verificação do SET via JWKS (RS256) + `iss`/`aud`.
- [ ] Dedupe por `jti` + ordering por `version`.
- [ ] Invalidação de cache + re-pull `GET /users/:sub`.
- [ ] `2xx` rápido; processamento async.
- [ ] (Opcional) empurrar ao browser via SSE/refetch.
