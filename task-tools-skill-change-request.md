# Change request: task-tool call economy in the Semantius skills

**For:** the upstream maintainers of `agents/semantius-admin/skills/**` (`semantius-admin`,
`-architect`, `-analyst`, `-modeler`, `-importer`). Nothing under that tree is modified in this
repo; this file proposes exact wording.

**Date:** 2026-08-19 · **Harness facts verified against:** `backend-b/src/tools/tasks.ts`,
`task-store.ts` (Claude Code 2.1.92 Task-tool contract, which the skills target).

## Why

A run observed on 2026-08-19 spent ~40 of 149 tool calls on task bookkeeping: 14 tasks, each
set up with a `TaskCreate`, a `TaskUpdate … addBlockedBy`, a `TaskUpdate … addBlocks`, and a
status flip, as separate calls. The tool contract does not require that:

- `TaskUpdate` accepts `status`, `addBlockedBy` and `addBlocks` **in one call**; both arrays take
  **several ids**; every link is mirrored onto the other task (Claude Code semantics, identical
  here). "Chain it, point it at its parent, start it" is one round trip per task.
- Gating a stage on N open `Q:` tasks is **one** call on the stage task —
  `{"taskId":"<stage>","addBlockedBy":[<the N Q: ids>]}` — not one `addBlocks` call per `Q:` task.
  Same graph, same gate, same UI order (the copilot design doc, §17, already documents this shape).
