/**
 * POC-wide constants shared by both backends (code sharing only — the
 * backends share no runtime resources, plan §13 C5).
 */

/** The mock Hoth Tourism API (HTTP echo endpoint, plan §7/§14). */
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
 * Semantius API hosts eligible for session-context JWT injection at egress
 * (see brokerEgress `policy.jwt`). Mirrors the semantius-admin agent's
 * proxy_whitelist: the JWT must never ride to non-Semantius hosts, so the
 * injection is scoped to these patterns independently of the (per-agent)
 * egress whitelist.
 */
export const SEMANTIUS_HOSTS = ['*.semantius.ai', 'www.semantius.com'];

// The egress whitelist is PER AGENT since the proxy_whitelist refactor:
// agent.jsonc `proxy_whitelist` -> bundle `proxyWhitelist` -> the `whitelist`
// field of THE session record, resolved at egress via the container pointer
// (resolveEgressPolicy). An agent without the property gets DENY-ALL egress.
// See core/agent.schema.json and core/src/egress.js.

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

/** Session ids are server-minted (plan §6/§9.6). This shape is a fixed point of
 * the sandbox SDK's sanitizeSandboxId, which keeps `containerId =
 * idFromName(id)` derivable in the Worker. */
export const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{6,61}[a-z0-9]$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !id.startsWith('-') && !id.endsWith('-');
}

/**
 * TENANT-PREFIXED SESSION IDS — `<org>-<sub>-<32 hex>`, e.g.
 * `tests-user3-1ea1a17e8e68456ab587986db90a4fc9`.
 *
 * Why the prefix: the tenant used to live only INSIDE the session record
 * (`session_context.semantius_org`), so "every session of org X" meant reading
 * every value, and a cross-tenant mistake was invisible in a key listing. In
 * the id it rides every key derived from the id (`session:<id>`, `agent:<id>`),
 * so KV prefix listing is tenant-scoped and the data browser shows ownership
 * without opening a record.
 *
 * Why hyphens, not colons: `:` would survive the SDK's sanitizeSandboxId (it
 * validates, it does not rewrite), but the id is also spliced into
 * `sandbox-<id>` and into container preview hostnames, which are DNS labels.
 * Hyphens keep every downstream use legal. It also keeps `kvGroupOf` (split on
 * the FIRST colon, admin.js) grouping by `session`/`agent` — the reason the
 * tenant goes INSIDE the id rather than in front of the group prefix.
 *
 * Why the caps: sanitizeSandboxId rejects ids over 63 characters, so both label
 * segments are bounded and the random tail is a v4 UUID with its dashes
 * stripped — 16 + 1 + 12 + 1 + 32 = 62 in the worst case.
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
export const SESSION_ID_MAX = 63;
export const SESSION_ORG_SEGMENT_MAX = 16;
export const SESSION_SUB_SEGMENT_MAX = 12;

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
 * One id segment from an identity value: the value itself when it is already a
 * short lowercase label (`tests`, `user3` — the common case), otherwise a
 * truncated slug plus a hash of the ORIGINAL. The hash is what keeps the
 * segment injective: without it a truncated long org, or two subs differing
 * only past the cut, would share a prefix and silently break tenant scoping.
 *
 * @param {unknown} value
 * @param {number} max segment length ceiling
 */
export function sessionIdSegment(value, max) {
  const raw = String(value ?? '');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug && slug === raw.toLowerCase() && slug.length <= max) return slug;
  const head = slug.slice(0, Math.max(1, max - 7)).replace(/-+$/, '') || 'x';
  return `${head}-${shortHash(raw)}`;
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
  // because an over-long id would be rejected by the sandbox SDK at the far end
  // of provisioning instead of here.
  if (id.length > SESSION_ID_MAX || !isValidSessionId(id)) {
    throw new Error(`minted an unusable session id (${id.length} chars)`);
  }
  return id;
}
