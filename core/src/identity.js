/**
 * Semantius user identity (host-agnostic).
 *
 * A chat session is opened on behalf of a REAL Semantius user. There are TWO
 * ways to prove who that user is, and both end at the SAME verdict object
 * (`{ ok: true, org, jwt, user }`) so nothing downstream — session-id minting,
 * the ownership gate, egress injection — has to know which one was used:
 *
 *   BEARER (verifySemantiusToken)  the client sends its own access token as
 *     `Authorization: Bearer <org>:<jwt>`. The token travels as `<org>:<jwt>`
 *     (what `pnpm mint-token` prints) because a bare JWT does not say which org
 *     issued it, and the org is what selects the tenant host: every Semantius
 *     org has its own subdomain. Verification is a live call to the org's OIDC
 *     userinfo endpoint (`https://<org>.semantius.cloud/api/auth/oauth2/userinfo`)
 *     with the JWT as a bearer — the issuer decides whether the token is good,
 *     so no key material, JWKS fetch, or clock handling lives here. A 2xx with
 *     a `sub` claim is the only accepted outcome; the endpoint answers 400
 *     `invalid_request` for an expired, malformed, or foreign token, and an
 *     unknown org resolves to a host that answers the same way.
 *
 *   COOKIE (verifySemantiusCookie)  the client sends a better-auth session
 *     cookie instead — what a user who signed in to the legacy app already
 *     holds, and the only credential a copilot embed can present. Two
 *     server-to-server calls turn it into the same verdict: `GET /session`
 *     validates the cookie and answers with the user, `POST /session/token`
 *     exchanges it for the JWT the sandbox needs at egress. See below.
 *
 * The bearer sent upstream is the BARE jwt: the `<org>:` prefix is this POC's
 * transport convention, never part of the credential. Callers persist the two
 * halves separately for the same reason (see the ingest route).
 *
 * A THIRD server-to-server call sits beside the exchange but is not part of
 * authentication: `POST /session/copilot` (fetchCopilotSettings) reads the
 * ORG's copilot settings — may this org use copilot at all, and what egress does
 * it permit. It runs once at session creation, not on the auth path.
 */
import { sanitizeAllowlist } from './egress.js';

/** A Semantius org slug — the subdomain label, so DNS-label shaped. */
export const SEMANTIUS_ORG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Compact JWS: three non-empty base64url segments. A cheap shape gate that
 * keeps obvious junk (and anything with a stray `:`) from reaching the network. */
const COMPACT_JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Told to clients on rejection — never echo the token itself back. */
export const SEMANTIUS_TOKEN_HINT = 'expected "<org>:<jwt>" — mint one with `pnpm mint-token`';

/** The OIDC userinfo endpoint of one org's tenant host. */
export function semantiusUserInfoUrl(org) {
  return `https://${org}.semantius.cloud/api/auth/oauth2/userinfo`;
}

/**
 * Split the transport form into its two halves. Null when the value is not
 * `<org>:<jwt>` with a plausible org and compact JWS. Splits on the FIRST
 * colon only — the JWT itself never contains one.
 *
 * @param {unknown} value
 * @returns {{ org: string, jwt: string } | null}
 */
export function parseSemantiusToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return null;
  const org = trimmed.slice(0, colon).toLowerCase();
  const jwt = trimmed.slice(colon + 1).trim();
  if (!SEMANTIUS_ORG_RE.test(org) || !COMPACT_JWS_RE.test(jwt)) return null;
  return { org, jwt };
}

/** The claims we keep — the identity of the human behind the session. Anything
 * else the issuer returns is dropped: this lands in THE session record. */
function projectClaims(claims) {
  const pick = (key, type) => (typeof claims[key] === type ? { [key]: claims[key] } : {});
  return {
    ...pick('sub', 'string'),
    ...pick('name', 'string'),
    ...pick('email', 'string'),
    ...pick('email_verified', 'boolean'),
  };
}

/**
 * Verify an `<org>:<jwt>` token against its org's userinfo endpoint and return
 * the user behind it. Never throws: a network failure is a rejection like any
 * other, so a caller can map every `ok: false` onto one 401.
 *
 * @param {unknown} value the raw `<org>:<jwt>` bearer value
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<
 *   | { ok: true, org: string, jwt: string, user: { org: string, sub: string, verifiedAt: string } }
 *   | { ok: false, error: string, status?: number }
 * >}
 */
