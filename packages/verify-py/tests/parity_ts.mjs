// Emit complete, deterministic results for the shared W0 vectors.
// The Python gate diffs this output against the Python verifier.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  canonicalAttestationMessage,
  createVerifier,
  hashHumanId,
  toPublicVerifyResult,
} from '../../verify-ts/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(resolve(here, '../../verify-ts/fixtures/vectors.json'), 'utf8'),
);
const rows = new Map(vectors.lookups.map((row) => [row.address.toLowerCase(), row.humanId]));
const now = () => new Date(vectors.fixedNow);
const reader = {
  source: 'fixture',
  async lookupHuman(address) {
    return rows.get(address.toLowerCase()) ?? null;
  },
};
const verifier = createVerifier({ reader, now });

// Only measured latency is nondeterministic. Keep the key and replace
// its value so the complete shape, including evidence, is compared.
function normalize(value) {
  const copy = structuredClone(value);
  if (copy?.evidence && Object.hasOwn(copy.evidence, 'rpcLatencyMs')) {
    copy.evidence.rpcLatencyMs = '<elapsed>';
  }
  return copy;
}

function pair(result) {
  return {
    internal: normalize(result),
    public: normalize(toPublicVerifyResult(result)),
  };
}

const output = {
  canonical: {},
  hashes: {},
  results: {},
  signedMessages: {},
};
for (const [name, humanId] of Object.entries(vectors.humans)) {
  output.hashes[name] = hashHumanId(humanId);
}
for (const row of vectors.lookups) {
  output.results['address/' + row.address] = pair(await verifier.verifyAddress(row.address));
}
output.results['address/malformed'] = pair(await verifier.verifyAddress('not-an-address'));

for (const [name, attestation] of Object.entries(vectors.attestations)) {
  output.canonical[name] = canonicalAttestationMessage(attestation.payload);
  output.results['attestation/' + name] = pair(
    await verifier.verifyAttestation(attestation),
  );
}
const valid = vectors.attestations.valid;
output.results['attestation/no-registration'] = pair(
  await verifier.verifyAttestation(valid, { checkRegistration: false }),
);
for (const field of ['attestationUrl', 'operatorDisplayName', 'extra']) {
  const withNull = structuredClone(valid);
  withNull.payload[field] = null;
  output.results['attestation/null-' + field] = pair(
    await verifier.verifyAttestation(withNull),
  );
}
output.results['resolve/address'] = pair(
  await verifier.resolveStatus({ kind: 'address', address: vectors.wallets.operatorA }),
);
output.results['resolve/attestation'] = pair(
  await verifier.resolveStatus({ kind: 'attestation', attestation: valid }),
);
const subject = valid.payload.subject;
output.results['resolve/attested-subject'] = pair(
  await verifier.resolveStatus({
    kind: 'attested_subject',
    subject,
    async resolveAttestation() { return valid; },
  }),
);
output.results['resolve/missing'] = pair(
  await verifier.resolveStatus({
    kind: 'attested_subject',
    subject,
    async resolveAttestation() { return null; },
  }),
);
const offline = createVerifier({
  now,
  reader: {
    source: 'fixture',
    async lookupHuman() { throw new Error('synthetic offline reader'); },
  },
});
output.results['address/lookup-failed'] = pair(
  await offline.verifyAddress(vectors.wallets.operatorA),
);

const seen = new Set();
const nonceStore = {
  async has(nonce, wallet) { return seen.has(wallet + ':' + nonce); },
  async claim(nonce, wallet, expiresAt) {
    const key = wallet + ':' + nonce;
    if (seen.has(key)) return 'replay';
    if (Date.parse(expiresAt) <= now().getTime()) return 'expired';
    seen.add(key);
    return 'claimed';
  },
};
output.results['nonce/first'] = pair(
  await verifier.verifyAttestation(valid, { nonceStore }),
);
output.results['nonce/replay'] = pair(
  await verifier.verifyAttestation(valid, { nonceStore }),
);
for (const [name, vector] of Object.entries(vectors.signedMessages)) {
  output.signedMessages[name + '/expected'] = await verifier.verifySignedMessage({
    message: vector.message,
    signature: vector.signature,
    signatureType: 'eoa',
    expectedAddress: vector.signer,
  });
  output.signedMessages[name + '/bare'] = await verifier.verifySignedMessage({
    message: vector.message,
    signature: vector.signature,
    signatureType: 'eoa',
  });
}
process.stdout.write(JSON.stringify(output));
