/**
 * Semantius user identity (host-agnostic).
 *
 * A chat session is opened on behalf of a REAL Semantius user, proven by the
 * access token the client sends as its own `Authorization: Bearer` on the user
 * surface (userTokenGuard, auth.js). The token travels as `<org>:<jwt>` (what
 * `pnpm mint-token` prints) because a bare JWT does not say which org issued
 * it, and the org is what selects the tenant host: every Semantius org has its
 * own subdomain.
 *
 * Verification is a live call to the org's OIDC userinfo endpoint
 * (`https://<org>.semantius.cloud/api/auth/oauth2/userinfo`) with the JWT as a
 * bearer — the issuer decides whether the token is good, so no key material,
 * JWKS fetch, or clock handling lives here. A 2xx with a `sub` claim is the
 * only accepted outcome; the endpoint answers 400 `invalid_request` for an
 * expired, malformed, or foreign token, and an unknown org resolves to a host
 * that answers the same way.
 *
 * The bearer sent upstream is the BARE jwt: the `<org>:` prefix is this POC's
 * transport convention, never part of the credential. Callers persist the two
 * halves separately for the same reason (see the ingest route).
 */

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
