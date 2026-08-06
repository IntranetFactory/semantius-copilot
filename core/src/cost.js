/**
 * Cloudflare CONTAINER cost, per session (host-agnostic).
 *
 * Every session owns exactly one sandbox container — `getSandbox(ns, sessionId)`
 * makes the sandbox id the session id — so container spend is attributable to a
 * session. Cloudflare's analytics can't be asked for that directly: the
 * `containersUsageAdaptiveGroups` dataset has no dimension carrying a name we
 * choose (`instanceId` is platform-assigned and NOT derivable from the Durable
 * Object id), and there is no `containerName` dimension despite what some
 * example queries suggest. What it does have is `label(name: "...")` — so
 * SemantiusCopilotSandbox stamps `session=<sessionId>` on every instance it starts
 * (backend-b/src/cloudflare.ts, SESSION_LABEL) and we group by that label here.
 *
 * This file is pure: it builds the query and prices the numbers. The fetch lives
 * in backend-b/src/costs.ts (Worker) and scripts/cf-costs.mjs (CLI), which share
 * these two functions so the UI and the CLI can never disagree on the math.
 *
 * WORKERS/DURABLE-OBJECT COST IS DELIBERATELY OUT OF SCOPE: the
 * `workersInvocationsAdaptive` dataset dimensions are scriptName / scriptTag /
 * scriptVersion / environmentName / status / usageModel / coloCode /
 * dispatchNamespaceName / isDispatcher — nothing session-shaped — so per-session
 * Worker cost cannot be reported, only estimated. We don't guess.
 */

/** Cloudflare's GraphQL Analytics endpoint. */
export const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * The label key every container instance is tagged with, and the ONLY join
 * between Cloudflare's billing analytics and our sessions. Lives here rather
 * than next to the SemantiusCopilotSandbox that stamps it, because both the stamper
 * (backend-b/src/cloudflare.ts) and the reader (backend-b/src/costs.ts) need it
 * and the sandbox module imports the reader — a constant in either would make
 * that graph circular.
 */
export const SESSION_LABEL = 'session';

/**
 * Container list prices, Workers Paid plan, as published 2026-07-30 at
 * https://developers.cloudflare.com/containers/pricing/ . Egress is the
 * North-America/Europe rate; other regions are dearer ($0.04–$0.05/GB), and the
 * dataset does not break egress down by region, so egress is the one line here
 * that can understate.
 */
export const CONTAINER_RATES = {
  /** USD per vCPU-second. Billed on ACTIVE cpu only. */
  cpuSecond: 0.000020,
  /** USD per GiB-second of PROVISIONED memory (charged while the instance lives). */
  memoryGiBSecond: 0.0000025,
  /** USD per GB-second of PROVISIONED disk. */
  diskGBSecond: 0.00000007,
  /** USD per GB of egress (North America + Europe). */
  egressGB: 0.025,
};

/**
 * Free allowance included with Workers Paid each month. We do NOT subtract it —
 * see `COST_BASIS` — but it's stated here so the number can be read in context.
 */
export const CONTAINER_INCLUDED_MONTHLY = {
  cpuSeconds: 375 * 60,
  memoryGiBSeconds: 25 * 3600,
  diskGBSeconds: 200 * 3600,
  egressGB: 1024,
};

export const COST_BASIS =
  'Usage at list price. The monthly included allowance (375 vCPU-min, 25 GiB-h memory, ' +
  '200 GB-h disk, 1 TB egress) is NOT deducted, so early-in-month totals overstate the ' +
  'invoice. Egress is priced at the North America/Europe rate.';

/**
 * The GraphQL document + variables for per-session container usage in a window.
 *
 * `limit` is required by the API and caps the number of GROUPS returned (one per
 * session), not the rows summed into them. Sessions carry a 24 h TTL and the
 * window here is a single day, so 1000 is far above real cardinality — but the
 * caller is told when the cap is hit rather than silently shown a partial total.
 *
 * @param {{ accountTag: string, start: string, end: string, label?: string, limit?: number }} params
 * @returns {{ query: string, variables: Record<string, unknown> }}
 */
export function containerCostQuery({ accountTag, start, end, label = SESSION_LABEL, limit = 1000 }) {
  return {
    query: `query SemantiusCopilotContainerCostBySession($accountTag: String!, $start: Time!, $end: Time!, $label: String!, $limit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersUsageAdaptiveGroups(
        limit: $limit
        filter: { datetime_geq: $start, datetime_leq: $end }
      ) {
        dimensions {
          session: label(name: $label)
        }
        sum {
          cpuTimeSec
          allocatedMemory
          allocatedDisk
          txBytes
        }
      }
    }
  }
}`,
    variables: { accountTag, start, end, label, limit },
  };
}

