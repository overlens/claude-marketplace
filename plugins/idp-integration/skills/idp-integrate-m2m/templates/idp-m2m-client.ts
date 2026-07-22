/**
 * IdpM2MClient — obtains and caches an Overlens M2M access token.
 *
 * OAuth 2.0 client_credentials (RFC 6749 §4.4). No user, no refresh token, no cookies.
 * The token lives 5 minutes; this client caches it in memory and refetches at exp − 30s,
 * so you do NOT hit POST /auth/token on every outbound request.
 *
 * Works two ways:
 *   1. NestJS — register as a provider (see "NestJS wiring" at the bottom) and inject it.
 *   2. Plain Node — `new IdpM2MClient({ ... })` directly.
 *
 * Requires Node 18+ (global fetch). On older Node, `import { fetch } from 'undici'`.
 */

export interface IdpM2MClientOptions {
  /** e.g. https://idp.overlens.com.br */
  idpBaseUrl: string;
  /** the registered M2M client_id, e.g. 'fractals-service' */
  clientId: string;
  /** the client_secret from POST /admin/clients (keep in a secret manager) */
  clientSecret: string;
  /** scopes this service requests, e.g. ['fractals:debit', 'fractals:read'] */
  scopes: string[];
  /** seconds before exp to consider the token stale and refetch (default 30) */
  safetyMarginSeconds?: number;
}

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export class IdpM2MClient {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly safetyMargin: number;

  constructor(private readonly opts: IdpM2MClientOptions) {
    this.safetyMargin = opts.safetyMarginSeconds ?? 30;
  }

  /** Returns a valid Bearer token, fetching a fresh one only when the cache is stale. */
  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt - this.safetyMargin > now) {
      return this.cached.token;
    }
    // Collapse concurrent cache misses into a single fetch.
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Convenience: the headers to spread onto an outbound fetch to a Resource Server. */
  async authHeader(): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');

    const res = await fetch(`${this.opts.idpBaseUrl}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        // Omit `scope` entirely to receive all the client's allowedScopes.
        ...(this.opts.scopes.length ? { scope: this.opts.scopes.join(' ') } : {}),
      }),
    });

    if (!res.ok) {
      // Read the body for diagnostics, but never log the secret.
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`Overlens M2M token request failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as TokenResponse;
    const now = Math.floor(Date.now() / 1000);
    this.cached = { token: data.access_token, expiresAt: now + data.expires_in };
    return data.access_token;
  }
}

/* ───────────────────────────── Plain Node usage ─────────────────────────────

const idp = new IdpM2MClient({
  idpBaseUrl: process.env.IDP_BASE_URL!,
  clientId: process.env.IDP_M2M_CLIENT_ID!,
  clientSecret: process.env.IDP_M2M_CLIENT_SECRET!,
  scopes: (process.env.IDP_M2M_SCOPES ?? '').split(',').filter(Boolean),
});

await fetch(`${process.env.API_BASE_URL}/fractals/debit`, {
  method: 'POST',
  headers: { ...(await idp.authHeader()), 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, amount: 10 }),
});

──────────────────────────────── NestJS wiring ───────────────────────────────

// idp-m2m.module.ts
@Module({
  providers: [
    {
      provide: IdpM2MClient,
      useFactory: (config: ConfigService) =>
        new IdpM2MClient({
          idpBaseUrl: config.getOrThrow('IDP_BASE_URL'),
          clientId: config.getOrThrow('IDP_M2M_CLIENT_ID'),
          clientSecret: config.getOrThrow('IDP_M2M_CLIENT_SECRET'),
          scopes: config.getOrThrow<string>('IDP_M2M_SCOPES').split(',').filter(Boolean),
        }),
      inject: [ConfigService],
    },
  ],
  exports: [IdpM2MClient],
})
export class IdpM2MModule {}

// then inject IdpM2MClient anywhere and call `await this.idp.getToken()`.
───────────────────────────────────────────────────────────────────────────── */
