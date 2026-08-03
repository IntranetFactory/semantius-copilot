import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// `vite dev` stand-in for the deployed Worker rewrite (worker/index.ts):
// serve agent-shell.html at /agent/<name> so the dynamic page is reachable in
// dev under its real URL (the page reads the name from location.pathname).
// Deployed, `run_worker_first` does this instead — this middleware exists only
// because the dev server serves plain files.
function agentShellDevRewrite(): Plugin {
  return {
    name: 'agent-shell-dev-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/agent\/[a-z0-9-]+(?:\?|$)/.test(req.url)) req.url = '/agent-shell.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), agentShellDevRewrite()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Three fixed pages plus one shell, four bundles, one Worker: `/chat` is the
  // user chat page (Semantius token), `/copilot` is the same workbench
  // authenticated by a better-auth session cookie instead, `/admin` is the
  // admin console (data browser, costs, deployment API key), and
  // agent-shell.html is the single page behind every `/agent/<name>` URL (the
  // input-free per-agent chat; worker/index.ts rewrites those paths here at
  // runtime, so agents deployed after this build still get a page). Separate
  // entries so the user pages never ship the admin code — the split is the
  // point, not a routing detail. Workers assets serve each <name>.html at
  // /<name> via its default html_handling; there is deliberately NO
  // index.html, so `/` is a real 404 (see wrangler.jsonc's
  // not_found_handling).
  build: {
    rollupOptions: {
      input: {
        chat: fileURLToPath(new URL('./chat.html', import.meta.url)),
        copilot: fileURLToPath(new URL('./copilot.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
        'agent-shell': fileURLToPath(new URL('./agent-shell.html', import.meta.url)),
      },
    },
  },
  server: { port: 5173 },
});
