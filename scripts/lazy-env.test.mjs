#!/usr/bin/env node
/**
 * Lazy sandbox env — broken-stub handling (the 2026-08-19 incident, README
 * "Workspace backup & restore" > "Mid-turn stub break"), offline.
 *
 * `backend-b/src/lazy-env.ts` is imported STRAIGHT FROM ITS .ts SOURCE (Node
 * ≥ 22.6 strips types natively; the file is erasable-TS, its only non-type
 * import is the plain-JS core package, resolved from backend-b/node_modules).
 *
 * The inner env is a scripted fake of @flue/runtime's Sandbox: each makeInner()
 * call yields a NEW stub whose methods succeed unless a scripted failure is
 * queued for them. workerd's broken-stub shape is reproduced exactly as seen
 * live: `internal error; reference = <id>` (and the `.retryable` flag variant).
 *
 * Covers: a stub break on a read drops the stub and replays ONCE on a fresh
 * one; the per-op bound (a second break is surfaced, never a third stub);
 * stubRetryLimit: 0 (no replay, stub still dropped); exec is never replayed
 * but drops the stub, surfaces a check-then-re-run message, still fires
 * onMutation once, and the NEXT op lands on a fresh stub; mkdir / rm behave
 * like exec, writeFile like a read; a stub break in the reset probe re-probes
 * on a fresh stub and the op runs there; a non-stub error neither drops nor
 * retries; the identity guard (a slow op on an already-replaced stub does not
 * drop the replacement); isStubBreak's signatures.
 *
 *   node scripts/lazy-env.test.mjs        (also part of `pnpm test`)
 */
import { isStubBreak, lazySessionEnv, STUB_RETRY_LIMIT } from '../backend-b/src/lazy-env.ts';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

const stubBreak = (id) => Object.assign(new Error(`internal error; reference = ${id}`), { retryable: true });

/**
 * One fake stub. `fail[method]` is a queue of errors: each call shifts one and
 * rejects with it; an empty queue resolves. Every call is recorded as
 * `<stubIndex>:<method>` in the shared trace so tests can assert which stub
 * served which call, in order.
 */
function makeStub(index, trace, fail = {}, state = { booting: false }) {
  const record = (method) => {
    trace.push(`${index}:${method}`);
    if (state.booting) return; // the harness's boot op never consumes a scripted failure
    const next = fail[method]?.shift();
    if (next) throw next;
  };
  return {
    cwd: '/workspace',
    resolvePath: (p) => p,
    async exists(path) {
      record('exists');
      return path === '/workspace/.restored';
    },
    async readdir() {
      record('readdir');
      return ['a'];
    },
    async stat() {
      record('stat');
      return { isFile: true, isDirectory: false, isSymbolicLink: false, size: 1, mtime: new Date(0) };
    },
    async readFile(path) {
      record('readFile');
      return `content of ${path} from stub ${index}`;
    },
    async readFileBuffer() {
      record('readFileBuffer');
      return new Uint8Array([1]);
    },
    async exec(command) {
      record('exec');
      return { stdout: `${command} on stub ${index}`, stderr: '', exitCode: 0 };
    },
    async writeFile() {
      record('writeFile');
    },
    async mkdir() {
      record('mkdir');
    },
    async rm() {
      record('rm');
    },
  };
}

/**
 * Build a lazy env over scripted stubs. `plan[i]` is the failure script for
 * the i-th stub makeInner() produces. Returns the env plus the shared trace,
 * the makeInner counter, and the hooks' call logs. `provisioned` is reached by
 * running one successful exec first (the boot op), unless `boot: false`.
 */
