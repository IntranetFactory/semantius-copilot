/**
 * Worker-level exports for the backend.
 *
 * Egress policy is PER SESSION, resolved in two hops: the handlers below
 * receive only ctx.containerId (idFromName is one-way), so they follow the
 * `container:<containerId> -> sessionId` pointer to THE session record
 * (`session:<sessionId>` — its egress_secrets/whitelist/org_whitelist/
 * session_context fields) — see resolveEgressPolicy. Both handlers resolve per
 * invocation (no caching — isolate-global registry, design §9.2a). NO POINTER OR
 * RECORD (agent without a proxy_whitelist still gets `whitelist: []`; expired
 * TTL; deleted session) MEANS DENY ALL — fail-closed.
 *
 * The allow list the handlers gate on is the UNION of two sources, merged by
 * resolveEgressPolicy: the AGENT's `proxy_whitelist` and the ORG's copilot
 * allow list (`org_whitelist`, read from POST /session/copilot when the session
 * was created). An org running with its copilot firewall off contributes `*`,
 * so the union can legitimately match everything — which is why the JWT's own
 * scope is a separate, narrow list (secretHosts / SEMANTIUS_HOSTS) rather than
 * "whatever is reachable".
 *
 * Two egress handlers are registered on SemantiusCopilotSandbox, one per credential shape:
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
 *     whitelisted request TO A SEMANTIUS HOST has any SEMANTIUS_JWT_SENTINEL
 *     header swapped for that JWT, and gets `Authorization: Bearer <jwt>`
 *     outright. A whitelisted request with no sentinel is forwarded as-is;
 *     anything to a non-whitelisted host is rejected — even carrying the
 *     sentinel (exfiltration guard) — and so is a sentinel aimed at a host that
 *     is reachable but outside SEMANTIUS_HOSTS. A session with no JWT (channel
 *     conversation, expired 24 h TTL) has NO credential to lend, so a
 *     sentinel-bearing request fails closed with 503.
 *
 * SemantiusCopilotSandbox also carries two non-egress responsibilities, both about cost
 * attribution: it stamps the session id as a container LABEL at start (the only
 * join Cloudflare's billing analytics offers), and 15 minutes after the
 * container stops it mirrors that session's spend onto the session record as
 * `session_sandbox`. See recordSandboxCost below.
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
  isAllowedEgressUrl,
  mergeExistingSessionRecord,
  readSession,
  resolveEgressPolicy,
  SEMANTIUS_HOSTS,
  SEMANTIUS_JWT_SENTINEL,
  SESSION_LABEL,
  brokerEgress,
  sessionIdForContainer,
} from '@semantius-copilot/core';

import { sweepExpiredBackups, type BackupEnv } from './backups';
import { queryContainerCosts, type CostEnv } from './costs';

export { ContainerProxy };

/**
 * The Cloudflare analytics credentials are here for the post-stop cost snapshot
 * below — the DO reads them straight off its own env, same values the admin
 * route uses. BACKUP_BUCKET rides along because the SDK's localBucket backup
 * path reads `this.env.BACKUP_BUCKET` on the sandbox DO itself (bindings are
 * worker-wide, so the same binding serves the DO, the routes, and the cron).
 */
type Env = CostEnv & { BACKUP_BUCKET?: R2Bucket };

/** Container start options we care about — @cloudflare/containers' ContainerStartConfigOptions. */
type StartOptions = { labels?: Record<string, string>; [key: string]: unknown };
type StartAndWaitArgs = { ports?: number | number[]; startOptions?: StartOptions; [key: string]: unknown };

/**
 * How long after the container STOPS we take its cost snapshot. Cloudflare's
 * analytics lags ingestion by minutes, and the part still missing at stop time
 * is precisely the container's final CPU — so reading immediately would
 * systematically undercount.
 */
const SNAPSHOT_DELAY_MS = 15 * 60 * 1000;

/**
 * How often the snapshot task wakes to ask "has it stopped yet, and has it been
 * quiet long enough?".
 *
 * WHY A POLL RATHER THAN SCHEDULING FROM onStop — the obvious design, and it
 * does not work on @cloudflare/containers 0.3.7. Its `alarm()` snapshots the
 * schedule table BEFORE delivering stop events, then acts on that stale read:
 *
 *     const resultForMinTime = this.sql`SELECT * FROM container_schedules;`;
 *     if (!this.container.running) {
 *       await this.syncPendingStoppedEvents();      // <- onStop runs HERE
 *       if (resultForMinTime.length == 0) {         // <- still the stale 0
 *         await this.ctx.storage.deleteAlarm();     // <- kills the new schedule
 *
 * so a `schedule()` call inside `onStop` lands in SQLite and is then orphaned:
 * the row exists, the alarm that would run it does not. Arming from `onStart`
 * instead sidesteps it entirely — that runs on the start path, and a schedule
 * re-armed from INSIDE a scheduled callback is created before `resultForMinTime`
 * is read, so it survives.
 */
