# JWKS, RSA e autenticação assimétrica

> **Frente de ensino/capacitação** — material conceitual para qualquer dev (do time ou
> integrador) entender o modelo de assinatura do IDP. Não é runbook.
>
> **Relacionados:**
> - Conceito de rotação de chaves: [`key-rotation.md`](./key-rotation.md)
> - Runbook operacional (gerar/configurar/rotacionar): [`../deploy/rsa-keys.md`](../deploy/rsa-keys.md)
> - OIDC Discovery (consumido pelas mesmas libs): [`../integration/oidc-discovery.md`](../integration/oidc-discovery.md)
> - Validação de token no Resource Server (código pronto): [`../integration/backend.md`](../integration/backend.md)
>
> **Última atualização:** 2026-07-18

---

## O problema que o RS256 resolve

No modelo simétrico (HS256), todos os serviços compartilham o mesmo `JWT_SECRET` para
verificar tokens. Se **qualquer** serviço for comprometido, o atacante pode **forjar
tokens** para todos os outros.

No modelo assimétrico (RS256), existe um par de chaves:

- **Chave privada** → só o IDP tem. **Assina** tokens.
- **Chave pública** → qualquer serviço pode ter. Apenas **verifica** tokens.

Um atacante que compromete um Resource Server obtém apenas a chave pública — inútil para
forjar tokens. Por isso o HS256 é proibido por design no IDP (ADR-0001).

## RSA_PRIVATE_KEY

A chave privada RSA 2048 vive **exclusivamente no IDP**, como env var. O formato exigido
pelo app é **PKCS8 serializado em base64 single-line** (`-----BEGIN PRIVATE KEY-----` após
decodificar — não confundir com PKCS1, `BEGIN RSA PRIVATE KEY`, que não funciona).

Comandos de geração e verificação: [`../deploy/rsa-keys.md`](../deploy/rsa-keys.md) §1–§2.

**Regras críticas:**

- Nunca commitar no git (`.gitignore`, secrets do Railway)
- Nunca logar (Sentry, Pino) — nem parcialmente
- Nunca passar para outro serviço

## RSA_KID (Key ID)

Identificador único da chave. Serve para **suportar múltiplas chaves simultaneamente**
durante uma rotação: o Resource Server lê o `kid` do header do token, busca no JWKS a
chave com aquele ID e verifica com ela.

```json
// Header de um JWT assinado pelo IDP
{ "alg": "RS256", "typ": "JWT", "kid": "e9e594c8f37e…" }
```

Neste projeto o `kid` é o **SHA-256 (hex) da chave pública em formato DER** — estável
entre restarts e derivado deterministicamente da chave (não é um nome arbitrário).

## JWKS (JSON Web Key Set)

O endpoint público `GET /.well-known/jwks.json` expõe a **chave pública** em formato
padronizado (RFC 7517):

```json
{
  "keys": [
    {
      "kty": "RSA",       // tipo
      "use": "sig",       // uso: assinatura
      "alg": "RS256",
      "kid": "e9e594…",   // identificador
      "n": "0Z3VS5JJ…",   // módulo RSA (base64url) — parte pública
      "e": "AQAB"         // expoente público
    }
  ]
}
```

**Por que `keys` (plural)?** O formato suporta rotação com múltiplas chaves simultâneas.
(No IDP, hoje, o array carrega **uma** chave — o suporte multi-key é evolução planejada;
ver [`key-rotation.md`](./key-rotation.md).)

O campo `d` (expoente privado) **jamais** aparece no JWKS.

## Fluxo completo de autenticação

