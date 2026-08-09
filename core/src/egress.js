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
 * Allow-list entries are globs in ONE grammar, shared by the agent's
 * `proxy_whitelist` and the org's `copilotFirewallAllowlist` (see
 * fetchCopilotSettings in identity.js). Two kinds, told apart by whether the
 * entry addresses a path:
 *
 *   HOST pattern   no `/` and no `://` — matched against the request's hostname
 *                  (port ignored):  `abc.com`, `*.abc.com`, `api.*.acme.io`
 *   URL pattern    has a scheme and/or a path — matched against the request's
 *                  URL:  `https://xxx/abc.com/*`, `x.com/abc/*`
 *   `*` alone      matches everything. This is what an org with the firewall
 *                  turned OFF contributes (copilotFirewallEnabled: false).
 *
 * `*` stands for any run of characters (including none) and may appear any
 * number of times, anywhere. Nothing else is special.
 *
 * A URL pattern that addresses NO PATH — `https://acme.io`, `https://*.acme.io`,
 * with or without a lone trailing `/` — covers THE WHOLE ORIGIN: the root and
 * every path under it. Anything else would make the most natural entry anyone
 * writes ("allow this site") mean "allow this site's root document and nothing
 * else", and silently deny every real request. It cannot leak sideways: the
 * implied `/` is as load-bearing as the dot in `*.suffix`, so `https://acme.io`
 * covers `acme.io/v1` but neither `acme.io.evil.com/v1` nor the SUBDOMAIN
 * `api.acme.io/v1` — a subdomain needs a wildcard in the host, exactly as it
 * does in a host pattern.
 *
 * The old `*.suffix`-only behavior is preserved by construction:
 * `*.semantius.ai` compiles to /^.*\.semantius\.ai$/, which matches
 * `tests.semantius.ai` but NOT the bare apex `semantius.ai`, nor look-alikes
 * like `evil-semantius.ai` or `tests.semantius.ai.evil.com` (the dot before the
 * suffix is load-bearing).
 */
const GLOB_META_RE = /[.*+?^${}()|[\]\\]/g;

/** One glob as regex source. `*` -> `.*`, everything else literal. */
function globSource(pattern) {
  return pattern
    .split('*')
    .map((part) => part.replace(GLOB_META_RE, '\\$&'))
    .join('.*');
}

/** Compile one glob to an anchored RegExp. `*` -> `.*`, everything else literal. */
function globToRegExp(pattern) {
  return new RegExp(`^${globSource(pattern)}$`);
}

/** A URL pattern addresses a scheme and/or a path; a host pattern does neither. */
function isUrlPattern(pattern) {
  return pattern.includes('://') || pattern.includes('/');
}

/** Where a URL pattern's path starts, or -1 when it addresses no path. A lone
 * trailing `/` is not a path: `https://acme.io/` is the same origin as
 * `https://acme.io` (candidates never carry a bare `/` either — see
 * urlMatchCandidates). */
function pathStartInPattern(pattern) {
  const afterScheme = pattern.indexOf('://');
  const authorityStart = afterScheme === -1 ? 0 : afterScheme + 3;
  const slash = pattern.indexOf('/', authorityStart);
  return slash === pattern.length - 1 ? -1 : slash;
}

/**
 * Lowercase a pattern's scheme+authority and leave its PATH as authored: an
 * allow list must not over-match, and paths are case-sensitive. `abc.com/API`
 * therefore does not allow `/api`, while `HTTPS://ABC.com/API` does allow
 * `https://abc.com/API`.
 */
function normalizeUrlPattern(pattern) {
  const afterScheme = pattern.indexOf('://');
  const authorityStart = afterScheme === -1 ? 0 : afterScheme + 3;
  const slash = pattern.indexOf('/', authorityStart);
  if (slash === -1) return pattern.toLowerCase();
  return pattern.slice(0, slash).toLowerCase() + pattern.slice(slash);
}

/**
 * The strings a URL pattern is tried against, in order. The authority is
 * lowercased and a bare `/` pathname is dropped, so `https://acme.io` matches a
 * request to the site root; the scheme-less forms let `x.com/abc/*` cover both
 * http and https; the `search`-bearing forms let a pattern opt into the query
 * string (`…/search?q=*`) without forcing every other pattern to account for one.
 *
 * @param {URL} url
 */
function urlMatchCandidates(url) {
  const scheme = url.protocol.toLowerCase(); // 'https:'
  const authority = url.host.toLowerCase(); // host[:port], default port already dropped by URL
  const path = url.pathname === '/' ? '' : url.pathname;
  const q = url.search;
  const base = `${scheme}//${authority}${path}`;
  const bare = `${authority}${path}`;
  return q ? [base, `${base}${q}`, bare, `${bare}${q}`] : [base, bare];
}

/**
 * Does one allow-list entry cover this request URL? See the grammar note above.
 *
 * @param {string | URL} url the full request URL
 * @param {string} pattern one allow-list entry
 */
export function matchesEgressPattern(url, pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  if (pattern === '*') return true; // the firewall-disabled marker
  const parsed = url instanceof URL ? url : new URL(url);
  if (!isUrlPattern(pattern)) {
    return globToRegExp(pattern.toLowerCase()).test(parsed.hostname.toLowerCase());
  }
  // Origin-only pattern: allow the origin itself and everything under it. The
  // `(/…)?` tail — never a bare `*` — is what keeps `https://acme.io` off
  // `acme.io.evil.com` while still covering `acme.io/v1/x`.
  const originOnly = pathStartInPattern(pattern) === -1;
  const source = globSource(normalizeUrlPattern(originOnly ? pattern.replace(/\/$/, '') : pattern));
  const re = new RegExp(originOnly ? `^${source}(/.*)?$` : `^${source}$`);
  return urlMatchCandidates(parsed).some((candidate) => re.test(candidate));
}

