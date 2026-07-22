/**
 * Resource Server conformance — drop-in (Overlens IDP, RFC-0005 / T5 RS flavor).
 *
 * Proves your token-validation layer honors the Overlens contract: valid tokens
 * accepted, and every invalid one (expired, wrong aud/iss, HS256/alg:none,
 * unknown kid, bad signature, insufficient scope) rejected — offline, no Docker,
 * no network, no real IDP.
 *
 * Works as-is in Jest OR Vitest. Run: `pnpm test`.
 *
 * The reference `verifyToken` below uses `jose` against the TEST JWKS. Replace
 * its body with YOUR real validator (NestJS guard, Express middleware, etc.)
 * pointed at the test environment — see references/resource-server.md.
 */
import {
  getJwks,
  JWT_AUDIENCE_DEFAULT,
  JWT_ISSUER_DEFAULT,
} from '@overlens/idp-testing';
import { runResourceServerConformance } from '@overlens/idp-testing/conformance';
import { createLocalJWKSet, jwtVerify } from 'jose';

// 1) Point your validator at the TEST environment: the kit mints tokens with the
//    test keypair and these defaults. Verify against the test JWKS + iss + aud.
const TEST_JWKS = createLocalJWKSet(getJwks() as Parameters<typeof createLocalJWKSet>[0]);

async function verifyToken(token: string): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, TEST_JWKS, {
    algorithms: ['RS256'], // pin RS256 — blocks HS256 / alg:none confusion
    issuer: JWT_ISSUER_DEFAULT,
    audience: JWT_AUDIENCE_DEFAULT[0],
  });
  return payload;
}

// 2) Wrap your validation in the adapter the kit drives.
runResourceServerConformance(
  {
    verifyBearer: async (token) => {
      try {
        const p = await verifyToken(token);
        return { ok: true, principal: { sub: p.sub as string, email: p.email as string } };
      } catch {
        return { ok: false, status: 401 };
      }
    },

    // OPTIONAL — provide if your API also reads the token from the `access_token`
    // cookie (the Overlens AuthGuard accepts both). Same validation, different
    // transport.
    verifyCookie: async (token) => {
      try {
        const p = await verifyToken(token);
        return { ok: true, principal: { sub: p.sub as string, email: p.email as string } };
      } catch {
        return { ok: false, status: 401 };
      }
    },

    // OPTIONAL — provide to exercise the M2M/scope cases (insufficient_scope → 403
    // and the user-vs-M2M distinction). Models a scope-protected endpoint.
    verifyScopedM2M: async (token, requiredScope) => {
      try {
        const p = await verifyToken(token);
        // A user token has no client_id/scope — reject it on the M2M path.
        if (typeof p.client_id !== 'string' || typeof p.scope !== 'string') {
          return { ok: false, status: 401 };
        }
        const scopes = (p.scope as string).split(' ').filter(Boolean);
        if (!scopes.includes(requiredScope)) return { ok: false, status: 403 };
        return { ok: true, principal: { sub: p.sub as string, clientId: p.client_id, scopes } };
      } catch {
        return { ok: false, status: 401 };
      }
    },
  },
  { requiredScope: 'idp:test', m2mClientId: 'test-m2m-service' },
);
