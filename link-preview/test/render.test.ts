import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalAttestationMessage } from '@fiador/verify';
import { attestationShortId } from '../src/shortId.js';
import type { SignedAttestation } from '@fiador/verify';
import { shortIdFromDigestHex } from '../src/resolve.js';
import { escapeXml, renderCard, wrapText } from '../src/card.js';

const attestation: SignedAttestation = {
  payload: {
    version: 1,
    subject: { type: 'discord_application', id: '42' },
    agentWalletAddress: ('0x' + 'ef'.repeat(20)) as `0x${string}`,
    humanIdDisclosure: 'none',
    issuedAt: '2026-10-20T00:00:00.000Z',
    expiresAt: '2026-12-19T00:00:00.000Z',
    nonce: 'unit-nonce',
  },
  signature: '0x' + '33'.repeat(65),
  signatureType: 'eip191',
};

describe('short-id derivation', () => {
  it('digest-hex path agrees with attestationShortId at several lengths', () => {
    const hex = createHash('sha256')
      .update(canonicalAttestationMessage(attestation.payload), 'utf8')
      .digest('hex');
    for (const len of [10, 12, 16]) {
      expect(shortIdFromDigestHex(hex, len)).toBe(attestationShortId(attestation, len));
    }
    // Prefix extension: a longer id extends the shorter one.
    expect(attestationShortId(attestation, 16).startsWith(attestationShortId(attestation, 10))).toBe(true);
  });
});

describe('card rendering safety', () => {
  it('escapes interpolated strings', () => {
    expect(escapeXml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
    const svg = renderCard('verified', {
      applicationName: '<script>alert(1)</script>',
      operatorDisplayName: 'Evil <Bot> & Co',
      checkedAt: '2026-10-26T04:00:00.000Z',
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('Evil &lt;Bot&gt; &amp; Co');
  });

  it('wraps long verdicts onto multiple lines', () => {
    const lines = wrapText('one two three four five six seven eight nine ten', 12);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
  });
});
