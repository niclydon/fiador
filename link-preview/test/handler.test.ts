import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  canonicalAttestationMessage,
  hashHumanId,
  truncateAddress,
} from '@fiador/verify';
import { attestationShortId } from '../src/shortId.js';
import { resolveShortId } from '../src/resolve.js';

const AGENTBOOK_CONTRACT = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA' as const;
import type {
  SignedAttestation,
  Verifier,
  VerifyResult,
} from '@fiador/verify';
import { handleRequest } from '../src/handler.js';
import type { LinkPreviewDeps } from '../src/deps.js';
import { normalizeEntries, type RegistryEntry } from '../src/registry.js';

// Fixture secrets/identifiers: synthetic only. The deep-scan tests assert
// neither ever appears in any response body — the full humanId is internal
// to the verify core's result shape, and the full wallet address is only
// ever rendered truncated.
const WALLET = ('0x' + 'cd'.repeat(20)) as `0x${string}`;
const HUMAN_ID = '0x' + '11'.repeat(32);
const HUMAN_HASH = hashHumanId(HUMAN_ID);
const APP_ID = '123456789012345678';
const BOT_ID = '999888777666555444';
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
        discord_bot_user_id: BOT_ID,
        human_id_hash: HUMAN_HASH,
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
    humanHash: HUMAN_HASH,
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
    // Not exercised by these tests; present so the fake satisfies
    // the Verifier surface (verifySignedMessage joined in 0.2.0).
    verifySignedMessage: async () => ({
      verified: false,
      address: null,
      failures: ['signature_mismatch'],
    }),
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

describe('core-valid claim without application-control proof', () => {
  it('asks the verify core to bind the attestation to its registry application', async () => {
    const verifyAttestation = vi.fn(async () => makeResult());
    const { deps } = makeHarness({
      verifier: { ...fakeVerifier(makeResult()), verifyAttestation },
    });
    await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    expect(verifyAttestation).toHaveBeenCalledWith(attestation, {
      expectedSubject: { type: 'discord_application', id: APP_ID },
      signal: expect.any(AbortSignal),
    });
  });

  it('crawler gets the OG page with descriptor, state, and og:image', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('human-backed attestation for Discord bots');
    expect(body).toContain('Claim unconfirmed');
    expect(body).not.toContain('Verified: a unique human backs');
    expect(body).toContain(
      `property="og:image" content="https://fiador.org/v/${liveId}/card.svg"`,
    );
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    expect(body).toContain('snapshot from crawl time');
    expect(body).toContain('A current result requires a live verification page');
    expect(body).not.toContain('run live at open time');
  });

  it('card SVG carries the app name with a neutral, non-green treatment', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}/card`, TWITTER_UA), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('Nova Helper');
    expect(body).toContain('Claim unconfirmed');
    expect(body).not.toContain('#D4A55D');
    expect(body).toContain('Discord application control is not established');
    expect(body).toContain('Checked 2026-10-26 04:00:00 UTC');
  });

  it('accepts the .svg suffix for the card', async () => {
    const { deps } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId}.svg`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
  });
});

