import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const expected = new Map([
  ['index.html', 'verify-page/index.html'],
  ['privacy/index.html', 'verify-page/privacy/index.html'],
  ['support/index.html', 'verify-page/support/index.html'],
  ['style.css', 'verify-page/style.css'],
  ['theme.js', 'verify-page/theme.js'],
  ['assets/fiador-banner.webp', 'verify-page/assets/fiador-banner.webp'],
  ['registry.json', 'registry/registry.json'],
  ['attestations/nova.json', 'verify-page/attestations/nova.json'],
]);
const read = (path) => readFile(new URL(path, root));

async function list(path) {
  const entries = await readdir(new URL(path, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = `${path}${entry.name}`;
    files.push(...(entry.isDirectory() ? await list(`${child}/`) : [child.slice('public/'.length)]));
  }
  return files.sort();
}

test('static output contains only approved routes and exact source bytes', async () => {
  assert.deepEqual(await list('public/'), [...expected.keys()].sort());
  for (const [destination, source] of expected) {
    assert.deepEqual(await read(`public/${destination}`), await read(source), destination);
  }
  for (const page of ['index.html', 'privacy/index.html', 'support/index.html']) {
    assert.doesNotMatch((await read(`public/${page}`)).toString(), /href="\/(?:verify|v|api\/preview)(?:\/|\?|\")/);
  }
});

test('published registry and attestation retain deployed bytes', async () => {
  const digest = (data) => createHash('sha256').update(data).digest('hex');
  // These are content digests of the two public files at the verified deployed base.
  assert.equal(digest(await read('public/registry.json')), '65b4d5f9cff45bbf967eb4248348bac1a443ec725ac9571cfdf71b47b5e006aa');
  assert.equal(digest(await read('public/attestations/nova.json')), 'ad1c0e5e2ab9ea3b78aebd5c2f1b3905392b86a96bc10246264e3a6eba4cce6b');
});

test('Vercel build has no serverless routes or rewrites', async () => {
  const config = JSON.parse((await read('vercel.json')).toString());
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.equal(config.buildCommand, 'node scripts/build-pages-static.mjs');
  assert.equal(config.functions, undefined);
  assert.equal(config.rewrites, undefined);
});
