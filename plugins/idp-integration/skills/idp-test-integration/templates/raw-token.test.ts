/**
 * Raw toolkit — custom assertions (Overlens IDP, RFC-0005 / T2 + T4).
 *
 * When the conformance kit's cases aren't enough, drive the primitives directly:
 * mint valid tokens, forge negative ones, serve a mock JWKS, or script a full
 * mock IDP. Offline, deterministic. Jest OR Vitest.
 */
import {
  expiredToken,
  getJwks,
  hs256Token,
  JWT_AUDIENCE_DEFAULT,
  JWT_ISSUER_DEFAULT,
  mintM2MToken,
  mintToken,
  startJwksServer,
  unknownKidToken,
  wrongAudToken,
} from '@overlens/idp-testing';
import { startMockIdp } from '@overlens/idp-testing/mock-idp';
import { getTestClient, getTestUser } from '@overlens/idp-testing/fixtures';

describe('Resource Server — raw token assertions', () => {
  it('accepts a freshly minted user token', async () => {
    const token = await mintToken({ sub: 'u1', email: 'u1@example.test' });
    // → feed `token` to YOUR validator and assert it accepts; assert req.user.sub === 'u1'.
    expect(typeof token).toBe('string');
  });

  it('rejects each negative case', async () => {
    const bad = await Promise.all([
      expiredToken(),
      wrongAudToken(),
      unknownKidToken(),
      hs256Token(), // algorithm confusion
    ]);
    // → feed each to YOUR validator and assert it REJECTS (401).
    expect(bad).toHaveLength(4);
  });

  it('M2M token without the required scope must 403', async () => {
    const token = await mintM2MToken({ clientId: 'svc', scope: 'some:other' });
    // → feed to YOUR scope guard requiring e.g. "idp:test" and assert 403.
    expect(typeof token).toBe('string');
  });

  it('serves a mock JWKS as object and as URL', async () => {
    const jwks = getJwks(); // { keys: [{ kty, use, alg, n, e, kid }] }
    expect(jwks.keys[0].alg).toBe('RS256');

    const server = await startJwksServer(); // for libs that need a jwksUri (e.g. jwks-rsa)
    try {
      // point your validator at `server.jwksUri`
      expect(server.jwksUri).toContain('/.well-known/jwks.json');
    } finally {
      await server.close();
    }
  });

  it('mints against the contract iss/aud', () => {
    expect(JWT_ISSUER_DEFAULT).toBeTruthy();
    expect(Array.isArray(JWT_AUDIENCE_DEFAULT)).toBe(true);
  });
});

describe('Client / BFF — scripted mock IDP', () => {
  it('runs the full code flow and can force negatives', async () => {
    const client = getTestClient('test-web-bff');
    const user = getTestUser('ana.active@example.test');
    const mock = await startMockIdp();
    try {
      // mock.url / mock.issuer / mock.jwksUri are ready; point YOUR client at mock.url.
      expect(mock.jwksUri).toBe(`${mock.url}/.well-known/jwks.json`);
      expect(client.clientId).toBe('test-web-bff');
      expect(user.email).toBe('ana.active@example.test');

      // Force a negative deterministically (live, mutable scripts):
      mock.scripts.failNextToken = { error: 'invalid_grant', status: 400 };
      // → your next token exchange should be handled as a failed callback (no session).
    } finally {
      await mock.stop();
    }
  });
});
