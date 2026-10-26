import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Consume the verify core from source so tests never depend on a dist
// build of @fiador/verify being present.
export default defineConfig({
  resolve: {
    alias: {
      '@fiador/verify': fileURLToPath(
        new URL('../packages/verify-ts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
