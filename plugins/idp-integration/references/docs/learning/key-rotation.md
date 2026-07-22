# Rotação de chaves RS256 — conceito

> **Frente de ensino/capacitação** — por que e como rotacionar o par RSA, e como os
> caches envolvidos determinam a timeline. O passo a passo executável (comandos, envs,
> estado real da implementação) é o runbook [`../deploy/rsa-keys.md`](../deploy/rsa-keys.md).
> Fundamentos de RS256/JWKS/kid: [`jwks.md`](./jwks.md).
>
> **Última atualização:** 2026-07-18

---

## Por que rotacionar

Rotação é a troca periódica do par RSA (recomendado: a cada 90–180 dias, ou imediatamente
após suspeita de comprometimento). Limita a janela de utilidade de uma chave vazada e
exercita o procedimento antes de você precisar dele numa emergência.

## Os três relógios envolvidos

Toda a complexidade da rotação vem de três TTLs independentes:

| Relógio | Valor | Efeito na rotação |
|---|---|---|
| Access token (user) | 15 min | Tokens assinados com a chave antiga circulam por até 15 min após a troca |
| Access token (M2M) | 5 min | Idem, janela menor |
| Cache do JWKS nos Resource Servers | até 1 h (`Cache-Control: public, max-age=3600`) | Um RS pode demorar até 1 h para *ver* uma chave nova (ou esquecer a antiga) |

O `kid` no header de cada JWT é o que permite conviver com múltiplas chaves: o RS
seleciona no JWKS a chave certa por token. Libs como `jwks-rsa` ainda fazem *refresh
lazy*: ao encontrar um `kid` desconhecido, re-buscam o JWKS antes de rejeitar — o que na
prática encurta o atraso de propagação da chave **nova**.

## O problema da rotação ingênua

Trocar a chave e derrubar a antiga de uma vez invalida **imediatamente** todos os tokens
assinados com ela — usuários ativos veem `401` até o próximo silent refresh. Não é
catastrófico (refresh tokens são opacos e não dependem da chave; a sessão se recupera
sozinha em segundos), mas é um blip visível.

## Rotação zero-downtime (o desenho ideal)

```
Dia 0:       JWKS = [chave_v1]
             Todos os tokens: kid=v1

Dia 1:       Gerar chave_v2
             JWKS = [chave_v1, chave_v2]   ← expõe AMBAS
             IDP passa a ASSINAR com v2
             Tokens novos: kid=v2 · tokens velhos: kid=v1 (ainda verificáveis)

Dia 1+15min: Todos os tokens v1 expiraram (TTL 15 min)
             (margem prudente: ≥30 min; máxima cautela: 1 h — cache JWKS)

Depois:      JWKS = [chave_v2]              ← remove v1
             chave_v1 pode ser descartada
```

O risco residual da janela: um RS que reinicie **depois** da remoção da v1 e receba um
token v1 ainda não expirado o rejeitará. Daí a margem de 30–60 min antes de remover a
chave antiga.

## Estado atual no IDP Overlens

⚠️ O JWKS do IDP hoje expõe **uma única chave** (`RSA_PRIVATE_KEY`/`RSA_KID`) — o passo
"expor ambas" do desenho acima **ainda não é suportado** e exigiria mudança de código
(envs `*_NEXT` + array no `jwks.service`). A rotação disponível é a **troca direta**, que
aceita a janela de invalidação descrita em "rotação ingênua". Detalhes, passos e
implicações: [`../deploy/rsa-keys.md`](../deploy/rsa-keys.md) §4.

Consequência prática para Resource Servers: implemente o cache do JWKS com *refresh lazy
por `kid` desconhecido* (padrão do `jwks-rsa` — ver [`../integration/backend.md`](../integration/backend.md) §9).
Assim seu serviço tolera tanto a rotação atual quanto a futura multi-key sem mudanças.

## Rotação de emergência (chave comprometida)

Se a chave privada vazou, a janela de invalidação deixa de ser um problema e vira o
objetivo: troque imediatamente (`rsa-keys.md` §4.1) — todos os tokens assinados com a
chave vazada passam a ser rejeitados assim que os RS atualizam o JWKS. Combine com a
revogação de todas as sessões de refresh ([`../deploy/admin-runbook.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/admin-runbook.md) §9).
