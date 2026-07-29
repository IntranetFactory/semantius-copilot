import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Two pages, two bundles, one Worker: `/` is the admin console (data browser,
  // deployment API key) and `/chat` is the user chat page (Semantius token
  // only). Separate entries so the chat page never ships the admin code — the
  // split is the point, not a routing detail. Workers assets serve chat.html
  // at /chat via its default html_handling.
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        chat: fileURLToPath(new URL('./chat.html', import.meta.url)),
      },
    },
  },
  server: { port: 5173 },
});
