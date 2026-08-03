/**
 * Chat/session machinery for the agent chat surface — auth, client
 * construction, session creation, and agent-meta loading. Everything in here
 * (and this folder) is app-agnostic: no page paths, no localStorage keys, no
 * workspace imports, so the whole `components/ai-elements/` folder can be
 * copied into another app as-is. Hoth-specific page wiring lives in
 * src/pages.ts; the admin console's helpers live in src/App.tsx.
 *
 * The backend contract this module speaks (any backend-b-shaped Worker):
 *   GET  /agents                 names of every deployed agent
 *   GET  /agents/:name/meta      one agent's welcome card + turn-1 seed
 *   GET  /sessions               the caller's own sessions (whitelisted meta)
 *   POST /sessions/agent         create a session (server mints the id)
 *   /agents/main/:sessionId      the conversation (flue v2 + SSE)
 */
import { createFlueClient, type FlueClient } from '@flue/sdk';
import { useEffect, useMemo, useState } from 'react';

import type { AgentWelcome } from './welcome';

/**
 * The header a browser page sends the better-auth session cookie VALUE in
 * (`cookie` auth mode below) — a page cannot set a real `Cookie` header from
 * fetch. Mirrors the canonical constant in core/src/identity.js; inlined so
 * this folder carries no workspace imports.
 */
const BETTER_AUTH_COOKIE_HEADER = 'x-better-auth-cookie';

/**
 * Instance-creation seed for conversations: the definition meta minus the
 * skill files. Sent as `initialData` with EVERY send (Flue consults it only on
 * the send that creates the instance, ignores it afterwards), so the agent's
 * very first model turn already runs with the right instructions and model —
 * state written in useAgentStart only lands after turn 1.
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

/** What `GET /agents/:name/meta` answers: the seed fields plus the welcome card. */
export type AgentMeta = AgentSeed & { welcome?: AgentWelcome };

/**
 * Hoth's own backend location — the DEFAULT `baseUrl` everywhere in this
 * module. Another app embedding this folder passes its backend's URL instead
 * (AgentChatContainer's `baseUrl` prop); the env read is optional-chained so
 * non-Vite bundlers don't crash on `import.meta.env`.
 */
export const BACKEND = {
  label: 'Backend',
  baseUrl: import.meta.env?.VITE_AGENTBACKEND_URL ?? 'http://localhost:3584',
} as const;

/** The one conversation URL a v2 FlueClient addresses (main mount + session id). */
export const conversationUrl = (sessionId: string, baseUrl: string = BACKEND.baseUrl) =>
  `${baseUrl}/agents/main/${encodeURIComponent(sessionId)}`;

/**
 * What the chat surface authenticates its requests with:
 *
 *   bearer      the user's own Semantius token (`<org>:<jwt>`) — sent as
 *               `Authorization: Bearer`.
 *   authCookie  a better-auth session cookie VALUE — sent in a custom header
 *               (a page cannot set `Cookie` from fetch), which the backend
 *               turns back into a real cookie on its server-to-server hop.
 *   ambient     NO explicit credential: every request goes out with
 *               `credentials: 'include'`, so the BROWSER attaches its own
 *               better-auth cookie for the backend's domain. Requires the
 *               backend to be same-site with the page (and in its CORS
 *               allowlist); a missing/invalid browser session answers 401,
 *               which the UI renders as signed-out.
 *
 * Server-side precedence when several arrive at once: bearer first, then the
 * custom header, then the browser's cookie jar (core/src/auth.js).
 */
export type ChatAuth = { bearer: string } | { authCookie: string } | { ambient: true };

/** The request headers one ChatAuth becomes. Ambient sends none — the
 * credential is the browser's own cookie, attached by `authFetchInit`. */
export function authHeaders(auth: ChatAuth): Record<string, string> {
  if ('bearer' in auth) return { authorization: `Bearer ${auth.bearer}` };
  if ('authCookie' in auth) return { [BETTER_AUTH_COOKIE_HEADER]: auth.authCookie };
  return {};
}

/** The fetch init one ChatAuth needs — the single place ambient mode turns
 * into `credentials: 'include'`. Spread it into every backend fetch. */
export function authFetchInit(auth: ChatAuth): RequestInit {
  return 'ambient' in auth
    ? { headers: authHeaders(auth), credentials: 'include' }
    : { headers: authHeaders(auth) };
}

/** Whether this auth can attempt a request at all. Ambient always can — the
 * browser may hold a session cookie the page cannot see; the backend's 401 is
 * the only authoritative "signed out". */
