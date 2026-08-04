/**
 * Egress seam (plan §2/§7): the one capability Flue does not abstract. The
 * POC ships only the Cloudflare (outbound-handler) consumer of this
 * interface; a Docker egress-proxy sidecar is future work behind the same
 * seam.
 *
 * Since the single-record refactor there is no separate egress store: the
 * per-session egress fields (egress_secrets, whitelist) and the opaque client
 * session_context live INSIDE THE session record (`session:<id>`, admin.js).
 * The only egress-owned key is the container pointer:
 *
 *   container:<containerId> -> sessionId
 *
 * It exists because outbound handlers receive ONLY ctx.containerId and
 * idFromName() is one-way — the pointer is the reverse index for the one
 * party that starts from the container side. Every other code path holds the
 * session id and simply computes the container id.
 *
 * Handlers resolve pointer -> session record on EVERY invocation — no
 * closure/module caching (plan §7/§9.2: the handler registry is
 * isolate-global, caching bleeds across concurrent sessions). Missing
 * pointer or record means DENY ALL egress (fail-closed).
 */
import { mergeSessionRecord, readSession } from './admin.js';

export const CONTAINER_KEY_PREFIX = 'container:';
export const DEFAULT_SECRET_TTL_SECONDS = 24 * 60 * 60;
export const SESSION_CONTEXT_MAX_BYTES = 8 * 1024;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Does `host` match a single whitelist glob? Supports an exact host or a
 * `*.suffix` subdomain wildcard. `*.semantius.ai` matches `tests.semantius.ai`
 * but NOT the bare apex `semantius.ai`, nor look-alikes like
 * `evil-semantius.ai` or `tests.semantius.ai.evil.com` (the leading dot in the
 * suffix is load-bearing).
 */