/**
 * THE egress gate: true when any entry in the effective allow list covers this
 * request. Callers pass the union of the agent's and the org's lists — see
 * resolveEgressPolicy.
 *
 * @param {string | URL} url
 * @param {string[]} allowlist
 */
export function isAllowedEgressUrl(url, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    return false; // an unparseable URL is not on any list
  }
  return allowlist.some((pattern) => matchesEgressPattern(parsed, pattern));
}

/**
 * HOST-ONLY matching, kept apart from isAllowedEgressUrl on purpose: it backs
 * the two scopes that must stay narrow no matter how wide the egress allow list
 * gets — the JWT-injection scope (SEMANTIUS_HOSTS) and the `egress_secrets`
 * credential map. Same glob grammar, but the pattern only ever sees a hostname.
 */
export function isWhitelistedHost(host, whitelist) {
  if (!Array.isArray(whitelist)) return false;
  const h = String(host).toLowerCase();
  return whitelist.some(
    (pattern) => typeof pattern === 'string' && pattern !== '' && globToRegExp(pattern.toLowerCase()).test(h),
  );
}

/** Per-entry cap, and the cap on an ORG list (the agent-side cap is
 * AGENT_LIMITS.maxWhitelistHosts, enforced at bundle validation). */
export const ALLOWLIST_ENTRY_MAX_CHARS = 255;
export const ORG_ALLOWLIST_MAX_ENTRIES = 64;

/** No whitespace, no control characters — an entry is one glob, never a list. */
function hasUnsafeChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Coerce an allow list that arrived from OUTSIDE this repo (the org's
 * `copilotFirewallAllowlist`) into entries this matcher can trust: strings
 * only, trimmed, no whitespace or control characters, bounded length and count,
 * deduped.
 *
 * Invalid entries are DROPPED, not fatal. Dropping can only ever make egress
 * more restrictive, so a malformed row upstream degrades to "less reachable",
 * never to "session refused" and never to "more reachable".
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function sanitizeAllowlist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value || value.length > ALLOWLIST_ENTRY_MAX_CHARS) continue;
    if (hasUnsafeChars(value)) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= ORG_ALLOWLIST_MAX_ENTRIES) break;
  }
  return out;
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
    if (typeof value === 'string' && value && isWhitelistedHost(host, [pattern])) return value;
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
 * The allow list this returns is the UNION OF TWO SOURCES, merged here and
 * nowhere else:
 *
 *   record.whitelist      the AGENT's proxy_whitelist. Re-written from the
 *                         bundle on every message by ensureEgressPolicy.
 *   record.org_whitelist  the ORG's contribution, read once from
 *                         POST /session/copilot at session creation and never
 *                         touched again — `['*']` when the org runs with its
 *                         copilot firewall OFF, its sanitized
 *                         copilotFirewallAllowlist when the firewall is on, and
 *                         `[]` for a session created without a session cookie.
 *
 * They are kept SEPARATE ON THE RECORD and unioned at READ time on purpose: the
 * per-message self-heal below rewrites the agent half from the bundle, so a
 * pre-merged field would lose the org half on the next turn.
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
  const strings = (value) => (Array.isArray(value) ? value.filter((h) => typeof h === 'string' && h) : []);
  const whitelist = [...strings(record.whitelist), ...strings(record.org_whitelist)];
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
 *  - `org_whitelist` is NEVER written or cleared here either. It comes from the
 *    org's copilot settings at session creation (backend-b/src/app.ts) and the
 *    self-heal has no cookie to re-fetch it with, so touching it would silently
 *    narrow a firewall-off session back to the agent's list. resolveEgressPolicy
 *    unions the two;
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
 * `policy.secretHosts` bounds the SWAP independently of the whitelist, and that
 * separation is load-bearing now that a whitelist can legitimately be `['*']`
 * (an org running with its copilot firewall off). Reachability and credential
 * scope are different questions: the org may widen where the sandbox can talk,
 * but it must never widen where the user's Semantius JWT can travel. A
 * sentinel-bearing request to a reachable host OUTSIDE that scope is rejected —
 * never forwarded with the placeholder, never with the real key.
 *
 * Matching is by substring, not whole-value equality: semantius sends the key
 * on an MCP `Authorization: Bearer <key>` header, so the value is
 * `Bearer __sak__` — replacing just the sentinel span preserves the `Bearer `
 * scheme; a bare `__sak__` value becomes exactly `secret`.
 *
 * @param {Request} request
 * @param {{ whitelist: string[], sentinel: string, secret: string | undefined, secretHosts?: string[], jwt?: { token: string, hosts: string[] } }} policy
 * @param {typeof fetch} fetchImpl
 */
export async function brokerEgress(request, policy, fetchImpl = fetch) {
  const { whitelist, sentinel, secret, secretHosts, jwt } = policy;
  const host = new URL(request.url).hostname;
  const headers = new Headers(request.headers);
  const sentinelPresent = [...headers].some(([, value]) => value.includes(sentinel));

  if (!isAllowedEgressUrl(request.url, whitelist)) {
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

  // Reachable, but out of the credential's scope (see the secretHosts note
  // above). The sandbox asked us to attach the user's JWT to a host that is
  // merely allowed, not trusted with it.
  if (secretHosts && !isWhitelistedHost(host, secretHosts)) {
    return jsonResponse(403, {
      error: 'egress denied: credential sentinel present but host is not in the credential scope',
      host,
    });
  }

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
