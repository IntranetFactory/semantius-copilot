/**
 * Task store — the pure half of the Claude Code–compatible task tools
 * (TaskCreate / TaskUpdate / TaskList / TaskGet; design §17). Everything here
 * is a function of a `TaskStore` value and returns a new one: no I/O, no
 * imports, erasable-TS only, so `scripts/tasks.test.mjs` can import it
 * straight into Node and the semantics are testable without a sandbox.
 *
 * The contract mirrors Claude Code 2.1.92 exactly (extracted from its
 * bundle): task record shape, sequential string ids that are never reused
 * (high-watermark), `status: "deleted"` removing the task and scrubbing its
 * id from every other task's `blocks`/`blockedBy`, two-sided
 * `addBlocks`/`addBlockedBy`, `metadata` merge with `null` deleting a key,
 * `updatedFields` listing only what actually changed, `TaskList` hiding
 * `metadata._internal` tasks and reporting only still-open blockers. The
 * output objects are byte-compatible with Claude Code's, so UI wrappers built
 * against its tool_use/tool_result stream work unchanged.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export type Task = {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
};

/** The on-disk document: `/workspace/.tasks/tasks.json` (see tasks.ts). */
export type TaskStore = {
  version: 1;
  /** Highest id ever allocated — deleted ids are never reused. */
  highwatermark: number;
  tasks: Task[];
};

export const EMPTY_STORE: TaskStore = { version: 1, highwatermark: 0, tasks: [] };

export type TaskCreateInput = {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
};

export type TaskUpdateInput = {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus | 'deleted';
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
};

/** Claude Code's TaskCreate result. */
export type TaskCreateOutput = { task: { id: string; subject: string } };
/** Claude Code's TaskUpdate result. */
export type TaskUpdateOutput = {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: { from: string; to: string };
};
/** Claude Code's TaskGet result. */
export type TaskGetOutput = {
  task: {
    id: string;
    subject: string;
    description: string;
    status: TaskStatus;
    blocks: string[];
    blockedBy: string[];
  } | null;
};
/** Claude Code's TaskList result. */
export type TaskListOutput = {
  tasks: Array<{ id: string; subject: string; status: TaskStatus; owner?: string; blockedBy: string[] }>;
};

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Structural guard for one persisted task; tolerant of extra keys. */
function parseTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const { id, subject, description, activeForm, owner, status, blocks, blockedBy, metadata } = value;
  if (typeof id !== 'string' || typeof subject !== 'string' || typeof description !== 'string') return null;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  if (!isStringArray(blocks) || !isStringArray(blockedBy)) return null;
  const task: Task = { id, subject, description, status: status as TaskStatus, blocks, blockedBy };
  if (typeof activeForm === 'string') task.activeForm = activeForm;
  if (typeof owner === 'string') task.owner = owner;
  if (isRecord(metadata)) task.metadata = metadata;
  return task;
}

/**
 * Parse the on-disk document. `null` means "not a task store" (corrupt or
 * foreign content) — the caller decides how to treat that; a well-formed
 * document with unknown tasks drops only the malformed entries.
 */
export function parseStore(raw: string): TaskStore | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks)) return null;
  const tasks: Task[] = [];
  for (const entry of value.tasks) {
    const task = parseTask(entry);
    if (task) tasks.push(task);
  }
  const maxId = tasks.reduce((max, task) => Math.max(max, numericId(task.id)), 0);
  const stored = typeof value.highwatermark === 'number' && Number.isFinite(value.highwatermark) ? value.highwatermark : 0;
  return { version: 1, highwatermark: Math.max(stored, maxId), tasks };
}

/** Serialize for disk: pretty-printed so a human or the model can `cat` it. */
export function serializeStore(store: TaskStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/** Numeric value of an id ("12" → 12); non-numeric ids sort last (0 here). */
export function numericId(id: string): number {
  const n = Number.parseInt(id, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function createTask(store: TaskStore, input: TaskCreateInput): { store: TaskStore; output: TaskCreateOutput } {
  const next = Math.max(store.highwatermark, ...store.tasks.map((task) => numericId(task.id))) + 1;
  const id = String(next);
  const task: Task = {
    id,
    subject: input.subject,
    description: input.description,
    status: 'pending',
    blocks: [],
    blockedBy: [],
  };
  if (input.activeForm !== undefined) task.activeForm = input.activeForm;
  if (input.metadata !== undefined) task.metadata = input.metadata;
  return {
    store: { version: 1, highwatermark: next, tasks: [...store.tasks, task] },
    output: { task: { id, subject: input.subject } },
  };
}

export function getTask(store: TaskStore, taskId: string): TaskGetOutput {
  const task = store.tasks.find((entry) => entry.id === taskId);
  if (!task) return { task: null };
  const { id, subject, description, status, blocks, blockedBy } = task;
  return { task: { id, subject, description, status, blocks, blockedBy } };
}

export function listTasks(store: TaskStore): TaskListOutput {
  const visible = store.tasks.filter((task) => !task.metadata?._internal);
  const open = new Set(visible.filter((task) => task.status !== 'completed').map((task) => task.id));
  return {
    // Claude Code's key order (id, subject, status, owner, blockedBy); `owner`
    // omitted rather than `undefined` so the on-wire shape stays exact.
    tasks: visible.map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.owner !== undefined ? { owner: task.owner } : {}),
      blockedBy: task.blockedBy.filter((id) => open.has(id)),
    })),
  };
}

