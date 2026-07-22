# Validating the IDP token outside NestJS/Express

The NestJS templates and the `express-jwt-middleware.js` template cover the two most common cases. The contract is identical everywhere — only the glue changes. Port the same shape: **fetch + cache the JWKS public key → verify with `algorithms:['RS256']`, `issuer`, `audience` → discriminate user vs M2M → build a principal.**

> Canonical: `../../../references/docs/integration/backend.md`. If you use a generic OIDC library, also see `../../../references/docs/integration/oidc-discovery.md`.

---

## The universal discriminator

Every language reduces to this once the JWT is verified:

```
isM2M = (payload.client_id is present) AND (payload.email is absent)
```

- **user** → `sub` = userId, has `email` + `role` → authorize by **role**
- **service (M2M)** → `sub` = clientId, has `client_id` + `scope` (space-separated) → authorize by **scope**

| Claim | User | M2M |
|---|---|---|
| `sub` | userId (CUID2) | clientId |
| `email`, `name`, `role`, `email_verified` | present | **absent** |
| `client_id`, `scope` | **absent** | present |
| `exp` | iat + 900 (15min) | iat + 300 (5min) |

---

## Fastify (Node)

```ts
import fastify from 'fastify';
import jwt from '@fastify/jwt';
import buildGetJwks from 'get-jwks';

const getJwks = buildGetJwks({ max: 5, ttl: 3_600_000 });
const app = fastify();

await app.register(jwt, {
  decode: { complete: true },
  secret: (req, token, cb) => {
    const { kid, alg } = token.header;
    getJwks
      .getPublicKey({ kid, alg, domain: 'https://idp.overlens.com.br' })
      .then((key) => cb(null, key), cb);
  },
  verify: {
    algorithms: ['RS256'],
    allowedIss: 'https://idp.overlens.com.br',
    allowedAud: process.env.JWT_AUDIENCE,
  },
});

app.addHook('onRequest', async (req) => {
  await req.jwtVerify(); // 401 on failure; req.user gets the payload
});
```

Token comes from `Authorization: Bearer` by default. For a cookie fallback, register `@fastify/cookie` and pass a custom `formatUser` / extract the token from `req.cookies.access_token`.

---

## Hono (Node / edge)

`jwks-rsa` and `jose` both run on edge runtimes. With `jose`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL(process.env.JWKS_URL!)); // caches internally

export async function auth(c, next) {
  const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
  const cookie = c.req.cookie?.('access_token');
  const token = bearer ?? cookie;
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      algorithms: ['RS256'],
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
    });
    c.set('principal', toPrincipal(payload)); // toPrincipal: see discriminator above
    await next();
  } catch {
    return c.json({ error: 'invalid_token' }, 401);
  }
}
```

---

## Python — FastAPI

```python
# pip install pyjwt[crypto] cachetools
import jwt
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, Request

jwks_client = PyJWKClient(os.environ["JWKS_URL"], cache_keys=True, lifespan=3600)

def current_principal(request: Request):
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else request.cookies.get("access_token")
    if not token:
        raise HTTPException(401, "unauthorized")
    try:
        key = jwks_client.get_signing_key_from_jwt(token).key
        payload = jwt.decode(
            token, key,
            algorithms=["RS256"],                       # pin RS256
            issuer=os.environ["JWT_ISSUER"],
            audience=os.environ["JWT_AUDIENCE"],
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid_token")

    if payload.get("client_id") and not payload.get("email"):
        return {"kind": "service", "client_id": payload["client_id"],
                "scopes": payload.get("scope", "").split()}
    return {"kind": "user", "id": payload["sub"],
            "email": payload["email"], "role": payload["role"]}

# usage:  def handler(principal=Depends(current_principal)): ...
```

---

## Java — Spring Security (resource server)

`spring-boot-starter-oauth2-resource-server` consumes the JWKS automatically; point it at the issuer (it discovers `jwks_uri` via OIDC discovery) or the JWKS URL directly.

```yaml
# application.yml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://idp.overlens.com.br      # discovery resolves jwks_uri
          audiences: https://api.seuapp.overlens.com.br
```

Spring pins the algorithm to the JWKS key type (RS256) and validates `iss`/`exp` out of the box; add an `audience` validator (shown via the `audiences` property in recent versions, or a custom `OAuth2TokenValidator`). Map authorities from `scope` (services) and a custom `role` claim (users) with a `JwtAuthenticationConverter`.

---

## Auto-config via OIDC discovery (any language)

If your library speaks OIDC discovery, skip hardcoding URLs — point it at the issuer and let it resolve `jwks_uri`:

```bash
curl -s https://idp.overlens.com.br/.well-known/openid-configuration | jq '{issuer, jwks_uri}'
```

Libraries that do this: `openid-client`, `passport-openidconnect`, Auth.js/NextAuth, Spring Security OAuth, most language-native OIDC SDKs. See `../../../references/docs/integration/oidc-discovery.md` for per-library recipes and the IDP's OIDC-conformance gaps (no `nonce`, code flow only).

> One caveat: discovery only helps with *configuration*. The validation rules (pin RS256, check `aud`, cache the JWKS, discriminate user-vs-M2M) still apply exactly the same.
