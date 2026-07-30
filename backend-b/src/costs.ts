/**
 * Today's Cloudflare CONTAINER spend, per session — the data behind the admin
 * console's Costs tab (GET /admin/costs).
 *
 * The join is the `session` label HothSandbox stamps on every container it
 * starts (src/cloudflare.ts, SESSION_LABEL); the query and the pricing live in
 * @hoth/core's cost.js so this file and scripts/cf-costs.mjs cannot drift apart.
 * All this adds is the fetch, the credential check, and the enrichment from KV.
 *
 * Fails LOUD, not silent: a missing token, a Cloudflare error, or a GraphQL
 * `errors[]` all come back as a described state the UI can render. A costs view
 * that quietly shows $0 because a secret is unset is worse than no costs view.
 */
import { containerCostQuery, foldContainerCostResponse, CF_GRAPHQL_URL, readSession } from '@hoth/core';

import { SESSION_LABEL } from './cloudflare';

type CostEnv = {
  STORE: KVNamespace;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
};

const GROUP_LIMIT = 1000;

export type ContainerCosts = ReturnType<typeof foldContainerCostResponse> & {
  configured: true;
  rows: Array<ReturnType<typeof foldContainerCostResponse>['rows'][number] & {
    agentName?: string;
    version?: string;
    createdAt?: string;
  }>;
};

export type ContainerCostsResult = ContainerCosts | { configured: false; reason: string };

/**
 * Query Cloudflare for container usage in [start, end) and price it per session.
 *
 * @throws Error with the Cloudflare/GraphQL message — the route turns it into a
 *   502 so the operator sees WHY, rather than an empty table.
 */
export async function fetchContainerCosts(
  env: CostEnv,
  window: { start: string; end: string },
): Promise<ContainerCostsResult> {
  const accountTag = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountTag) return { configured: false, reason: 'CLOUDFLARE_ACCOUNT_ID var is not set' };
  if (!token) {
    return {
      configured: false,
      reason:
        'CLOUDFLARE_API_TOKEN secret is not set. Create a token with Account → Account Analytics → Read, ' +
        'then: wrangler secret put CLOUDFLARE_API_TOKEN --config backend-b/wrangler.jsonc',
    };
  }

  const body = containerCostQuery({
    accountTag,
    start: window.start,
    end: window.end,
    label: SESSION_LABEL,
    limit: GROUP_LIMIT,
  });

  const res = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare GraphQL ${res.status}: ${text.slice(0, 500)}`);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare GraphQL returned non-JSON: ${text.slice(0, 200)}`);
  }

  // GraphQL reports failures with HTTP 200 + errors[]. Surfacing them verbatim
  // is what makes a wrong dimension name or an under-scoped token diagnosable.
  const errors = (payload as { errors?: Array<{ message?: string }> })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Cloudflare GraphQL: ${errors.map((e) => e?.message ?? String(e)).join('; ')}`);
  }

  const folded = foldContainerCostResponse(payload, GROUP_LIMIT);

  // Enrich with what we know about each session. Missing record (24 h TTL
  // expired, session deleted) is normal and non-fatal — the cost is still real
  // and still attributable to that id.
  const rows = [];
  for (const row of folded.rows) {
    const record = (await readSession(env.STORE, row.sessionId).catch(() => null)) as
      | Record<string, unknown>
      | null;
    rows.push({
      ...row,
      ...(typeof record?.agentName === 'string' ? { agentName: record.agentName } : {}),
      ...(typeof record?.version === 'string' ? { version: record.version } : {}),
      ...(typeof record?.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    });
  }

  return { ...folded, rows, configured: true };
}
