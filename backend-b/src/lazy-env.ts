/**
 * Lazy-boot Sandbox wrapper (design §15 P1 successor): nothing sandbox-side —
 * not the container, not even its Durable Object — is touched until a turn
 * performs an operation that genuinely needs the machine.
 *
 * Why this exists: Flue runs workspace discovery (AGENTS.md probes, skills-dir
 * listing, SKILL.md reads, cwd listing) at the start of EVERY submission,
 * before the model turn — and on @cloudflare/sandbox the first RPC is what
 * boots the container. On top of that, `getSandbox()` itself is not free: on a
 * cold per-isolate cache it always sends a `configure` RPC carrying the
 * sandbox name (sandbox-DI6suZAc.js:6617 — `sandboxName` is emitted whenever
 * the cache is empty), which wakes the sandbox DO even if no container ever
 * starts. So the wrapper defers BOTH: `getSandbox()` is only called on the
 * provision/delegation path, never at construction.
 *
 * The fix is execution-layer interception, not prompting: we know exactly what
 * the unbooted workspace will contain, because the immutable per-session
 * bundle in KV holds every skill file's content — the container's disk copy is
 * just `provisionAgentSkills`' extraction of it. So:
 *
 *   - Reads inside the skills tree (and the probes leading to it) are answered
 *     from a virtual view of the bundle: discovery and `read`-tool SKILL.md
 *     reads see byte-identical content to a warm container, at zero sandbox
 *     activity of any kind.
 *   - Probes outside that tree answer "not there" — truthful, nothing else
 *     exists before provisioning (no AGENTS.md is ever shipped).
 *   - Operations that need a live machine (`exec` — which carries the bash /
 *     grep / glob tools — writes, and reads outside the tree) first run
 *     `provision` (single-flight; boots the container and materializes the
 *     same bundle onto disk), then construct the real env and forward. From
 *     then on every call passes through — the view never changes, only its
 *     backing store.
 *
 * The wrapper mirrors @flue/runtime's `Sandbox` surface (exec, readFile,
 * readFileBuffer, writeFile, stat, readdir, exists, mkdir, rm, cwd,
 * resolvePath — types-CVx9SjIx.d.mts:388, the interface 2.0.3 renamed from
 * `SessionEnv`) and its POSIX path resolution (normalizePath/makeResolvePath,
 * sandbox-DAJ0daML.mjs:245-262). Re-verify both on any @flue/runtime upgrade
 * (the chunk hashes move every release): a method added upstream and not
 * delegated here would bypass the boot gate or, worse, dodge the bundle view.
 * Verified unchanged for 2.0.3.
 *
 * One wrapper instance lives per submission (Flue calls createSandbox per
 * submission), so "provisioned" also acts as the per-submission self-heal:
 * the first container-needing op after a container slept re-runs the
 * absent→write provisioning, exactly what useAgentStart used to do eagerly on
 * every message.
 *
 * Mid-submission resets (options.resetProbe): the container can be replaced
 * UNDER a running turn — sleepAfter elapsing between two slow tool calls,
 * eviction, a deploy. The SDK then boots a fresh disk transparently, and a
 * memoized `provisioned` would let every later op run on it: no skills, no
 * env, none of the files earlier tool calls wrote — and a persist of that
 * blank disk would supersede the session's good backup. So once provisioned,
 * every op that reaches the inner env first runs `resetProbe(inner)`; a
 * `false` answer clears the memo and re-runs the full provision (restore +
 * skills + env) before the op proceeds. One cheap RPC per container op.
 *
 * Mutations (options.onMutation): fired after every exec / writeFile / mkdir /
 * rm settles (success OR failure — a failed exec may still have written), so
 * the caller can persist the workspace after each filesystem mutation.
 *
 * Broken stubs (the 2026-08-19 incident, README "Workspace backup & restore" >
 * "Mid-turn stub break"): `inner` is ONE Durable Object stub — the client-side
 * handle whose every method is an RPC to the sandbox DO — memoized for the
 * whole submission. workerd's contract is that a stub whose connection breaks
 * (the DO reset or evicted under an in-flight call, the inter-colo link
 * dropped) stays broken: every later call on it rejects at once, typically
 * `internal error; reference = <id>` with `.retryable === true`, while the DO
 * and its container are perfectly reachable through a NEW stub. Seen live
 * (and read back from the sandbox DO's Workers Logs): the runtime's container
 * proxy threw `internal error` inside the SDK's containerFetch 29 s into an
 * `exec` whose command had in fact run, the sandbox DO instance was reset
 * under the call (its keep-alive alarm died in the same millisecond, the next
 * RPC was served by a fresh instance), the next five agent calls (`echo`,
 * `true`) failed in 9 ms each WITHOUT reaching the DO, and the backup path —
 * which builds a fresh stub per call — kept succeeding against the same DO
 * throughout. So:
 *
 *   - every op that fails with a stub-break error (isStubBreak) DROPS the memo:
 *     the next op, whatever it is, builds a fresh stub (makeInner again); the
 *     reset probe on that stub decides whether the container also needs
 *     re-provisioning;
 *   - the failed op itself is re-run on the fresh stub ONCE (STUB_RETRY_LIMIT,
 *     a per-op counter — never a second retry) when replaying it is safe:
 *     reads, the reset probe, and writeFile (idempotent by content);
 *   - `exec`, `mkdir` and `rm` are NOT replayed: the RPC may have failed on the
 *     way BACK, after the container ran the command, and replaying a shell
 *     command is at-least-once (a `semantius` write would double-apply). They
 *     fail with a message that says the connection is re-established and the
 *     effect must be checked before re-running — the model's own retry is the
 *     retry, and it lands on the fresh stub.
 */
