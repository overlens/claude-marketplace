/**
 * Wrapper around the IDP token endpoint. Keeps the HTTP details out of the controller.
 *
 * Place under `src/auth/idp-client.service.ts`. Register in the AuthModule providers.
 *
 * Why a service: the controller becomes a thin HTTP layer (read cookies, set cookies, redirect),
 * and the token exchange logic stays testable in isolation. Mocking IdpClientService is much
 * easier than mocking `fetch` directly in controller tests.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  id_token?: string;
}

@Injectable()
export class IdpClientService {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('IDP_BASE_URL');
    this.clientId = config.getOrThrow<string>('IDP_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>('IDP_CLIENT_SECRET');
    this.redirectUri = config.getOrThrow<string>('IDP_REDIRECT_URI');
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenSet> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(params),
    });

    if (!res.ok) {
      const body = await res.text();
      // Re-throw with structured detail; the controller converts to HTTP semantics.
      throw new IdpTokenError(res.status, body);
    }

    return (await res.json()) as TokenSet;
  }
}

export class IdpTokenError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`IDP token request failed: ${status}`);
  }
}