export async function verifySemantiusToken(value, fetchImpl = fetch) {
  const parsed = parseSemantiusToken(value);
  if (!parsed) return { ok: false, error: `malformed semantius_jwt (${SEMANTIUS_TOKEN_HINT})` };
  const { org, jwt } = parsed;
  const url = semantiusUserInfoUrl(org);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' },
    });
  } catch (err) {
    return { ok: false, error: `userinfo unreachable at ${url}: ${String(err).slice(0, 200)}` };
  }

  if (!response.ok) {
    // The issuer's own words help a caller tell "expired" from "wrong org".
    const detail = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: `userinfo ${response.status} from ${url}: ${detail.slice(0, 200)}` };
  }

  const claims = await response.json().catch(() => null);
  if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string' || !claims.sub) {
    return { ok: false, error: `userinfo at ${url} returned no sub claim` };
  }

  return {
    ok: true,
    org,
    jwt,
    user: { org, ...projectClaims(claims), verifiedAt: new Date().toISOString() },
  };
}

// --- BETTER-AUTH SESSION COOKIE -------------------------------------------

/**
 * The cookie better-auth writes, in both of its spellings: `__Secure-` prefixed
 * over HTTPS (production), bare over plain HTTP. Forwarded verbatim to
 * `/session`, which matches the value against both names internally.
 */
export const BETTER_AUTH_COOKIE_NAMES = ['__Secure-better-auth.session_token', 'better-auth.session_token'];

/**
 * How a BROWSER hands us that cookie — two transports, both read by
 * extractSessionCookie below:
 *
 *   1. This custom header, carrying the cookie VALUE. A page cannot set a
 *      `Cookie` header from fetch (forbidden header name), so a CROSS-SITE
 *      page (the workers.dev copilot page) pastes/forwards the value and the
 *      backend turns it back into a proper `Cookie` header on the
 *      server-to-server hop. Custom request headers need no CORS change:
 *      Hono's `cors()` echoes `Access-Control-Request-Headers` back when
 *      `allowHeaders` is unset. Inherently CSRF-proof (custom headers force a
 *      preflight).
 *
 *   2. A real `Cookie` header, attached by the browser itself when a
 *      SAME-SITE page fetches with `credentials: 'include'` ("ambient" mode —
 *      no explicit credential in the app at all). This requires the backend's
 *      credentialed CORS allowlist (ALLOWED_ORIGINS in backend-b) and its
 *      CSRF origin check, both in backend-b/src/app.ts, and a cookie whose
 *      Domain covers the backend host. Server-to-server callers use the same
 *      shape.
 */
export const BETTER_AUTH_COOKIE_HEADER = 'x-better-auth-cookie';

/** Told to clients on rejection — never echo the cookie itself back. */
export const SEMANTIUS_COOKIE_HINT =
  `send the better-auth session cookie as \`${BETTER_AUTH_COOKIE_HEADER}: <value>\` or a normal Cookie header`;

/** The session host's default. Overridable per-worker (SEMANTIUS_SESSION_BASE_URL). */
export const SEMANTIUS_SESSION_BASE_URL = 'https://api.semantius.cloud';

/** Cookie values are `<token>.<signature>`: no semicolons, commas, or whitespace.
 * A cheap shape gate, so junk never reaches the network — and so nothing can
 * smuggle a second cookie into the header we build. */
const SESSION_COOKIE_RE = /^[^\s;,]+$/;

/** Default validity requested from /session/token — 24 h, the session TTL. */
const SESSION_TOKEN_EXPIRES_IN = 24 * 60 * 60;

/** How long an exchanged JWT is reused before a fresh one is minted. Far below
 * its own 24 h validity, so a cached token is never close to expiring. */
export const SESSION_JWT_CACHE_TTL_SECONDS = 60 * 60;

/** KV prefix for the exchange cache. Keyed by the cookie's HASH — see below. */
export const SESSION_JWT_KEY_PREFIX = 'authjwt:';

/** The server-to-server session endpoints of the shared better-auth host. */
export function semantiusSessionUrl(baseUrl = SEMANTIUS_SESSION_BASE_URL) {
  return `${String(baseUrl).replace(/\/+$/, '')}/session`;
}
export function semantiusSessionTokenUrl(baseUrl = SEMANTIUS_SESSION_BASE_URL) {
  return `${String(baseUrl).replace(/\/+$/, '')}/session/token`;
}
export function semantiusSessionCopilotUrl(baseUrl = SEMANTIUS_SESSION_BASE_URL) {
  return `${String(baseUrl).replace(/\/+$/, '')}/session/copilot`;
}

/**
 * Pull a better-auth session cookie out of a request's headers. Returns the raw
 * cookie VALUE (never a `name=value` pair) or null.
 *
 * Both transports are accepted, custom header first:
 *   `x-better-auth-cookie: <value>`  what a browser page can actually send.
 *   `Cookie: __Secure-better-auth.session_token=<value>`  the documented
 *       server-to-server shape (and what a same-site deployment would send).
 *
 * @param {{ get(name: string): string | null | undefined }} headers Headers, or
 *   anything with the same `get` (Hono's `c.req.header` is passed wrapped).
 * @returns {string | null}
 */