import type { FileStat, Sandbox } from '@flue/runtime';
import { SKILLS_DIR } from '@semantius-copilot/core';

/**
 * How many times ONE operation may be re-run on a fresh stub after a
 * stub-break failure. One: a second break in a row on a brand-new stub means
 * the sandbox DO itself is unreachable, and looping would only delay the
 * error the model needs to see. Per op, not per submission — each op costs at
 * most one extra attempt, and a later op starts its own count.
 */
export const STUB_RETRY_LIMIT = 1;

/**
 * workerd's broken-stub signatures, as seen by the caller of a Durable Object
 * stub: `.retryable === true` (the documented flag on DO stub errors),
 * `internal error; reference = …` (the runtime's opaque internal failure, the
 * 2026-08-19 shape), a DO reset under the call, or the kj transport message
 * for a dropped connection. Deliberately NOT matched: the Sandbox SDK's own
 * container-transport messages (`WebSocket … disconnected`, `Request timeout
 * after …`) — those are the DO talking to its container, which the SDK
 * reconnects itself and a new stub would not change — and Flue's
 * SandboxDiedError (the container really stopped; the reset probe handles it).
 */
export function isStubBreak(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { retryable?: unknown; message?: unknown };
  if (e.retryable === true) return true;
  const message = typeof e.message === 'string' ? e.message : String(err);
  return /internal error; reference = |Durable Object reset because|Network connection lost/i.test(message);
}

/** The ops the wrapper forwards to the inner env once it exists. */
type Op = 'exists' | 'readdir' | 'stat' | 'readFile' | 'readFileBuffer' | 'exec' | 'writeFile' | 'mkdir' | 'rm' | 'resetProbe';

/**
 * Which ops may be re-run on a fresh stub after a stub break. Replay is safe
 * when a lost-but-landed first attempt leaves the second attempt with the same
 * outcome: reads and the probe trivially; writeFile because the same bytes land
 * twice. Not exec (arbitrary shell, at-least-once), not mkdir (a landed first
 * attempt makes a non-recursive replay fail "exists"), not rm (a landed first
 * attempt makes a non-forced replay fail "not found").
 */
const REPLAY_SAFE: ReadonlySet<Op> = new Set(['exists', 'readdir', 'stat', 'readFile', 'readFileBuffer', 'resetProbe', 'writeFile']);

/**
 * The error a NON-replayed op surfaces after a stub break. Flue renders a
 * thrown error's message as the tool result, so this is what the model reads:
 * it says the effect is unknown and the connection is already back, so the
 * right move is check-then-re-run, not blind re-run. The original error rides
 * along as `cause` (and its text in the message — the reference id is what
 * Cloudflare support asks for).
 */
function notReplayed(op: Op, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `sandbox connection dropped during this ${op} — it may or may not have taken effect; ` +
      `the connection is re-established, so check its effect and re-run only what is missing (${detail})`,
    { cause: err },
  );
}

/** The slice of the agent bundle the virtual view needs. */
export type SkillFilesBundle = { skills?: Record<string, Record<string, string>> } | null;

type VNode = { kind: 'file'; content: string } | { kind: 'dir'; children: Set<string> };