/** Bytes -> GiB (1024³), the unit memory is priced in. */
const GIB = 1024 ** 3;
/** Bytes -> GB (10⁹), the unit disk and egress are priced in. */
const GB = 1e9;

/** Round to whole cents-of-a-millionth — enough precision for sub-cent sessions. */
const round = (n) => Math.round(n * 1e8) / 1e8;

/**
 * Price one usage group.
 *
 * `allocatedMemory` and `allocatedDisk` come back as BYTE-SECONDS (the dataset's
 * "allocated" sums are integrals over time, which is why they are enormous);
 * `cpuTimeSec` is already vCPU-seconds and `txBytes` plain bytes.
 *
 * @param {{ cpuTimeSec?: number, allocatedMemory?: number, allocatedDisk?: number, txBytes?: number }} sums
 * @param {typeof CONTAINER_RATES} [rates]
 * @returns {{ cpuSeconds: number, memoryGiBSeconds: number, diskGBSeconds: number, egressBytes: number,
 *            cost: { cpu: number, memory: number, disk: number, egress: number, total: number } }}
 */
export function priceContainerUsage(sums, rates = CONTAINER_RATES) {
  const cpuSeconds = Number(sums?.cpuTimeSec ?? 0) || 0;
  const memoryGiBSeconds = (Number(sums?.allocatedMemory ?? 0) || 0) / GIB;
  const diskGBSeconds = (Number(sums?.allocatedDisk ?? 0) || 0) / GB;
  const egressBytes = Number(sums?.txBytes ?? 0) || 0;

  const cpu = cpuSeconds * rates.cpuSecond;
  const memory = memoryGiBSeconds * rates.memoryGiBSecond;
  const disk = diskGBSeconds * rates.diskGBSecond;
  const egress = (egressBytes / GB) * rates.egressGB;

  return {
    cpuSeconds: round(cpuSeconds),
    memoryGiBSeconds: round(memoryGiBSeconds),
    diskGBSeconds: round(diskGBSeconds),
    egressBytes,
    cost: {
      cpu: round(cpu),
      memory: round(memory),
      disk: round(disk),
      egress: round(egress),
      total: round(cpu + memory + disk + egress),
    },
  };
}

/** Sum a list of priced groups into one total of the same shape. */
export function sumContainerCosts(priced) {
  const zero = {
    cpuSeconds: 0,
    memoryGiBSeconds: 0,
    diskGBSeconds: 0,
    egressBytes: 0,
    cost: { cpu: 0, memory: 0, disk: 0, egress: 0, total: 0 },
  };
  const out = priced.reduce((acc, p) => {
    acc.cpuSeconds += p.cpuSeconds;
    acc.memoryGiBSeconds += p.memoryGiBSeconds;
    acc.diskGBSeconds += p.diskGBSeconds;
    acc.egressBytes += p.egressBytes;
    acc.cost.cpu += p.cost.cpu;
    acc.cost.memory += p.cost.memory;
    acc.cost.disk += p.cost.disk;
    acc.cost.egress += p.cost.egress;
    acc.cost.total += p.cost.total;
    return acc;
  }, zero);
  return {
    cpuSeconds: round(out.cpuSeconds),
    memoryGiBSeconds: round(out.memoryGiBSeconds),
    diskGBSeconds: round(out.diskGBSeconds),
    egressBytes: out.egressBytes,
    cost: {
      cpu: round(out.cost.cpu),
      memory: round(out.cost.memory),
      disk: round(out.cost.disk),
      egress: round(out.cost.egress),
      total: round(out.cost.total),
    },
  };
}

/**
 * The UTC day containing `now`, clamped to now — the window the costs view uses.
 * UTC because that is the day Cloudflare bills and aggregates on; a local-time
 * day would silently mix two billing days.
 *
 * @param {Date} [now]
 * @returns {{ date: string, start: string, end: string }}
 */
export function utcDayWindow(now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return { date, start: `${date}T00:00:00Z`, end: now.toISOString().replace(/\.\d+Z$/, 'Z') };
}

