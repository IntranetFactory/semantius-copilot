/**
 * Shared between the three pages: the chat page (`/chat`, chat.html), the
 * copilot page (`/copilot`, copilot.html) and the admin console (`/admin`,
 * admin.html). They are separate builds on purpose — the user pages must not
 * carry the data browser, and their users never hold the deployment API key —
 * so anything more than one of them needs lives here.
 */
import { createFlueClient, type FlueClient } from '@flue/sdk';
import { BETTER_AUTH_COOKIE_HEADER, SKILL_NAME_RE } from '@hoth/core';
import { useEffect, useMemo, useState } from 'react';

/** One clickable starter prompt on the welcome card. The text sent (or
 * prefilled, when `prefill` is true) is `prompt ?? display`. */
export type WelcomePrompt = { display: string; prompt?: string; prefill?: boolean };
export type WelcomeSection = { title: string; subtitle?: string; prompts: WelcomePrompt[] };
/** Per-agent welcome card (agent.jsonc `welcome`) — shown by the chat UI while
 * a conversation is empty. UI-only: never part of the AgentSeed. */
export type AgentWelcome = { title: string; subtitle?: string; sections?: WelcomeSection[] };

export type AgentBundle = {
  agentName: string;
  version: string;
  baseImage: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  proxyWhitelist?: string[];
  welcome?: AgentWelcome;
  skills: Record<string, Record<string, string>>;
};

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
 * Names of every deployed agent (`GET /agents`) — the RUNTIME agent registry.
 * There is no build-time agent list anywhere in this UI: agents deploy to
 * backend KV independently of any frontend build (`pnpm deploy:agent <name>`),
 * so the pages ask the backend which agents exist. Auth-gated like the rest of
 * the user surface — callable only once a credential is present.
 */
