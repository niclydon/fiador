import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run the verify core from source (the production path resolves the
// built package through the workspace, as the other packages do).
export default defineConfig({
  resolve: {
    alias: {
      '@fiador/verify': resolve(
        fileURLToPath(new URL('.', import.meta.url)),
        '../../packages/verify-ts/src/index.ts',
      ),
    },
  },
});
