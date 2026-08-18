/**
 * POC-wide constants shared by both backends (code sharing only — the
 * backends share no runtime resources, design §13 C5).
 */

/** The mock Hoth Tourism API (HTTP echo endpoint, design §7/§14). */
export const ECHO_HOST = 'postman-echo.com';

/**
 * Placeholder the sandbox is given in place of the session user's Semantius
 * JWT. The container only ever holds this sentinel — no real credential enters
 * the sandbox. The catch-all egress handler scans EVERY outbound request header
 * and swaps any occurrence of this sentinel for the session's JWT (see
 * brokerEgress in egress.js and the `secret` it is called with in
 * backend-b/src/cloudflare.ts). Keep this value in sync with the
 * `ENV SEMANTIUS_JWT` line baked into the backend's Dockerfile.
 *
 * The image bakes it as `SEMANTIUS_JWT` (NOT `SEMANTIUS_API_KEY`): what the
 * sandbox authenticates with is the user's own token for this session, not a
 * shared org key. The other half of that pair, `SEMANTIUS_ORG`, cannot be baked
 * at all — it is per session (the `<org>` half of the user's token), applied to
 * the container by provisionSemantiusEnv (`core/src/sandbox-env.js`).
 */
export const SEMANTIUS_JWT_SENTINEL = '__sak__';

/**
 * Semantius API hosts eligible for session-context JWT injection at egress, and
 * the scope of the sentinel->JWT swap (brokerEgress `policy.jwt` and
 * `policy.secretHosts`). Mirrors the semantius-admin agent's proxy_whitelist.
 *
 * The JWT must never ride to non-Semantius hosts, so this list is deliberately
 * INDEPENDENT of the egress allow list — and that independence became
 * load-bearing once an ORG could contribute `*` to the allow list (a firewall
 * turned off). Where the sandbox may talk and where its credential may travel
 * are different questions; only this constant answers the second one.
 */
export const SEMANTIUS_HOSTS = ['*.semantius.ai', 'www.semantius.com'];

// The egress allow list has TWO sources, unioned at read time by
// resolveEgressPolicy:
//   agent.jsonc `proxy_whitelist` -> bundle `proxyWhitelist` -> the `whitelist`
//     field of THE session record (rewritten from the bundle every message);
//   the org's copilot settings (POST /session/copilot at session creation) ->
//     the `org_whitelist` field (written once; `['*']` when the org's firewall
//     is off).
// Both are resolved at egress via the container pointer. Neither present means
// DENY-ALL egress. See core/agent.schema.json and core/src/egress.js.

/** Default LLM settings; override per-worker with the LLM_PROVIDER /
 * LLM_MODEL / LLM_BASE_URL vars and the LLM_API_KEY secret. Provider
 * "cloudflare" uses the Workers AI binding and needs no key. */
export const DEFAULT_LLM = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };

/**
 * Env-driven LLM setup. Registers any provider
 * override and returns the model specifier to hand to useModel().
 *
 * LLM_PROVIDER: "cloudflare" (AI binding, keyless) | "openrouter" |
 * "custom" (any OpenAI-compatible endpoint at LLM_BASE_URL). LLM_API_KEY and
 * LLM_BASE_URL apply to every provider except "cloudflare". Takes a
 * registerProvider(name, { api?, baseUrl?, apiKey? }) adapter as a parameter
 * so core stays dependency-free — each backend's llm.ts implements it (on
 * Flue v2 via setProvider + Pi's createProvider).
 */
export function configureLlm(registerProvider, env) {
  const provider = env.LLM_PROVIDER || DEFAULT_LLM.provider;
  const model = env.LLM_MODEL || DEFAULT_LLM.model;
  if (provider === 'custom') {
    if (!env.LLM_BASE_URL) throw new Error('LLM_PROVIDER=custom requires LLM_BASE_URL');
    registerProvider('custom', {
      api: 'openai-completions',
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
    });
  } else if (provider !== 'cloudflare' && (env.LLM_API_KEY || env.LLM_BASE_URL)) {
    // Built-in provider: keeps its model catalog, overrides transport/auth.
    registerProvider(provider, {
      ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
      ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
    });
  }
  return `${provider}/${model}`;
}

