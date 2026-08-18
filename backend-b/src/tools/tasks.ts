/**
 * Task tools — Claude Code–compatible TaskCreate / TaskUpdate / TaskList /
 * TaskGet (design §17), the successor to TodoWrite (deliberately not
 * provided). Same tool names, input schemas and result shapes as Claude Code
 * 2.1.92, so a UI that consumes its tool_use / tool_result stream renders ours
 * unchanged; the chat frontend folds these events into the pinned checklist
 * (frontend task-fold.ts).
 *
 * Persistence: ONE JSON document, `/workspace/.tasks/tasks.json` (task-store.ts
 * owns the format and every semantic). It is a workspace file like any other,
 * so it rides the per-mutation R2 backup and is restored before the first read
 * of the next container life — the list survives compaction, a paused turn, a
 * container reset and a session restart. Why one index file and not Claude
 * Code's one-file-per-task layout: the lazy env (lazy-env.ts) answers
 * `exists`/`readdir`/`stat` outside the skills tree from the KV bundle view
 * ("not there") until the container is provisioned — only `readFile`, `exec`
 * and writes boot + restore — so a `readdir('/workspace/.tasks')` at the start
 * of a submission would report zero tasks without ever restoring the backup.
 * One `readFile` boots, restores, then reads. Not under `.agents` (excluded
 * from archives) and not at the top level (user-downloadable).
 *
 * The tools reach the sandbox through `harness: true` → `harness.sandbox`,
 * which IS the lazy env wrapper `useSandbox` created for the conversation
 * (Flue's invocation harness hands out the attached env), so every write
 * fires `onMutation` → `requestWorkspacePersist` with no extra wiring.
 *
 * Serialization: Flue runs a tool batch in PARALLEL (pi-agent-core
 * `toolExecution: "parallel"`), so three TaskCreate calls in one assistant
 * message would race the read-modify-write and allocate duplicate ids. Every
 * run goes through a per-session promise-chain mutex (module-level map — one
 * conversation = one Durable Object = one isolate; pi starts the parallel
 * executions in call order, so ids come out in message order). `defineTool`
 * exposes no `executionMode: 'sequential'` seam, hence the mutex.
 *
 * Costs (README "Task tracking"): the first task op of a submission provisions
 * the container like any bash/read; every op after that pays one resetProbe
 * RPC; each write triggers a coalesced R2 persist. Same as any workspace file.
 */
import { defineTool, type Sandbox } from '@flue/runtime';
import * as v from 'valibot';
import {
  createTask,
  EMPTY_STORE,
  getTask,
  listTasks,
  parseStore,
  serializeStore,
  updateTask,
  type TaskStore,
} from './task-store';

export const TASKS_DIR = '/workspace/.tasks';
export const TASKS_FILE = `${TASKS_DIR}/tasks.json`;

/** The four tool names, in the order the model usually meets them. */
export const TASK_TOOL_NAMES = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'] as const;

