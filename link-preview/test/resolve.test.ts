import { describe, expect, it, vi } from 'vitest';
import { resolveShortId } from '../src/resolve.js';
import { attestationShortId } from '../src/shortId.js';
import type { RegistryEntry } from '../src/registry.js';
import type { SignedAttestation } from '@fiador/verify';

describe('short-id resolution budget', () => {
  it('stops the registry scan when its signal expires during a fetch', async () => {
    const entries: RegistryEntry[] = [
      { discord_application_id: '123456789012345678', attestation_url: 'https://one.example/attestation.json' },
      { discord_application_id: '234567890123456789', attestation_url: 'https://two.example/attestation.json' },
    ];
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, _signal?: AbortSignal): Promise<unknown> => {
      controller.abort();
      return new Promise(() => {});
    });

    const result = await resolveShortId(entries, 'aaaaaaaaaa', fetcher, controller.signal);

    expect(result.kind).toBe('lookup_failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(entries[0].attestation_url, expect.any(AbortSignal));
    expect(fetcher.mock.calls[0][1]?.aborted).toBe(true);
  }, 500);

  it('finds a healthy third candidate while two earlier hosts stall', async () => {
    const attestation: SignedAttestation = {
      payload: {
        version: 1,
        subject: { type: 'discord_application', id: '345678901234567890' },
        agentWalletAddress: `0x${'cd'.repeat(20)}`,
        attestationUrl: 'https://three.example/attestation.json',
        humanIdDisclosure: 'hash',
        issuedAt: '2026-10-20T00:00:00.000Z',
        expiresAt: '2026-12-19T00:00:00.000Z',
        nonce: 'f'.repeat(32),
      },
      signature: `0x${'22'.repeat(65)}`,
      signatureType: 'eip191',
    };
    const entries: RegistryEntry[] = [
      { discord_application_id: '123456789012345678', attestation_url: 'https://one.example/attestation.json' },
      { discord_application_id: '234567890123456789', attestation_url: 'https://two.example/attestation.json' },
      { discord_application_id: '345678901234567890', attestation_url: 'https://three.example/attestation.json' },
    ];
    const fetcher = vi.fn((url: string): Promise<unknown> =>
      url === entries[2].attestation_url ? Promise.resolve(attestation) : new Promise(() => {}),
    );

    const result = await resolveShortId(
      entries,
      attestationShortId(attestation),
      fetcher,
      AbortSignal.timeout(100),
    );

    expect(result).toEqual({ kind: 'live', entry: entries[2], attestation });
    expect(fetcher).toHaveBeenCalledTimes(3);
  }, 500);
});