const SNAPSHOT_POLL_SECONDS = 5 * 60;

/**
 * How many times to come back when the settle wait is over but Cloudflare still
 * has no usage for this session. Ingestion lag is not a fixed number — 45 s in
 * one measurement, well over 15 min in another — so giving up after a single
 * look is how a snapshot silently goes missing. At SNAPSHOT_POLL_SECONDS apart
 * this keeps trying for ~30 min after the settle window, then stops rather than
 * polling a dead session forever.
 */
const SNAPSHOT_MAX_TRIES = 6;

/** DO storage keys for the snapshot task's own state. */
const STOPPED_AT_KEY = 'semantius-copilot:stoppedAt';
const SNAPSHOT_ARMED_KEY = 'semantius-copilot:snapshotArmed';
const SNAPSHOT_TRIES_KEY = 'semantius-copilot:snapshotTries';
const LAST_RUN_KEY = 'semantius-copilot:snapshotLastRun';

export class SemantiusCopilotSandbox extends Sandbox<Env> {
  enableInternet = false;
  // Intercept HTTPS egress too (SDK default is false). semantius calls
  // https://<org>.semantius.ai, so without this the catch-all `outbound` swap
  // would never see its request. The container trusts the interceptor CA via
  // NODE_EXTRA_CA_CERTS baked in the Dockerfile.
  interceptHttps = true;

  /**
   * `sandboxName` is the SANDBOX name, not the session id: every caller reaches
   * us through `getSandbox(namespace, sandboxNameForSession(id))` (config.js),
   * which drops the user segment — `<org>-<tail>`. The SDK persists the name in
   * DO storage and reloads it inside blockConcurrencyWhile before any request
   * runs — so it is populated by the time a container can start. It is `private`
   * in the SDK's types (a plain field at runtime), hence the cast.
   *
   * The label therefore carries the sandbox name too; consumers that need the
   * full session id (the costs enrichment, writeSnapshot below) resolve it via
   * the `container:` pointer (sessionIdForContainer).
   *
   * Returns undefined rather than an empty label when it is somehow unset: an
   * unlabeled instance shows up in the costs view's "unlabeled" bucket, which is
   * honest, whereas an empty label would look like a real session.
   */
  private sessionLabels(existing?: Record<string, string>): Record<string, string> | undefined {
    const session = (this as unknown as { sandboxName: string | null }).sandboxName;
    if (!session) return existing;
    return { ...existing, [SESSION_LABEL]: session };
  }

  // Both public start paths funnel into the SDK's startContainerIfNotRunning,
  // which resolves `options?.labels ?? this.labels`. `this.labels` can't carry
  // the session id (it would have to be set before blockConcurrencyWhile has
  // loaded the name), so the label goes in per call instead.
  override async start(startOptions?: StartOptions, waitOptions?: unknown): Promise<void> {
    return super.start(
      { ...startOptions, labels: this.sessionLabels(startOptions?.labels) } as never,
      waitOptions as never,
    );
  }

  override async startAndWaitForPorts(
    portsOrArgs?: number | number[] | StartAndWaitArgs,
    cancellationOptions?: unknown,
    startOptions?: StartOptions,
  ): Promise<void> {
    // Two overloads: an options object (what Sandbox.containerFetch uses) or
    // positional (ports, cancellation, startOptions).
    if (portsOrArgs && typeof portsOrArgs === 'object' && !Array.isArray(portsOrArgs)) {
      const args = portsOrArgs as StartAndWaitArgs;
      return super.startAndWaitForPorts({
        ...args,
        startOptions: { ...args.startOptions, labels: this.sessionLabels(args.startOptions?.labels) },
      } as never);
    }
    return super.startAndWaitForPorts(
      portsOrArgs as never,
      cancellationOptions as never,
      { ...startOptions, labels: this.sessionLabels(startOptions?.labels) } as never,
    );
  }

