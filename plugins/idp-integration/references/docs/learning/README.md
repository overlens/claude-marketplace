# Ensino & Capacitação — IDP + Accounts

> Material **conceitual** para entender os fundamentos por trás do IDP — útil tanto para
> quem entra no time quanto para integradores que querem entender o *porquê* antes do
> *como*. Nada aqui é runbook: os procedimentos executáveis vivem em
> [`../deploy/`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/README.md) e os contratos de integração em
> [`../integration/`](../integration/README.md).
>
> **Última atualização:** 2026-07-18

---

## Conteúdo

| Documento | O que ensina |
|---|---|
| [`jwks.md`](./jwks.md) | Por que RS256 (e não HS256), o que são JWKS e `kid`, o fluxo completo de verificação local, algorithm confusion e as regras de cache no Resource Server |
| [`key-rotation.md`](./key-rotation.md) | Por que rotacionar chaves, os três TTLs que ditam a timeline, rotação ingênua vs zero-downtime, e o estado real da implementação no IDP |

## Conceitos cobertos em outros lugares (leitura recomendada)

| Conceito | Onde |
|---|---|
| Os três modos de autenticação (OAuth code+PKCE, cookie-mode, M2M) e o modelo de tokens | [`../integration/overview.md`](../integration/overview.md) |
| Multi-sessão de refresh, grace window e logout por dispositivo — o *porquê* | ADRs [0010](https://github.com/overlens/identity-provider/blob/main/docs/adr/0010-multi-sessao-refresh.md) e [0011](https://github.com/overlens/identity-provider/blob/main/docs/adr/0011-logout-por-dispositivo.md) |
| Fronteira "perfil global × dado de app" e avatar por URL determinística | ADR [0007](https://github.com/overlens/identity-provider/blob/main/docs/adr/0007-idp-autoridade-perfil-global-avatar.md) / [RFC-0001](https://github.com/overlens/identity-provider/blob/main/docs/rfc/0001-idp-autoridade-de-perfil-e-avatar.md) |
| Por que `SameSite=Lax` e `maxAge` em milissegundos | ADRs [0003](https://github.com/overlens/identity-provider/blob/main/docs/adr/0003-samesite-lax.md) e [0005](https://github.com/overlens/identity-provider/blob/main/docs/adr/0005-maxage-cookies-milissegundos.md) |
| Push de eventos de perfil (SET/outbox) — o desenho | ADR [0009](https://github.com/overlens/identity-provider/blob/main/docs/adr/0009-push-eventos-de-perfil-set.md) / [RFC-0004](https://github.com/overlens/identity-provider/blob/main/docs/rfc/0004-push-eventos-de-perfil.md) |
