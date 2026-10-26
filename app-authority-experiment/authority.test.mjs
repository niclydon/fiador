import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createAuthorityExperiment } from './authority.mjs';

const ORIGIN = 'https://experiment.example';
const APP_ID = '111111111111111111';
const OTHER_APP_ID = '222222222222222222';

function fixture({ meApplicationId = APP_ID, onExchange, onAuthorization } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  let sequence = 0;
  const calls = [];
  const entropy = (length) => Buffer.alloc(length, ++sequence);
  const fetchDiscord = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://discord.com/api/oauth2/token') {
      if (onExchange) return onExchange(url, options);
      return Response.json({ token_type: 'Bearer', access_token: 'synthetic-access', scope: 'identify' });
    }
    if (url === 'https://discord.com/api/v10/oauth2/@me') {
      if (onAuthorization) return onAuthorization(url, options);
      return Response.json({ application: { id: meApplicationId }, scopes: ['identify'] });
    }
    throw new Error('unexpected HTTP destination');
  };
  const experiment = createAuthorityExperiment({
    callbackOrigin: ORIGIN,
    fetchDiscord,
    now: () => clock,
    entropy,
  });
  async function signed(applicationId = APP_ID) {
    const challenge = experiment.issue({ walletAddress: account.address, applicationId });
    const signature = await account.signMessage({ message: challenge.message });
    const authorization = await experiment.acceptWalletSignature({ proofId: challenge.proofId, signature });
    return { challenge, authorization };
  }
  function callback(authorization, changes = {}) {
    const request = new URL(authorization.authorizationUrl);
    const url = new URL(authorization.callbackUri);
    url.searchParams.set('code', 'synthetic-authorization-code');
    url.searchParams.set('state', request.searchParams.get('state'));
    url.searchParams.set('iss', 'https://discord.com');
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    }
    return url.toString();
  }
  return {
    account,
    calls,
    experiment,
    signed,
    callback,
    advance: (milliseconds) => { clock += milliseconds; },
  };
}

test('exact signed app, unique callback, S256 code flow and one-use observation', async () => {
  const f = fixture();
  const first = await f.signed();
  const second = f.experiment.issue({ walletAddress: f.account.address, applicationId: APP_ID });
  assert.notEqual(first.challenge.callbackUri, second.callbackUri);
  assert.match(first.challenge.message, new RegExp(`Discord application ID: ${APP_ID}`));
  assert.match(first.challenge.message, /Nonce: [A-Za-z0-9_-]{43}/);
  assert.match(first.challenge.message, /Expires at: 2026-10-26T12:10:00.000Z/);
  assert.ok(first.challenge.message.includes(first.challenge.callbackUri));

  const auth = new URL(first.authorization.authorizationUrl);
  assert.equal(auth.origin, 'https://discord.com');
  assert.equal(auth.pathname, '/api/oauth2/authorize');
  assert.equal(auth.searchParams.get('client_id'), APP_ID);
  assert.equal(auth.searchParams.get('redirect_uri'), first.challenge.callbackUri);
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'identify');

  const callbackUrl = f.callback(first.authorization);
  const result = await f.experiment.complete({ callbackUrl });
  assert.deepEqual(result, {
    outcome: 'local_experiment_passed',
    wallet: f.account.address,
    applicationId: APP_ID,
    observedAt: '2026-10-26T12:00:00.000Z',
    proofId: first.challenge.proofId,
  });
  assert.equal(f.calls.length, 2);
  const form = new URLSearchParams(f.calls[0].options.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('client_id'), APP_ID);
  assert.equal(form.get('redirect_uri'), first.challenge.callbackUri);
  assert.equal(form.get('code'), 'synthetic-authorization-code');
  assert.equal(
    createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
    auth.searchParams.get('code_challenge'),
  );
  assert.equal(form.has('client_secret'), false);
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[1].options.headers.authorization, 'Bearer synthetic-access');
  await assert.rejects(f.experiment.complete({ callbackUrl }), /already used/);
  assert.equal(f.calls.length, 2);
});