export function extractSessionCookie(headers) {
  const direct = headers.get(BETTER_AUTH_COOKIE_HEADER);
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const jar = headers.get('cookie');
  if (typeof jar !== 'string' || !jar) return null;
  for (const pair of jar.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!BETTER_AUTH_COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(eq + 1).trim();
    if (value) return value;
  }
  return null;
}

/** SHA-256, hex. The cookie is a live credential, so only its DIGEST is ever
 * used as a cache key — the cookie itself is never written to KV. */
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a better-auth session cookie and return the user behind it, in the
 * SAME verdict shape as verifySemantiusToken — that equivalence is the whole
 * design: every caller downstream (session-id minting, the ownership gate, the
 * write-on-change JWT refresh, egress injection) stays identical.
 *
 * Two upstream calls, both server-to-server against the shared better-auth host:
 *
 *   GET  /session        AUTHENTICATION. Validates the cookie and answers
 *        `{ session, user }`, where `user` already carries exactly the claims
 *        this repo projects (`org`, `sub`, `name`, `email`) — so the org needs
 *        no guessing and no second identity lookup. 401 when the session is
 *        missing, invalid, or expired. Run on EVERY request: it is the authn,
 *        and it is what notices a signed-out or revoked session.
 *   POST /session/token  AUTHORIZATION MATERIAL. Trades the cookie (plus our
 *        `x-jwt-exchange-api-key`) for a real Semantius JWT — the credential
 *        the sandbox acts with at egress, since a cookie is useless there.
 *        CACHED, keyed by the cookie's hash: without a cache every chat request
 *        would mint a fresh 24 h token AND rewrite it onto the session record.
 *
 * The exchanged JWT is deliberately NOT re-verified against OIDC userinfo: the
 * cookie was just validated by the issuer, and the JWT came from the issuer over
 * TLS authenticated with our own exchange key. This does mean `/session`'s
 * `user.sub` must be the same value userinfo reports as `sub` — the ownership
 * gate compares `{ org, sub }`, so if they ever diverged, a session created with
 * a bearer could not be opened with a cookie (and vice versa).
 *
 * Never throws: a network failure is a rejection like any other, so a caller can
 * map every `ok: false` onto one 401.
 *
 * @param {unknown} value the raw session cookie value
 * @param {{ baseUrl?: string, exchangeKey: string, kv?: { get(k: string): Promise<string|null>, put(k: string, v: string, o?: object): Promise<unknown> }, expiresIn?: number }} options
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<
 *   | { ok: true, org: string, jwt: string, user: { org: string, sub: string, verifiedAt: string } }
 *   | { ok: false, error: string, status?: number }
 * >}
 */
export async function verifySemantiusCookie(value, options, fetchImpl = fetch) {
  const { baseUrl = SEMANTIUS_SESSION_BASE_URL, exchangeKey, kv, expiresIn = SESSION_TOKEN_EXPIRES_IN } = options ?? {};
  if (typeof value !== 'string' || !SESSION_COOKIE_RE.test(value)) {
    return { ok: false, error: 'malformed better-auth session cookie' };
  }
  if (typeof exchangeKey !== 'string' || !exchangeKey) {
    return { ok: false, error: 'session cookie auth unavailable: no JWT exchange key bound server-side' };
  }

  // 1. AUTHENTICATE. The cookie header is rebuilt here from the value alone, so
  //    whatever else sat in the caller's jar never travels upstream.
  const sessionUrl = semantiusSessionUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(sessionUrl, {
      headers: { cookie: `${BETTER_AUTH_COOKIE_NAMES[0]}=${value}`, accept: 'application/json' },
    });
  } catch (err) {
    return { ok: false, error: `session endpoint unreachable at ${sessionUrl}: ${String(err).slice(0, 200)}` };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: `session ${response.status} from ${sessionUrl}: ${detail.slice(0, 200)}` };
  }

  const body = await response.json().catch(() => null);
  const claims = body && typeof body === 'object' ? body.user : null;
  if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string' || !claims.sub) {
    return { ok: false, error: `session at ${sessionUrl} returned no user.sub` };
  }
  const org = typeof claims.org === 'string' ? claims.org.toLowerCase() : '';
  if (!SEMANTIUS_ORG_RE.test(org)) {
    return { ok: false, error: `session at ${sessionUrl} returned no usable user.org (the session has no active organization)` };
  }

  // 2. THE SANDBOX'S CREDENTIAL. Cache hit only when the cached token belongs to
  //    the org the session is CURRENTLY active in — switching organization must
  //    not keep acting on the previous tenant.
  const cacheKey = kv ? `${SESSION_JWT_KEY_PREFIX}${await sha256Hex(value)}` : null;
  if (cacheKey) {
    const cached = await kv.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed?.org === org && COMPACT_JWS_RE.test(parsed?.jwt ?? '')) {
          return { ok: true, org, jwt: parsed.jwt, user: { org, ...projectClaims(claims), verifiedAt: new Date().toISOString() } };
        }
      } catch {
        // Unparseable cache entry: fall through and mint a fresh one.
      }
    }
  }

  const tokenUrl = semantiusSessionTokenUrl(baseUrl);
  let exchange;
  try {
    exchange = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-jwt-exchange-api-key': exchangeKey },
      body: JSON.stringify({ sessionCookie: value, expiresIn }),
    });
  } catch (err) {
    return { ok: false, error: `token exchange unreachable at ${tokenUrl}: ${String(err).slice(0, 200)}` };
  }
  if (!exchange.ok) {
    const detail = await exchange.text().catch(() => '');
    return { ok: false, status: exchange.status, error: `session/token ${exchange.status} from ${tokenUrl}: ${detail.slice(0, 200)}` };
  }

  const minted = await exchange.json().catch(() => null);
  // The field name is not pinned by the docs — accept the three plausible
  // spellings rather than couple to one. The shape gate below is what actually
  // decides whether we got a JWT.
  const jwt = [minted?.token, minted?.access_token, minted?.jwt].find((t) => typeof t === 'string' && COMPACT_JWS_RE.test(t));
  if (!jwt) {
    return { ok: false, error: `token exchange at ${tokenUrl} returned no compact JWS` };
  }

  if (cacheKey) {
    await kv
      .put(cacheKey, JSON.stringify({ org, jwt }), { expirationTtl: SESSION_JWT_CACHE_TTL_SECONDS })
      .catch(() => {}); // a cache that cannot be written is slow, not broken
  }

  return { ok: true, org, jwt, user: { org, ...projectClaims(claims), verifiedAt: new Date().toISOString() } };
}

