import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, recoverMessageAddress } from 'viem';

// This experiment is not imported by Fiador's production packages or routes.
const DISCORD_ISSUER = 'https://discord.com';
const AUTHORIZE_ENDPOINT = 'https://discord.com/api/oauth2/authorize';
const EXCHANGE_ENDPOINT = 'https://discord.com/api/oauth2/token';
const AUTHORIZATION_ENDPOINT = 'https://discord.com/api/v10/oauth2/@me';
const CALLBACK_PATH = '/app-authority-experiment/callback/';
const LIFETIME_MS = 10 * 60 * 1000;
const APPLICATION_ID = /^[1-9][0-9]{0,19}$/;

function fail(reason) {
  throw new Error(reason);
}

function requireCallbackOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value.replace(/\/$/, '')
  ) {
    fail('callback origin must be an exact HTTPS origin');
  }
  return url.origin;
}

function randomToken(entropy) {
  const bytes = entropy(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    fail('entropy source must return 32 bytes');
  }
  return bytes.toString('base64url');
}

function matchesSecret(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCallback(callbackUrl, origin) {
  const url = new URL(callbackUrl);
  if (url.origin !== origin || url.protocol !== 'https:' || url.hash || url.username || url.password) {
    fail('callback URI mismatch');
  }
  if (!url.pathname.startsWith(CALLBACK_PATH)) fail('callback URI mismatch');
  const proofId = url.pathname.slice(CALLBACK_PATH.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(proofId)) fail('callback URI mismatch');
  for (const name of url.searchParams.keys()) {
    if (!['code', 'state', 'iss'].includes(name) || url.searchParams.getAll(name).length !== 1) {
      fail('unexpected or repeated callback parameter');
    }
  }
  if ([...url.searchParams.keys()].length !== 3) fail('callback parameters incomplete');
  return { url, proofId };
}

async function responseJson(response) {
  if (!response?.ok || !response.headers?.get('content-type')?.toLowerCase().startsWith('application/json')) {
    fail('Discord response was not successful JSON');
  }
  // A production transport needs a streaming byte cap. This experiment only
  // accepts an injected transport and is never wired to a server route.
  const body = await response.text();
  if (body.length > 16_384) fail('Discord response too large');
  try {
    return JSON.parse(body);
  } catch {
    fail('Discord response was invalid JSON');
  }
}

export function createAuthorityExperiment({ callbackOrigin, fetchDiscord, now = Date.now, entropy = randomBytes }) {
  const origin = requireCallbackOrigin(callbackOrigin);
  if (typeof fetchDiscord !== 'function') fail('an injected Discord transport is required');
  const sessions = new Map();

  function getPending(proofId) {
    const session = sessions.get(proofId);
    if (!session || session.status === 'consumed') fail('challenge unavailable or already used');
    if (now() >= session.expiresAt) {
      session.status = 'consumed';
      fail('challenge expired');
    }
    return session;
  }

  function issue({ walletAddress, applicationId }) {
    if (!isAddress(walletAddress) || !APPLICATION_ID.test(applicationId)) {
      fail('wallet address and exact decimal application ID are required');
    }
    const proofId = randomToken(entropy);
    if (sessions.has(proofId)) fail('challenge collision');
    const expiresAt = now() + LIFETIME_MS;
    const callbackUri = `${origin}${CALLBACK_PATH}${proofId}`;
    const wallet = getAddress(walletAddress);
    const nonce = randomToken(entropy);
    const message = [
      'Fiador application-settings-control experiment',
      `Wallet: ${wallet}`,
      `Discord application ID: ${applicationId}`,
      `Callback URI: ${callbackUri}`,
      `Nonce: ${nonce}`,
      `Expires at: ${new Date(expiresAt).toISOString()}`,
      'This signature does not grant a Discord role or publish a verified claim.',
    ].join('\n');
    sessions.set(proofId, {
      wallet,
      applicationId,
      callbackUri,
      message,
      state: randomToken(entropy),
      verifier: randomToken(entropy),
      expiresAt,
      status: 'unsigned',
    });
    return { proofId, message, callbackUri, expiresAt: new Date(expiresAt).toISOString() };
  }

  async function acceptWalletSignature({ proofId, signature }) {
    const session = getPending(proofId);
    if (session.status !== 'unsigned') fail('wallet signature already accepted');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      fail('invalid EIP-191 signature');
    }
    let recovered;
    try {
      recovered = await recoverMessageAddress({ message: session.message, signature });
    } catch {
      fail('invalid EIP-191 signature');
    }
    if (getAddress(recovered) !== session.wallet) fail('wallet signature does not match');
    session.status = 'signed';
    const challenge = createHash('sha256').update(session.verifier).digest('base64url');
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', session.applicationId);
    url.searchParams.set('redirect_uri', session.callbackUri);
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', session.state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'consent');
    return { authorizationUrl: url.toString(), callbackUri: session.callbackUri };
  }

  async function complete({ callbackUrl }) {
    const { url, proofId } = parseCallback(callbackUrl, origin);
    const session = getPending(proofId);
    if (session.status !== 'signed') fail('wallet signature required');
    if (`${url.origin}${url.pathname}` !== session.callbackUri) fail('callback URI mismatch');
    if (!matchesSecret(url.searchParams.get('state'), session.state)) fail('OAuth state mismatch');
    if (url.searchParams.get('iss') !== DISCORD_ISSUER) fail('OAuth issuer mismatch');
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) fail('authorization code missing or oversized');

    // Consume before the first await so a concurrent callback cannot exchange
    // the same code. Failed exchanges also require a new challenge.
    session.status = 'consumed';
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: session.callbackUri,
      client_id: session.applicationId,
      code_verifier: session.verifier,
    });
    delete session.verifier;
    delete session.state;
    delete session.message;
    const exchange = await responseJson(await fetchDiscord(EXCHANGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'error',
    }));
    if (exchange?.token_type !== 'Bearer' || typeof exchange.access_token !== 'string' || !exchange.access_token) {
      fail('Discord returned no bearer access token');
    }
    // The access token is used once and never returned or stored. A refresh
    // token, if supplied, is ignored; this is not account linking.
    const authorization = await responseJson(await fetchDiscord(AUTHORIZATION_ENDPOINT, {
      method: 'GET',
      headers: { authorization: `Bearer ${exchange.access_token}` },
      redirect: 'error',
    }));
    if (authorization?.application?.id !== session.applicationId) {
      fail('Discord authorization belongs to another application');
    }
    if (!Array.isArray(authorization.scopes) || !authorization.scopes.includes('identify')) {
      fail('Discord authorization lacked the requested scope');
    }
    if (now() >= session.expiresAt) fail('challenge expired during Discord check');
    return {
      outcome: 'local_experiment_passed',
      wallet: session.wallet,
      applicationId: session.applicationId,
      observedAt: new Date(now()).toISOString(),
      proofId,
    };
  }

  return { issue, acceptWalletSignature, complete };
}