export async function fetchAgentNames(auth: ChatAuth): Promise<string[]> {
  const response = await fetch(`${BACKEND.baseUrl}/agents`, { headers: authHeaders(auth) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${payload?.error ?? 'could not list agents'}`);
  return Array.isArray(payload?.agents) ? (payload.agents as string[]) : [];
}

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
 * Where each page lives. THE single source of truth for the paths — the three
 * fixed pages are implicit in Workers assets (filename + html_handling), and
 * the `/agent/<name>` family is the frontend Worker's one rewrite
 * (frontend/worker/index.ts), so nothing else may hardcode any of them. `/` is
 * not a page: it is a real 404.
 */
export const CHAT_PAGE = '/chat';
export const COPILOT_PAGE = '/copilot';
export const ADMIN_PAGE = '/admin';
export const AGENT_PAGE_PREFIX = '/agent';

/** Deep link to the chat page, optionally opening one session. */
export function chatPageUrl(sessionId?: string): string {
  return sessionId ? `${CHAT_PAGE}#session=${encodeURIComponent(sessionId)}` : CHAT_PAGE;
}

/** Deep link to one agent's input-free page, optionally opening one session. */
export function agentPageUrl(name: string, sessionId?: string): string {
  const base = `${AGENT_PAGE_PREFIX}/${encodeURIComponent(name)}`;
  return sessionId ? `${base}#session=${encodeURIComponent(sessionId)}` : base;
}

/**
 * The agent name an `/agent/<name>` page was opened for, from its pathname —
 * the inverse of `agentPageUrl`. Accepts a stray `.html` suffix (the shell
 * asset addressed by filename) and rejects anything that is not a well-formed
 * agent name, so a direct hit on the shell yields undefined, not a bogus name.
 */
export function agentNameFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(`${AGENT_PAGE_PREFIX}/`)) return undefined;
  const name = pathname.slice(AGENT_PAGE_PREFIX.length + 1).replace(/\.html$/, '');
  return SKILL_NAME_RE.test(name) && name.length <= 64 ? name : undefined;
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
 * Read the credentials (and optionally a session id) out of the URL fragment —
 * `#jwt=<org>:<jwt>` and/or `#cookie=<value>`, either with `&session=<id>`.
 * That is how a link, or the admin console's "Open chat", hands one over. The
 * fragment never reaches the server; it is consumed once at mount and every
 * credential key is stripped from the address bar — also the key a page does
 * not use, so a mis-addressed link never leaves a credential sitting there.
 * Which key(s) a page honors is the page's call: /chat reads `jwt`, /copilot
 * reads `cookie`, /agent/<name> reads both (the bearer wins server-side).
 *
 * Call once per mount (via useMemo): it mutates history.
 */
export function consumeCredentialFragment(): { jwt?: string; cookie?: string; session?: string } {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  const jwt = params.get('jwt') ?? undefined;
  const cookie = params.get('cookie') ?? undefined;
  const session = params.get('session') ?? undefined;
  if (jwt || cookie) {
    // Don't leave a credential sitting in the address bar. (It stays in browser
    // history for this entry either way — a link-borne credential is a
    // convenience for POC/automation, not a way to keep one secret.)
    params.delete('jwt');
    params.delete('cookie');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `#${rest}` : ''}`);
  }
  return { jwt, cookie, session };
}

/**
 * Conversation-scoped client (v2: no deployment-wide client, no name/id).
 *
 * `auth` is the USER'S own credential: the chat surface authenticates every
 * request with it and the backend re-verifies it upstream, so a refreshed
 * credential takes effect on the next request and an expired one stops the
 * conversation. The SDK resolves `headers` on every request — including each
 * stream reconnection — so a cookie-authenticated conversation streams exactly
 * like a bearer one. The agent seed is NOT attached here: AgentChat owns the
 * meta and wraps the client via `withAgentSeed`.
 */
export function useConversationClient(
  auth: ChatAuth,
  sessionId?: string,
  urlFor: (sessionId: string) => string = conversationUrl,
) {
  // Destructured to primitives BEFORE the dependency array: `auth` is a fresh
  // object literal on every render, which would defeat the memo entirely.
  const bearer = 'bearer' in auth ? auth.bearer : '';
  const cookie = 'cookie' in auth ? auth.cookie : '';
  return useMemo(() => {
    if (!sessionId || !(bearer || cookie)) return undefined;
    return createFlueClient({
      url: urlFor(sessionId),
      ...(bearer ? { token: bearer } : { headers: { [BETTER_AUTH_COOKIE_HEADER]: cookie } }),
    });
  }, [bearer, cookie, sessionId, urlFor]);
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
 * Cached per agent name for the page's lifetime: the draft → live key-flip
 * remounts AgentChat, and the remounted instance must see the meta
 * SYNCHRONOUSLY — its first send creates the Flue instance, and that is the
 * only send whose `initialData` counts. AgentChat blocks draft submits until
 * the meta is here, so the cache is always warm by then.
 */
const metaCache = new Map<string, AgentMeta>();

/**
 * One agent's live definition meta (`GET /agents/:name/meta`): the turn-1 seed
 * plus the welcome card, straight from the backend registry — the runtime
 * counterpart of `fetchAgentNames`, and the only place the UI learns what an
 * agent is. 404 = the name names no deployed agent.
 */
export function useAgentMeta(auth: ChatAuth, agentName?: string): { meta?: AgentMeta; metaError?: string } {
  const bearer = 'bearer' in auth ? auth.bearer : '';
  const cookie = 'cookie' in auth ? auth.cookie : '';
  const meta = agentName ? metaCache.get(agentName) : undefined;
  const [result, setResult] = useState<{ name: string; error?: string }>();
  useEffect(() => {
    if (!agentName || meta || !(bearer || cookie)) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${BACKEND.baseUrl}/agents/${encodeURIComponent(agentName)}/meta`, {
          headers: authHeaders(bearer ? { bearer } : { cookie }),
        });
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setResult({ name: agentName, error: String(payload?.error ?? `could not load agent (${response.status})`) });
        } else {
          metaCache.set(agentName, payload as AgentMeta);
          setResult({ name: agentName }); // re-render so the cache read above picks it up
        }
      } catch (err) {
        if (!cancelled) setResult({ name: agentName, error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentName, meta, bearer, cookie]);
  return { meta, metaError: !meta && result && result.name === agentName ? result.error : undefined };
}
