/**
 * Task progress fold — the pure half of the pinned checklist for the
 * backend's Claude Code–compatible task tools (backend-b/src/tools/tasks.ts;
 * design §17). It derives the CURRENT task list from the conversation's
 * tool_use events alone, exactly the way the Claude Agent SDK docs describe
 * consuming these tools: TaskCreate results and TaskUpdate inputs accumulate
 * into a map keyed by task id, TaskList/TaskGet results are snapshots that
 * reconcile it. Durable truth is history, so a reload, the container's
 * key-flip remount, or model-context compaction re-derive the same panel
 * (the UI projection walks the whole conversation, not the compacted context).
 *
 * No React, no `@/` alias, no workspace imports: importable straight into
 * Node (`scripts/tasks.test.mjs`) and part of the copy-pasteable folder.
 *
 * Every read is defensive: `part.input` is the model's RAW arguments (a
 * numeric `taskId` is possible; Claude Code documents `id`/`task_id` aliases
 * it repairs on its side), `output` is what the tool returned. Only settled,
 * successful calls count — `output-error` parts and `success:false` updates
 * are skipped, so a rejected call never phantom-updates the panel.
 */

export const TASK_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];

export type TrackedTaskStatus = "pending" | "in_progress" | "completed";

export type TrackedTask = {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status: TrackedTaskStatus;
  blocks: string[];
  blockedBy: string[];
};

/** The slice of a conversation part the fold reads (structurally, off `unknown`). */
type ToolPartLike = {
  type: "dynamic-tool";
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

type MessageLike = { parts: readonly unknown[] };

const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asId = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const asIdList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asId).filter((id): id is string => id !== undefined) : [];

const asStatus = (value: unknown): TrackedTaskStatus | undefined =>
  typeof value === "string" && STATUSES.includes(value) ? (value as TrackedTaskStatus) : undefined;

export function isTaskToolName(name: unknown): name is TaskToolName {
  return typeof name === "string" && (TASK_TOOL_NAMES as readonly string[]).includes(name);
}

function isSettledTaskPart(part: unknown): part is ToolPartLike & { state: "output-available" } {
  return (
    isRecord(part) &&
    part.type === "dynamic-tool" &&
    isTaskToolName(part.toolName) &&
    part.state === "output-available"
  );
}

