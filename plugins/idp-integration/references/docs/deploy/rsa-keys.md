# Chaves RSA (RS256) — geração e rotação

> **Público:** time IDP + Accounts (DevOps/engenharia).
> Runbook operacional das envs `RSA_PRIVATE_KEY` e `RSA_KID`. O **conceito** (por que RS256,
> o que é JWKS/kid, como a rotação funciona) está em [`../learning/jwks.md`](../learning/jwks.md)
> e [`../learning/key-rotation.md`](../learning/key-rotation.md).
>
> **Última atualização:** 2026-07-18

---

## 1. Geração do par de chaves

Execute **localmente, em máquina segura**. A chave privada nunca entra no repositório
(`*.pem`/`*.key` estão no `.gitignore`).

> ⚠️ Gere o arquivo `private.pem` **uma vez** e derive os dois valores dele. Rodar
> `openssl genrsa` duas vezes produz chaves diferentes — e um `RSA_KID` que não
> corresponde à `RSA_PRIVATE_KEY` (o Resource Server passa a rejeitar todos os tokens
> com `kid not found`).

```bash
# 1. Chave privada base (NÃO commitar; apague ao final)
openssl genrsa -out private.pem 2048

# 2. RSA_PRIVATE_KEY = PKCS8 em base64 single-line
openssl pkcs8 -topk8 -nocrypt -in private.pem | base64 -w0     # Linux
openssl pkcs8 -topk8 -nocrypt -in private.pem | base64         # macOS (whitespace final é tolerado)

# 3. RSA_KID = SHA-256 hex do DER da chave pública (64 chars; determinístico por chave)
openssl rsa -in private.pem -pubout -outform DER | openssl dgst -sha256 -hex | awk '{print $2}'

# 4. Limpeza
rm private.pem
```

### Variante Windows (sem OpenSSL local — via Docker)

```bash
docker run -it --rm ubuntu
# dentro do container:
apt-get update && apt-get install -y openssl
openssl genrsa -out private.pem 2048
openssl pkcs8 -topk8 -nocrypt -in private.pem | base64 -w0                                      # → RSA_PRIVATE_KEY
openssl rsa -in private.pem -pubout -outform DER | openssl dgst -sha256 -hex | awk '{print $2}' # → RSA_KID
exit   # --rm descarta o container e o private.pem junto
```

> Copie os **dois** valores antes de sair — com `--rm`, o `private.pem` desaparece com o container.

## 2. Verificar round-trip (antes de configurar)

```bash
node -e "
const b64 = '<RSA_PRIVATE_KEY>';
const pem = Buffer.from(b64, 'base64').toString('utf-8');
console.log('Round-trip OK:', pem.startsWith('-----BEGIN PRIVATE KEY-----'));
"
```

Se imprimir `false` (ou o PEM começar com `-----BEGIN RSA PRIVATE KEY-----`), o formato está
errado: o app exige **PKCS8** (`BEGIN PRIVATE KEY`), não PKCS1 (`BEGIN RSA PRIVATE KEY`).

## 3. Configurar

| Ambiente | Onde |
|---|---|
| Produção | Railway → serviço do IDP → **Variables** → `RSA_PRIVATE_KEY` + `RSA_KID` (redeploy automático) |
| Dev local | Infisical, env `dev`, path `/idp` — ver [`infisical.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/infisical.md) |
| Testes/container/sandbox | Keypair de **teste** versionado (`apps/idp/docker/test.env`, público — RFC-0005/T1). Nunca use o keypair de teste fora de teste |

### Verificar após deploy

```bash
curl -s https://idp.overlens.com.br/.well-known/jwks.json | jq '.keys[0] | keys'
# Esperado: ["alg","e","kid","kty","n","use"]

curl -s https://idp.overlens.com.br/.well-known/jwks.json | jq -r '.keys[0].kid'
# Esperado: o RSA_KID configurado
```

(Requests prontos para REST client: [`JWKS-validation.http`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/JWKS-validation.http).)

## 4. Rotação de chave — estado real e procedimento

> **Importante — o que está implementado hoje:** o `JwksModule` lê **um único par**
> (`RSA_PRIVATE_KEY`/`RSA_KID`) e o JWKS expõe **uma única chave**. A rotação
> "zero-downtime" com duas chaves simultâneas no JWKS (descrita em
> [`../learning/key-rotation.md`](../learning/key-rotation.md)) **exige mudança de
> código** (aceitar `RSA_PRIVATE_KEY_NEXT`/`RSA_KID_NEXT` e servir as duas no JWKS) —
> ainda não foi implementada. Não trate docs antigos que a descreviam como runbook
> pronto como verdade.

### 4.1 Procedimento disponível hoje (com janela de invalidação)

Trocar `RSA_PRIVATE_KEY` + `RSA_KID` diretamente. Consequências:

1. Tokens novos saem assinados com a chave nova (`kid` novo).
2. Tokens antigos em circulação (≤ 15 min de vida) passam a ser **rejeitados** pelos
   Resource Servers assim que eles atualizarem o JWKS — usuários ativos podem ver `401`
   até o próximo silent refresh (que emite token novo). Sessões de refresh **não** são
   afetadas (são opacas, não dependem da chave).
3. Resource Servers com cache de JWKS (TTL 1h — `Cache-Control: public, max-age=3600`)
   podem rejeitar os tokens **novos** (`kid` desconhecido) até o cache expirar ou o RS
   fazer refresh lazy por `kid` não encontrado (comportamento padrão do `jwks-rsa`).

**Passos:**

1. Gerar o par novo (§1) e validar round-trip (§2).
2. Comunicar os times dos Resource Servers (janela de possível `401`).
3. Trocar `RSA_PRIVATE_KEY` + `RSA_KID` no Railway (redeploy automático).
4. Validar (§3) e monitorar erros de validação nos RS por ~1h (TTL do cache JWKS).

Use em: suspeita de comprometimento da chave (aí a janela de erro é aceitável — e
desejada: invalida tudo imediatamente) ou rotação programada em horário de baixo uso.

### 4.2 Rotação zero-downtime (pendente de implementação)

Para eliminar a janela do §4.1, é preciso implementar o suporte a múltiplas chaves:

- envs novas `RSA_PRIVATE_KEY_NEXT`/`RSA_KID_NEXT` (ou equivalente);
- `jwks.service.ts` servindo `{ keys: [atual, próxima] }`;
- troca de assinatura para a chave nova mantendo a antiga publicada por ≥ 30 min
  (TTL do access token 15 min + margem) e idealmente 1h (TTL do cache JWKS).

A timeline completa e o racional estão em [`../learning/key-rotation.md`](../learning/key-rotation.md).
Quando isso for implementado, atualize esta seção com o runbook definitivo.

## 5. Regras de segurança

- A chave privada **nunca** aparece em logs, respostas HTTP ou Sentry (ver
  [`security-hardening.md`](https://github.com/overlens/identity-provider/blob/main/docs/deploy/security-hardening.md)).
- Em produção a chave existe apenas como env var no Railway e na memória do processo.
- A chave pública é derivada da privada em runtime — `RSA_PUBLIC_KEY` **não existe** como env.
- Rotação recomendada: a cada 90–180 dias, ou imediatamente após suspeita de vazamento.
