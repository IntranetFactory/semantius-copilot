/**
 * Today's Cloudflare CONTAINER spend, per session — the data behind the admin
 * console's Costs tab (GET /admin/costs).
 *
 * The join is the `session` label SemantiusCopilotSandbox stamps on every container it
 * starts (src/cloudflare.ts); the label key, the query and the pricing all live
 * in @semantius-copilot/core's cost.js so this file and scripts/cf-costs.mjs cannot drift
 * apart. All this adds is the fetch, the credential check, and the enrichment
 * from KV.
 *
 * TWO CALLERS, one query:
 *   - `fetchContainerCosts` — the admin route, all sessions, KV-enriched.
 *   - `queryContainerCosts` — the raw priced rows, used by SemantiusCopilotSandbox's
 *     post-stop snapshot (src/cloudflare.ts) to find its own session's row.
 *     The DO picks its row out of the full result rather than filtering
 *     server-side: it is then literally the query already proven in production,
 *     with no second filter shape to validate.
 *
 * Fails LOUD, not silent: a missing token, a Cloudflare error, or a GraphQL
 * `errors[]` all come back as a described state the UI can render. A costs view
 * that quietly shows $0 because a secret is unset is worse than no costs view.
 */
import {
  containerCostQuery,
  foldContainerCostResponse,
  CF_GRAPHQL_URL,
  SESSION_LABEL,
  readSession,
} from '@semantius-copilot/core';

export type CostEnv = {
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
    /** session_state.cost_total — the session's LIFETIME LLM spend, not today's. */
    llmCost?: number;
  }>;
  /** Sum of the rows' llmCost. Deliberately not added to the container total. */
  llmTotal: number;
};

export type ContainerCostsResult = ContainerCosts | { configured: false; reason: string };

/** Both credentials, or the reason one is missing. */
function credentials(env: CostEnv): { accountTag: string; token: string } | { reason: string } {
  if (!env.CLOUDFLARE_ACCOUNT_ID) return { reason: 'CLOUDFLARE_ACCOUNT_ID var is not set' };
  if (!env.CLOUDFLARE_API_TOKEN) {
    return {
      reason:
        'CLOUDFLARE_API_TOKEN secret is not set. Create a token with Account → Account Analytics → Read, ' +
        'then: wrangler secret put CLOUDFLARE_API_TOKEN --config backend-b/wrangler.jsonc',
    };
  }
  return { accountTag: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN };
}

/**
 * The raw query: container usage in [start, end), priced, grouped by session.
 * No KV, no enrichment — just what Cloudflare measured.
 *
 * @throws Error with the Cloudflare/GraphQL message. Callers decide whether
 *   that becomes a 502 (the admin route) or a swallowed best-effort miss (the
 *   DO's post-stop snapshot).
 */
export async function queryContainerCosts(
  env: CostEnv,
  window: { start: string; end: string },
): Promise<ReturnType<typeof foldContainerCostResponse> | null> {
  const creds = credentials(env);
  if ('reason' in creds) return null;

  const body = containerCostQuery({
    accountTag: creds.accountTag,
    start: window.start,
    end: window.end,
    label: SESSION_LABEL,
    limit: GROUP_LIMIT,
  });

  const res = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
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

  return foldContainerCostResponse(payload, GROUP_LIMIT);
}

/**
 * The admin route's view: the same rows, enriched from KV with what we know
 * about each session, and with the credential state described rather than
 * thrown.
 *
 * @throws Error with the Cloudflare/GraphQL message — the route turns it into a
 *   502 so the operator sees WHY, rather than an empty table.
 */
export async function fetchContainerCosts(
  env: CostEnv,
  window: { start: string; end: string },
): Promise<ContainerCostsResult> {
  const creds = credentials(env);
  if ('reason' in creds) return { configured: false, reason: creds.reason };

  const folded = await queryContainerCosts(env, window);
  if (!folded) return { configured: false, reason: 'Cloudflare credentials unavailable' };

  // Enrich with what we know about each session. Missing record (24 h TTL
  // expired, session deleted) is normal and non-fatal — the cost is still real
  // and still attributable to that id.
  //
  // llmCost rides along from the same read. NOTE THE MISMATCHED WINDOWS: the
  // container figures are today's UTC day, `session_state.cost_total` is the
  // session's running lifetime total. They are reported side by side and never
  // summed — see COST_BASIS and the column headers.
  const rows = [];
  let llmTotal = 0;
  for (const row of folded.rows) {
    const record = (await readSession(env.STORE, row.sessionId).catch(() => null)) as
      | Record<string, unknown>
      | null;
    const state = record?.session_state as { cost_total?: unknown } | undefined;
    const llmCost = typeof state?.cost_total === 'number' ? state.cost_total : undefined;
    if (llmCost !== undefined) llmTotal += llmCost;
    rows.push({
      ...row,
      ...(typeof record?.agentName === 'string' ? { agentName: record.agentName } : {}),
      ...(typeof record?.version === 'string' ? { version: record.version } : {}),
      ...(typeof record?.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
      ...(llmCost !== undefined ? { llmCost } : {}),
    });
  }

  return { ...folded, rows, llmTotal: Math.round(llmTotal * 1e8) / 1e8, configured: true };
}