/** Byte-for-byte mirror of @flue/runtime's normalizePath (sandbox-DAJ0daML.mjs:245). */
function normalizePath(p: string): string {
  const parts = p.split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') result.pop();
    else result.push(part);
  }
  return `/${result.join('/')}`;
}

/** Mirror of @flue/runtime's makeResolvePath (sandbox-DAJ0daML.mjs:256). */
function makeResolvePath(cwd: string) {
  return (p: string) => {
    if (p.startsWith('/')) return normalizePath(p);
    if (cwd === '/') return normalizePath(`/${p}`);
    return normalizePath(`${cwd}/${p}`);
  };
}

/**
 * Materialize the bundle's skills as path -> node, rooted exactly where
 * `provisionAgentSkills` extracts them (`<SKILLS_DIR>/<skillName>/<relPath>`),
 * so pre- and post-boot reads are byte-identical. A missing/zero-skill bundle
 * yields an empty view: nothing exists before provisioning, and discovery's
 * cwd listing tolerates the resulting not-found (it try/catches readdir).
 */
function buildView(bundle: SkillFilesBundle): Map<string, VNode> {
  const nodes = new Map<string, VNode>();
  const skills = bundle?.skills ?? {};
  if (Object.keys(skills).length === 0) return nodes;

  const dir = (path: string): Extract<VNode, { kind: 'dir' }> => {
    let node = nodes.get(path);
    if (!node) {
      node = { kind: 'dir', children: new Set() };
      nodes.set(path, node);
    }
    if (node.kind !== 'dir') throw new Error(`bundle path is both file and dir: ${path}`);
    return node;
  };
  // SKILLS_DIR is /workspace/.agents/skills — seed its ancestry so the cwd
  // listing shows `.agents` exactly like a provisioned container would.
  dir('/workspace').children.add('.agents');
  dir('/workspace/.agents').children.add('skills');
  dir(SKILLS_DIR);

  for (const [skillName, files] of Object.entries(skills)) {
    dir(SKILLS_DIR).children.add(skillName);
    const skillRoot = `${SKILLS_DIR}/${skillName}`;
    dir(skillRoot);
    for (const [relPath, content] of Object.entries(files)) {
      const parts = relPath.split('/').filter(Boolean);
      let parent = skillRoot;
      for (const part of parts.slice(0, -1)) {
        dir(parent).children.add(part);
        parent = `${parent}/${part}`;
        dir(parent);
      }
      const base = parts[parts.length - 1];
      if (!base) continue;
      dir(parent).children.add(base);
      nodes.set(`${parent}/${base}`, { kind: 'file', content });
    }
  }
  return nodes;
}

const notFound = (op: string, path: string) =>
  new Error(`${op} failed for ${path}: No such file or directory`);

export type LazySessionEnvOptions = {
  /**
   * "Is the container still the one we provisioned?" — checked before every
   * op once provisioned; `false` re-runs provision first. Should be a single
   * cheap RPC (a marker `exists`). A throwing probe is treated as "still
   * live" so a flaky probe never blocks the op it guards.
   */
  resetProbe?: (inner: Sandbox) => Promise<boolean>;
  /** Fired after every mutating op settles (exec / writeFile / mkdir / rm). */
  onMutation?: (op: 'exec' | 'writeFile' | 'mkdir' | 'rm', detail: string) => void;
  /**
   * Retries per op on a fresh stub after a stub break (default
   * STUB_RETRY_LIMIT). Tests pass 0 to prove the bound; production never sets it.
   */
  stubRetryLimit?: number;
  /**
   * Fired when a stub-break failure drops the memoized stub (the op that
   * detected it, its detail, the error, and whether that op will be replayed).
   * Observability hook for tests; production reads the console breadcrumb.
   */
  onStubBreak?: (op: Op, detail: string, err: unknown, replay: boolean) => void;
};

