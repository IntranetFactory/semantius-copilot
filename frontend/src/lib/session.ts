/**
 * Shared between the two pages: the admin console (`/`, index.html) and the
 * chat page (`/chat`, chat.html). They are separate builds on purpose — the
 * chat page must not carry the data browser, and its user never holds the
 * deployment API key — so anything both need lives here.
 */
import { createFlueClient } from '@flue/sdk';
import { skillCatalogFromBundle } from '@hoth/core';
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

/** Deployment API key — ADMIN console only. Never read by the chat page. */
export const API_KEY_STORAGE = 'hoth-api-key';
/** The user's Semantius token (`<org>:<jwt>`) — CHAT page only. */
export const TOKEN_STORAGE = 'hoth-semantius-jwt';

/** Where the chat page lives, for links out of the admin console. */
export const CHAT_PAGE = '/chat';

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
 * Conversation-scoped client (v2: no deployment-wide client, no name/id).
 *
 * `token` is the USER'S Semantius token: the chat surface authenticates every
 * request as `Authorization: Bearer <org>:<jwt>` and the backend re-verifies it
 * against the issuer, so a refreshed token takes effect on the next request and
 * an expired one stops the conversation. With a seed, `send` always carries it
 * as `initialData` — only the instance-creating send records it, so this is
 * idempotent by contract.
 */
export function useConversationClient(
  token: string,
  sessionId?: string,
  seed?: AgentSeed,
  urlFor: (sessionId: string) => string = conversationUrl,
) {
  return useMemo(() => {
    if (!sessionId || !token) return undefined;
    const client = createFlueClient({ url: urlFor(sessionId), token });
    if (!seed) return client;
    return {
      ...client,
      send: (opts: Parameters<typeof client.send>[0]) => client.send({ ...opts, initialData: seed }),
    };
  }, [token, sessionId, seed, urlFor]);
}
