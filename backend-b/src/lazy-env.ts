/**
 * Lazy-boot Sandbox wrapper (plan §15 P1 successor): nothing sandbox-side —
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
 */
import type { FileStat, Sandbox } from '@flue/runtime';
import { SKILLS_DIR } from '@semantius-copilot/core';

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
  let viewPromise: Promise<Map<string, VNode>> | undefined;

  const normalizedCwd = normalizePath(cwd);
  const resolvePath = makeResolvePath(normalizedCwd);

  const inner = () => {
    innerPromise ??= makeInner().catch((err) => {
      innerPromise = undefined;
      throw err;
    });
    return innerPromise;
  };

  /**
   * The inner env, verified live: after provisioning, run the reset probe;
   * a reset clears the memo and re-provisions (single-flight via `ready`)
   * before the op proceeds. Concurrent ops that all see the reset share the
   * one re-provision, because `ready` memoizes `provisioning`.
   */
  const live = async (op: string, detail: string): Promise<Sandbox> => {
    const env = await inner();
    if (!provisioned) {
      // A concurrent op already detected the reset and is re-provisioning:
      // join it rather than run on the not-yet-restored disk.
      await ready(op, detail);
      return env;
    }
    if (options.resetProbe) {
      let alive = true;
      try {
        alive = await options.resetProbe(env);
      } catch (err) {
        console.log(`lazy-env: reset probe failed, assuming live: ${String(err).slice(0, 200)}`);
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
      if (provisioned) return (await live('exists', path)).exists(path);
      return (await view()).has(norm(path));
    },
    async readdir(path) {
      if (provisioned) return (await live('readdir', path)).readdir(path);
      const node = (await view()).get(norm(path));
      if (node?.kind !== 'dir') throw notFound('readdir', path);
      return [...node.children];
    },
    async stat(path) {
      if (provisioned) return (await live('stat', path)).stat(path);
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
        return (await inner()).readFile(path); // just provisioned: the probe would be redundant
      }
      return (await live('readFile', path)).readFile(path);
    },
    async readFileBuffer(path) {
      if (!provisioned) {
        const node = (await view()).get(norm(path));
        if (node?.kind === 'file') return new TextEncoder().encode(node.content);
        if (node) throw new Error(`readFile failed for ${path}: is a directory`);
        await ready('readFileBuffer', path);
        return (await inner()).readFileBuffer(path);
      }
      return (await live('readFileBuffer', path)).readFileBuffer(path);
    },

    // Mutating ops: boot-or-verify, forward, then report the mutation whether
    // the op succeeded or threw (a failed exec may still have written).
    async exec(command, execOptions) {
      const wasProvisioned = provisioned;
      await ready('exec', command);
      const env = wasProvisioned ? await live('exec', command) : await inner();
      try {
        return await env.exec(command, execOptions);
      } finally {
        mutated('exec', command);
      }
    },
    async writeFile(path, content) {
      const wasProvisioned = provisioned;
      await ready('writeFile', path);
      const env = wasProvisioned ? await live('writeFile', path) : await inner();
      try {
        return await env.writeFile(path, content);
      } finally {
        mutated('writeFile', path);
      }
    },
    async mkdir(path, mkdirOptions) {
      const wasProvisioned = provisioned;
      await ready('mkdir', path);
      const env = wasProvisioned ? await live('mkdir', path) : await inner();
      try {
        return await env.mkdir(path, mkdirOptions);
      } finally {
        mutated('mkdir', path);
      }
    },
    async rm(path, rmOptions) {
      const wasProvisioned = provisioned;
      await ready('rm', path);
      const env = wasProvisioned ? await live('rm', path) : await inner();
      try {
        return await env.rm(path, rmOptions);
      } finally {
        mutated('rm', path);
      }
    },
  };
}
