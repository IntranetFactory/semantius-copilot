import { verifySemantiusToken } from './identity.js';

/**
 * The backend has TWO auth surfaces, and they must not be confused:
 *
 *   admin / CLI  — deploying agent definitions, browsing stored data (including
 *                  reading conversations, via the read-only /admin mount of the
 *                  agent router), running skill-checks, deleting sessions.
 *                  Machine-to-machine, one shared deployment secret: apiKeyGuard
 *                  below.
 *   user chat    — creating a session and talking in it. A real person, proven
 *                  by their own Semantius token: userTokenGuard below.
 *
 * They were one blanket guard before user identity existed. Sharing it meant a
 * chat client had to hold the deploy-capable key, and left the Authorization
 * header occupied so the user's own token had nowhere standard to go. Split,
 * each surface takes the credential that actually belongs to it — and the chat
 * surface holds no API key at all, so a chat client can never browse data.
 */

/**
 * Shared API-key gate for the ADMIN surface (plan §9.6 is the production
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
 * User gate for the CHAT surface: `Authorization: Bearer <org>:<jwt>`, verified
 * on every request against that org's OIDC userinfo endpoint. The bearer is the
 * user's own credential — there is no shared key on this surface, and holding a
 * token grants exactly two things: create a session, and use one you own.
 *
 * Verified per request, not once per session, because the token belongs to the
 * request: a conversation lives 24 h while a token lives ~1 h, so pinning
 * identity at creation would keep a stale token working for the rest of the day
 * and leave the sandbox's own credential unrefreshable. Re-presenting the
 * current token makes expiry survivable — the client simply sends a fresh one.
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
    if (!match) {
      return c.json(
        { error: 'unauthorized: send Authorization: Bearer <org>:<jwt> (mint one with pnpm mint-token)' },
        401,
      );
    }
    const verified = await verifySemantiusToken(match[1], fetchImpl ?? fetch);
    if (!verified.ok) {
      return c.json({ error: `unauthorized: ${verified.error}` }, 401);
    }
    c.set('semantiusUser', verified);
    return next();
  };
}
