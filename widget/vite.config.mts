import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
      fileName: () => 'widget.js',
    },
    cssCodeSplit: false,
    outDir: 'dist',
    // widget.js ships as a single embeddable <script> tag — lender logo PNGs (tens of KB each)
    // must be inlined as data URIs rather than emitted as separate files Vite's 4KB default would
    // otherwise produce, which the embed model has no way to deploy alongside the script.
    assetsInlineLimit: 300_000,
  },
  server: {
    port: 5173,
  },
});