test('wallet signature is required and must recover the claimed wallet', async () => {
  const f = fixture();
  const challenge = f.experiment.issue({ walletAddress: f.account.address, applicationId: APP_ID });
  await assert.rejects(f.experiment.complete({ callbackUrl: `${challenge.callbackUri}?code=x&state=y&iss=https%3A%2F%2Fdiscord.com` }), /wallet signature required/);
  const stranger = privateKeyToAccount(generatePrivateKey());
  const wrongSignature = await stranger.signMessage({ message: challenge.message });
  await assert.rejects(f.experiment.acceptWalletSignature({ proofId: challenge.proofId, signature: wrongSignature }), /does not match/);
  assert.equal(f.calls.length, 0);
});

test('state, issuer, callback URI and parameter shape fail before HTTP', async () => {
  const cases = [
    ['state', 'wrong', /state mismatch/],
    ['iss', null, /parameters incomplete/],
    ['iss', 'https://other.example', /issuer mismatch/],
  ];
  for (const [name, value, expected] of cases) {
    const f = fixture();
    const { authorization } = await f.signed();
    await assert.rejects(f.experiment.complete({ callbackUrl: f.callback(authorization, { [name]: value }) }), expected);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const { authorization } = await f.signed();
  const wrongOrigin = f.callback(authorization).replace(ORIGIN, 'https://elsewhere.example');
  await assert.rejects(f.experiment.complete({ callbackUrl: wrongOrigin }), /callback URI mismatch/);
  const extra = new URL(f.callback(authorization));
  extra.searchParams.append('state', 'duplicate');
  await assert.rejects(f.experiment.complete({ callbackUrl: extra.toString() }), /repeated callback parameter/);
  assert.equal(f.calls.length, 0);
});

test('Discord /oauth2/@me must name the exact target application', async () => {
  const f = fixture({ meApplicationId: OTHER_APP_ID });
  const { authorization } = await f.signed();
  const callbackUrl = f.callback(authorization);
  await assert.rejects(f.experiment.complete({ callbackUrl }), /another application/);
  await assert.rejects(f.experiment.complete({ callbackUrl }), /already used/);
  assert.equal(f.calls.length, 2);
});

test('expired or failed exchanges cannot be replayed', async () => {
  const expired = fixture();
  const { authorization } = await expired.signed();
  expired.advance(600_000);
  await assert.rejects(expired.experiment.complete({ callbackUrl: expired.callback(authorization) }), /expired/);
  assert.equal(expired.calls.length, 0);

  const failed = fixture({ onExchange: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  const proof = await failed.signed();
  const callbackUrl = failed.callback(proof.authorization);
  await assert.rejects(failed.experiment.complete({ callbackUrl }), /not successful JSON/);
  await assert.rejects(failed.experiment.complete({ callbackUrl }), /already used/);
  assert.equal(failed.calls.length, 1);
});

test('concurrent callback consumes before the first network await', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const f = fixture({ onExchange: async () => {
    await wait;
    return Response.json({ token_type: 'Bearer', access_token: 'synthetic-access' });
  } });
  const { authorization } = await f.signed();
  const callbackUrl = f.callback(authorization);
  const first = f.experiment.complete({ callbackUrl });
  await assert.rejects(f.experiment.complete({ callbackUrl }), /already used/);
  release();
  assert.equal((await first).outcome, 'local_experiment_passed');
  assert.equal(f.calls.length, 2);
});

test('rejects invalid app IDs, callback origins and missing transport', () => {
  const f = fixture();
  assert.throws(() => f.experiment.issue({ walletAddress: f.account.address, applicationId: '1&scope=bot' }), /exact decimal/);
  assert.throws(() => createAuthorityExperiment({ callbackOrigin: 'http://experiment.example', fetchDiscord: () => {} }), /HTTPS origin/);
  assert.throws(() => createAuthorityExperiment({ callbackOrigin: ORIGIN }), /injected Discord transport/);
});
