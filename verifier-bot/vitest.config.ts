import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// Tests never touch the network or a real Discord token, and they run
// against a fake verify core: '@fiador/verify' is aliased to the test
// double in tests/fakeVerify.ts, which re-exports the real public-shape
// helpers from the verify package's types module and stubs createVerifier
// with programmable results. 'node:sqlite' is aliased to a createRequire
// shim because this Vite version predates it in its builtin list.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^node:sqlite$/,
        replacement: path.resolve(here, './tests/nodeSqliteShim.ts'),
      },
      {
        find: '@fiador/verify',
        replacement: path.resolve(here, './tests/fakeVerify.ts'),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
