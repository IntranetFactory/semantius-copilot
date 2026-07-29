/**
 * Worker-level exports for the backend.
 *
 * Egress policy is PER SESSION, resolved in two hops: the handlers below
 * receive only ctx.containerId (idFromName is one-way), so they follow the
 * `container:<containerId> -> sessionId` pointer to THE session record
 * (`session:<sessionId>` — its egress_secrets/whitelist/session_context
 * fields) — see resolveEgressPolicy. Both handlers resolve per invocation (no caching
 * — isolate-global registry, plan §9.2a). NO POINTER OR RECORD (agent
 * without a proxy_whitelist still gets `whitelist: []`; expired TTL; deleted
 * session) MEANS DENY ALL — fail-closed.
 *
 * Two egress handlers are registered on HothSandbox, one per credential shape:
 *   - outboundByHost[ECHO_HOST] — ZERO-KNOWLEDGE injection from the session's
 *     `egress_secrets` map (plus its `x-semantius-org`), gated by the policy's
 *     whitelist. The container holds nothing for these hosts, not even a
 *     placeholder, so it cannot leak or misdirect the credential. Registering a
 *     host here is what declares it credential-REQUIRED: no matching entry in
 *     the map means 403, never an unauthenticated forward. The POC's one entry
 *     is the fictional Hoth Tourism API — never the deployment key, which
 *     stays a Worker secret and guards inbound admin routes instead.
 *   - static outbound (catch-all) — the Semantius credential broker
 *     (brokerEgress), gated by the same whitelist. The credential is the
 *     SESSION USER'S JWT (`session_context.semantius_jwt`, put there by the
 *     verified `<org>:<jwt>` token at ingest), never a shared org key: a
 *     whitelisted request has any SEMANTIUS_JWT_SENTINEL header swapped for
 *     that JWT, and requests to SEMANTIUS_HOSTS additionally get
 *     `Authorization: Bearer <jwt>` outright. A whitelisted request with no
 *     sentinel is forwarded as-is; anything to a non-whitelisted host is
 *     rejected — even carrying the sentinel (exfiltration guard). A session
 *     with no JWT (channel conversation, expired 24 h TTL) has NO credential
 *     to lend, so a sentinel-bearing request fails closed with 503.
 *
 * Why the JWT is NOT an `egress_secrets` entry: it is the one credential with
 * two jobs — the backend verifies it to authenticate the user (auth.js /
 * identity.js) and egress also forwards it — so it belongs with the identity in
 * session_context, and it needs the sentinel rather than zero-knowledge
 * injection because the vendored semantius CLI insists on a credential in its
 * env. Everything with only the egress job goes in the map.
 */
import { Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import {
  ECHO_HOST,
  injectAndForward,
  isWhitelistedHost,
  resolveEgressPolicy,
  SEMANTIUS_HOSTS,
  SEMANTIUS_JWT_SENTINEL,
  brokerEgress,
} from '@hoth/core';

export { ContainerProxy };

type Env = {
  STORE: KVNamespace;
};

export class HothSandbox extends Sandbox<Env> {
  enableInternet = false;
  // Intercept HTTPS egress too (SDK default is false). semantius calls
  // https://<org>.semantius.ai, so without this the catch-all `outbound` swap
  // would never see its request. The container trusts the interceptor CA via
  // NODE_EXTRA_CA_CERTS baked in the Dockerfile.
  interceptHttps = true;
}

HothSandbox.outboundByHost = {
  [ECHO_HOST]: async (request: Request, env: Env, ctx: { containerId: string }) => {
    const policy = await resolveEgressPolicy(env.STORE, ctx.containerId);
    if (!policy || !isWhitelistedHost(new URL(request.url).hostname, policy.whitelist)) {
      return new Response(JSON.stringify({ error: 'egress denied: host not in agent proxy_whitelist' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return injectAndForward(request, policy);
  },
};

HothSandbox.outbound = async (request: Request, env: Env, ctx: { containerId: string }) => {
  const policy = await resolveEgressPolicy(env.STORE, ctx.containerId);
  const jwt =
    policy && typeof policy.context?.semantius_jwt === 'string' && policy.context.semantius_jwt
      ? policy.context.semantius_jwt
      : undefined;
  return brokerEgress(request, {
    whitelist: policy?.whitelist ?? [],
    // The sentinel the container carries as SEMANTIUS_JWT resolves to THIS
    // session's user JWT — there is no shared-key fallback: a session with no
    // verified user has no credential, so a sentinel-bearing request fails
    // closed (503) instead of silently borrowing org-wide access.
    sentinel: SEMANTIUS_JWT_SENTINEL,
    secret: jwt,
    ...(jwt ? { jwt: { token: jwt, hosts: SEMANTIUS_HOSTS } } : {}),
  });
};
