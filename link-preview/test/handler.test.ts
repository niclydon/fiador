import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AGENTBOOK_CONTRACT,
  attestationShortId,
  canonicalAttestationBytes,
  hashHumanId,
  truncateAddress,
} from '@fiador/verify';
import type {
  SignedAttestation,
  Verifier,
  VerifyResult,
} from '@fiador/verify';
import { handleRequest } from '../src/handler.js';
import type { LinkPreviewDeps } from '../src/deps.js';
import type { RegistryEntry } from '../src/registry.js';

// Fixture secrets/identifiers: synthetic only. The deep-scan tests assert
// neither ever appears in any response body — the full humanId is internal
// to the verify core's result shape, and the full wallet address is only
// ever rendered truncated.
const WALLET = ('0x' + 'cd'.repeat(20)) as `0x${string}`;
const HUMAN_ID = '0x' + '11'.repeat(32);
const APP_ID = '123456789012345678';
const ATT_URL = 'https://bots.example.com/attestation.json';
const CHECKED_AT = '2026-10-26T04:00:00.000Z';
const NOW_ISO = '2026-10-26T04:05:00.000Z';

const DISCORD_UA =
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const TWITTER_UA = 'Twitterbot/1.0';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function makeAttestation(
  overrides: Partial<SignedAttestation['payload']> = {},
): SignedAttestation {
  return {
    payload: {
      version: 1,
      subject: { type: 'discord_application', id: APP_ID },
      agentWalletAddress: WALLET,
      attestationUrl: ATT_URL,
      humanIdDisclosure: 'hash',
      issuedAt: '2026-10-20T00:00:00.000Z',
      expiresAt: '2026-12-19T00:00:00.000Z',
      nonce: 'fixture-nonce-1',
      extra: {
        discord_application_name: 'Nova Helper',
        discord_bot_user_id: '999888777666555444',
      },
      ...overrides,
    },
    signature: '0x' + '22'.repeat(65),
    signatureType: 'eip191',
  };
}

function makeResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    status: 'verified',
    address: WALLET,
    addressTruncated: truncateAddress(WALLET),
    humanHash: hashHumanId(HUMAN_ID),
    humanId: HUMAN_ID, // internal-only fixture: must never reach a body
    failures: [],
    evidence: {
      checkedAt: CHECKED_AT,
      source: 'live',
      agentBook: { network: 'eip155:480', contract: AGENTBOOK_CONTRACT },
    },
    ...overrides,
  };
}

function fakeVerifier(result: VerifyResult): Verifier {
  return {
    verifyAddress: async () => result,
    verifyAttestation: async () => result,
    resolveStatus: async () => result,
  };
}

const liveEntry: RegistryEntry = {
  discord_application_id: APP_ID,
  attestation_url: ATT_URL,
  submitted_by: 'fixture',
  added_at: '2026-10-25T00:00:00.000Z',
};

interface Harness {
  deps: LinkPreviewDeps;
  fetchCalls: string[];
}

function makeHarness(overrides: Partial<LinkPreviewDeps> = {}): Harness {
  const fetchCalls: string[] = [];
  const attestation = makeAttestation();
  const deps: LinkPreviewDeps = {
    baseUrl: 'https://fiador.org',
    now: () => new Date(NOW_ISO),
    registrySource: async () => ({ version: 1, entries: [liveEntry] }),
    attestationFetcher: async (url: string) => {
      fetchCalls.push(url);
      if (url === ATT_URL) return attestation;
      throw new Error(`unexpected fetch: ${url}`);
    },
    verifier: fakeVerifier(makeResult()),
    ...overrides,
  };
  return { deps, fetchCalls };
}

function req(path: string, ua: string): Request {
  return new Request(`https://fiador.org${path}`, {
    headers: { 'user-agent': ua },
  });
}

const attestation = makeAttestation();
const liveId = attestationShortId(attestation);

describe('verified flow', () => {
  it('crawler gets the OG page with descriptor, state, and og:image', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('human-backed attestation for Discord bots');
    expect(body).toContain('Verified');
    expect(body).toContain(
      `property="og:image" content="https://fiador.org/v/${liveId}/card.svg"`,
    );
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    expect(body).toContain('snapshot from crawl time');
  });

  it('card SVG carries the app name and the gold verified treatment', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}/card`, TWITTER_UA), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('Nova Helper');
    expect(body).toContain('#D4A55D'); // eye gold — verified accent
    expect(body).toContain('Checked 2026-10-26 04:00:00 UTC');
  });

  it('accepts the .svg suffix for the card', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}.svg`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
  });
});