/**
 * durable-streams protocol response headers that the browser client MUST be
 * able to read. The Flue agent conversation endpoint (`/agents/:name/:id`)
 * carries the stream cursor in these headers — `Stream-Up-To-Date` and
 * `Stream-Next-Offset` above all. Cross-origin (the frontend Worker and these
 * backend Workers are different origins), the Fetch spec hides every response
 * header from JS EXCEPT the CORS-safelisted ones UNLESS the server names it in
 * `Access-Control-Expose-Headers`. Without this, the long-poll client never
 * observes `Stream-Up-To-Date`, so it never reaches "up-to-date", never
 * advances its offset, never switches to a held long-poll — and busy-polls
 * catch-up reads at network speed forever (a request flood when a stored
 * conversation is opened). curl sees the headers and works; the browser can't.
 * Pass this to Hono's `cors({ exposeHeaders })` in both backends.
 */
export const STREAM_PROTOCOL_HEADERS = [
  'Stream-Next-Offset',
  'Stream-Cursor',
  'Stream-Up-To-Date',
  'Stream-Closed',
  'Stream-Seq',
  'Stream-TTL',
  'Stream-Expires-At',
  'Stream-SSE-Data-Encoding',
  'Producer-Id',
  'Producer-Epoch',
  'Producer-Seq',
  'Producer-Expected-Seq',
  'Producer-Received-Seq',
];

/** Session ids are server-minted (design §6/§9.6). The id itself is only a KV
 * key suffix and a DO name (neither cares about length) — the sandbox SDK's
 * 63-char sanitizeSandboxId limit applies to the CONTAINER name, which is the
 * id's random tail alone (sandboxNameForSession below), never the full id. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{6,159}[a-z0-9]$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !id.startsWith('-') && !id.endsWith('-');
}

/**
 * TENANT-PREFIXED SESSION IDS — `<org>-<sub>-<32 hex>`, e.g.
 * `tests-user3-1ea1a17e8e68456ab587986db90a4fc9` or, for a UUID sub,
 * `tests-019d78248034755eb95e88f46bb2c8dc-1ea1a17e8e68456ab587986db90a4fc9`.
 *
 * The identity segments ride VERBATIM (lowercased, separators stripped) — a
 * user id is never truncated or hashed into the id. What made truncation look
 * necessary was the sandbox SDK's 63-char sanitizeSandboxId ceiling, but that
 * ceiling binds the CONTAINER name, not the session id: the container is named
 * by the id's random tail alone (sandboxNameForSession), which drops the
 * tenant from the DNS-label role entirely. The session id itself is only a KV
 * key suffix (512-byte budget) and a DO name (unbounded).
 *
 * Why the prefix: the tenant used to live only INSIDE the session record
 * (`session_context.semantius_org`), so "every session of org X" meant reading
 * every value, and a cross-tenant mistake was invisible in a key listing. In
 * the id it rides every key derived from the id (`session:<id>`, `agent:<id>`),
 * so KV prefix listing is tenant-scoped and the data browser shows ownership
 * without opening a record.
 *
 * Why hyphens, not colons: `:` would break `kvGroupOf` (split on the FIRST
 * colon, admin.js), which is what keeps `session:`/`agent:` grouping intact —
 * the reason the tenant goes INSIDE the id rather than in front of the group
 * prefix.
 *
 * Why the caps: the org segment must fit the CONTAINER name beside the tail
 * (sandbox name = `<org>-<tail>` ≤ 63 ⇒ org ≤ 30), and the sub cap is a
 * generous guard, not identity policy — no real IdP sub exceeds 64
 * alphanumerics; the hash fallback beyond a cap only exists so a pathological
 * value cannot blow the budgets. Both identity segments are HYPHEN-FREE by
 * construction (compaction strips separators; the fallback concatenates
 * head+hash without one), so every minted id is exactly three `-`-separated
 * parts — which is what lets the sandbox name be re-derived from the id
 * alone. Worst case id: 30 + 1 + 64 + 1 + 32 = 128 (SESSION_ID_MAX).
 *
 * Why server-minted: a prefix the caller chooses proves nothing. The org/sub
 * pair comes from the verified bearer (the ingest route's `semantiusUser`),
 * never from the client — which until this change generated the whole id in the
 * browser and could therefore have claimed any tenant it liked.
 *
 * NOT every conversation id has this shape: channel conversations are keyed by
 * their channel's instance id (`github:v1:owner:…`) and have no Semantius user
 * at all. `isValidSessionId` stays the shape gate for routes that take an id.
 */
export const SESSION_ID_MAX = 128;
export const SESSION_ORG_SEGMENT_MAX = 30;
export const SESSION_SUB_SEGMENT_MAX = 64;

