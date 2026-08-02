/**
 * Per-session container environment (host-agnostic).
 *
 * The semantius CLI in the sandbox is configured by two environment variables,
 * and NEITHER can be fully baked into the image:
 *
 *   SEMANTIUS_ORG  the org whose tenant the session acts on — the `<org>` half
 *                  of the user's `<org>:<jwt>` token, so it is per session and
 *                  only known once that token has been verified at ingest.
 *   SEMANTIUS_JWT  the credential. The container is given the SENTINEL, never a
 *                  real token: the Worker's catch-all egress handler swaps the
 *                  sentinel for this session's JWT on the way out, so the token
 *                  itself never enters the sandbox (same secret-at-egress seam
 *                  the shared API key used to ride, now per user).
 *
 * The image bakes the sentinel as a floor (see the Dockerfile) so a container
 * that somehow runs before this call holds a placeholder rather than nothing;
 * this function is what makes the pair correct for the session. Applied at two
 * points, exactly like skill provisioning: the agent's lazy boot path
 * (backend-b/src/lazy-env.ts provisioning, right after skill extraction) and
 * the admin skill-check route's replay (self-heal either way, since a cold
 * container starts from the image's environment again).
 *
 * @typedef {Object} SandboxEnvLike
 * @property {(envVars: Record<string, string | undefined>) => Promise<unknown>} setEnvVars
 */
import { SEMANTIUS_JWT_SENTINEL } from './config.js';

/**
 * Point the sandbox's semantius CLI at this session's org, with the sentinel
 * standing in for the user's JWT. No-op (and no RPC) without an org — a session
 * that never presented a token gets no Semantius environment at all, which
 * leaves the CLI unconfigured rather than pointed at someone else's tenant.
 *
 * @param {SandboxEnvLike} sandbox
 * @param {string | undefined} org the verified `<org>` half of the session token
 * @returns {Promise<boolean>} whether the environment was applied
 */
export async function provisionSemantiusEnv(sandbox, org) {
  if (typeof org !== 'string' || org.length === 0) return false;
  await sandbox.setEnvVars({ SEMANTIUS_ORG: org, SEMANTIUS_JWT: SEMANTIUS_JWT_SENTINEL });
  return true;
}
