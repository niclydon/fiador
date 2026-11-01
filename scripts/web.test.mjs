import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url));

test('the web build publishes the exact static source files at their requested paths', async () => {
  const sourcePaths = [
    'index.html',
    'theme.js',
    'verify/index.html',
    'verify/app.js',
    'verify/style.css',
    'attestations/nova.json',
    'assets/fiador-banner.webp',
    'assets/badges/fiador-pill-light-unverified.svg',
  ];
  for (const path of sourcePaths) {
    assert.deepEqual(await read(`public/${path}`), await read(`verify-page/${path}`), path);
  }
  assert.deepEqual(await read('public/registry.json'), await read('registry/registry.json'));
});

test('vercel.json routes are exactly the pinned set', async () => {
  const config = JSON.parse((await read('vercel.json')).toString('utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.equal(config.buildCommand, 'npm run build:web');
  assert.deepEqual(config.functions, { 'api/preview.ts': { maxDuration: 20 } });
  assert.deepEqual(config.headers, [
    {
      source: '/registry.json',
      headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
    },
    {
      source: '/attestations/:path*',
      headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
    },
  ]);
  assert.deepEqual(config.rewrites, [
    {
      source: '/app-authority/callback/:proofId',
      destination: '/app-authority-callback.html',
    },
    {
      source: '/v/:id/card.svg',
      destination: '/api/preview?fiador_id=:id&fiador_card=1',
    },
    {
      source: '/v/:id',
      destination: '/api/preview?fiador_id=:id',
    },
  ]);
});