- `TaskCreate` has no edge fields (Claude Code's schema, kept deliberately), so the create stays a
  separate call. That is the only per-task call the tool genuinely imposes.

Every task call is a sandbox round trip (reset probe + read + write), every write starts a
workspace persist that later calls contend with, and calls batched into one response queue
behind each other — so call count is also wall-clock. Counts for a 4-stage sub-skill run under
the admin: today 4 creates + 3 chain + 4 parent + 1 start = **12 calls**; proposed 4 creates + 4
updates = **8**. An enumeration of N questions: N creates + N gate calls → N creates + **1**.
(Standalone, without a parent edge, the count is already minimal: 4 + 4.)

The wording below keeps every rule of `task-tracking.md` intact — ownership ("edges are set on
your own tasks only": the stage task IS the skill's own), the gate semantics, the ledger sequence
— and only changes how many calls build the same graph.

## 1. `semantius-admin/references/task-tracking.md`

### §1 Tool contract — table row `TaskUpdate` (line 16)

Current:

> | `TaskUpdate` | `taskId`, `status` (`pending` / `in_progress` / `completed` / `deleted`), `addBlockedBy` (ids this task waits for), `addBlocks` (ids that wait for this task), optionally `subject`, `description` | the updated task |

Proposed:

> | `TaskUpdate` | `taskId`, `status` (`pending` / `in_progress` / `completed` / `deleted`), `addBlockedBy` (ids this task waits for), `addBlocks` (ids that wait for this task), optionally `subject`, `description` — **several fields in one call; both id arrays take many ids** | the updated task |

### §1 — table row `TaskList` (line 17), correction

Current: `every task: id, subject, status, blockedBy, blocks`
Proposed: `every task: id, subject, status, blockedBy (still-open blockers only)` — `TaskList`
does not return `blocks` (Claude Code and this harness alike); `TaskGet` does.

### §1 — the relations paragraph (lines 22–28)

Current (line 22, end of sentence):

> …set them with `TaskUpdate` immediately after the `TaskCreate` calls of the same response (the harness mirrors an edge onto the other task):

Proposed:

> …set them with `TaskUpdate` immediately after the `TaskCreate` calls of the same response — **one `TaskUpdate` per task, carrying every edge and the status that task needs; never one call per field** (the harness mirrors an edge onto the other task, and both id arrays take several ids):

Current (line 26):

> - **Question gate:** every `Q:` task `addBlocks: [stageTaskId]` its stage task, so the stage visibly cannot complete while a question is open.

Proposed:

> - **Question gate:** the stage task is `blockedBy` every one of its `Q:` tasks — one call, `TaskUpdate` the stage task with `addBlockedBy: [<all the Q: ids just created>]` — so the stage visibly cannot complete while a question is open.

Line 28 (no change needed; still true: the gate is set on the skill's own stage task).

### §2 Pattern A, rule 1 "Create at entry, then chain" (line 36)

Current:

> …all `pending`; then, in the same response, `TaskUpdate` each task after the first with `addBlockedBy: [<previous task id>]` (the chain), and, when running under the admin, `TaskUpdate` every stage task with `addBlocks: [<the admin pipeline task id for this step>]` (parent / child; the pipeline task is the one currently `in_progress` with no prefix, read from `TaskList`).

Proposed:

> …all `pending`; then, in the same response, **one `TaskUpdate` per task** carrying everything it needs: `addBlockedBy: [<previous task id>]` for every task after the first (the chain), `addBlocks: [<the admin pipeline task id for this step>]` when running under the admin (parent / child; the pipeline task is the one currently `in_progress` with no prefix, read from `TaskList`), and `status: in_progress` for the first. Never one call per field.

### §3 Pattern B, **E** (line 56)

Current:

> `TaskCreate` one `Q:` task per open question object, then `TaskUpdate` each with `addBlocks: [<this stage's task id>]` (the question gate: the stage task shows as blocked until every `Q:` task is completed or deleted).

Proposed:

> `TaskCreate` one `Q:` task per open question object, then **one** `TaskUpdate` on this stage's task with `addBlockedBy: [<every Q: id just created>]` (the question gate: the stage task shows as blocked until every `Q:` task is completed or deleted).

### §3 "The gate" (line 61)

Current: `A new `Q:` task created at **R** also gets `addBlocks: [<stage task id>]`.`
Proposed: `A new `Q:` task created at **R** is added to the gate the same way: `TaskUpdate` the stage task with `addBlockedBy: [<the new Q: id(s)>]`.`

## 2. Resident sections (keep in sync with the canonical text above)

### `semantius-importer/SKILL.md` — rule 7, "Stage tasks" (line 54)

Current: `then chain them in the same response (`TaskUpdate` each task after the first with `addBlockedBy: [<previous task id>]`)`
Proposed: `then, in the same response, one `TaskUpdate` per task (`addBlockedBy: [<previous task id>]` for every task after the first; `status: in_progress` for the first; under the admin also `addBlocks: [<the in-progress unprefixed pipeline task id from TaskList>]`)`

### `semantius-importer/SKILL.md` — "Ledger stages" (line 55)

Current: `created all at once at the start of the stage (E) and each pointed at the stage task with `addBlocks: [<stage task id>]` so the stage shows as blocked while any question is open`
Proposed: `created all at once at the start of the stage (E) and gated in one call — `TaskUpdate` the stage task with `addBlockedBy: [<every Q: task id>]` — so the stage shows as blocked while any question is open`

### `semantius-modeler/SKILL.md` — "Stage tasks" (line 79)

Current: `in the same response chain them (`TaskUpdate` each after the first with `addBlockedBy: [<previous task id>]`) and, under the admin, point every one at the admin's current pipeline task (`addBlocks: [<the in-progress unprefixed pipeline task id from TaskList>]`) so that task cannot complete before the deploy's stages do; the first goes `in_progress`.`
Proposed: `in the same response, one `TaskUpdate` per task: `addBlockedBy: [<previous task id>]` for every task after the first, and, under the admin, `addBlocks: [<the in-progress unprefixed pipeline task id from TaskList>]` in the same call so that task cannot complete before the deploy's stages do; the first task's call also carries `status: in_progress`.`

### `semantius-modeler/SKILL.md` — "Ledger stages: 2.5 and 3" (line 80)

Current: `enumerated before the first widget and each pointed at its stage task with `addBlocks` (2.5 → the check task, Stage 3 → the plan task)`
Proposed: `enumerated before the first widget and gated with one `TaskUpdate` on the stage task, `addBlockedBy: [<the Q: ids>]` (2.5 → the check task, Stage 3 → the plan task)`

### `semantius-analyst/SKILL.md` — "Stage tasks" (line 56)

Current: `in the same response chain them (`TaskUpdate` each after the first with `addBlockedBy: [<previous task id>]`) and, under the admin, point every one at the admin's current pipeline task (`addBlocks: [<the in-progress unprefixed pipeline task id from TaskList>]`); the first goes `in_progress`.`
Proposed: `in the same response, one `TaskUpdate` per task: `addBlockedBy: [<previous task id>]` for every task after the first, and, under the admin, `addBlocks: [<the in-progress unprefixed pipeline task id from TaskList>]` in the same call; the first task's call also carries `status: in_progress`.`

### `semantius-analyst/SKILL.md` — "Ledger stages" (line 57)

Current: `each `Q:` task gets `addBlocks: [<its stage task id>]` so the stage shows as blocked while questions are open`
Proposed: `one `TaskUpdate` per stage task with `addBlockedBy: [<its Q: task ids>]` so the stage shows as blocked while questions are open`

### `semantius-architect/SKILL.md` — "Stage tasks" (line 150)

Current: `in the same response chain them (`TaskUpdate` each after the first with `addBlockedBy: [<previous task id>]`) and, under the admin, point every one at the admin's current pipeline task (`addBlocks: [<the in-progress unprefixed pipeline task id from TaskList>]`); the first goes `in_progress`.`
Proposed: same replacement as the analyst's line 56 above.

### `semantius-architect/SKILL.md` — "Ledger stage: Stage 2 only" (line 161)

Current: ``addBlocks: [<the first stage task's id>]``
Proposed: `gated by `TaskUpdate` on the first stage task with `addBlockedBy: [<the Q: task id>]`` (one question, so one call either way — changed only so every skill states the gate in the same direction).

### `semantius-admin/SKILL.md`

Line 86 ("Sub-skills point their own stage tasks at the pipeline task with `addBlocks`") and lines
526/536 (`TaskUpdate … addBlockedBy` on each pipeline task after the first) already describe one
call per task — **no change**.

## 3. Suggested CHANGELOG line (each affected skill)

> Task tracking: one `TaskUpdate` per task carries chain edge, parent edge and status together;
> question gates are set in one call on the stage task (`addBlockedBy: [Q: ids]`). Same graph,
> ~⅓ fewer task calls per stage entry, N→1 for a question enumeration.

## Not proposed

- Dropping the `TaskList` at the start of every update-bearing response (§2 rule 4 — resume
  safety; the create response needs it anyway for the duplicate guard).
- Edge fields on `TaskCreate` — the harness keeps Claude Code's schema; the skills' cross-harness
  contract should not assume more.