  /**
   * Container started — arm the cost-snapshot task if it isn't already, and
   * forget any earlier stop (a restarted container is not a stopped one).
   *
   * Arming HERE, not in onStop: see SNAPSHOT_POLL_SECONDS. Sandbox overrides
   * onStart itself, so super must run.
   */
  override async onStart(): Promise<void> {
    await super.onStart();
    try {
      await this.ctx.storage.delete(STOPPED_AT_KEY);
      await this.ctx.storage.delete(SNAPSHOT_TRIES_KEY);
      if (!(await this.ctx.storage.get(SNAPSHOT_ARMED_KEY))) {
        await this.ctx.storage.put(SNAPSHOT_ARMED_KEY, true);
        await this.schedule(SNAPSHOT_POLL_SECONDS, 'recordSandboxCost');
      }
    } catch {
      // Best-effort: cost bookkeeping must never break container startup.
    }
  }

  /**
   * Container stopped — just record WHEN, so the snapshot task can wait out the
   * analytics lag. Deliberately does no scheduling (see SNAPSHOT_POLL_SECONDS).
   *
   * The base class declares `onStop(params: StopParams)` while the SDK's own
   * override takes none, so we declare the parameter and call super without it.
   * Skipping `super.onStop()` would skip the SDK's session/tunnel/mount
   * teardown.
   */
  override async onStop(_params?: unknown): Promise<void> {
    await super.onStop();
    await this.ctx.storage.put(STOPPED_AT_KEY, Date.now()).catch(() => {});
  }