async function harness(plan = [], opts = {}) {
  const trace = [];
  const makes = { count: 0 };
  const mutations = [];
  const breaks = [];
  const state = { booting: opts.boot !== false };
  const stubs = [];
  const env = lazySessionEnv(
    '/workspace',
    async () => {
      const stub = makeStub(++makes.count, trace, plan[makes.count - 1], state);
      stubs.push(stub);
      return stub;
    },
    async () => ({ skills: { demo: { 'SKILL.md': '# demo' } } }),
    async () => {},
    {
      resetProbe: (inner) => inner.exists('/workspace/.restored'),
      onMutation: (op, detail) => mutations.push(`${op}:${detail}`),
      onStubBreak: (op, detail, err, replay) => breaks.push({ op, detail, message: String(err?.message ?? err), replay }),
      ...opts,
    },
  );
  if (opts.boot !== false) {
    await env.exec('boot');
    state.booting = false;
    trace.length = 0;
    mutations.length = 0;
  }
  return { env, trace, makes, mutations, breaks, stubs };
}

// ---------------------------------------------------------------------------
// isStubBreak signatures

check('isStubBreak: internal error; reference', isStubBreak(new Error('internal error; reference = unbhcaukga1o6dadc9klavln')));
check('isStubBreak: .retryable flag alone', isStubBreak(Object.assign(new Error('something'), { retryable: true })));
check('isStubBreak: Durable Object reset', isStubBreak(new Error('Durable Object reset because its code was updated.')));
check('isStubBreak: Network connection lost', isStubBreak(new Error('Network connection lost.')));
check('isStubBreak: plain shell error is not', !isStubBreak(new Error('readFile failed for /x: No such file or directory')));
check('isStubBreak: SDK container-transport message is not', !isStubBreak(new Error('Request timeout after 120000ms: POST /api/execute')));
check('isStubBreak: non-object is not', !isStubBreak('internal error; reference = x') && !isStubBreak(undefined));
check('STUB_RETRY_LIMIT is one retry', STUB_RETRY_LIMIT === 1);

// ---------------------------------------------------------------------------
// read op: break → drop → replay once on a fresh stub

{
  const h = await harness([{ readFile: [stubBreak('r1')] }]);
  const out = await h.env.readFile('/workspace/x.txt');
  check('read replays on a fresh stub and succeeds', out === 'content of /workspace/x.txt from stub 2', out);
  check('read replay: probe, fail, probe on fresh stub, read', h.trace.join(' ') === '1:exists 1:readFile 2:exists 2:readFile', h.trace.join(' '));
  check('read replay: exactly two stubs built', h.makes.count === 2, String(h.makes.count));
  check('read replay: onStubBreak fired once, replay=true', h.breaks.length === 1 && h.breaks[0].op === 'readFile' && h.breaks[0].replay === true, JSON.stringify(h.breaks));
  // The stub stays fresh for what follows: no third build.
  await h.env.readFile('/workspace/y.txt');
  check('read replay: next op reuses the fresh stub', h.makes.count === 2 && h.trace.at(-1) === '2:readFile');
}

// ---------------------------------------------------------------------------
// the bound: a second break in a row surfaces, and no third stub is built

{
  const h = await harness([{ readFile: [stubBreak('b1')] }, { readFile: [stubBreak('b2')] }]);
  let err;
  try {
    await h.env.readFile('/workspace/x.txt');
  } catch (e) {
    err = e;
  }
  check('bound: second break surfaces the second error', err?.message === 'internal error; reference = b2', err?.message);
  check('bound: two stubs, never a third', h.makes.count === 2, String(h.makes.count));
  check('bound: two onStubBreak events, the last with replay=false', h.breaks.length === 2 && h.breaks[1].replay === false, JSON.stringify(h.breaks));
  // The second break also dropped its stub: the next op builds stub 3 and succeeds.
  const out = await h.env.readFile('/workspace/z.txt');
  check('bound: the next op starts its own count on a fresh stub', out.endsWith('stub 3') && h.makes.count === 3, out);
}