/**
 * Read the COPILOT SETTINGS of the organization a session is currently active
 * in: `POST /session/copilot`, the same server-to-server shape as the token
 * exchange above (`x-jwt-exchange-api-key` + the cookie in the body), answering
 * the copilot columns of that org.
 *
 *   copilotEnabled            may this org use copilot at all? False is a hard
 *                             stop — the caller refuses to create a session.
 *   copilotFirewallEnabled    false means the org runs UNFIRewalled; the caller
 *                             turns that into the `*` allow-list entry.
 *   copilotFirewallAllowlist  the org's egress allow list, merged (union) with
 *                             the agent's own proxy_whitelist at the egress
 *                             seam. Hostnames or URLs, `*` anywhere — see
 *                             matchesEgressPattern in egress.js.
 *
 * Called ONCE PER SESSION, at creation (backend-b/src/app.ts), and the answer is
 * persisted on the session record. Not per request and not cached: unlike the
 * exchanged JWT this is not a credential that expires, and re-reading it on
 * every chat message would put a second upstream round-trip on the hot path for
 * a value that only changes when an admin changes it.
 *
 * BOTH BOOLEANS DEFAULT TO THE RESTRICTIVE READING. A body that omits or
 * mistypes `copilotEnabled` is not enabled, and one that omits
 * `copilotFirewallEnabled` is firewalled — a malformed answer must never be the
 * thing that opens egress up.
 *
 * Never throws, same as verifySemantiusCookie: every failure is a verdict.
 *
 * @param {unknown} value the raw session cookie value
 * @param {{ baseUrl?: string, exchangeKey: string }} options
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<
 *   | { ok: true, enabled: boolean, firewallEnabled: boolean, allowlist: string[] }
 *   | { ok: false, error: string, status?: number }
 * >}
 */
export async function fetchCopilotSettings(value, options, fetchImpl = fetch) {
  const { baseUrl = SEMANTIUS_SESSION_BASE_URL, exchangeKey } = options ?? {};
  if (typeof value !== 'string' || !SESSION_COOKIE_RE.test(value)) {
    return { ok: false, error: 'malformed better-auth session cookie' };
  }
  if (typeof exchangeKey !== 'string' || !exchangeKey) {
    return { ok: false, error: 'copilot settings unavailable: no JWT exchange key bound server-side' };
  }

  const url = semantiusSessionCopilotUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-jwt-exchange-api-key': exchangeKey },
      body: JSON.stringify({ sessionCookie: value }),
    });
  } catch (err) {
    return { ok: false, error: `copilot settings unreachable at ${url}: ${String(err).slice(0, 200)}` };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: `session/copilot ${response.status} from ${url}: ${detail.slice(0, 200)}` };
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return { ok: false, error: `copilot settings at ${url} returned no JSON object` };
  }
  return {
    ok: true,
    enabled: body.copilotEnabled === true,
    firewallEnabled: body.copilotFirewallEnabled !== false,
    allowlist: sanitizeAllowlist(body.copilotFirewallAllowlist),
  };
}