export function hasCredential(auth: ChatAuth): boolean {
  if ('ambient' in auth) return true;
  return ('bearer' in auth ? auth.bearer : auth.authCookie).length > 0;
}

/**
 * Names of every deployed agent (`GET /agents`) — the RUNTIME agent registry.
 * There is no build-time agent list anywhere in this UI: agents deploy to
 * backend KV independently of any frontend build (`pnpm deploy:agent <name>`),
 * so the pages ask the backend which agents exist.
 */
export async function fetchAgentNames(auth: ChatAuth, baseUrl: string = BACKEND.baseUrl): Promise<string[]> {
  const response = await fetch(`${baseUrl}/agents`, authFetchInit(auth));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${payload?.error ?? 'could not list agents'}`);
  return Array.isArray(payload?.agents) ? (payload.agents as string[]) : [];
}

/** One entry of `GET /sessions` — whitelisted session meta, never the record. */
export type SessionListEntry = {
  id: string;
  agentName?: string;
  version?: string;
  /** ISO-8601 UTC; entries arrive newest-first. */
  createdAt?: string;
};

/** What `GET /sessions` answers: the caller's sessions plus WHOSE they are —
 * the identity the listing was scoped to. A browser can hold several
 * credentials (jwt, cookie, ambient), and without the echo an empty list is
 * indistinguishable from "listed as somebody else". */
export type SessionListing = {
  sessions: SessionListEntry[];
  user?: { org?: string; sub?: string; email?: string; name?: string };
};

/**
 * The caller's own sessions (`GET /sessions`), newest first. Tenant-scoped
 * server-side (the id's tenant prefix narrows the KV listing, then each
 * record's owner is re-checked), so the answer is exactly the sessions this
 * credential may reopen. Deliberately NOT agent-filtered here — entries carry
 * `agentName`, and a single-agent surface narrows client-side.
 */
export async function fetchSessions(auth: ChatAuth, baseUrl: string = BACKEND.baseUrl): Promise<SessionListing> {
  const response = await fetch(`${baseUrl}/sessions`, authFetchInit(auth));
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${payload?.error ?? 'could not list sessions'}`);
  // STRICT on a 200: a body that is not `{ sessions: [...] }` is an error, not
  // an empty list — coercing it to [] would render the "no sessions yet" state
  // for a truncated/rewritten response and hide the failure entirely.
  if (!payload || !Array.isArray(payload.sessions)) {
    throw new Error(
      payload === null
        ? 'malformed /sessions answer — body was not JSON'
        : `malformed /sessions answer — ${JSON.stringify(payload).slice(0, 120)}`,
    );
  }
  return {
    sessions: payload.sessions as SessionListEntry[],
    user: payload?.user && typeof payload.user === 'object' ? (payload.user as SessionListing['user']) : undefined,
  };
}

/** What `POST /sessions/agent` answers on success. */
export type SessionCreateInfo = {
  sessionId: string;
  agentName?: string;
  version?: string;
  user?: { org?: string; sub?: string; email?: string; name?: string };
};

/**
 * Create a session (`POST /sessions/agent`). Name-based: the definition must
 * already be deployed to KV via `pnpm deploy:agent <name>` — 404 otherwise.
 * The credential travels in the headers, so nothing credential- or
 * tenant-shaped goes in the body: the org and the user come from what the
 * backend verifies. The SESSION ID comes back from the server — the id
 * carries the tenant (`<org>-<sub>-<random>`), and an id a browser picked
 * would let a client stamp any tenant it liked on its own KV keys.
 */