// stubRetryLimit: 0 — no replay at all, but the broken stub is still dropped.
{
  const h = await harness([{ readFile: [stubBreak('z1')] }], { stubRetryLimit: 0 });
  let err;
  try {
    await h.env.readFile('/workspace/x.txt');
  } catch (e) {
    err = e;
  }
  check('limit 0: the break surfaces unchanged', err?.message === 'internal error; reference = z1', err?.message);
  check('limit 0: no replay (one stub so far)', h.makes.count === 1 && h.trace.join(' ') === '1:exists 1:readFile', h.trace.join(' '));
  await h.env.readFile('/workspace/y.txt');
  check('limit 0: the next op still gets a fresh stub', h.makes.count === 2 && h.trace.at(-1) === '2:readFile');
}

// ---------------------------------------------------------------------------
// exec: never replayed; stub dropped; check-then-re-run message; onMutation once;
// the NEXT op lands on a fresh stub (the incident's cascade)

{
  const h = await harness([{ exec: [stubBreak('e1')] }]);
  let err;
  try {
    await h.env.exec('semantius call crud getCurrentUser');
  } catch (e) {
    err = e;
  }
  check('exec: not replayed (one stub, one exec)', h.makes.count === 1 && h.trace.join(' ') === '1:exists 1:exec', h.trace.join(' '));
  check(
    'exec: surfaces the check-then-re-run message with the reference id',
    /sandbox connection dropped during this exec/.test(err?.message ?? '') &&
      /may or may not have taken effect/.test(err?.message ?? '') &&
      /internal error; reference = e1/.test(err?.message ?? ''),
    err?.message,
  );
  check('exec: original error is the cause', err?.cause?.message === 'internal error; reference = e1');
  check('exec: onMutation fired exactly once for the failed exec', h.mutations.length === 1 && h.mutations[0].startsWith('exec:'), JSON.stringify(h.mutations));
  check('exec: onStubBreak fired with replay=false', h.breaks.length === 1 && h.breaks[0].replay === false, JSON.stringify(h.breaks));
  // The incident: the following execs must NOT keep failing on the dead stub.
  const next = await h.env.exec('echo hello');
  check('exec: the next exec runs on a fresh stub', next.stdout === 'echo hello on stub 2' && h.makes.count === 2, next.stdout);
  const again = await h.env.exec('true');
  check('exec: and the one after reuses that stub', again.stdout === 'true on stub 2' && h.makes.count === 2, again.stdout);
}

// mkdir / rm: like exec. writeFile: like a read (idempotent by content).
{
  const h = await harness([{ mkdir: [stubBreak('m1')], rm: [stubBreak('d1')], writeFile: [stubBreak('w1')] }]);
  let err;
  try {
    await h.env.mkdir('/workspace/dir', { recursive: true });
  } catch (e) {
    err = e;
  }
  check('mkdir: not replayed, check-then-re-run message', h.makes.count === 1 && /during this mkdir/.test(err?.message ?? ''), err?.message);
  // stub 1 dropped → rm builds stub 2 (its own script has no rm failure).
  await h.env.rm('/workspace/dir', { recursive: true, force: true });
  check('rm after the drop: fresh stub, succeeds', h.makes.count === 2 && h.trace.at(-1) === '2:rm', h.trace.join(' '));
  // writeFile break on stub 2? Its script is plan[1] = undefined → no failure. Use a new harness.
  const w = await harness([{ writeFile: [stubBreak('w1')] }]);
  await w.env.writeFile('/workspace/f.txt', 'same bytes');
  check('writeFile: replayed once on a fresh stub', w.makes.count === 2 && w.trace.join(' ') === '1:exists 1:writeFile 2:exists 2:writeFile', w.trace.join(' '));
  check('writeFile: onMutation fired once (per call, not per attempt)', w.mutations.length === 1, JSON.stringify(w.mutations));
  const r = await harness([{ rm: [stubBreak('d1')] }]);
  let rmErr;
  try {
    await r.env.rm('/workspace/f.txt', {});
  } catch (e) {
    rmErr = e;
  }
  check('rm: not replayed', r.makes.count === 1 && /during this rm/.test(rmErr?.message ?? ''), rmErr?.message);
}

