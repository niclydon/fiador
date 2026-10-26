import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_HUMAN_ID,
  SYNTHETIC_WALLET,
  makeAttestation,
  makeResult,
  toPublicVerifyResult,
} from './fakeVerify.js';
import { buildResultEmbed, DESCRIPTOR_LINE } from '../src/embeds.js';

describe('buildResultEmbed — public shape only (DESIGN §5.3, §3.3)', () => {
  it('a verified embed contains neither the raw humanId nor the full wallet address', () => {
    const internal = makeResult('verified');
    // Sanity: the internal result really does carry the raw value, so the
    // scan below is hunting something that exists upstream of the embed.
    expect(internal.humanId).toBe(SYNTHETIC_HUMAN_ID);

    const pub = toPublicVerifyResult(internal);
    const embed = buildResultEmbed({
      applicationId: '123456789012345678',
      botName: 'Nova',
      result: pub,
      attestation: makeAttestation({ operatorDisplayName: 'Nic Lydon' }),
    });

    const rendered = JSON.stringify(embed);
    expect(rendered).not.toContain(SYNTHETIC_HUMAN_ID);
    expect(rendered).not.toContain('humanId');
    expect(rendered).not.toContain(SYNTHETIC_WALLET);
    // Not even the full hash: the embed shows it truncated.
    expect(pub.humanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered).not.toContain(pub.humanHash as string);
    expect(embed.title).toContain('Application control unproven');
    expect(embed.color).toBe(0x6e6e73);
    expect(embed.description).toContain('has not been linked to control');
    // What it does show: truncated wallet, status, descriptor footer.
    expect(rendered).toContain('0x1234…45678');
    expect(embed.footer.text).toBe(DESCRIPTOR_LINE);
    expect(embed.footer.text).toBe('Fiador — human-backed attestation for Discord bots');
  });

  it('shows the operator line only when the payload opted in', () => {
    const pub = toPublicVerifyResult(makeResult('verified'));
    const withName = buildResultEmbed({
      applicationId: '123456789012345678',
      result: pub,
      attestation: makeAttestation({ operatorDisplayName: 'Nic Lydon' }),
    });
    expect(withName.fields.some((f) => f.name === 'Operator (self-asserted)')).toBe(true);

    const withoutName = buildResultEmbed({
      applicationId: '123456789012345678',
      result: pub,
      attestation: makeAttestation(),
    });
    expect(withoutName.fields.some((f) => f.name === 'Operator (self-asserted)')).toBe(false);
  });

  it('a failed embed carries the failure sentence for its code', () => {
    const pub = toPublicVerifyResult(makeResult('expired'));
    const embed = buildResultEmbed({
      applicationId: '123456789012345678',
      result: pub,
      attestation: makeAttestation(),
    });
    expect(embed.description).toContain('has expired');
    expect(embed.title).toContain('expired');
  });
});