```
┌─────────┐         ┌─────────────┐         ┌───────────────────┐
│ Browser │         │     IDP     │         │  Resource Server  │
└────┬────┘         └──────┬──────┘         └────────┬──────────┘
     │  POST /login        │                          │
     │  {email, password}  │                          │
     │────────────────────>│ bcrypt.compare()         │
     │                     │ sign(payload, PRIVATE_KEY)
     │<────────────────────│ alg=RS256, kid=…         │
     │  Set-Cookie:        │                          │
     │  access_token=<jwt> │                          │
     │                     │                          │
     │  GET /api/lessons   │                          │
     │  Cookie: access_token=<jwt>                    │
     │───────────────────────────────────────────────>│
     │                     │  (startup: fetch JWKS)   │
     │                     │<─────────────────────────│
     │                     │─────────────────────────>│
     │                     │                          │ jwt.verify(token, publicKey)
     │                     │                          │ valida: alg, exp, iss, aud
     │<───────────────────────────────────────────────│
     │  200 OK + dados     │                          │
```

**O Resource Server nunca chama o IDP por request** — cacheia a chave pública e verifica
localmente. É isso que torna o modelo escalável.

## Prevenção de vazamentos e ataques

### 1. Chave privada nos logs

```typescript
// NUNCA:
this.logger.log({ privateKey: process.env.RSA_PRIVATE_KEY }) // vaza no log
throw new Error(`Key error: ${this.privateKey}`)              // vaza em stack trace
res.json({ debug: { key: this.privateKey } })                 // vaza na resposta

// SEMPRE: carregar uma vez no módulo, nunca re-expor
const privateKey = createPrivateKey(process.env.RSA_PRIVATE_KEY)
```

### 2. Validação completa no Resource Server

Validar **todos** estes campos, não só a assinatura:

```typescript
jwt.verify(token, publicKey, {
  algorithms: ['RS256'],                    // rejeita HS256 explicitamente
  issuer: 'https://idp.overlens.com.br',    // rejeita tokens de outro emissor
  audience: 'https://api.overlens.com.br',  // rejeita tokens de outro serviço
})
// exp é verificado automaticamente
```

### 3. Algorithm Confusion Attack

O ataque clássico: o atacante pega a **chave pública** (que é pública) e a usa como secret
HS256, forjando um token com `alg: HS256`. Se o servidor aceitar ambos os algoritmos, o
token forjado passa.

**Solução:** `algorithms: ['RS256']` — nunca `['RS256', 'HS256']`.

### 4. Cache do JWKS no Resource Server

```typescript
// Errado: fetch a cada request (lento + vetor de DoS no IDP)
// Errado: nunca atualizar (não acompanha rotação de chave)

// Correto: cache TTL 1h + refresh lazy quando o kid não for encontrado
const jwksClient = jwksRsa({
  jwksUri: 'https://idp.overlens.com.br/.well-known/jwks.json',
  cache: true,
  cacheMaxAge: 3_600_000, // 1h — alinhado ao Cache-Control do endpoint
  rateLimit: true,        // evita thundering herd
})
```

## Resumo: quem sabe o quê

| Componente | Conhece | Não conhece |
|---|---|---|
| IDP | `RSA_PRIVATE_KEY`, `RSA_KID` | — |
| JWKS endpoint | chave pública (`n`, `e`, `kid`) | chave privada |
| Resource Server | chave pública (via JWKS) | chave privada |
| Client M2M | seu próprio `client_secret` (+ chave pública, se validar tokens) | chave privada do IDP |
| Browser | o JWT (opaco — não precisa decodificar) | qualquer chave |

Propriedade fundamental: comprometer o **banco** do IDP não expõe a chave privada nem
tokens utilizáveis — as sessões de refresh são armazenadas como `sha256(token)`
(ADR-0010). Comprometer um **Resource Server** expõe só a chave pública. A chave privada
existe apenas na memória do processo IDP e na env var do Railway.

## Fluxos suportados pelo mesmo JWKS

- **User JWTs** (fluxo OAuth e modo cookie) — TTL 15 min.
- **M2M JWTs** (`client_credentials`) — TTL 5 min, `sub = clientId`, sem `email`/`role`.
  Ver [`../integration/m2m.md`](../integration/m2m.md).
- **SETs do Push de eventos de perfil** (webhook — RFC-0004) — mesmo `kid`/chave.
- **`GET /auth/userinfo`** — mesmo Bearer, mesma chave.