export function lazySessionEnv(
  cwd: string,
  /** Builds the real env — first use of this is the first sandbox-DO contact. */
  makeInner: () => Promise<Sandbox>,
  loadBundle: () => Promise<SkillFilesBundle>,
  provision: (bundle: SkillFilesBundle) => Promise<void>,
  options: LazySessionEnvOptions = {},
): Sandbox {
  let provisioned = false;
  let provisioning: Promise<void> | undefined;
  let innerPromise: Promise<Sandbox> | undefined;
  /** The env `innerPromise` resolved to — identity check for dropInner. */
  let innerEnv: Sandbox | undefined;
  let viewPromise: Promise<Map<string, VNode>> | undefined;
  const retryLimit = options.stubRetryLimit ?? STUB_RETRY_LIMIT;

  const normalizedCwd = normalizePath(cwd);
  const resolvePath = makeResolvePath(normalizedCwd);

  const inner = () => {
    innerPromise ??= makeInner().then(
      (env) => {
        innerEnv = env;
        return env;
      },
      (err) => {
        innerPromise = undefined;
        throw err;
      },
    );
    return innerPromise;
  };

  /**
   * A call on `env` failed with a stub-break error: forget it, so the next
   * `inner()` builds a fresh stub. `provisioned` is deliberately KEPT — the
   * container is almost always still the one we provisioned (the incident's
   * backups kept landing on it); the reset probe on the fresh stub is what
   * decides, exactly as for any other op. Identity-guarded: a slow call on an
   * already-replaced stub must not throw away the replacement a later op is
   * using (it would only cost one more makeInner, but it would also lose that
   * stub's log attribution).
   */
  const dropInner = (env: Sandbox, op: Op, detail: string, err: unknown, replay: boolean) => {
    const current = innerEnv === env;
    console.log(
      `lazy-env: sandbox stub broke during ${op}: ${detail.slice(0, 200)} — ${String(err).slice(0, 200)}` +
        (current ? ` — dropped; next op builds a fresh stub${replay ? '; replaying this op' : ''}` : ' — already replaced'),
    );
    if (current) {
      innerPromise = undefined;
      innerEnv = undefined;
    }
    try {
      options.onStubBreak?.(op, detail, err, replay);
    } catch (hookErr) {
      console.log(`lazy-env: onStubBreak hook threw: ${String(hookErr).slice(0, 200)}`);
    }
  };

  /**
   * The inner env, verified live: after provisioning, run the reset probe;
   * a reset clears the memo and re-provisions (single-flight via `ready`)
   * before the op proceeds. Concurrent ops that all see the reset share the
   * one re-provision, because `ready` memoizes `provisioning`.
   *
   * The probe is itself an RPC on the stub, so it is the first thing to learn
   * the stub is broken: a stub-break rejection drops the stub and re-probes
   * ONCE on a fresh one (a probe is a read — replay-safe). Any other probe
   * failure, or a second break, is "assuming live" as before: a flaky probe
   * never blocks the op it guards.
   */
  const live = async (op: Op, detail: string): Promise<Sandbox> => {
    let env = await inner();
    if (!provisioned) {
      // A concurrent op already detected the reset and is re-provisioning:
      // join it rather than run on the not-yet-restored disk.
      await ready(op, detail);
      return env;
    }
    if (options.resetProbe) {
      let alive = true;
      let probes = 0;
      for (;;) {
        try {
          alive = await options.resetProbe(env);
          break;
        } catch (err) {
          if (isStubBreak(err) && probes < retryLimit) {
            probes += 1;
            dropInner(env, 'resetProbe', detail, err, true);
            env = await inner();
            continue;
          }
          console.log(`lazy-env: reset probe failed, assuming live: ${String(err).slice(0, 200)}`);
          break;
        }
      }
      if (!alive) {
        console.log(`lazy-env: container reset detected before ${op}: ${detail.slice(0, 200)} — re-provisioning`);
        provisioned = false;
        provisioning = undefined;
        await ready(op, `${detail} (after reset)`);
      }
    }
    return env;
  };

  /**
   * Run one op against the inner env. `probe` = run the reset probe first
   * (false only for the op that just provisioned — the probe would be
   * redundant; a retry always probes, because the fresh stub may be looking at
   * a replaced container). On a stub break the stub is dropped either way; the
   * op is re-run on a fresh stub at most `retryLimit` times when it is
   * replay-safe, else it fails with notReplayed. A non-stub error passes
   * through untouched — no drop, no retry.
   */
  const call = async <T>(op: Op, detail: string, probe: boolean, run: (env: Sandbox) => Promise<T>): Promise<T> => {
    const replay = REPLAY_SAFE.has(op);
    let tries = 0;
    for (;;) {
      const env = probe || tries > 0 ? await live(op, detail) : await inner();
      try {
        return await run(env);
      } catch (err) {
        if (!isStubBreak(err)) throw err;
        const again = replay && tries < retryLimit;
        dropInner(env, op, detail, err, again);
        if (!again) throw replay ? err : notReplayed(op, err);
        tries += 1;
      }
    }
  };

  const mutated = (op: 'exec' | 'writeFile' | 'mkdir' | 'rm', detail: string) => {
    try {
      options.onMutation?.(op, detail);
    } catch (err) {
      console.log(`lazy-env: onMutation hook threw: ${String(err).slice(0, 200)}`);
    }
  };

  const view = () => {
    viewPromise ??= loadBundle().then(buildView, (err) => {
      viewPromise = undefined; // a failed KV read must not cache as "empty"
      throw err;
    });
    return viewPromise;
  };

  /** Boot + provision exactly once; a failure clears the memo so a later op retries. */
  const ready = (op: string, detail: string) => {
    // Boot attribution (Workers Logs / wrangler tail): every container start
    // must be explainable by exactly one of these lines.
    if (!provisioning) console.log(`lazy-env: container boot triggered by ${op}: ${detail.slice(0, 200)}`);
    provisioning ??= loadBundle()
      .then(provision)
      .then(
        () => {
          provisioned = true;
        },
        (err) => {
          provisioning = undefined;
          throw err;
        },
      );
    return provisioning;
  };

  /** Absolute, normalized key into the view. */
  const norm = (path: string) => resolvePath(path);

  return {
    cwd: normalizedCwd,
    resolvePath,

    async exists(path) {
      if (provisioned) return call('exists', path, true, (env) => env.exists(path));
      return (await view()).has(norm(path));
    },
    async readdir(path) {
      if (provisioned) return call('readdir', path, true, (env) => env.readdir(path));
      const node = (await view()).get(norm(path));
      if (node?.kind !== 'dir') throw notFound('readdir', path);
      return [...node.children];
    },
    async stat(path) {
      if (provisioned) return call('stat', path, true, (env) => env.stat(path));
      const node = (await view()).get(norm(path));
      if (!node) throw notFound('stat', path);
      const isFile = node.kind === 'file';
      return {
        isFile,
        isDirectory: !isFile,
        isSymbolicLink: false,
        size: isFile ? new TextEncoder().encode(node.content).length : 0,
        mtime: new Date(0),
      } satisfies FileStat;
    },
    async readFile(path) {
      if (!provisioned) {
        const node = (await view()).get(norm(path));
        if (node?.kind === 'file') return node.content;
        if (node) throw new Error(`readFile failed for ${path}: is a directory`);
        await ready('readFile', path); // outside the bundled tree — genuinely needs the container
        return call('readFile', path, false, (env) => env.readFile(path)); // just provisioned: the probe would be redundant
      }
      return call('readFile', path, true, (env) => env.readFile(path));
    },
    async readFileBuffer(path) {
      if (!provisioned) {
        const node = (await view()).get(norm(path));
        if (node?.kind === 'file') return new TextEncoder().encode(node.content);
        if (node) throw new Error(`readFile failed for ${path}: is a directory`);
        await ready('readFileBuffer', path);
        return call('readFileBuffer', path, false, (env) => env.readFileBuffer(path));
      }
      return call('readFileBuffer', path, true, (env) => env.readFileBuffer(path));
    },

    // Mutating ops: boot-or-verify, forward, then report the mutation whether
    // the op succeeded or threw (a failed exec may still have written).
    async exec(command, execOptions) {
      const wasProvisioned = provisioned;
      await ready('exec', command);
      try {
        return await call('exec', command, wasProvisioned, (env) => env.exec(command, execOptions));
      } finally {
        mutated('exec', command);
      }
    },
    async writeFile(path, content) {
      const wasProvisioned = provisioned;
      await ready('writeFile', path);
      try {
        return await call('writeFile', path, wasProvisioned, (env) => env.writeFile(path, content));
      } finally {
        mutated('writeFile', path);
      }
    },
    async mkdir(path, mkdirOptions) {
      const wasProvisioned = provisioned;
      await ready('mkdir', path);
      try {
        return await call('mkdir', path, wasProvisioned, (env) => env.mkdir(path, mkdirOptions));
      } finally {
        mutated('mkdir', path);
      }
    },
    async rm(path, rmOptions) {
      const wasProvisioned = provisioned;
      await ready('rm', path);
      try {
        return await call('rm', path, wasProvisioned, (env) => env.rm(path, rmOptions));
      } finally {
        mutated('rm', path);
      }
    },
  };
}
