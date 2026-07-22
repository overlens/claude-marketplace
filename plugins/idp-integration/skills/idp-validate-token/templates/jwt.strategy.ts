// src/auth/jwt.strategy.ts
//
// Validates an Overlens IDP access token (RS256) on every authenticated
// request, WITHOUT calling the IDP. The public key is fetched once from the
// JWKS endpoint and cached for 1h (aligned with the IDP's Cache-Control).
//
// Token transport: Bearer header has priority, cookie `access_token` is the
// fallback — accept BOTH so the same Resource Server serves SPAs (cookie mode)
// and mobile/M2M callers (Bearer). This mirrors the IDP's own AuthGuard.
//
// Required env vars:
//   JWKS_URL=https://idp.overlens.com.br/.well-known/jwks.json
//   JWT_ISSUER=https://idp.overlens.com.br
//   JWT_AUDIENCE=https://api.seuapp.overlens.com.br   (must match what the IDP mints)

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';

// The discriminated principal every downstream guard / handler consumes.
// A user has identity (email/role); a service (M2M) has client_id/scope.
// NOTE: `role` is kept here because the token still carries it, but it is
// @deprecated as an authorization source (RFC-0003 / ADR-8) — authorize users
// by a role local to your app (mapped from `sub`), not by this claim.
export type Principal =
  | { kind: 'user'; id: string; email: string; role: 'BASIC' | 'ADMIN' | 'SYSTEM' }
  | { kind: 'service'; clientId: string; scopes: string[] };

interface CommonJwt {
  sub: string;
  iss: string;
  aud: string[];
  iat: number;
  exp: number;
}
interface UserJwt extends CommonJwt {
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  email_verified: boolean;
  new_user?: true;
}
interface M2MJwt extends CommonJwt {
  client_id: string;
  scope: string;
}
type Payload = UserJwt | M2MJwt;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // jwks-rsa fetches + caches the RS256 public key. cache + rateLimit
      // prevent a thundering herd of JWKS fetches on unknown `kid`s.
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        cacheMaxAge: 3_600_000, // 1h — aligned with the IDP's Cache-Control
        jwksRequestsPerMinute: 5,
        jwksUri: process.env.JWKS_URL!,
      }),
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(), // priority: Bearer
        (req) => (req?.cookies?.access_token ?? null) as string, // fallback: cookie
      ]),
      issuer: process.env.JWT_ISSUER, // reject tokens from another issuer
      audience: process.env.JWT_AUDIENCE, // reject tokens minted for another API
      algorithms: ['RS256'], // pin RS256 — NEVER accept HS256 (algorithm-confusion guard)
    });
  }

  // passport-jwt has already verified signature, exp, iss, aud, and alg by the
  // time this runs. Here we only shape the payload into a typed Principal.
  validate(payload: Payload): Principal {
    // M2M: has client_id, lacks email. This is the canonical discriminator.
    if ('client_id' in payload && !('email' in payload)) {
      return {
        kind: 'service',
        clientId: payload.client_id,
        scopes: (payload.scope ?? '').split(' ').filter(Boolean),
      };
    }
    // User: has email + role.
    if ('email' in payload && payload.role) {
      return {
        kind: 'user',
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
    }
    throw new UnauthorizedException('Token inválido');
  }
}