function hostMatchesPattern(host, pattern) {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // keep the leading dot: ".semantius.ai"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

/** True when `host` matches any glob in `whitelist` (an agent's proxyWhitelist). */
export function isWhitelistedHost(host, whitelist) {
  return whitelist.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * Pick the credential for `host` out of an `egress_secrets` map: host glob ->
 * credential, matched with the same globber as the whitelist, so an entry can
 * cover a whole subdomain family (`*.partner.example`) or one exact host.
 * First match wins (POC cardinality — one or two entries per session).
 *
 * Undefined means "this container has no credential for that host", which the
 * caller MUST treat as deny, not as "forward unauthenticated" (see
 * injectAndForward).
 *
 * @param {Record<string, unknown> | undefined} secrets
 * @param {string} host
 * @returns {string | undefined}
 */
export function egressSecretForHost(secrets, host) {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return undefined;
  for (const [pattern, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value && hostMatchesPattern(host, pattern)) return value;
  }
  return undefined;
}

/** The egress_secrets map off a record, or undefined when absent/malformed. */
function readEgressSecrets(record) {
  const secrets = record?.egress_secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) return undefined;
  const entries = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ---------------------------------------------------------------------------
// Container pointer + policy resolution over the session record.
// ---------------------------------------------------------------------------

/**
 * @param {{ put(k: string, v: string, o?: object): Promise<void> }} kv
 * @param {string} containerId
 * @param {string} sessionId
 * @param {number} [ttlSeconds]
 */
export async function putContainerPointer(kv, containerId, sessionId, ttlSeconds = DEFAULT_SECRET_TTL_SECONDS) {
  await kv.put(CONTAINER_KEY_PREFIX + containerId, sessionId, { expirationTtl: ttlSeconds });
}

/**
 * @param {{ delete(k: string): Promise<void> }} kv
 * @param {string} containerId
 */
export async function removeContainerPointer(kv, containerId) {
  await kv.delete(CONTAINER_KEY_PREFIX + containerId);
}

/**
 * The session id a container belongs to — the pointer read on its own, for
 * callers that need the id but not the egress slice. Since sandboxNameForSession
 * (config.js) dropped the user segment from container names, the container-side
 * `session` label no longer equals the session id, and this pointer is the ONLY
 * way back from a container/label to the full id: the costs join
 * (backend-b/src/costs.ts) and the DO's post-stop snapshot both resolve through
 * here. Null when the pointer is absent or expired.
 *
 * @param {{ get(k: string): Promise<string | null> }} kv
 * @param {string} containerId
 * @returns {Promise<string | null>}
 */
export async function sessionIdForContainer(kv, containerId) {
  return kv.get(CONTAINER_KEY_PREFIX + containerId);
}

/**
 * Resolve a container's egress policy: pointer -> session record -> the
 * egress-relevant slice. Null when the pointer or record is absent/expired —
 * DENY ALL. A record without a whitelist field is deny-all too ([]).
 *
 * The tenant a session acts on is NOT a separate stored field: it is
 * `session_context.semantius_org`, the org half of the user's verified token
 * (identity has exactly one home — see the ingest route). Sessions with no
 * verified user (channel conversations) resolve without one.
 *
 * Two credential shapes come back, deliberately kept apart:
 *  - `egressSecrets` — the record's `egress_secrets` map (host glob ->
 *    credential) for downstream services the SANDBOX NEVER SEES. Nothing is
 *    baked into the container, so the injection is zero-knowledge.
 *  - `context.semantius_jwt` — the session user's own token, the one credential
 *    that is NOT just an egress secret: the backend verifies it to authenticate
 *    the user (auth.js/identity.js) and egress additionally forwards it, so it
 *    lives with the identity in session_context and is swapped in through the
 *    sentinel (brokerEgress) because the vendored CLI insists on an env var.
 *
 * @param {{ get(k: string): Promise<string | null> }} kv
 * @param {string} containerId
 * @returns {Promise<{ sessionId: string, egressSecrets?: Record<string, string>, semantiusOrg?: string, whitelist: string[], context?: Record<string, unknown> } | null>}
 */
export async function resolveEgressPolicy(kv, containerId) {
  const sessionId = await sessionIdForContainer(kv, containerId);
  if (!sessionId) return null; // fail closed
  const record = await readSession(kv, sessionId);
  if (!record) return null; // fail closed
  const whitelist = Array.isArray(record.whitelist) ? record.whitelist.filter((h) => typeof h === 'string') : [];
  const context =
    record.session_context && typeof record.session_context === 'object' && !Array.isArray(record.session_context)
      ? record.session_context
      : undefined;
  const org = context?.semantius_org;
  const egressSecrets = readEgressSecrets(record);
  return {
    sessionId,
    ...(egressSecrets ? { egressSecrets } : {}),
    ...(typeof org === 'string' && org ? { semantiusOrg: org } : {}),
    whitelist,
    ...(context ? { context } : {}),
  };
}

/**
 * Per-message self-heal (agent initializer and the skill-check route): make
 * sure the pointer exists and the session record carries the bundle's
 * whitelist. Semantics preserved across refactors:
 *  - `egress_secrets` is NEVER created or modified here. The server must not
 *    generate or hardcode credential values anywhere — a secret-retrieval
 *    layer (resolving the tenant's secret REFERENCES from a vault/secrets
 *    store) is the only thing that may ever populate the map, and that layer
 *    does not exist yet (TODO; see the ingest route in backend-b/src/app.ts).
 *    Until it does, credential-required hosts fail closed (injectAndForward);
 *  - everything else on the record (session_context, payload, session_data,
 *    session_state, meta) is preserved by the merge, never reconstructed.
 * Writes only on change: a warm session costs two reads, zero writes.
 *
 * @param {{ get(k: string): Promise<string | null>, put(k: string, v: string, o?: object): Promise<void> }} kv
 * @param {string} containerId
 * @param {string} sessionId
 * @param {{ whitelist: string[] }} desired
 */
export async function ensureEgressPolicy(kv, containerId, sessionId, desired) {
  const record = (await readSession(kv, sessionId)) ?? {};
  const patch = {};
  const existingWhitelist = Array.isArray(record.whitelist) ? record.whitelist : null;
  if (JSON.stringify(existingWhitelist) !== JSON.stringify(desired.whitelist)) patch.whitelist = desired.whitelist;
  if (record.containerId !== containerId) patch.containerId = containerId;
  if (Object.keys(patch).length > 0) await mergeSessionRecord(kv, sessionId, patch);
  if ((await kv.get(CONTAINER_KEY_PREFIX + containerId)) !== sessionId) {
    await putContainerPointer(kv, containerId, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Egress response builders (pure over the resolved policy).
// ---------------------------------------------------------------------------

/**
 * Catch-all secret broker with a domain whitelist (plan §7 secret-at-egress).
 * The container holds only the placeholder `sentinel`; the real key lives here
 * in the Worker and never enters the sandbox. Policy per outbound request:
 *
 *   host whitelisted + sentinel present -> swap sentinel→secret in every header, forward
 *   host whitelisted + no sentinel      -> forward as-is (e.g. follow-up JWT calls)
 *   host NOT whitelisted                -> reject (a sentinel here is an
 *                                          exfiltration attempt — never leak the key)
 *
 * Session-context JWT precedence: when `policy.jwt` is present AND the host
 * matches `jwt.hosts`, the request's `Authorization` header is overwritten
 * with `Bearer <jwt.token>` — AFTER the whitelist gate (the 403 stays
 * authoritative) but BEFORE the sentinel scan, so the sentinel swap never
 * re-touches the injected header and a JWT-only request cannot 503 on a
 * missing worker-side secret. The session's user JWT thus takes precedence
 * over the shared API key; sessions without a JWT behave exactly as before.
 *
 * Matching is by substring, not whole-value equality: semantius sends the key
 * on an MCP `Authorization: Bearer <key>` header, so the value is
 * `Bearer __sak__` — replacing just the sentinel span preserves the `Bearer `
 * scheme; a bare `__sak__` value becomes exactly `secret`.
 *
 * @param {Request} request
 * @param {{ whitelist: string[], sentinel: string, secret: string | undefined, jwt?: { token: string, hosts: string[] } }} policy
 * @param {typeof fetch} fetchImpl
 */
export async function brokerEgress(request, policy, fetchImpl = fetch) {
  const { whitelist, sentinel, secret, jwt } = policy;
  const host = new URL(request.url).hostname;
  const headers = new Headers(request.headers);
  const sentinelPresent = [...headers].some(([, value]) => value.includes(sentinel));

  if (!isWhitelistedHost(host, whitelist)) {
    // Deny by default. If the request carried the sentinel this is an attempt to
    // send the real key somewhere it shouldn't go — reject WITHOUT swapping.
    return jsonResponse(403, {
      error: sentinelPresent
        ? 'egress denied: credential sentinel present but host not in whitelist'
        : 'egress denied: host not in whitelist',
      host,
    });
  }

  // Session-context JWT (see precedence note above): overwrite Authorization
  // before the sentinel scan so the swap below never sees the sentinel there.
  let jwtApplied = false;
  if (jwt?.token && isWhitelistedHost(host, jwt.hosts)) {
    headers.set('authorization', `Bearer ${jwt.token}`);
    jwtApplied = true;
  }

  // Collect first, then set — mutating Headers mid-iteration is unsafe.
  const hits = [];
  for (const [name, value] of headers) {
    if (value.includes(sentinel)) hits.push([name, value]);
  }

  // Whitelisted host, no credential to inject: legitimate follow-up traffic
  // (e.g. JWT-bearing MCP calls). Forward unchanged (mutated only by the JWT).
  if (hits.length === 0) return jwtApplied ? fetchImpl(new Request(request, { headers })) : fetchImpl(request);

  if (!secret) {
    // Never forward the raw placeholder.
    return jsonResponse(503, { error: 'egress misconfigured: no real secret bound server-side' });
  }
  for (const [name, value] of hits) headers.set(name, value.replaceAll(sentinel, secret));
  return fetchImpl(new Request(request, { headers }));
}

/**
 * Zero-knowledge credential injection for a downstream service: look the
 * request's host up in the session's `egress_secrets` and ADD the
 * `Authorization` header the sandbox never held — the container sends no
 * credential and no placeholder, so it cannot leak or misdirect one. Fails
 * closed when the session has no credential for that host (deleted session,
 * or a chat session whose policy self-healed without one — plan §13 C5).
 * Host-agnostic: the Cloudflare outbound handler calls this with its own fetch.
 *
 * Callers gate on the whitelist FIRST — this function assumes the host is
 * already allowed and only answers "which credential, if any".
 *
 * `x-semantius-org` rides along to say WHOSE tenant the session acts on; the
 * credential is what differs per session. A session with no verified user
 * carries no org header (channel conversations act on no Semantius tenant).
 *
 * @param {Request} request
 * @param {{ egressSecrets?: Record<string, string>, semantiusOrg?: string } | null | undefined} policy
 * @param {typeof fetch} fetchImpl
 */
export async function injectAndForward(request, policy, fetchImpl = fetch) {
  const host = new URL(request.url).hostname;
  const secret = egressSecretForHost(policy?.egressSecrets, host);
  if (!secret) {
    return jsonResponse(403, { error: 'egress denied: no credential mapping for this container', host });
  }
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${secret}`);
  if (policy?.semantiusOrg) headers.set('x-semantius-org', policy.semantiusOrg);
  return fetchImpl(new Request(request, { headers }));
}
