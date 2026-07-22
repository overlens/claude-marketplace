#!/usr/bin/env node
// inspect-token.mjs — diagnose an Overlens IDP JWT.
//
// Decodes the token WITHOUT trusting it, then fetches the live JWKS, matches the
// `kid`, verifies the RS256 signature, and checks iss / aud / exp. It is the first
// thing to run when a token "should be valid but isn't" — it tells you *which* of
// the many possible reasons it failed, instead of a generic "invalid signature".
//
// Zero dependencies: Node >= 18 (global fetch + crypto.createPublicKey from JWK).
//
// Usage:
//   node inspect-token.mjs <token>
//   echo "<token>" | node inspect-token.mjs
//   node inspect-token.mjs <token> --jwks https://idp.overlens.com.br/.well-known/jwks.json
//   node inspect-token.mjs <token> --iss https://idp.overlens.com.br --aud https://api.overlens.com.br
//
// Defaults match production. Override --jwks/--iss/--aud for staging or a custom audience.

import crypto from 'node:crypto';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const JWKS_URL = flag('--jwks', 'https://idp.overlens.com.br/.well-known/jwks.json');
const EXPECTED_ISS = flag('--iss', 'https://idp.overlens.com.br');
const EXPECTED_AUD = flag('--aud', 'https://api.overlens.com.br');

const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
const ok = (s) => `${C.green}✓${C.reset} ${s}`;
const bad = (s) => `${C.red}✗${C.reset} ${s}`;
const warn = (s) => `${C.yellow}⚠${C.reset} ${s}`;
const head = (s) => `\n${C.bold}${s}${C.reset}`;

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function decodeSegment(seg) {
  return JSON.parse(b64urlToBuf(seg).toString('utf8'));
}

async function readToken() {
  if (positional[0]) return positional[0].trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return '';
}

async function main() {
  const raw = await readToken();
  if (!raw) {
    console.error('Pass a JWT as an argument or via stdin. See header of this file for usage.');
    return 2;
  }
  // Tolerate accidental "Bearer " prefix and surrounding quotes.
  const token = raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
  const parts = token.split('.');
  if (parts.length !== 3) {
    console.log(bad(`Not a JWS: expected 3 dot-separated parts, got ${parts.length}.`));
    console.log(C.dim + 'A standard JWT has header.payload.signature. If you have 5 parts it is a JWE (encrypted) — the IDP does not issue those.' + C.reset);
    return 1;
  }

  let header, payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    console.log(bad('Header or payload is not valid base64url JSON — the token is corrupted or truncated (often a copy/paste cut it short).'));
    return 1;
  }

  console.log(head('Header'));
  console.log(JSON.stringify(header, null, 2));
  console.log(head('Payload'));
  console.log(JSON.stringify(payload, null, 2));

  console.log(head('Quick reads'));

  // --- algorithm confusion guard ---
  if (header.alg !== 'RS256') {
    console.log(bad(`alg is "${header.alg}", expected "RS256".`));
    if (String(header.alg).startsWith('HS')) {
      console.log(`  ${warn('Algorithm-confusion red flag.')} The IDP signs ONLY with RS256. An HS-signed token here means either a forged token (attacker used the public key as an HMAC secret) or a misconfigured issuer. A correct Resource Server pins algorithms:['RS256'] and rejects this outright.`);
    }
  } else {
    console.log(ok('alg = RS256'));
  }

  // --- user vs M2M ---
  const isM2M = !!payload.client_id && !payload.email;
  if (isM2M) {
    console.log(ok(`Token kind: M2M (service). client_id=${payload.client_id}, scope="${payload.scope ?? ''}"`));
    console.log(C.dim + '  Authorize this downstream by SCOPE, never by role — M2M tokens carry no role.' + C.reset);
  } else if (payload.email) {
    console.log(ok(`Token kind: USER. sub=${payload.sub}, role=${payload.role}, email=${payload.email}`));
  } else {
    console.log(warn('Token kind: UNKNOWN — has neither (client_id without email) nor (email). Payload does not match either Overlens shape.'));
  }

  // --- iss ---
  console.log(payload.iss === EXPECTED_ISS
    ? ok(`iss = ${payload.iss}`)
    : bad(`iss = ${payload.iss ?? '(absent)'} — expected ${EXPECTED_ISS}. A Resource Server pinning issuer will reject this. (Pass --iss to compare against a different expected issuer.)`));

  // --- aud ---
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud != null ? [payload.aud] : [];
  console.log(auds.includes(EXPECTED_AUD)
    ? ok(`aud includes ${EXPECTED_AUD}`)
    : bad(`aud = ${JSON.stringify(payload.aud)} — does not include ${EXPECTED_AUD}. If your API validates audience, this is why it 401s. (Pass --aud to match your service's audience.)`));

  // --- exp ---
  if (typeof payload.exp === 'number') {
    const now = Math.floor(Date.now() / 1000);
    const secs = payload.exp - now;
    const when = new Date(payload.exp * 1000).toISOString();
    if (secs <= 0) {
      console.log(bad(`exp = ${when} — EXPIRED ${-secs}s ago. User tokens live 15min, M2M 5min. Refresh / re-fetch.`));
    } else {
      console.log(ok(`exp = ${when} (valid for ${secs}s more)`));
    }
  } else {
    console.log(bad('exp is absent or non-numeric.'));
  }

  // --- signature verification against live JWKS ---
  console.log(head(`Signature (verifying against ${JWKS_URL})`));
  let jwks;
  try {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    jwks = await res.json();
  } catch (e) {
    console.log(warn(`Could not fetch JWKS (${e.message}). Skipping signature check. Verify the URL is reachable from here.`));
    return 1;
  }

  const keys = jwks.keys ?? [];
  console.log(C.dim + `  JWKS advertises kid(s): ${keys.map((k) => k.kid).join(', ') || '(none)'}` + C.reset);

  if (header.kid && !keys.some((k) => k.kid === header.kid)) {
    console.log(bad(`Token kid "${header.kid}" is NOT in the live JWKS.`));
    console.log(C.dim + '  Two usual causes:' + C.reset);
    console.log(C.dim + '   1. Stale JWKS cache on the Resource Server — it cached the set BEFORE a key rotation. Force a refresh (restart / clear cache); the IDP serves Cache-Control max-age=3600.' + C.reset);
    console.log(C.dim + '   2. The token was signed by a different/old key already retired from the set. If it is also expired, just get a fresh token.' + C.reset);
    return 1;
  }

  const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!jwk) {
    console.log(bad('No usable key in JWKS to verify against.'));
    return 1;
  }

  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signingInput = `${parts[0]}.${parts[1]}`;
    const valid = crypto.verify('RSA-SHA256', Buffer.from(signingInput), publicKey, b64urlToBuf(parts[2]));
    if (valid) {
      console.log(ok(`Signature VALID against kid "${jwk.kid}".`));
      console.log(C.dim + '  If your service still rejects it, the failure is NOT the signature — re-check iss/aud/exp/alg above and your validator config.' + C.reset);
    } else {
      console.log(bad(`Signature INVALID against kid "${jwk.kid}". The token body was altered after signing, or it was signed by a key that is not this one.`));
      return 1;
    }
  } catch (e) {
    console.log(bad(`Verification error: ${e.message}`));
    return 1;
  }
}

main().then((code) => { process.exitCode = code ?? 0; });