  /**
   * Mirror this session's Cloudflare container spend onto THE session record as
   * `session_sandbox`, so it outlives the Costs tab's today-only window.
   *
   * PUBLIC AND STRING-ADDRESSED: `schedule()` resolves the callback by method
   * name at alarm time, so renaming this silently breaks the snapshot.
   *
   * NEVER RESURRECTS A DELETED SESSION — hence mergeEXISTINGSessionRecord, and
   * the early read below. `DELETE /sessions/:id` removes the KV record but does
   * NOT stop the container (it keeps running until sleepAfter, 10 min), so this
   * callback routinely fires for sessions that were deliberately deleted, and
   * the ordinary mergeSessionRecord creates when absent. (The acceptance suite
   * deletes every session it creates, so this is the common path, not an edge
   * case.)
   *
   * Idempotent: the window is the session's whole life, so a container that
   * starts and stops repeatedly just recomputes a more complete total each time.
   */
  async recordSandboxCost(): Promise<void> {
    let phase = 'start';
    try {
      // Still running: nothing final to record yet, come back later. Re-arming
      // from inside the callback is safe — unlike from onStop, this happens
      // before alarm() re-reads the schedule table.
      if (this.ctx.container?.running === true) {
        phase = 'running';
        await this.schedule(SNAPSHOT_POLL_SECONDS, 'recordSandboxCost');
        return;
      }

      // Stopped, but onStop may not have landed (or predates this code) — treat
      // "first time we noticed" as the stop time so the wait always converges.
      let stoppedAt = await this.ctx.storage.get<number>(STOPPED_AT_KEY);
      if (typeof stoppedAt !== 'number') {
        stoppedAt = Date.now();
        await this.ctx.storage.put(STOPPED_AT_KEY, stoppedAt);
      }
      const settledFor = Date.now() - stoppedAt;
      if (settledFor < SNAPSHOT_DELAY_MS) {
        phase = `settling ${Math.round(settledFor / 1000)}s`;
        await this.schedule(Math.ceil((SNAPSHOT_DELAY_MS - settledFor) / 1000), 'recordSandboxCost');
        return;
      }

      const outcome = await this.writeSnapshot();
      phase = outcome.phase;

      // "Cloudflare has nothing for this session yet" is the one outcome worth
      // coming back for — ingestion lag is variable, and a single look is how a
      // snapshot silently goes missing. Everything else (written, record gone,
      // no credentials) is final.
      if (outcome.retry) {
        const tries = ((await this.ctx.storage.get<number>(SNAPSHOT_TRIES_KEY)) ?? 0) + 1;
        if (tries < SNAPSHOT_MAX_TRIES) {
          await this.ctx.storage.put(SNAPSHOT_TRIES_KEY, tries);
          await this.schedule(SNAPSHOT_POLL_SECONDS, 'recordSandboxCost');
          phase = `${outcome.phase} — retry ${tries}/${SNAPSHOT_MAX_TRIES}`;
          return;
        }
        phase = `${outcome.phase} — gave up after ${tries}`;
      }
      await this.ctx.storage.delete(SNAPSHOT_ARMED_KEY);
      await this.ctx.storage.delete(SNAPSHOT_TRIES_KEY);
    } catch (err) {
      // Best-effort mirror, exactly like the session_state write in
      // agents/main.ts. Throwing here would make the DO alarm retry.
      phase = `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      // The breadcrumb is the whole reason this is debuggable: the task runs on
      // a 15-minute fuse in a Durable Object nobody is watching, so a swallowed
      // error with no trace is indistinguishable from "never fired".
      await this.ctx.storage
        .put(LAST_RUN_KEY, { at: new Date().toISOString(), phase })
        .catch(() => {});
    }
  }

  /**
   * Query and write the snapshot. Split out so `snapshotNow()` can exercise
   * exactly this path without waiting out the settle delay.
   *
   * @returns a one-line phase description for the breadcrumb, and whether the
   *   caller should come back (only ever true for "not ingested yet").
   */
  private async writeSnapshot(): Promise<{ phase: string; retry: boolean }> {
    const session = (this as unknown as { sandboxName: string | null }).sandboxName;
    if (!session) return { phase: 'no sandboxName', retry: false };
    if (!this.env.CLOUDFLARE_API_TOKEN || !this.env.CLOUDFLARE_ACCOUNT_ID) {
      return { phase: 'no cloudflare credentials', retry: false };
    }

    // `session` is the sandbox name (the analytics label), not the session id —
    // the KV record lives under the FULL id. Our own DO id is the container id
    // every pointer is keyed by, so the resolution needs no namespace lookup.
    // Fall back to the name itself: channel ids pass through
    // sandboxNameForSession unchanged and have no pointer requirement.
    const sessionId =
      (await sessionIdForContainer(this.env.STORE, this.ctx.id.toString()).catch(() => null)) ?? session;
    const record = await readSession(this.env.STORE, sessionId);
    if (!record) return { phase: 'session record gone — not resurrecting', retry: false };

    const now = new Date();
    // Sessions carry a 24 h TTL, so their life spans at most two UTC days;
    // the fallback covers a record written before createdAt existed.
    const createdAt = typeof record.createdAt === 'string' ? record.createdAt : undefined;
    const start = createdAt ?? new Date(now.getTime() - 25 * 3600_000).toISOString();
    const end = now.toISOString().replace(/\.\d+Z$/, 'Z');

    const folded = await queryContainerCosts(this.env, { start, end });
    // Row match stays by the LABEL (the sandbox name) — that is what Cloudflare
    // grouped by; only the KV write targets the full id.
    const row = folded?.rows.find((r) => r.sessionId === session);
    if (!row) {
      return { phase: `no usage ingested yet (${folded?.rows.length ?? 0} sessions in window)`, retry: true };
    }

    await mergeExistingSessionRecord(this.env.STORE, sessionId, {
      // snake_case to sit alongside session_state, which uses the same style.
      session_sandbox: {
        cpu_seconds: row.cpuSeconds,
        memory_gib_seconds: row.memoryGiBSeconds,
        disk_gb_seconds: row.diskGBSeconds,
        egress_bytes: row.egressBytes,
        cost_total: row.cost.total,
        measured_at: end,
        window_start: start,
        window_end: end,
      },
    });
    return { phase: `written $${row.cost.total}`, retry: false };
  }

  /**
   * Operator view of the snapshot task — RPC, behind GET
   * /admin/sessions/:id/sandbox. Answers the only questions that matter when
   * the node is missing: did the task ever run, what did it decide, and is it
   * still armed?
   */
  async snapshotStatus(): Promise<Record<string, unknown>> {
    return {
      sandboxName: (this as unknown as { sandboxName: string | null }).sandboxName,
      containerRunning: this.ctx.container?.running ?? null,
      armed: (await this.ctx.storage.get(SNAPSHOT_ARMED_KEY)) ?? false,
      tries: (await this.ctx.storage.get<number>(SNAPSHOT_TRIES_KEY)) ?? 0,
      stoppedAt: (await this.ctx.storage.get<number>(STOPPED_AT_KEY)) ?? null,
      lastRun: (await this.ctx.storage.get(LAST_RUN_KEY)) ?? null,
      pollSeconds: SNAPSHOT_POLL_SECONDS,
      settleMs: SNAPSHOT_DELAY_MS,
    };
  }

  /**
   * Take the snapshot NOW, skipping the settle delay — RPC, behind POST
   * /admin/sessions/:id/sandbox. For operators who want the figure before the
   * fuse burns down, and the only way to test the query/write path without a
   * 25-minute round trip.
   */
  /**
   * Arm the scheduled task with an explicit fuse — RPC, behind POST
   * /admin/sessions/:id/sandbox?in=<seconds>.
   *
   * Exists because the production fuse is minutes long inside a DO with no
   * console: this is how you check that `schedule()` really does invoke
   * `recordSandboxCost` on this SDK version, in a minute rather than half an
   * hour. It writes the same breadcrumb the real path does.
   */
  async armSnapshot(seconds: number): Promise<Record<string, unknown>> {
    await this.ctx.storage.put(SNAPSHOT_ARMED_KEY, true);
    const scheduled = await this.schedule(seconds, 'recordSandboxCost');
    return { armedIn: seconds, taskId: (scheduled as { taskId?: string })?.taskId ?? null };
  }

  async snapshotNow(): Promise<Record<string, unknown>> {
    const outcome = await this.writeSnapshot().catch((err: unknown) => ({
      phase: `error: ${err instanceof Error ? err.message : String(err)}`,
      retry: false,
    }));
    await this.ctx.storage
      .put(LAST_RUN_KEY, { at: new Date().toISOString(), phase: outcome.phase, forced: true })
      .catch(() => {});
    return { phase: outcome.phase };
  }
}

SemantiusCopilotSandbox.outboundByHost = {
  [ECHO_HOST]: async (request: Request, env: Env, ctx: { containerId: string }) => {
    const policy = await resolveEgressPolicy(env.STORE, ctx.containerId);
    if (!policy || !isAllowedEgressUrl(request.url, policy.whitelist)) {
      return new Response(JSON.stringify({ error: 'egress denied: host not in the effective allow list' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return injectAndForward(request, policy);
  },
};

SemantiusCopilotSandbox.outbound = async (request: Request, env: Env, ctx: { containerId: string }) => {
  const policy = await resolveEgressPolicy(env.STORE, ctx.containerId);
  const jwt =
    policy && typeof policy.context?.semantius_jwt === 'string' && policy.context.semantius_jwt
      ? policy.context.semantius_jwt
      : undefined;
  return brokerEgress(request, {
    // The union of the agent's proxy_whitelist and the org's copilot allow list
    // (resolveEgressPolicy). It can legitimately be ['*'] — an org running with
    // its copilot firewall off — which is exactly why secretHosts below is a
    // separate, narrow scope.
    whitelist: policy?.whitelist ?? [],
    // The sentinel the container carries as SEMANTIUS_JWT resolves to THIS
    // session's user JWT — there is no shared-key fallback: a session with no
    // verified user has no credential, so a sentinel-bearing request fails
    // closed (503) instead of silently borrowing org-wide access.
    sentinel: SEMANTIUS_JWT_SENTINEL,
    secret: jwt,
    // WHERE that credential may travel, independent of where the sandbox may
    // talk. Widening egress must never widen the JWT's reach: a sentinel aimed
    // at a merely-reachable host is a 403, not a swap.
    secretHosts: SEMANTIUS_HOSTS,
    ...(jwt ? { jwt: { token: jwt, hosts: SEMANTIUS_HOSTS } } : {}),
  });
};

/**
 * Non-HTTP Worker handlers. The @flue/vite entry spreads this default export
 * into the Worker's own (`export default { ...cloudflareHandlers, fetch }`) —
 * its designed extension point; `fetch` must NOT appear here (the entry
 * throws — HTTP belongs to app.ts).
 *
 * `scheduled` is the hourly backup sweep (wrangler.jsonc `triggers.crons`):
 * sessions expire silently at their 24 h KV TTL, and this is the mechanism
 * that deletes their R2 backups (add_backup_restore_plan.md requirement 2) —
 * the loud paths (supersede, DELETE /sessions/:id) already delete inline.
 */
export default {
  async scheduled(_controller: ScheduledController, env: BackupEnv, _ctx: ExecutionContext): Promise<void> {
    try {
      await sweepExpiredBackups(env);
    } catch (err) {
      // Best-effort like every mirror here — a failed sweep retries next hour.
      console.log(`backup: scheduled sweep failed: ${String(err).slice(0, 300)}`);
    }
  },
};
