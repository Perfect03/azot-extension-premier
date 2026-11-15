import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['azot/vitest'],
    alias: { eme: fileURLToPath(new URL('./test/eme.ts', import.meta.url)) },
  },
});
