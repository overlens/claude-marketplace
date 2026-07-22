// express-jwt-middleware.js
//
// Plain Express (no NestJS). Validates an Overlens IDP access token locally
// against the cached JWKS public key, accepting Bearer header OR cookie
// `access_token`. Builds a discriminated principal (user vs service) on req.user.
//
//   npm i passport passport-jwt jwks-rsa cookie-parser
//
// Env: JWKS_URL, JWT_ISSUER, JWT_AUDIENCE (see jwt.strategy.ts header).

const express = require('express');
const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { passportJwtSecret } = require('jwks-rsa');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cookieParser()); // required for the cookie fallback below

passport.use(
  new JwtStrategy(
    {
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        cacheMaxAge: 3_600_000, // 1h
        jwksRequestsPerMinute: 5,
        jwksUri: process.env.JWKS_URL,
      }),
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(), // priority: Bearer
        (req) => req?.cookies?.access_token ?? null, // fallback: cookie
      ]),
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      algorithms: ['RS256'], // pin RS256 — never accept HS256
    },
    (payload, done) => {
      // M2M: client_id present, email absent. Otherwise treat as user.
      if (payload.client_id && !payload.email) {
        return done(null, {
          kind: 'service',
          clientId: payload.client_id,
          scopes: (payload.scope ?? '').split(' ').filter(Boolean),
        });
      }
      return done(null, {
        kind: 'user',
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      });
    },
  ),
);

app.use(passport.initialize());

const requireAuth = passport.authenticate('jwt', { session: false });

// Authorize a user by role.
function requireRole(role) {
  return (req, res, next) => {
    const p = req.user;
    if (p?.kind !== 'user' || p.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// Authorize a service by scope.
function requireScope(scope) {
  return (req, res, next) => {
    const p = req.user;
    if (p?.kind !== 'service' || !p.scopes.includes(scope)) {
      return res.status(403).json({ error: 'insufficient_scope' });
    }
    next();
  };
}

// Examples
app.get('/me', requireAuth, (req, res) => res.json({ principal: req.user }));
app.get('/admin', requireAuth, requireRole('ADMIN'), (req, res) => res.json({ ok: true }));
app.post('/fractals/debit', requireAuth, requireScope('fractals:debit'), (req, res) =>
  res.json({ ok: true }),
);

app.listen(3000);

module.exports = { requireAuth, requireRole, requireScope };
