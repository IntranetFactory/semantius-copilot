/**
 * The frontend Worker script — it exists ONLY for `/agent/<name>`.
 * `run_worker_first` routes just `/agent` and `/agent/*` here; every other
 * path is served straight from assets, exactly as before this file existed
 * (see wrangler.jsonc).
 *
 * `/agent/<name>` is runtime-dynamic: which agents exist is decided by the
 * backend KV registry (`agentdef:<name>`, deployed via `pnpm deploy:agent`),
 * not by the frontend build, so there cannot be one HTML asset per agent.
 * This worker rewrites every well-FORMED name to the single built shell
 * (`agent-shell.html`), and the page itself asks the backend whether the
 * agent is real (`GET /agents/:name/meta`). Ill-formed names and bare
 * `/agent` fall through to assets, where they match nothing and answer the
 * same bare 404 page as every other unknown path; a well-formed name that
 * names no deployed agent renders an in-page error instead — the accepted
 * trade-off of the dynamic design.
 */
import { isAgentName } from '../src/pages';

type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let name = url.pathname.slice('/agent/'.length); // '' for bare /agent
    if (name.endsWith('/')) name = name.slice(0, -1);
    try {
      name = decodeURIComponent(name);
    } catch {
      name = ''; // malformed percent-encoding — nothing an agent name can be
    }
    if (!isAgentName(name)) {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname !== `/agent/${name}`) {
      // Canonicalize `/agent/<name>/` and percent-encoded spellings. The
      // browser re-attaches a #cookie=/#session= fragment to the target.
      return Response.redirect(`${url.origin}/agent/${name}`, 307);
    }
    // Fetched extensionless: auto-trailing-slash serves agent-shell.html at
    // /agent-shell directly, with no normalization redirect to bounce back.
    // The page reads the agent name out of location.pathname.
    return env.ASSETS.fetch(new Request(new URL('/agent-shell', url), request));
  },
};