describe('Discord profile checks', () => {
  it.each([
    ['non-hash disclosure', { humanIdDisclosure: 'none' } as const, 'hash disclosure'],
    ['missing human hash', { extra: { discord_bot_user_id: BOT_ID } }, 'human hash is missing or malformed'],
    ['uppercase human hash', { extra: { discord_bot_user_id: BOT_ID, human_id_hash: HUMAN_HASH.toUpperCase() } }, 'human hash is missing or malformed'],
    ['wrong live human hash', { extra: { discord_bot_user_id: BOT_ID, human_id_hash: '0'.repeat(64) } }, 'human hash does not match'],
    ['different signed URL', { attestationUrl: 'https://bots.example.com/other.json' }, 'signed attestation URL does not match'],
    ['missing bot user ID', { extra: { human_id_hash: HUMAN_HASH } }, 'bot user ID is missing or invalid'],
    ['malformed bot user ID', { extra: { human_id_hash: HUMAN_HASH, discord_bot_user_id: 'abc' } }, 'bot user ID is missing or invalid'],
    ['raw human ID field', { extra: { human_id_hash: HUMAN_HASH, discord_bot_user_id: BOT_ID, humanId: HUMAN_ID } }, 'raw human ID fields are not allowed'],
    ['raw human ID alias', { extra: { human_id_hash: HUMAN_HASH, discord_bot_user_id: BOT_ID, human_id_raw: HUMAN_ID } }, 'raw human ID fields are not allowed'],
    ['unsupported signed field', { extra: { human_id_hash: HUMAN_HASH, discord_bot_user_id: BOT_ID, other_claim: 'value' } }, 'unsupported signed fields'],
    ['malformed application name', { extra: { human_id_hash: HUMAN_HASH, discord_bot_user_id: BOT_ID, discord_application_name: 42 as never } }, 'Discord application name is malformed'],
    ['different Discord application', { subject: { type: 'discord_application', id: '111222333444555666' } }, 'Discord application ID is missing or invalid'],
  ])('rejects %s', async (_name, override, reason) => {
    const candidate = makeAttestation(override);
    const id = attestationShortId(candidate);
    const { deps } = makeHarness({ attestationFetcher: async () => candidate });
    const res = await handleRequest(req(`/v/${id}`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).toContain('Not verified');
    expect(body).toContain(reason);
    const card = await handleRequest(req(`/v/${id}/card`, DISCORD_UA), deps);
    expect(await card.text()).not.toContain('#D4A55D');
  });

  it('rejects a Discord-reported bot user ID mismatch', async () => {
    const reportedBotUserId = vi.fn(async () => '111222333444555666');
    const { deps } = makeHarness({ discordBotUserIdForApplication: reportedBotUserId });
    const res = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(await res.text()).toContain('bot user ID differs from Discord');
    expect(reportedBotUserId).toHaveBeenCalledWith(APP_ID, expect.any(AbortSignal));
  });

  it('a matching Discord-reported bot user ID still does not prove application control', async () => {
    const { deps } = makeHarness({
      discordBotUserIdForApplication: async () => BOT_ID,
    });
    const res = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).toContain('Claim unconfirmed');
    expect(body).not.toContain('#D4A55D');
  });

  it('a Discord lookup failure is a no-store could-not-check state', async () => {
    const { deps } = makeHarness({
      discordBotUserIdForApplication: async () => { throw new Error('Discord unavailable'); },
    });
    const res = await handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Could not check');
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
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('does not cache a changing crawler verdict or its SVG card', async () => {
    const { deps } = makeHarness();
    const page = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Claim unconfirmed');

    const card = await handleRequest(req(`/v/${liveId}/card.svg`, DISCORD_UA), deps);
    expect(card.status).toBe(200);
    expect(card.headers.get('cache-control')).toBe('no-store');
    expect(await card.text()).toContain('Claim unconfirmed');
  });
});

describe('failure states fail closed', () => {
  it('returns no-store could-not-check when the core verifier stalls', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const verifierStarted = new Promise<void>((resolve) => { started = resolve; });
      const { deps } = makeHarness({
        verifier: {
          ...fakeVerifier(makeResult()),
          verifyAttestation: async () => {
            started();
            return new Promise(() => {});
          },
        },
      });
      const pending = handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
      await verifierStarted;
      await vi.advanceTimersByTimeAsync(15_000);
      const response = await pending;
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('Could not check');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one deadline across a slow registry load and a stalled verifier', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const verifierStarted = new Promise<void>((resolve) => { started = resolve; });
      const { deps } = makeHarness({
        registrySource: async () => new Promise((resolve) => {
          setTimeout(() => resolve({ version: 1, entries: [liveEntry] }), 14_000);
        }),
        verifier: {
          ...fakeVerifier(makeResult()),
          verifyAttestation: async () => {
            started();
            return new Promise(() => {});
          },
        },
      });
      const pending = handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
      await vi.advanceTimersByTimeAsync(14_000);
      await verifierStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('Could not check');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns no-store could-not-check when the optional Discord lookup stalls', async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
      const { deps } = makeHarness({
        discordBotUserIdForApplication: async () => {
          started();
          return new Promise(() => {});
        },
      });
      const pending = handleRequest(req(`/v/${liveId}/card`, DISCORD_UA), deps);
      await lookupStarted;
      await vi.advanceTimersByTimeAsync(15_000);
      const response = await pending;
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toContain('Could not check');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resolve a short prefix below the documented ten-character minimum', async () => {
    const { deps, fetchCalls } = makeHarness();
    const res = await handleRequest(req(`/v/${liveId.slice(0, 1)}`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Attestation not found');
    expect(fetchCalls).toHaveLength(0);
  });

  it('malformed registry data is a lookup failure, not a missing attestation', async () => {
    const { deps } = makeHarness({
      registrySource: async () => ({ version: 1, entries: null }) as never,
    });
    const res = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Could not check');
  });

  it('malformed registry entries fail closed instead of crashing the handler', async () => {
    const { deps } = makeHarness({
      registrySource: async () => ({ version: 1, entries: [null] }) as never,
    });
    const res = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Could not check');
  });

  it('malformed attestation data is a lookup failure, not a server error', async () => {
    const { deps } = makeHarness({
      attestationFetcher: async () => ({
        payload: { subject: { type: 'discord_application', id: APP_ID } },
        signature: '0x00',
      }),
    });
    const res = await handleRequest(req(`/v/${liveId}`, DISCORD_UA), deps);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Could not check');
  });

  it('invalid signed display fields cannot crash an unverified card', async () => {
    const malformed = makeAttestation({
      extra: { discord_application_name: 42 as never },
    });
    const malformedId = attestationShortId(malformed);
    const { deps } = makeHarness({
      attestationFetcher: async () => malformed,
      verifier: fakeVerifier(makeResult({ status: 'invalid', failures: ['malformed_attestation'] })),
    });
    const res = await handleRequest(req(`/v/${malformedId}/card`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Not verified');
  });

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

  it('rejects malformed Discord profile fields before showing Expired', async () => {
    const malformed = makeAttestation({
      extra: { human_id_hash: HUMAN_HASH, discord_bot_user_id: BOT_ID, human_id_raw: HUMAN_ID },
    });
    const id = attestationShortId(malformed);
    const { deps } = makeHarness({
      attestationFetcher: async () => malformed,
      verifier: fakeVerifier(makeResult({ status: 'expired', humanHash: null, failures: ['expired'] })),
    });
    const res = await handleRequest(req(`/v/${id}/card`, DISCORD_UA), deps);
    const body = await res.text();
    expect(body).toContain('Not verified');
    expect(body).toContain('raw human ID fields are not allowed');
    expect(body).not.toContain('#C9933A');
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
  it('keeps the current published short link resolvable after revocation', async () => {
    const registry = JSON.parse(readFileSync(new URL('../../registry/registry.json', import.meta.url), 'utf8'));
    const mirror = JSON.parse(readFileSync(new URL('../../verify-page/registry.json', import.meta.url), 'utf8'));
    const publishedAttestation = JSON.parse(readFileSync(new URL('../../verify-page/attestations/nova.json', import.meta.url), 'utf8')) as SignedAttestation;
    const entries = normalizeEntries(registry);
    const payloadHash = createHash('sha256')
      .update(canonicalAttestationMessage(publishedAttestation.payload), 'utf8')
      .digest('hex');
    expect(entries).toHaveLength(1);
    expect(entries[0].payload_hash).toBe(payloadHash);
    expect(normalizeEntries(mirror)[0].payload_hash).toBe(payloadHash);

    const oldId = attestationShortId(publishedAttestation);
    const before = await resolveShortId(entries, oldId, async () => publishedAttestation);
    expect(before.kind).toBe('live');

    const tombstone: RegistryEntry = { ...entries[0], status: 'revoked' };
    const fetcher = vi.fn(async () => { throw new Error('Revoked attestation must not be fetched'); });
    const { deps } = makeHarness({
      registrySource: async () => ({ version: 1, entries: [tombstone] }),
      attestationFetcher: fetcher,
    });
    const res = await handleRequest(req(`/v/${oldId}/card`, DISCORD_UA), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Revoked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['prefixed', `0x${'a'.repeat(64)}`],
    ['uppercase', 'A'.repeat(64)],
    ['short', 'a'.repeat(63)],
    ['nonhex', 'g'.repeat(64)],
  ])('rejects a %s payload hash', (_label, payloadHash) => {
    expect(() => normalizeEntries({ version: 1, entries: [{ ...liveEntry, payload_hash: payloadHash }] }))
      .toThrow('Malformed registry entry.');
  });

  it('rejects a tombstone without a payload hash even if it has a short id', () => {
    expect(() => normalizeEntries({
      version: 1,
      entries: [{ ...liveEntry, status: 'revoked', short_id: 'a'.repeat(10) }],
    })).toThrow('Malformed registry entry.');
  });

  it('renders the revoked card without ever fetching the attestation', async () => {
    const revokedAttestation = makeAttestation({
      subject: { type: 'discord_application', id: '555000111222333444' },
      attestationUrl: 'https://bots.example.com/revoked.json',
      nonce: 'fixture-nonce-revoked',
    });
    const payloadHash = createHash('sha256')
      .update(canonicalAttestationMessage(revokedAttestation.payload), 'utf8')
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
