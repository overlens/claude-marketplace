# The consuming side — validating & authorizing an M2M token

This is the **Resource Server** side: the API that *receives* the `Bearer` token your service sends. The token is a normal RS256 JWT signed by the IDP — same JWKS, same `iss`, same `aud` as a user token. The only thing different is **how you authorize it**: by `scope`, not by `role`.

> If your whole task is building this validation layer (not the M2M caller), the dedicated skill is `idp-validate-token` — it covers JWKS caching, multi-framework strategies, Bearer-vs-cookie extraction. This file is the M2M-specific slice: telling a service token apart from a user token and gating on scope.

> Canonical: `../../../references/docs/integration/backend.md` §3.

---

## 1. Discriminate user vs M2M

The presence/absence of identity claims is the discriminator. M2M tokens have `client_id` and `scope` but **no** `email`/`role`:

```ts
const isM2M = !!payload.client_id && !payload.email;
```

A typed principal makes downstream code safe:

```ts
type Principal =
  | { kind: 'user'; id: string; email: string; role: string }
  | { kind: 'service'; clientId: string; scopes: string[] };

function toPrincipal(payload: any): Principal {
  if (payload.client_id && !payload.email) {
    return {
      kind: 'service',
      clientId: payload.client_id,
      scopes: (payload.scope ?? '').split(' ').filter(Boolean),
    };
  }
  return { kind: 'user', id: payload.sub, email: payload.email, role: payload.role };
}
```

---

## 2. Passport JWT strategy (Node / NestJS)

Validates RS256 against the cached JWKS, then builds the principal:

```ts
import { passportJwtSecret } from 'jwks-rsa';
import { Strategy, ExtractJwt } from 'passport-jwt';

passport.use(new Strategy({
  secretOrKeyProvider: passportJwtSecret({
    jwksUri: 'https://idp.overlens.com.br/.well-known/jwks.json',
    cache: true,
    cacheMaxAge: 3_600_000, // 1h — JWKS only changes on manual key rotation
  }),
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  issuer: 'https://idp.overlens.com.br',
  audience: 'https://api.overlens.com.br',
  algorithms: ['RS256'], // pin RS256 — never accept HS256 (algorithm-confusion guard)
}, (payload, done) => done(null, toPrincipal(payload)));
```

---

## 3. Scope guard (NestJS)

The key rule: **a service is authorized by scope, never by role.** This guard also rejects user tokens on M2M-only endpoints by checking `kind === 'service'`.

```ts
@Injectable()
export class RequireScope implements CanActivate {
  constructor(private readonly required: string) {}

  canActivate(ctx: ExecutionContext): boolean {
    const principal = ctx.switchToHttp().getRequest().user as Principal;
    if (principal?.kind !== 'service') return false; // user tokens don't carry scopes
    return principal.scopes.includes(this.required);
  }
}

// usage
@Post('debit')
@UseGuards(JwtAuthGuard, new RequireScope('fractals:debit'))
async debit() { /* ... */ }
```

If an endpoint should accept *either* a user with the right role *or* a service with the right scope, branch on `principal.kind` inside one guard rather than forcing M2M through a role check.

---

## 4. Express equivalent

```js
const { expressjwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');

const checkJwt = expressjwt({
  secret: jwksRsa.expressJwtSecret({
    jwksUri: 'https://idp.overlens.com.br/.well-known/jwks.json',
    cache: true,
    cacheMaxAge: 3_600_000,
  }),
  issuer: 'https://idp.overlens.com.br',
  audience: 'https://api.overlens.com.br',
  algorithms: ['RS256'],
});

function requireScope(scope) {
  return (req, res, next) => {
    const p = req.auth; // decoded payload
    const isM2M = p.client_id && !p.email;
    if (!isM2M) return res.status(403).json({ error: 'service token required' });
    const scopes = (p.scope || '').split(' ');
    if (!scopes.includes(scope)) return res.status(403).json({ error: 'insufficient_scope' });
    next();
  };
}

app.post('/fractals/debit', checkJwt, requireScope('fractals:debit'), handler);
```

---

## 5. Gotchas on the consuming side

- **Don't gate M2M endpoints on `role`.** There is no `role` in a service token; the check fails closed and the service gets a confusing 403.
- **Pin `algorithms: ['RS256']`.** Accepting `HS256` opens an algorithm-confusion attack where the public JWKS key is abused as an HMAC secret. The IDP only ever issues RS256.
- **Validate `aud` explicitly.** A token minted for a different Resource Server (`aud`) should not be accepted just because the signature checks out.
- **Cache the JWKS (1h), don't fetch per request.** Only fetch on boot / cache miss. A request-time fetch to the IDP defeats the point of local validation. See `idp-debug-jwt` if you hit `kid not found` after a key rotation.
