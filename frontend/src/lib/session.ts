/**
 * Shared between the three pages: the chat page (`/chat`, chat.html), the
 * copilot page (`/copilot`, copilot.html) and the admin console (`/admin`,
 * admin.html). They are separate builds on purpose — the user pages must not
 * carry the data browser, and their users never hold the deployment API key —
 * so anything more than one of them needs lives here.
 */
import { createFlueClient } from '@flue/sdk';
import { BETTER_AUTH_COOKIE_HEADER, skillCatalogFromBundle } from '@hoth/core';
import { useMemo } from 'react';

export type AgentBundle = {
  agentName: string;
  version: string;
  baseImage: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  proxyWhitelist?: string[];
  skills: Record<string, Record<string, string>>;
};

// Every agents/<name>/ folder the bundler built — eager glob import, so a new
// agent is picked up by re-running `pnpm bundle`, with no code change here.
const agentModules = import.meta.glob('../generated/agents/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, AgentBundle>;

export const AGENTS: Record<string, AgentBundle> = Object.fromEntries(
  Object.values(agentModules).map((bundle) => [bundle.agentName, bundle]),
);
export const AGENT_NAMES = Object.keys(AGENTS).sort();

/**
 * Instance-creation seed for conversations: the bundle meta minus the skill
 * files. Sent as `initialData` with EVERY send (Flue consults it only on the
 * send that creates the instance, ignores it afterwards), so the agent's very
 * first model turn already runs with the right instructions and model — state
 * written in useAgentStart only lands after turn 1.
 */
export type AgentSeed = {
  agentName: string;
  version: string;
  baseImage: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  /** Explicit skill catalog (name + description) so turn 1 mounts skills via useSkill(). */
  skillCatalog?: Array<{ name: string; description: string }>;
};

export const AGENT_SEEDS: Record<string, AgentSeed> = Object.fromEntries(
  Object.values(AGENTS).map((b) => {
    const skillCatalog = skillCatalogFromBundle(b);
    return [
      b.agentName,
      {
        agentName: b.agentName,
        version: b.version,
        baseImage: b.baseImage,
        instructions: b.instructions,
        ...(b.model ? { model: b.model } : {}),
        ...(b.modelBaseUrl ? { modelBaseUrl: b.modelBaseUrl } : {}),
        ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
      },
    ];
  }),
);

export const BACKEND = {
  label: 'Backend',
  baseUrl: import.meta.env.VITE_BACKEND_B_URL ?? 'http://localhost:3584',
} as const;

/** Deployment API key — ADMIN console only. Never read by the user pages. */
export const API_KEY_STORAGE = 'hoth-api-key';
/** The user's Semantius token (`<org>:<jwt>`) — CHAT page only. */
export const TOKEN_STORAGE = 'hoth-semantius-jwt';
/** The user's better-auth session cookie VALUE — COPILOT page only. */
export const COOKIE_STORAGE = 'hoth-better-auth-cookie';

/**
 * Where each page lives. THE single source of truth for the three paths — all
 * are implicit in Workers assets (filename + html_handling), so nothing else
 * may hardcode them. `/` is not a page: it is a real 404.
 */
export const CHAT_PAGE = '/chat';
export const COPILOT_PAGE = '/copilot';
export const ADMIN_PAGE = '/admin';

/** Deep link to the chat page, optionally opening one session. */
export function chatPageUrl(sessionId?: string): string {
  return sessionId ? `${CHAT_PAGE}#session=${encodeURIComponent(sessionId)}` : CHAT_PAGE;
}

/** The one conversation URL a v2 FlueClient addresses (main mount + session id). */
export const conversationUrl = (sessionId: string) =>
  `${BACKEND.baseUrl}/agents/main/${encodeURIComponent(sessionId)}`;

/**
 * The same conversation, read through the admin console's credential. The
 * backend mounts the agent router twice — `/agents/main/*` for the owner's
 * Semantius token, `/admin/agents/main/*` (read-only, GET only) for the
 * deployment key — so the data browser can show conversations without the
 * operator holding anyone's user token.
 */
export const adminConversationUrl = (sessionId: string) =>
  `${BACKEND.baseUrl}/admin/agents/main/${encodeURIComponent(sessionId)}`;

/**
 * What a page authenticates its chat requests with. The backend's chat gate
 * accepts either, bearer first (core/src/auth.js userTokenGuard):
 *
 *   bearer  the user's own Semantius token (`<org>:<jwt>`) — the chat page, and
 *           the admin console reading a conversation through its own key.
 *   cookie  a better-auth session cookie VALUE — the copilot page. It travels
 *           in a custom header, not a real Cookie header: a browser cannot set
 *           `Cookie` from fetch, and this backend is a different origin from
 *           the page, so a real cookie would never be sent at all.
 */
export type ChatAuth = { bearer: string } | { cookie: string };

/** The request headers one ChatAuth becomes. The single place either credential
 * is turned into a header — used for the plain POST /sessions/agent fetch and
 * by the conversation client below. */
export function authHeaders(auth: ChatAuth): Record<string, string> {
  return 'bearer' in auth
    ? { authorization: `Bearer ${auth.bearer}` }
    : { [BETTER_AUTH_COOKIE_HEADER]: auth.cookie };
}

/** Empty credential = nothing to authenticate with (an empty input box). */
export function hasCredential(auth: ChatAuth): boolean {
  return ('bearer' in auth ? auth.bearer : auth.cookie).length > 0;
}

/**
 * Read a credential (and optionally a session id) out of the URL fragment —
 * `#jwt=<org>:<jwt>` on /chat, `#cookie=<value>` on /copilot, either with
 * `&session=<id>`. That is how a link, or the admin console's "Open chat",
 * hands one over. The fragment never reaches the server; it is consumed once at
 * mount and the credential is stripped from the address bar.
 *
 * Call once per mount (via useMemo): it mutates history.
 *
 * @param param the fragment key holding the credential
 */
export function consumeCredentialFragment(param: 'jwt' | 'cookie'): { credential?: string; session?: string } {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const credential = params.get(param) ?? undefined;
  const session = params.get('session') ?? undefined;
  if (credential) {
    // Don't leave a credential sitting in the address bar. (It stays in browser
    // history for this entry either way — a link-borne credential is a
    // convenience for POC/automation, not a way to keep one secret.)
    params.delete(param);
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `#${rest}` : ''}`);
  }
  return { credential, session };
}

/**
 * Conversation-scoped client (v2: no deployment-wide client, no name/id).
 *
 * `auth` is the USER'S own credential: the chat surface authenticates every
 * request with it and the backend re-verifies it upstream, so a refreshed
 * credential takes effect on the next request and an expired one stops the
 * conversation. The SDK resolves `headers` on every request — including each
 * stream reconnection — so a cookie-authenticated conversation streams exactly
 * like a bearer one. With a seed, `send` always carries it as `initialData` —
 * only the instance-creating send records it, so this is idempotent by contract.
 */
export function useConversationClient(
  auth: ChatAuth,
  sessionId?: string,
  seed?: AgentSeed,
  urlFor: (sessionId: string) => string = conversationUrl,
) {
  // Destructured to primitives BEFORE the dependency array: `auth` is a fresh
  // object literal on every render, which would defeat the memo entirely.
  const bearer = 'bearer' in auth ? auth.bearer : '';
  const cookie = 'cookie' in auth ? auth.cookie : '';
  return useMemo(() => {
    if (!sessionId || !(bearer || cookie)) return undefined;
    const client = createFlueClient({
      url: urlFor(sessionId),
      ...(bearer ? { token: bearer } : { headers: { [BETTER_AUTH_COOKIE_HEADER]: cookie } }),
    });
    if (!seed) return client;
    return {
      ...client,
      send: (opts: Parameters<typeof client.send>[0]) => client.send({ ...opts, initialData: seed }),
    };
  }, [bearer, cookie, sessionId, seed, urlFor]);
}
