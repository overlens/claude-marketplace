/**
 * Express equivalent of the OAuth login/callback/refresh/logout flow.
 *
 * Usage:
 *   const cookieParser = require('cookie-parser');
 *   const { authRouter } = require('./auth.routes');
 *   app.use(cookieParser());
 *   app.use('/auth', authRouter);
 *
 * Requires Node 18+ for global fetch; on older Node use node-fetch.
 *
 * Cookie maxAge in Express is MILLISECONDS. The #1 footgun:
 *   res.cookie('x', v, { maxAge: 900 })  → sets Max-Age=0, cookie deleted immediately.
 *   res.cookie('x', v, { maxAge: 900_000 }) → 15 minutes, correct.
 */
'use strict';

const { Router } = require('express');
const { createHash, randomBytes } = require('node:crypto');

const ACCOUNTS_URL = process.env.ACCOUNTS_URL;
const IDP_BASE_URL = process.env.IDP_BASE_URL;
const IDP_CLIENT_ID = process.env.IDP_CLIENT_ID;
const IDP_CLIENT_SECRET = process.env.IDP_CLIENT_SECRET;
const IDP_REDIRECT_URI = process.env.IDP_REDIRECT_URI;
// Must EXACT-MATCH a post_logout_redirect_uri registered for this client with the IDP.
const POST_LOGOUT_REDIRECT_URI = process.env.POST_LOGOUT_REDIRECT_URI;

const TEMP_COOKIE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/auth/callback',
  maxAge: 600_000, // 10 min in ms
};

const SESSION_REFRESH_COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

function genVerifier() {
  return randomBytes(32).toString('base64url');
}
function genChallenge(v) {
  return createHash('sha256').update(v).digest('base64url');
}
function genState() {
  return randomBytes(32).toString('hex');
}

function decodeJwtPayload(jwt) {
  const [, b64] = jwt.split('.');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
}

async function exchangeOrRefresh(body) {
  const basic = Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${IDP_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`IDP token request failed: ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

const authRouter = Router();

function startFlow(mode) {
  return (req, res) => {
    const verifier = genVerifier();
    const challenge = genChallenge(verifier);
    const state = genState();

    res.cookie('pkce_code_verifier', verifier, TEMP_COOKIE);
    res.cookie('oauth_state', state, TEMP_COOKIE);

    const params = new URLSearchParams({
      client_id: IDP_CLIENT_ID,
      redirect_uri: IDP_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'openid profile email',
    });

    res.redirect(`${ACCOUNTS_URL}/${mode}?${params.toString()}`);
  };
}

authRouter.get('/login', startFlow('login'));
authRouter.get('/signup', startFlow('signup'));

authRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.redirect('/login?error=missing_params');
  }

  const savedState = req.cookies?.oauth_state;
  const verifier = req.cookies?.pkce_code_verifier;

  if (!savedState || savedState !== state) {
    return res.redirect('/login?error=invalid_state');
  }
  if (!verifier) {
    return res.redirect('/login?error=missing_verifier');
  }

  let tokens;
  try {
    tokens = await exchangeOrRefresh({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: IDP_REDIRECT_URI,
    });
  } catch (err) {
    console.error('IDP exchange failed', { status: err.status, body: err.body });
    return res.redirect('/login?error=token_exchange_failed');
  }

  const payload = decodeJwtPayload(tokens.access_token);

  res.cookie('session_token', tokens.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: tokens.expires_in * 1000, // server returns seconds; cookies need ms
  });
  res.cookie('session_refresh', tokens.refresh_token, SESSION_REFRESH_COOKIE_BASE);

  res.clearCookie('pkce_code_verifier', { path: '/auth/callback' });
  res.clearCookie('oauth_state', { path: '/auth/callback' });

  res.redirect(payload.new_user ? '/onboarding/profile' : '/dashboard');
});

authRouter.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.session_refresh;
  if (!refreshToken) {
    return res.status(401).json({ error: 'no_refresh_token' });
  }

  let tokens;
  try {
    tokens = await exchangeOrRefresh({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  } catch {
    res.clearCookie('session_token', { path: '/' });
    res.clearCookie('session_refresh', { path: '/auth' });
    return res.status(401).json({ error: 'refresh_failed' });
  }

  res.cookie('session_token', tokens.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: tokens.expires_in * 1000,
  });
  // Store the new refresh_token. The old one is invalidated server-side.
  res.cookie('session_refresh', tokens.refresh_token, SESSION_REFRESH_COOKIE_BASE);
  res.json({ ok: true });
});

// OIDC RP-Initiated Logout. The browser must reach this via a TOP-LEVEL NAVIGATION (e.g. a link or
// form GET, window.location), never fetch/XHR — only a navigation lets the browser send the IDP's
// first-party cookies and honor the Set-Cookie clears the IDP returns. This route clears the local
// BFF session, then redirects the browser to the IDP end_session_endpoint, which nulls the
// server-side refresh code, clears the IDP SSO cookies on .overlens.com.br, and 302-redirects to
// the registered post_logout_redirect_uri (with `state` echoed back).
//
// No per-token revocation: already-issued access tokens stay valid until they expire (<=15 min).
// For immediate hard revocation, an admin calls POST /admin/users/:id/block.
authRouter.get('/logout', (_req, res) => {
  res.clearCookie('session_token', { path: '/' });
  res.clearCookie('session_refresh', { path: '/auth' });

  const params = new URLSearchParams({
    client_id: IDP_CLIENT_ID,
    post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI, // must be registered with the IDP
    state: randomBytes(16).toString('hex'), // echoed back on the redirect
  });
  return res.redirect(`${IDP_BASE_URL}/auth/logout?${params.toString()}`);
});

module.exports = { authRouter };