describe('operator display name (opt-in only)', () => {
  it('appears on the card when the attestation carries it', async () => {
    const optedIn = makeAttestation({ operatorDisplayName: 'Nic L.' });
    const id = attestationShortId(optedIn);
    const { deps } = makeHarness({
      attestationFetcher: async () => optedIn,
    });
    const res = await handleRequest(req(`/v/${id}/card`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).toContain('Operator (self-asserted): Nic L.');
  });

  it('is absent when the attestation does not carry it', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).not.toContain('Operator (self-asserted)');
  });
});

describe('browser click-through', () => {
  it('redirects to the verify page with the attestation prefilled', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}`, BROWSER_UA), deps);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `https://fiador.org/verify/?attestation=${encodeURIComponent(ATT_URL)}`,
    );
  });
});

describe('failure states fail closed', () => {
  it('unknown id renders a neutral not-found card with full meta, HTTP 200', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req('/v/zzzzzzzzzz', DISCORD_UA), deps);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Attestation not found');
    expect(body).toContain('property="og:title"');
    expect(body).toContain('property="og:image"');
  });

  it('verifier unknown renders could-not-check, no-store, never verified-looking', async () => {
    const { deps } = makeHarness({
      verifier: fakeVerifier(
        makeResult({ status: 'unknown', humanHash: null, failures: ['lookup_failed'] }),
      ),
    });
    const card = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    expect(card.headers.get('cache-control')).toBe('no-store');
    const cardBody = await card.text();
    expect(cardBody).toContain('Could not check');
    expect(cardBody).not.toContain('Verified: a unique human backs');

    const page = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Could not check');
  });

  it('registry failure also renders could-not-check with no-store', async () => {
    const { deps } = makeHarness({
      registrySource: async () => {
        throw new Error('registry unreachable');
      },
    });
    const res = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Could not check');
  });

  it('expired renders the expired card in amber', async () => {
    const { deps } = makeHarness({
      verifier: fakeVerifier(
        makeResult({ status: 'expired', humanHash: null, failures: ['expired'] }),
      ),
    });
    const res = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).toContain('Expired');
    expect(body).toContain('#C9933A'); // amber
  });

  it('unregistered renders unverified with the not-registered wording', async () => {
    const { deps } = makeHarness({
      verifier: fakeVerifier(
        makeResult({
          status: 'unregistered',
          humanHash: null,
          failures: ['not_registered'],
        }),
      ),
    });
    const res = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).toContain('Not verified');
    expect(body).toContain('not registered in AgentBook');
  });
});

describe('revoked tombstone', () => {
  it('renders the revoked card without ever fetching the attestation', async () => {
    const revokedAttestation = makeAttestation({
      subject: { type: 'discord_application', id: '555000111222333444' },
      attestationUrl: 'https://bots.example.com/revoked.json',
      nonce: 'fixture-nonce-revoked',
    });
    const payloadHash = createHash('sha256')
      .update(canonicalAttestationBytes(revokedAttestation.payload), 'utf8')
      .digest('hex');
    const tombstone: RegistryEntry = {
      discord_application_id: '555000111222333444',
      attestation_url: 'https://bots.example.com/revoked.json',
      status: 'revoked',
      payload_hash: payloadHash,
      name: 'Old Bot',
    };
    const id = attestationShortId(revokedAttestation);
    const { deps, fetchCalls } = makeHarness({
      registrySource: async () => ({ version: 1, entries: [tombstone] }),
    });
    const res = await handleRequest(req(`/v/${id}/card`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Revoked');
    expect(body).toContain('Old Bot');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('privacy deep-scan', () => {
  it('no response body contains the full humanId or the full wallet address', async () => {
    const { deps } = makeHarness();
    const bodies: string[] = [];
    bodies.push(await (await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps)).text());
    bodies.push(await (await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps)).text());
    bodies.push(await (await handleRequest(req('/v/zzzzzzzzzz', DISCORD_UA), deps)).text());
    bodies.push(await (await handleRequest(req('/v/zzzzzzzzzz/card', DISCORD_UA), deps)).text());
    for (const body of bodies) {
      expect(body).not.toContain(HUMAN_ID);
      expect(body).not.toContain(WALLET);
      expect(body).not.toContain('humanId');
    }
  });
});
