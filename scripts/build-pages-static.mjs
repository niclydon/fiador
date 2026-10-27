import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../public/', import.meta.url));
const sources = new Map([
  ['index.html', 'verify-page/index.html'],
  ['privacy/index.html', 'verify-page/privacy/index.html'],
  ['support/index.html', 'verify-page/support/index.html'],
  ['style.css', 'verify-page/style.css'],
  ['theme.js', 'verify-page/theme.js'],
  ['assets/fiador-banner.webp', 'verify-page/assets/fiador-banner.webp'],
  ['registry.json', 'registry/registry.json'],
  ['attestations/nova.json', 'verify-page/attestations/nova.json'],
]);

await rm(output, { recursive: true, force: true });
for (const [destination, source] of sources) {
  await mkdir(dirname(`${output}/${destination}`), { recursive: true });
  await copyFile(`${root}/${source}`, `${output}/${destination}`);
}
