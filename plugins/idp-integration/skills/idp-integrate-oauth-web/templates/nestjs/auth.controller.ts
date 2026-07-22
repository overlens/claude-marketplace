/**
 * NestJS controller for the OAuth login/callback/refresh/logout flow.
 *
 * Routes:
 *   GET  /auth/login         — start login flow (sets PKCE/state cookies, redirects to Accounts)
 *   GET  /auth/signup        — start signup flow (same, but redirects to /signup on Accounts)
 *   GET  /auth/callback      — handles the redirect back from Accounts, exchanges the code
 *   POST /auth/refresh       — silent refresh, rotates session cookies
 *   GET  /auth/logout        — OIDC RP-Initiated Logout: clears session cookies, redirects the
 *                              browser to the IDP end_session_endpoint (top-level navigation)
 *
 * Requires:
 *   - cookie-parser middleware in main.ts (`app.use(cookieParser())`)
 *   - @nestjs/config with the env vars from idp-client.service.ts
 *   - IdpClientService registered in the AuthModule
 */
import { randomBytes } from 'node:crypto';
import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce';
import { IdpClientService, IdpTokenError } from './idp-client.service';

const TEMP_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/auth/callback',
  // maxAge IN MILLISECONDS for Express/NestJS. 600s would set Max-Age=0 (cookie deleted).
  maxAge: 600_000,
};

const SESSION_TOKEN_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  // Set in handler from expires_in (also in ms).
};

const SESSION_REFRESH_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
};

interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: 'BASIC' | 'ADMIN' | 'SYSTEM';
  new_user?: true;
}

function decodeJwtPayload(jwt: string): JwtPayload {
  const [, b64] = jwt.split('.');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly idp: IdpClientService,
    private readonly config: ConfigService,
  ) {}

  @Get('login')
  startLogin(@Res() res: Response) {
    return this.startFlow('login', res);
  }

  @Get('signup')
  startSignup(@Res() res: Response) {
    return this.startFlow('signup', res);
  }

  private startFlow(mode: 'login' | 'signup', res: Response) {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = generateState();

    res.cookie('pkce_code_verifier', verifier, TEMP_COOKIE);
    res.cookie('oauth_state', state, TEMP_COOKIE);

    const accountsUrl = this.config.getOrThrow<string>('ACCOUNTS_URL');
    const clientId = this.config.getOrThrow<string>('IDP_CLIENT_ID');
    const redirectUri = this.config.getOrThrow<string>('IDP_REDIRECT_URI');

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'openid profile email',
    });

    return res.redirect(`${accountsUrl}/${mode}?${params.toString()}`);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!code || !state) {
      return res.redirect('/login?error=missing_params');
    }

    const savedState = req.cookies?.oauth_state as string | undefined;
    const verifier = req.cookies?.pkce_code_verifier as string | undefined;

    if (!savedState || savedState !== state) {
      return res.redirect('/login?error=invalid_state');
    }
    if (!verifier) {
      return res.redirect('/login?error=missing_verifier');
    }

    let tokens: Awaited<ReturnType<IdpClientService['exchangeCode']>>;
    try {
      tokens = await this.idp.exchangeCode(code, verifier);
    } catch (err) {
      if (err instanceof IdpTokenError) {
        console.error('IDP exchange failed', { status: err.status, body: err.body });
      } else {
        console.error('IDP exchange threw', err);
      }
      return res.redirect('/login?error=token_exchange_failed');
    }

    const payload = decodeJwtPayload(tokens.access_token);

    res.cookie('session_token', tokens.access_token, {
      ...SESSION_TOKEN_COOKIE,
      maxAge: tokens.expires_in * 1000, // server returns seconds; Express cookies need ms
    });
    res.cookie('session_refresh', tokens.refresh_token, SESSION_REFRESH_COOKIE);

    res.clearCookie('pkce_code_verifier', { path: '/auth/callback' });
    res.clearCookie('oauth_state', { path: '/auth/callback' });

    return res.redirect(payload.new_user ? '/onboarding/profile' : '/dashboard');
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res() res: Response) {
    const refreshToken = req.cookies?.session_refresh as string | undefined;
    if (!refreshToken) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'no_refresh_token' });
    }

    let tokens: Awaited<ReturnType<IdpClientService['refresh']>>;
    try {
      tokens = await this.idp.refresh(refreshToken);
    } catch {
      // Refresh failed → session is dead, clear both cookies so the user re-logs.
      res.clearCookie('session_token', { path: '/' });
      res.clearCookie('session_refresh', { path: '/auth' });
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'refresh_failed' });
    }

    res.cookie('session_token', tokens.access_token, {
      ...SESSION_TOKEN_COOKIE,
      maxAge: tokens.expires_in * 1000,
    });
    // CRITICAL: store the new refresh token, the old one is dead now.
    res.cookie('session_refresh', tokens.refresh_token, SESSION_REFRESH_COOKIE);
    return res.json({ ok: true });
  }

  // OIDC RP-Initiated Logout. Reach this via a TOP-LEVEL NAVIGATION (link / window.location),
  // never fetch/XHR — only a navigation carries the IDP's first-party cookies and lets the browser
  // honor the Set-Cookie clears. Clears the local BFF session, then redirects the browser to the
  // IDP end_session_endpoint, which nulls the server-side refresh code, clears the IDP SSO cookies
  // on .overlens.com.br, and 302-redirects to the registered post_logout_redirect_uri (state echoed
  // back). No per-token revocation: in-flight access tokens stay valid until they expire (<=15 min);
  // for hard revocation an admin calls POST /admin/users/:id/block.
  @Get('logout')
  logout(@Res() res: Response) {
    res.clearCookie('session_token', { path: '/' });
    res.clearCookie('session_refresh', { path: '/auth' });

    const idpBaseUrl =
      this.config.get<string>('IDP_BASE_URL') ?? 'https://idp.overlens.com.br';
    const params = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('IDP_CLIENT_ID'),
      // Must EXACT-MATCH a post_logout_redirect_uri registered for this client with the IDP.
      post_logout_redirect_uri: this.config.getOrThrow<string>(
        'POST_LOGOUT_REDIRECT_URI',
      ),
      state: randomBytes(16).toString('hex'),
    });
    return res.redirect(`${idpBaseUrl}/auth/logout?${params.toString()}`);
  }
}
