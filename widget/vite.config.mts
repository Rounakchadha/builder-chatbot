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
    // Lender logos are no longer imported into the source at all (security-review finding,
    // 2026-11-02: base64-inlining ~600KB of logos into this single script made the bundle 6.9MB) —
    // they're plain static files served from the API server and referenced by absolute url instead
    // (see resultCard.ts's logoHtml), so there's nothing left for Vite's asset pipeline to inline.
  },
  server: {
    port: 5173,
  },
});