// ---------------------------------------------------------------------------
// Per-session mutex

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier task op of this session has settled. */
function withTaskLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Keep the chain alive only while something is queued behind it.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(sessionId, settled);
  void settled.then(() => {
    if (chains.get(sessionId) === settled) chains.delete(sessionId);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Store I/O against the session sandbox

type Logger = { info(message: string): void; warn?(message: string): void };

/**
 * Read the index. Any read failure is disambiguated with `exists` — by then
 * the lazy env is provisioned (a readFile outside the skills tree runs its
 * boot+restore first), so the probe hits the real disk. Absent → empty store.
 * Present-but-unreadable → rethrow (never treat a real failure as "no tasks";
 * the next write would clobber). Corrupt content → keep the bytes aside
 * (`tasks.json.corrupt-<iso>`), log, continue empty: a squashfs taken mid-write
 * can restore truncated JSON, and the tools must not become permanently
 * unusable over it.
 */
async function readStore(sandbox: Sandbox, log: Logger): Promise<TaskStore> {
  let raw: string;
  try {
    raw = await sandbox.readFile(TASKS_FILE);
  } catch (error) {
    if (await sandbox.exists(TASKS_FILE)) throw error;
    return EMPTY_STORE;
  }
  const store = parseStore(raw);
  if (store) return store;
  const aside = `${TASKS_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  log.info(`tasks: ${TASKS_FILE} is not a valid task store — moved aside to ${aside}, starting empty`);
  await sandbox.writeFile(aside, raw);
  return EMPTY_STORE;
}

async function writeStore(sandbox: Sandbox, store: TaskStore): Promise<void> {
  // Sandbox.writeFile creates missing parent directories (Flue contract).
  await sandbox.writeFile(TASKS_FILE, serializeStore(store));
}

// ---------------------------------------------------------------------------
// Schemas — Claude Code's, field for field (valibot instead of zod)

const TaskId = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const Metadata = v.record(v.string(), v.unknown());

export const taskCreateInput = v.object({
  subject: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  description: v.pipe(v.string(), v.maxLength(8000)),
  activeForm: v.optional(v.pipe(v.string(), v.maxLength(500))),
  metadata: v.optional(Metadata),
});

export const taskUpdateInput = v.object({
  taskId: TaskId,
  subject: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
  description: v.optional(v.pipe(v.string(), v.maxLength(8000))),
  activeForm: v.optional(v.pipe(v.string(), v.maxLength(500))),
  status: v.optional(v.picklist(['pending', 'in_progress', 'completed', 'deleted'])),
  addBlocks: v.optional(v.array(TaskId)),
  addBlockedBy: v.optional(v.array(TaskId)),
  owner: v.optional(v.pipe(v.string(), v.maxLength(200))),
  metadata: v.optional(Metadata),
});

export const taskListInput = v.object({});

export const taskGetInput = v.object({ taskId: TaskId });

// ---------------------------------------------------------------------------
// Descriptions — condensed from Claude Code's tool prompts (teammate/swarm
// material removed; one line each on persistence and on the unrelated
// built-in `task` delegation tool).

const TASK_CREATE_DESCRIPTION = `Create a tracked to-do item in this session's task list (a checklist entry — it does NOT launch or delegate anything; that is the separate "task" tool). Use it to plan and show progress on multi-step work.

When to use: complex work needing 3+ distinct steps; when the user gives several things to do; when new instructions arrive (capture them as tasks right away); when you start on a task (mark it in_progress BEFORE beginning) and when you finish (mark it completed, then add any follow-ups you discovered).
When NOT to use: a single straightforward step, trivial work, or purely conversational requests — just do those directly.

Fields: subject — a brief, actionable title in imperative form ("Fix authentication bug in login flow"); description — what needs to be done; activeForm (optional) — present-continuous form shown while in_progress ("Fixing authentication bug"); metadata (optional) — arbitrary key/values.
Every task starts as pending. Ids are sequential strings ("1", "2", …) returned in the result — use them with TaskUpdate/TaskGet. Check TaskList first to avoid duplicates. The list is saved to /workspace/.tasks/tasks.json and survives across turns and restarts.`;

const TASK_UPDATE_DESCRIPTION = `Update one task in the task list by id: status, subject, description, activeForm, owner, metadata (merged; set a key to null to delete it), addBlocks (tasks that cannot start until this one completes) and addBlockedBy (tasks that must complete before this one can start).

Status flow: pending → in_progress → completed. Set status "deleted" to remove a task permanently (also drops it from other tasks' dependencies).
Mark a task in_progress when you start it and completed ONLY when it is fully done — never while tests fail, the implementation is partial, or errors are unresolved; if blocked, keep it in_progress and create a task describing what must be resolved. Read the latest state with TaskGet before updating a task you have not touched recently.

Examples: {"taskId":"1","status":"in_progress"} · {"taskId":"1","status":"completed"} · {"taskId":"1","status":"deleted"} · {"taskId":"2","addBlockedBy":["1"]}`;

const TASK_LIST_DESCRIPTION = `List every task in this session's task list: id, subject, status (pending / in_progress / completed), owner (if any) and blockedBy (ids of still-open tasks that must finish first). Use it to check overall progress, find what to work on next (pending, not blocked — prefer the lowest id, earlier tasks set up context for later ones), and after completing a task to see what it unblocked. Use TaskGet for a task's full description.`;

const TASK_GET_DESCRIPTION = `Retrieve one task by id with its full details: subject, description, status, blocks (tasks waiting on this one) and blockedBy (tasks that must complete first). Use it to read the complete requirements before starting a task and to verify its blockedBy list is empty. Returns {"task":null} when the id does not exist.`;

// ---------------------------------------------------------------------------
// The tools. A factory: `ToolContext` carries no conversation id, so the
// session id — the mutex key — has to be closed over per render (per-render
// tool objects are fine; `useTool` just registers them for this render).

export function taskTools(sessionId: string) {
  const locked = <T>(fn: () => Promise<T>) => withTaskLock(sessionId, fn);

  const taskCreate = defineTool({
    name: 'TaskCreate',
    description: TASK_CREATE_DESCRIPTION,
    input: taskCreateInput,
    harness: true,
    run({ data, harness, log }) {
      return locked(async () => {
        const store = await readStore(harness.sandbox, log);
        const { store: next, output } = createTask(store, data);
        await writeStore(harness.sandbox, next);
        return { output };
      });
    },
  });

  const taskUpdate = defineTool({
    name: 'TaskUpdate',
    description: TASK_UPDATE_DESCRIPTION,
    input: taskUpdateInput,
    harness: true,
    run({ data, harness, log }) {
      return locked(async () => {
        const store = await readStore(harness.sandbox, log);
        const { store: next, output } = updateTask(store, data);
        if (next !== store) await writeStore(harness.sandbox, next);
        return { output };
      });
    },
  });

  const taskList = defineTool({
    name: 'TaskList',
    description: TASK_LIST_DESCRIPTION,
    input: taskListInput,
    harness: true,
    run({ harness, log }) {
      return locked(async () => ({ output: listTasks(await readStore(harness.sandbox, log)) }));
    },
  });

  const taskGet = defineTool({
    name: 'TaskGet',
    description: TASK_GET_DESCRIPTION,
    input: taskGetInput,
    harness: true,
    run({ data, harness, log }) {
      return locked(async () => ({ output: getTask(await readStore(harness.sandbox, log), data.taskId) }));
    },
  });

  return [taskCreate, taskUpdate, taskList, taskGet];
}
