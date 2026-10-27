import { SqliteNonceStore } from '../dist/index.js';

const [dbPath, nonce, wallet, expiresAt] = process.argv.slice(2);
const store = new SqliteNonceStore(dbPath);
process.send({ stage: 'ready', hadClaim: await store.has(nonce, wallet) });

process.once('message', async (message) => {
  if (message !== 'claim') {
    process.exitCode = 2;
    return;
  }
  try {
    const outcome = await store.claim(nonce, wallet, expiresAt);
    process.send({ stage: 'done', outcome }, () => {
      store.close();
      process.disconnect();
    });
  } catch (error) {
    process.send({ stage: 'error', message: String(error) }, () => {
      store.close();
      process.disconnect();
    });
  }
});