/**
 * Fold a raw `containersUsageAdaptiveGroups` response into priced per-session
 * rows. Groups whose `session` label is absent land in `unlabeled` — containers
 * started before the label shipped, or by anything that isn't a session — which
 * is stated rather than hidden, so the totals still add up.
 *
 * @param {unknown} payload the parsed GraphQL response body
 * @param {number} limit the limit the query was made with, to detect truncation
 * @returns {{ rows: Array<{ sessionId: string } & ReturnType<typeof priceContainerUsage>>,
 *             unlabeled: ReturnType<typeof priceContainerUsage> | null, totals: ReturnType<typeof sumContainerCosts>,
 *             truncated: boolean }}
 */
export function foldContainerCostResponse(payload, limit = 1000) {
  const accounts = payload?.data?.viewer?.accounts;
  const groups = Array.isArray(accounts?.[0]?.containersUsageAdaptiveGroups)
    ? accounts[0].containersUsageAdaptiveGroups
    : [];

  const rows = [];
  const unlabeledParts = [];
  for (const group of groups) {
    const priced = priceContainerUsage(group?.sum ?? {});
    const sessionId = typeof group?.dimensions?.session === 'string' ? group.dimensions.session.trim() : '';
    if (sessionId) rows.push({ sessionId, ...priced });
    else unlabeledParts.push(priced);
  }
  rows.sort((a, b) => b.cost.total - a.cost.total || a.sessionId.localeCompare(b.sessionId));

  const unlabeled = unlabeledParts.length > 0 ? sumContainerCosts(unlabeledParts) : null;
  const totals = sumContainerCosts([...rows, ...(unlabeled ? [unlabeled] : [])]);
  return { rows, unlabeled, totals, truncated: groups.length >= limit };
}

// ---------------------------------------------------------------------------
// R2 workspace-backup cost (add_backup_restore_plan.md requirement 1).
//
// Unlike containers there is no analytics query here: each session's backup
// footprint is known exactly from its own `session_backup` record node
// (size_bytes captured from meta.json at persist time, backup_count counted
// by the persist hook), so the estimate is pure arithmetic over the session
// record — no GraphQL, no label join.
// ---------------------------------------------------------------------------

/**
 * R2 list prices, Workers Paid plan, as published 2026-08-05 at
 * https://developers.cloudflare.com/r2/pricing/ (Standard storage class —
 * the class R2 buckets use unless configured otherwise). Deletes are free.
 */
export const R2_RATES = {
  /** USD per GB-month of stored data. */
  storageGBMonth: 0.015,
  /** USD per million Class A operations (writes: PutObject, CreateMultipartUpload, list). */
  classAPerMillion: 4.5,
  /** USD per million Class B operations (reads: GetObject, HeadObject). */
  classBPerMillion: 0.36,
};

/** Free allowance included each month (Standard class). NOT deducted — see basis. */
export const R2_INCLUDED_MONTHLY = {
  storageGBMonths: 10,
  classA: 1_000_000,
  classB: 10_000_000,
};

export const BACKUP_COST_BASIS =
  'Run-rate ESTIMATE at R2 list price from the session\'s last backup: storage $/mo is ' +
  'size_bytes at $0.015/GB-month; ops are ~2 Class A + 2 Class B per backup. The monthly ' +
  'included allowance (10 GB-mo, 1M Class A, 10M Class B) is NOT deducted, and deletes are ' +
  'free. Not a billed figure — R2 bills storage on account-wide daily averages.';

/**
 * Monthly storage run-rate for one session's current backup.
 * @param {number | null | undefined} sizeBytes
 * @param {typeof R2_RATES} [rates]
 * @returns {number} USD per month
 */
export function backupStorageMonthlyUsd(sizeBytes, rates = R2_RATES) {
  const bytes = Number(sizeBytes ?? 0) || 0;
  return round((bytes / GB) * rates.storageGBMonth);
}

/**
 * Cumulative operations cost estimate for a session's backups so far. Each
 * persist costs ~2 Class A (archive + meta put) and ~2 Class B (the SDK's
 * size-verify head + our meta read); restores add reads at the same order of
 * magnitude — all far below a cent at POC cardinality, priced anyway so the
 * Costs tab never shows a false zero-cost claim.
 *
 * @param {number | null | undefined} backupCount
 * @param {typeof R2_RATES} [rates]
 * @returns {number} USD
 */
export function backupOpsUsd(backupCount, rates = R2_RATES) {
  const n = Number(backupCount ?? 0) || 0;
  return round(n * 2 * (rates.classAPerMillion / 1e6) + n * 2 * (rates.classBPerMillion / 1e6));
}
