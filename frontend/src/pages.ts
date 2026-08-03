/**
 * Hoth's page map + credential bootstrap — everything about WHERE this app's
 * pages live and HOW they receive credentials. App-level on purpose: the
 * reusable chat surface (components/ai-elements/) must stay copyable into
 * other apps, and none of this — page paths, localStorage keys, URL-fragment
 * handover — travels with it. This module may import `@hoth/core` (the
 * ai-elements folder may not), and must never import react or @flue/* so the
 * frontend Worker (worker/index.ts) can share it without bundling either.
 *
 * The pages: `/chat` (chat.html), `/copilot` (copilot.html), `/admin`
 * (admin.html) are implicit in Workers assets (filename + html_handling); the
 * `/agent/<name>` family is the frontend Worker's one rewrite. `/` is not a
 * page: it is a real 404.
 */
import { SKILL_NAME_RE } from '@hoth/core';

/** Deployment API key — ADMIN console only. Never read by the user pages. */
export const API_KEY_STORAGE = 'hoth-api-key';
/** The user's Semantius token (`<org>:<jwt>`) — CHAT page only. */
export const TOKEN_STORAGE = 'hoth-semantius-jwt';
/** The user's better-auth session cookie VALUE — COPILOT page only. */
export const COOKIE_STORAGE = 'hoth-better-auth-cookie';

export const CHAT_PAGE = '/chat';
export const AGENT_PAGE_PREFIX = '/agent';

/** Deep link to the chat page, optionally opening one session. */
export function chatPageUrl(sessionId?: string): string {
  return sessionId ? `${CHAT_PAGE}#session=${encodeURIComponent(sessionId)}` : CHAT_PAGE;
}

/** Same naming rule as the backend's agent-name checks (agent names share the
 * skill-name charset) and the same 64-char cap. The single frontend copy —
 * the Worker's rewrite and the page's path parsing both call this. */
export const AGENT_NAME_MAX = 64;
export function isAgentName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && name.length <= AGENT_NAME_MAX;
}

/**
 * The agent name an `/agent/<name>` page was opened for, from its pathname.
 * Accepts a stray `.html` suffix (the shell asset addressed by filename) and
 * rejects anything that is not a well-formed agent name, so a direct hit on
 * the shell yields undefined, not a bogus name.
 */
export function agentNameFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(`${AGENT_PAGE_PREFIX}/`)) return undefined;
  const name = pathname.slice(AGENT_PAGE_PREFIX.length + 1).replace(/\.html$/, '');
  return isAgentName(name) ? name : undefined;
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