/** Numeric sort key ("12" → 12); non-numeric ids keep insertion order after them. */
const numericId = (id: string): number => {
  const n = Number.parseInt(id, 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
};

function link(tasks: Map<string, TrackedTask>, blocker: string, blocked: string) {
  const a = tasks.get(blocker);
  const b = tasks.get(blocked);
  if (a && !a.blocks.includes(blocked)) a.blocks = [...a.blocks, blocked];
  if (b && !b.blockedBy.includes(blocker)) b.blockedBy = [...b.blockedBy, blocker];
}

function unlinkEverywhere(tasks: Map<string, TrackedTask>, id: string) {
  for (const task of tasks.values()) {
    if (task.blocks.includes(id)) task.blocks = task.blocks.filter((x) => x !== id);
    if (task.blockedBy.includes(id)) task.blockedBy = task.blockedBy.filter((x) => x !== id);
  }
}

function applyCreate(tasks: Map<string, TrackedTask>, input: unknown, output: unknown) {
  if (!isRecord(output) || !isRecord(output.task)) return;
  const id = asId(output.task.id);
  if (id === undefined) return;
  const inp = isRecord(input) ? input : {};
  const subject = asString(output.task.subject) ?? asString(inp.subject) ?? `Task #${id}`;
  const task: TrackedTask = { id, subject, status: "pending", blocks: [], blockedBy: [] };
  const description = asString(inp.description);
  const activeForm = asString(inp.activeForm);
  if (description !== undefined) task.description = description;
  if (activeForm !== undefined) task.activeForm = activeForm;
  tasks.set(id, task);
}

function applyUpdate(tasks: Map<string, TrackedTask>, input: unknown, output: unknown) {
  if (!isRecord(output) || output.success !== true) return;
  const inp = isRecord(input) ? input : {};
  const id = asId(output.taskId) ?? asId(inp.taskId) ?? asId(inp.id) ?? asId(inp.task_id);
  if (id === undefined) return;
  if (inp.status === "deleted") {
    tasks.delete(id);
    unlinkEverywhere(tasks, id);
    return;
  }
  const task = tasks.get(id);
  if (!task) return; // created outside this conversation — TaskList/TaskGet will surface it
  const subject = asString(inp.subject);
  const description = asString(inp.description);
  const activeForm = asString(inp.activeForm);
  const owner = asString(inp.owner);
  const status = asStatus(inp.status);
  if (subject !== undefined) task.subject = subject;
  if (description !== undefined) task.description = description;
  if (activeForm !== undefined) task.activeForm = activeForm;
  if (owner !== undefined) task.owner = owner;
  if (status !== undefined) task.status = status;
  for (const other of asIdList(inp.addBlocks)) link(tasks, id, other);
  for (const other of asIdList(inp.addBlockedBy)) link(tasks, other, id);
}

/** A TaskList result is the file's truth: merge each listed task (it carries
 * no description/activeForm/blocks, so those are kept) and drop the rest. */
function applyList(tasks: Map<string, TrackedTask>, output: unknown) {
  if (!isRecord(output) || !Array.isArray(output.tasks)) return;
  const seen = new Set<string>();
  for (const entry of output.tasks) {
    if (!isRecord(entry)) continue;
    const id = asId(entry.id);
    if (id === undefined) continue;
    seen.add(id);
    const existing = tasks.get(id);
    const task: TrackedTask = existing ?? { id, subject: `Task #${id}`, status: "pending", blocks: [], blockedBy: [] };
    const subject = asString(entry.subject);
    const status = asStatus(entry.status);
    const owner = asString(entry.owner);
    if (subject !== undefined) task.subject = subject;
    if (status !== undefined) task.status = status;
    if (owner !== undefined) task.owner = owner;
    if (Array.isArray(entry.blockedBy)) task.blockedBy = asIdList(entry.blockedBy);
    tasks.set(id, task);
  }
  for (const id of [...tasks.keys()]) if (!seen.has(id)) tasks.delete(id);
}

function applyGet(tasks: Map<string, TrackedTask>, output: unknown) {
  if (!isRecord(output) || !isRecord(output.task)) return; // {task:null} = not found
  const entry = output.task;
  const id = asId(entry.id);
  if (id === undefined) return;
  const existing = tasks.get(id);
  const task: TrackedTask = existing ?? { id, subject: `Task #${id}`, status: "pending", blocks: [], blockedBy: [] };
  const subject = asString(entry.subject);
  const description = asString(entry.description);
  const status = asStatus(entry.status);
  if (subject !== undefined) task.subject = subject;
  if (description !== undefined) task.description = description;
  if (status !== undefined) task.status = status;
  if (Array.isArray(entry.blocks)) task.blocks = asIdList(entry.blocks);
  if (Array.isArray(entry.blockedBy)) task.blockedBy = asIdList(entry.blockedBy);
  tasks.set(id, task);
}

/**
 * Fold the conversation's task tool events, in order, into the current list
 * (sorted by numeric id). Pass ALL messages, not just the visible ones — the
 * parts live on assistant messages either way, and hidden/diagnostic ones
 * simply carry no task parts.
 */
export function foldTasks(messages: readonly MessageLike[]): TrackedTask[] {
  const tasks = new Map<string, TrackedTask>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isSettledTaskPart(part)) continue;
      switch (part.toolName) {
        case "TaskCreate":
          applyCreate(tasks, part.input, part.output);
          break;
        case "TaskUpdate":
          applyUpdate(tasks, part.input, part.output);
          break;
        case "TaskList":
          applyList(tasks, part.output);
          break;
        case "TaskGet":
          applyGet(tasks, part.output);
          break;
      }
    }
  }
  return [...tasks.values()].sort((a, b) => numericId(a.id) - numericId(b.id));
}

/** Completed / total counts and the percentage the progress bar shows. */
export function taskProgress(tasks: readonly TrackedTask[]): { completed: number; total: number; percent: number } {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}
