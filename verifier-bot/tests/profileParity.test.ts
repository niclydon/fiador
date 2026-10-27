import { describe, expect, it } from 'vitest';
import { discordProfileFailure as previewProfileFailure } from '../../link-preview/src/profile.js';
import { discordProfileFailure as botProfileFailure } from '../src/profile.js';
import { hashHumanId, makeAttestation, SYNTHETIC_HUMAN_ID } from './fakeVerify.js';

const APP = '123456789012345678';
const URL = 'https://operator.example.com/attestation.json';
const HUMAN_HASH = hashHumanId(SYNTHETIC_HUMAN_ID);
const BOT = '987654321098765432';

describe('bot Discord profile parity with public preview', () => {
  it('accepts and rejects the same signed profile shapes and live human hashes', () => {
    const base = { extra: { discord_bot_user_id: BOT, human_id_hash: HUMAN_HASH } };
    const cases = [
      { payload: base, live: HUMAN_HASH },
      { payload: { ...base, subject: { type: 'discord_application', id: 'bad' } }, live: HUMAN_HASH },
      { payload: { ...base, humanIdDisclosure: 'none' as const }, live: HUMAN_HASH },
      { payload: { ...base, attestationUrl: 'https://other.example.com/a.json' }, live: HUMAN_HASH },
      { payload: { extra: { ...base.extra, human_id_hash: 'bad' } }, live: HUMAN_HASH },
      { payload: { extra: { ...base.extra, discord_bot_user_id: 'bad' } }, live: HUMAN_HASH },
      { payload: { extra: { ...base.extra, unsupported: 'value' } }, live: HUMAN_HASH },
      { payload: { extra: { ...base.extra, raw_human_id: 'forbidden' } }, live: HUMAN_HASH },
      { payload: { ...base, operatorDisplayName: 'x'.repeat(65) }, live: HUMAN_HASH },
      { payload: base, live: 'aa'.repeat(32) },
    ];
    for (const { payload, live } of cases) {
      const attestation = makeAttestation(payload);
      const entry = { discord_application_id: APP, attestation_url: URL };
      const preview = previewProfileFailure(attestation, entry, live);
      const bot = botProfileFailure(attestation, APP, URL, live);
      expect(Boolean(bot), JSON.stringify(payload)).toBe(Boolean(preview));
    }
  });
});
