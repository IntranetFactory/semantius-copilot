import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Three pages, three bundles, one Worker: `/chat` is the user chat page
  // (Semantius token), `/copilot` is the same workbench authenticated by a
  // better-auth session cookie instead, and `/admin` is the admin console (data
  // browser, costs, deployment API key). Separate entries so the user pages
  // never ship the admin code — the split is the point, not a routing detail.
  // Workers assets serve each <name>.html at /<name> via its default
  // html_handling; there is deliberately NO index.html, so `/` is a real 404
  // (see wrangler.jsonc's not_found_handling).
  build: {
    rollupOptions: {
      input: {
        chat: fileURLToPath(new URL('./chat.html', import.meta.url)),
        copilot: fileURLToPath(new URL('./copilot.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  server: { port: 5173 },
});