/** FNV-1a (32-bit), 6 hex chars. A stable, dependency-free disambiguator for
 * identity values that do not survive slugging — NOT a security primitive. */
function shortHash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * One id segment from an identity value: its COMPACTED form (lowercased,
 * separators stripped) whenever that fits the cap — `user3` stays `user3`,
 * and a UUID sub becomes its 32 hex chars verbatim, so the segment IS the
 * user id, not an abbreviation of it. Only a value whose alphanumeric content
 * exceeds the cap falls back to truncation plus a hash of the ORIGINAL, which
 * keeps over-long values from sharing a prefix past the cut. The fallback
 * concatenates head and hash WITHOUT a separator: segments must stay
 * hyphen-free so a minted id is always exactly `<org>-<sub>-<tail>` and the
 * sandbox name can be re-derived from the id alone (sandboxNameForSession).
 *
 * Stripping separators does erase them (`user-3` and `user3` compact alike) —
 * accepted: identity values within one provider share a format, and ownership
 * never rests on the prefix (the chat gate and the listing both re-check the
 * record's full `session_context.user`).
 *
 * @param {unknown} value
 * @param {number} max segment length ceiling
 */
export function sessionIdSegment(value, max) {
  const raw = String(value ?? '');
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (compact && compact.length <= max) return compact;
  const head = compact.slice(0, Math.max(1, max - 6)) || 'x';
  return `${head}${shortHash(raw)}`;
}

/** The prefix every session id of this (org, sub) starts with — the unit of
 * tenant-scoped KV listing (`session:<prefix>`). */
export function sessionTenantPrefix(org, sub) {
  return `${sessionIdSegment(org, SESSION_ORG_SEGMENT_MAX)}-${sessionIdSegment(sub, SESSION_SUB_SEGMENT_MAX)}-`;
}

/**
 * Mint a session id for a VERIFIED (org, sub). Callers must pass the identity
 * the token guard resolved, never anything from a request body.
 *
 * @param {string} org
 * @param {string} sub
 * @param {() => string} [uuid] injectable for tests
 */
export function mintSessionId(org, sub, uuid = () => crypto.randomUUID()) {
  const id = `${sessionTenantPrefix(org, sub)}${uuid().replace(/-/g, '')}`;
  // Unreachable given the segment caps; an assert rather than a code path,
  // because an over-long id would silently blow the KV key budget downstream
  // instead of failing here.
  if (id.length > SESSION_ID_MAX || !isValidSessionId(id)) {
    throw new Error(`minted an unusable session id (${id.length} chars)`);
  }
  return id;
}

/**
 * The random tail of a minted id — everything after the tenant prefix. The
 * tail never contains a hyphen and always comes last, so it is the final `-`
 * segment however many hyphens the org/sub segments contributed.
 *
 * Use this (not a slice of the whole id) wherever a session needs a SHORT
 * label: the id's head is now the tenant prefix, identical for every session of
 * one user, and a label taken off the id's end reads as a suffix nobody can
 * match against a full id. `sessionIdTail(id).slice(0, 8)` is the git-style
 * short form.
 */
export function sessionIdTail(id) {
  const parts = String(id ?? '').split('-');
  return parts[parts.length - 1] ?? '';
}

/**
 * The name a session's SANDBOX CONTAINER goes by — `<org>-<tail>`, the USER
 * segment dropped. The container name is the one consumer bound by the
 * sandbox SDK's 63-char DNS-label ceiling (it is spliced into preview
 * hostnames): the org keeps the tenant visible on the container, the tail is
 * the unique part, and the user id — the only segment that cannot be bounded
 * without mangling it — stays out of the DNS-label role entirely
 * (org ≤30 + 1 + 32 = 63 worst case). Re-derivable from the id alone because
 * minted ids are exactly `<org>-<sub>-<tail>` with hyphen-free segments.
 * Every getSandbox()/idFromName() call and the `container:<containerId>`
 * pointer MUST derive from this one function — a single site using the full
 * id would boot a second container for the same session.
 *
 * Channel conversation ids (`github:v1:…`) contain no hyphen and pass through
 * whole — their sandbox naming is unchanged by this indirection.
 *
 * @param {string} id session/conversation id
 */
export function sandboxNameForSession(id) {
  const value = String(id ?? '');
  if (!value.includes('-')) return value;
  return `${value.split('-')[0]}-${sessionIdTail(value)}`;
}