export async function createAgentSession(
  auth: ChatAuth,
  agentName: string,
  baseUrl: string = BACKEND.baseUrl,
): Promise<SessionCreateInfo> {
  const init = authFetchInit(auth);
  const response = await fetch(`${baseUrl}/sessions/agent`, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(auth) },
    body: JSON.stringify({ agentName }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${payload?.error ?? JSON.stringify(payload)}`);
  const id = payload?.sessionId;
  if (typeof id !== 'string' || !id) {
    throw new Error(`session create returned no sessionId: ${JSON.stringify(payload)}`);
  }
  return payload as SessionCreateInfo;
}

/**
 * Conversation-scoped client (v2: no deployment-wide client, no name/id).
 *
 * `auth` is the USER'S credential: the surface authenticates every request
 * with it and the backend re-verifies it upstream, so a refreshed credential
 * takes effect on the next request and an expired one stops the conversation.
 * The SDK resolves headers/fetch on every request — including each stream
 * reconnection — so cookie- and ambient-authenticated conversations stream
 * exactly like bearer ones. The agent seed is NOT attached here: AgentChat
 * owns the meta and wraps the client via `withAgentSeed`.
 */
export function useConversationClient(
  auth: ChatAuth,
  sessionId?: string,
  urlFor: (sessionId: string) => string = conversationUrl,
) {
  // Destructured to primitives BEFORE the dependency array: `auth` is a fresh
  // object literal on every render, which would defeat the memo entirely.
  const bearer = 'bearer' in auth ? auth.bearer : '';
  const authCookie = 'authCookie' in auth ? auth.authCookie : '';
  const ambient = 'ambient' in auth;
  return useMemo(() => {
    if (!sessionId || !(ambient || bearer || authCookie)) return undefined;
    return createFlueClient({
      url: urlFor(sessionId),
      // The SDK routes EVERY request — sends, history, the SSE stream and its
      // reconnects — through this fetch, so ambient mode rides on one wrapper.
      ...(ambient
        ? { fetch: ((input, init) => fetch(input, { ...init, credentials: 'include' })) as typeof fetch }
        : bearer
          ? { token: bearer }
          : { headers: { [BETTER_AUTH_COOKIE_HEADER]: authCookie } }),
    });
  }, [ambient, bearer, authCookie, sessionId, urlFor]);
}

/**
 * The same client with one agent seed attached to every send (`initialData` —
 * Flue consults it only on the send that creates the instance, ignores it
 * afterwards, so this is idempotent by contract). The agent's very first model
 * turn already runs with the right instructions and model.
 */
export function withAgentSeed(client: FlueClient, seed: AgentSeed): FlueClient {
  return {
    ...client,
    send: (opts: Parameters<FlueClient['send']>[0]) => client.send({ ...opts, initialData: seed }),
  };
}

/** The seed one meta carries, ready for `withAgentSeed` (drops the UI-only welcome). */
export function seedFromMeta(meta: AgentMeta): AgentSeed {
  const { welcome: _welcome, ...seed } = meta;
  return seed;
}

/**
 * Cached per backend + agent name for the page's lifetime: the draft → live
 * key-flip remounts AgentChat, and the remounted instance must see the meta
 * SYNCHRONOUSLY — its first send creates the Flue instance, and that is the
 * only send whose `initialData` counts. AgentChat blocks draft submits until
 * the meta is here, so the cache is always warm by then.
 */
const metaCache = new Map<string, AgentMeta>();

/**
 * One agent's live definition meta (`GET /agents/:name/meta`): the turn-1 seed
 * plus the welcome card, straight from the backend registry — the runtime
 * counterpart of `fetchAgentNames`, and the only place the UI learns what an
 * agent is. `metaStatus` carries the HTTP status of a failure so callers can
 * tell 401 (signed out — AgentChatContainer's signed-out notice) from 404
 * (the name names no deployed agent — AgentChat's error card).
 */
export function useAgentMeta(
  auth: ChatAuth,
  agentName?: string,
  baseUrl: string = BACKEND.baseUrl,
): { meta?: AgentMeta; metaError?: string; metaStatus?: number } {
  const bearer = 'bearer' in auth ? auth.bearer : '';
  const authCookie = 'authCookie' in auth ? auth.authCookie : '';
  const ambient = 'ambient' in auth;
  const cacheKey = agentName ? `${baseUrl}|${agentName}` : undefined;
  const meta = cacheKey ? metaCache.get(cacheKey) : undefined;
  const [result, setResult] = useState<{ key: string; error?: string; status?: number }>();
  useEffect(() => {
    if (!agentName || !cacheKey || meta || !(ambient || bearer || authCookie)) return;
    let cancelled = false;
    (async () => {
      const requestAuth: ChatAuth = ambient ? { ambient: true } : bearer ? { bearer } : { authCookie };
      try {
        const response = await fetch(
          `${baseUrl}/agents/${encodeURIComponent(agentName)}/meta`,
          authFetchInit(requestAuth),
        );
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setResult({
            key: cacheKey,
            error: String(payload?.error ?? `could not load agent (${response.status})`),
            status: response.status,
          });
        } else {
          metaCache.set(cacheKey, payload as AgentMeta);
          setResult({ key: cacheKey }); // re-render so the cache read above picks it up
        }
      } catch (err) {
        if (!cancelled) setResult({ key: cacheKey, error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentName, cacheKey, meta, ambient, bearer, authCookie, baseUrl]);
  const failed = !meta && result && result.key === cacheKey ? result : undefined;
  return { meta, metaError: failed?.error, metaStatus: failed?.status };
}
