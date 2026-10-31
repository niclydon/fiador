import { cp, mkdir, rm } from 'node:fs/promises';

const output = new URL('../public/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of ['index.html', 'theme.js', 'style.css', 'privacy', 'support', 'terms', 'verify', 'assets', 'attestations']) {
  await cp(new URL(`../verify-page/${path}`, import.meta.url), new URL(`../public/${path}`, import.meta.url), {
    recursive: true,
    force: true,
  });
}
// The repository registry is canonical; do not publish a second maintained copy.
await cp(new URL('../registry/registry.json', import.meta.url), new URL('../public/registry.json', import.meta.url));