// ---------------------------------------------------------------------------
// reset probe: a stub break there re-probes on a fresh stub; the op runs there

{
  const h = await harness([{ exists: [stubBreak('p1')] }]);
  const out = await h.env.exec('ls');
  check('probe break: exec runs on the fresh stub', out.stdout === 'ls on stub 2', out.stdout);
  check('probe break: probe fails on 1, re-probes on 2, exec on 2', h.trace.join(' ') === '1:exists 2:exists 2:exec', h.trace.join(' '));
  check('probe break: onStubBreak op=resetProbe, replay=true', h.breaks.length === 1 && h.breaks[0].op === 'resetProbe' && h.breaks[0].replay === true, JSON.stringify(h.breaks));
}
// probe break twice in a row: "assuming live" (today's behavior), op on stub 2
{
  const h = await harness([{ exists: [stubBreak('p1')] }, { exists: [stubBreak('p2')] }]);
  const out = await h.env.exec('ls');
  check('double probe break: assumes live, exec still runs (on stub 2)', out.stdout === 'ls on stub 2', out.stdout);
  check('double probe break: no third stub', h.makes.count === 2, String(h.makes.count));
}
// a probe that throws a NON-stub error is still "assuming live" on the same stub
{
  const h = await harness([{ exists: [new Error('exists failed: EIO')] }]);
  const out = await h.env.exec('ls');
  check('non-stub probe error: assumes live on the same stub', out.stdout === 'ls on stub 1' && h.makes.count === 1 && h.breaks.length === 0, out.stdout);
}

// ---------------------------------------------------------------------------
// non-stub errors: pass through, no drop, no retry

{
  const h = await harness([{ readFile: [new Error('readFile failed for /x: No such file or directory')] }]);
  let err;
  try {
    await h.env.readFile('/x');
  } catch (e) {
    err = e;
  }
  check('non-stub error passes through untouched', err?.message === 'readFile failed for /x: No such file or directory', err?.message);
  check('non-stub error: no drop, no retry, no hook', h.makes.count === 1 && h.trace.join(' ') === '1:exists 1:readFile' && h.breaks.length === 0, h.trace.join(' '));
}

// ---------------------------------------------------------------------------
// identity guard: a slow op failing on an already-replaced stub does not drop
// the replacement

{
  // Stub 1: a readFile that hangs until released and then breaks; meanwhile
  // a stat on stub 1 breaks fast (limit 0: no replay, but the drop happens),
  // the next op builds stub 2. When the slow failure finally arrives it is a
  // failure on stub 1 — already replaced — and must NOT drop stub 2.
  const h = await harness([{ stat: [stubBreak('fast')] }], { stubRetryLimit: 0 });
  let releaseSlow;
  const gate = new Promise((resolve) => (releaseSlow = resolve));
  h.stubs[0].readFile = async () => {
    h.trace.push('1:readFile(slow)');
    await gate;
    throw stubBreak('slow');
  };
  const slowRead = h.env.readFile('/a').catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the slow read reach stub 1
  await h.env.stat('/b').catch(() => {}); // fast break on stub 1 → dropped
  await h.env.readdir('/c'); // builds stub 2
  check('identity guard setup: stub 2 is current', h.makes.count === 2 && h.trace.at(-1) === '2:readdir', h.trace.join(' '));
  releaseSlow();
  const slowErr = await slowRead;
  check('identity guard: the slow failure surfaces', slowErr?.message === 'internal error; reference = slow', slowErr?.message);
  check('identity guard: the late break reports "already replaced"', h.breaks.length === 2 && h.breaks[1].message === 'internal error; reference = slow', JSON.stringify(h.breaks));
  await h.env.readdir('/d');
  check('identity guard: stub 2 survived the late failure (no stub 3)', h.makes.count === 2 && h.trace.at(-1) === '2:readdir', `${h.makes.count} ${h.trace.join(' ')}`);
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