/**
 * Apply one TaskUpdate. Returns the unchanged store (same reference) when
 * nothing changed, so callers can skip the write.
 */
export function updateTask(store: TaskStore, input: TaskUpdateInput): { store: TaskStore; output: TaskUpdateOutput } {
  const { taskId } = input;
  const current = store.tasks.find((task) => task.id === taskId);
  if (!current) {
    return { store, output: { success: false, taskId, updatedFields: [], error: 'Task not found' } };
  }

  // Delete: drop the task, scrub its id from every other task, keep the
  // high-watermark at or above the id so it is never reused.
  if (input.status === 'deleted') {
    const tasks = store.tasks
      .filter((task) => task.id !== taskId)
      .map((task) => {
        const blocks = task.blocks.filter((id) => id !== taskId);
        const blockedBy = task.blockedBy.filter((id) => id !== taskId);
        return blocks.length === task.blocks.length && blockedBy.length === task.blockedBy.length
          ? task
          : { ...task, blocks, blockedBy };
      });
    return {
      store: { version: 1, highwatermark: Math.max(store.highwatermark, numericId(taskId)), tasks },
      output: {
        success: true,
        taskId,
        updatedFields: ['deleted'],
        statusChange: { from: current.status, to: 'deleted' },
      },
    };
  }

  const updatedFields: string[] = [];
  const patch: Partial<Task> = {};
  if (input.subject !== undefined && input.subject !== current.subject) {
    patch.subject = input.subject;
    updatedFields.push('subject');
  }
  if (input.description !== undefined && input.description !== current.description) {
    patch.description = input.description;
    updatedFields.push('description');
  }
  if (input.activeForm !== undefined && input.activeForm !== current.activeForm) {
    patch.activeForm = input.activeForm;
    updatedFields.push('activeForm');
  }
  if (input.owner !== undefined && input.owner !== current.owner) {
    patch.owner = input.owner;
    updatedFields.push('owner');
  }
  if (input.metadata !== undefined) {
    const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    patch.metadata = merged;
    updatedFields.push('metadata');
  }
  let statusChange: TaskUpdateOutput['statusChange'];
  if (input.status !== undefined && input.status !== current.status) {
    patch.status = input.status;
    updatedFields.push('status');
    statusChange = { from: current.status, to: input.status };
  }

  // Dependencies are two-sided: this task's `blocks` ↔ the other's
  // `blockedBy`. Unknown ids and already-present links are skipped, and
  // `updatedFields` names the side only when a link was actually added.
  const byId = new Map(store.tasks.map((task) => [task.id, { ...task }]));
  const self = byId.get(taskId)!;
  Object.assign(self, patch);
  let blocksAdded = false;
  for (const other of input.addBlocks ?? []) {
    const target = byId.get(other);
    if (!target || other === taskId) continue;
    if (!self.blocks.includes(other)) {
      self.blocks = [...self.blocks, other];
      blocksAdded = true;
    }
    if (!target.blockedBy.includes(taskId)) {
      target.blockedBy = [...target.blockedBy, taskId];
      blocksAdded = true;
    }
  }
  let blockedByAdded = false;
  for (const other of input.addBlockedBy ?? []) {
    const blocker = byId.get(other);
    if (!blocker || other === taskId) continue;
    if (!self.blockedBy.includes(other)) {
      self.blockedBy = [...self.blockedBy, other];
      blockedByAdded = true;
    }
    if (!blocker.blocks.includes(taskId)) {
      blocker.blocks = [...blocker.blocks, taskId];
      blockedByAdded = true;
    }
  }
  if (blocksAdded) updatedFields.push('blocks');
  if (blockedByAdded) updatedFields.push('blockedBy');

  if (updatedFields.length === 0) {
    return { store, output: { success: true, taskId, updatedFields } };
  }
  const tasks = store.tasks.map((task) => byId.get(task.id)!);
  const output: TaskUpdateOutput = { success: true, taskId, updatedFields };
  if (statusChange) output.statusChange = statusChange;
  return { store: { version: 1, highwatermark: store.highwatermark, tasks }, output };
}
