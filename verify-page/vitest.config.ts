import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@fiador/verify': fileURLToPath(new URL('../packages/verify-ts/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['test/*.test.ts'] },
});
