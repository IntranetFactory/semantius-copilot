import {
  extractSessionCookie,
  SEMANTIUS_COOKIE_HINT,
  SEMANTIUS_SESSION_BASE_URL,
  verifySemantiusCookie,
  verifySemantiusToken,
} from './identity.js';

/**
 * The backend has TWO auth surfaces, and they must not be confused:
 *
 *   admin / CLI  — deploying agent definitions, browsing stored data (including
 *                  reading conversations, via the read-only /admin mount of the
 *                  agent router), running skill-checks, deleting sessions.
 *                  Machine-to-machine, one shared deployment secret: apiKeyGuard
 *                  below.
 *   user chat    — creating a session and talking in it. A real person, proven
 *                  by their own Semantius token OR by their better-auth session
 *                  cookie: userTokenGuard below.
 *
 * They were one blanket guard before user identity existed. Sharing it meant a
 * chat client had to hold the deploy-capable key, and left the Authorization
 * header occupied so the user's own token had nowhere standard to go. Split,
 * each surface takes the credential that actually belongs to it — and the chat
 * surface holds no API key at all, so a chat client can never browse data.
 */

/**
 * Shared API-key gate for the ADMIN surface (design §9.6 is the production
 * successor). A single shared secret in `env.API_TOKEN`, supplied per-request
 * as `Authorization: Bearer <API_TOKEN>`.
 *
 * Fail-closed: if API_TOKEN is not configured on the Worker, protected routes
 * return 503 rather than silently running wide open.
 *
 * This is a gate against outside abuse, NOT identity — the token is shared by
 * every caller. Never put it on a route a browser user reaches.
 *
 * Returns a Hono middleware. Usage: `app.use('/admin/*', apiKeyGuard())`.
 */
export function apiKeyGuard(options = {}) {
  const publicPaths = new Set(options.publicPaths ?? ['/health']);
  return async (c, next) => {
    if (publicPaths.has(new URL(c.req.url).pathname)) return next();

    const expected = c.env?.API_TOKEN;
    if (!expected) {
      return c.json({ error: 'server not configured: API_TOKEN is unset' }, 503);
    }
    const provided = c.req.header('authorization');
    if (provided !== `Bearer ${expected}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}

/**
 * User gate for the CHAT surface. TWO credentials are accepted, and the BEARER
 * always wins when both are present:
 *
 *   1. `Authorization: Bearer <org>:<jwt>` — the user's own Semantius access
 *      token, verified against that org's OIDC userinfo endpoint.
 *   2. a better-auth session cookie (`x-better-auth-cookie: <value>` from a
 *      browser, or a normal `Cookie` header server-to-server) — only consulted
 *      when there is no bearer. What a user who signed in to the legacy app
 *      already holds, so a copilot embed needs no token minting at all.
 *
 * There is no shared key on this surface, and either credential grants exactly
 * two things: create a session, and use one you own. Both paths end at the same
 * `{ org, jwt, user }` verdict (identity.js), so nothing downstream has to care
 * which one the caller used.
 *
 * Verified per request, not once per session, because the credential belongs to
 * the request: a conversation lives 24 h while a token lives ~1 h, so pinning
 * identity at creation would keep a stale token working for the rest of the day
 * and leave the sandbox's own credential unrefreshable. Re-presenting the
 * current credential makes expiry survivable — the client simply sends a fresh
 * one, and on the cookie path the exchange mints a fresh JWT on its own.
 *
 * On success the verdict is put on the Hono context as `semantiusUser`
 * ({ org, jwt, user }) so the route doesn't verify a second time.
 *
 * @param {typeof fetch} [fetchImpl]
 */
export function userTokenGuard(fetchImpl) {
  return async (c, next) => {
    const provided = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(provided.trim());

    let verified;
    if (match) {
      verified = await verifySemantiusToken(match[1], fetchImpl ?? fetch);
    } else {
      const cookie = extractSessionCookie({ get: (name) => c.req.header(name) ?? null });
      if (!cookie) {
        return c.json(
          {
            error:
              'unauthorized: send Authorization: Bearer <org>:<jwt> (mint one with pnpm mint-token), ' +
              `or ${SEMANTIUS_COOKIE_HINT}`,
          },
          401,
        );
      }
      // Fail-closed and diagnosable, exactly as apiKeyGuard treats a missing
      // API_TOKEN: a cookie cannot be exchanged for the JWT the sandbox needs
      // without this key, and silently 401ing would look like a bad cookie.
      if (!c.env?.JWT_EXCHANGE_API_KEY) {
        return c.json({ error: 'server not configured: JWT_EXCHANGE_API_KEY is unset' }, 503);
      }
      verified = await verifySemantiusCookie(
        cookie,
        {
          baseUrl: c.env?.SEMANTIUS_SESSION_BASE_URL || SEMANTIUS_SESSION_BASE_URL,
          exchangeKey: c.env.JWT_EXCHANGE_API_KEY,
          kv: c.env?.STORE,
        },
        fetchImpl ?? fetch,
      );
    }

    if (!verified.ok) {
      return c.json({ error: `unauthorized: ${verified.error}` }, 401);
    }
    c.set('semantiusUser', verified);
    return next();
  };
}
