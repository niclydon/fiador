import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../verify/app.js', import.meta.url)),
  alias: { '@fiador/verify': `${root}packages/verify-ts/src/index.ts` },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
});
