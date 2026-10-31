import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@builder-chatbot/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
