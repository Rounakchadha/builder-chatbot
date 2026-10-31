import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Same bundling setup as widget/vite.config.mts, just a different entry/output name — this is the
// original Finfinity green design (ported from "builder chatbot copy"), built as a SEPARATE
// standalone bundle (widget-finfinity.js) so switching a host page between the two designs is a
// one-line change (which script tag it loads), not a runtime theme flag inside a shared bundle.
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@builder-chatbot/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'LoanChatWidget',
      formats: ['iife'],
      fileName: () => 'widget-finfinity.js',
    },
    cssCodeSplit: false,
    outDir: 'dist',
    assetsInlineLimit: 300_000,
  },
  server: {
    port: 5174,
  },
});
