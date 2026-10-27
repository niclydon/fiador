import { createServer } from 'node:http';
import { createVerifier } from '@fiador/verify';
import { SqliteNonceStore } from '../dist/index.js';

const [databasePath, mode, attestationText] = process.argv.slice(2);
const attestation = JSON.parse(attestationText);
const store = new SqliteNonceStore(databasePath);
let reads = 0;
let claims = 0;
let server;
let releaseRead;
const readGate = new Promise((resolve) => { releaseRead = resolve; });

const nonceStore = {
  async has(nonce, wallet) {
    reads += 1;
    const hadClaim = await store.has(nonce, wallet);
    if (mode === 'race') {
      process.send({ stage: 'read', hadClaim });
      await readGate;
    }
    return hadClaim;
  },
  async claim(nonce, wallet, expiresAt) {
    claims += 1;
    const outcome = await store.claim(nonce, wallet, expiresAt);
    if (mode === 'lost-response' && outcome === 'claimed') {
      throw new Error('the committed claim response was lost');
    }
    return outcome;
  },
};

function finish(message) {
  process.send(message, () => {
    if (server) server.close();
    store.close();
    process.disconnect();
  });
}

async function verify() {
  let rpcUrl;
  if (mode === 'uncertain-signature') {
    server = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    rpcUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const verifier = createVerifier({
    timeoutMs: 1_000,
    ...(rpcUrl ? { rpcUrl } : {}),
    reader: {
      source: 'fixture',
      async lookupHuman() {
        if (mode === 'uncertain-registration') throw new Error('fixture lookup unavailable');
        return `0x${'a1'.repeat(32)}`;
      },
    },
  });
  const result = await verifier.verifyAttestation(attestation, { nonceStore });
  finish({ stage: 'done', status: result.status, failures: result.failures, reads, claims });
}

process.on('message', (message) => {
  if (message === 'release') {
    releaseRead();
  } else if (message === 'verify') {
    verify().catch((error) => finish({ stage: 'error', message: String(error) }));
  }
});
process.send({ stage: 'ready' });
