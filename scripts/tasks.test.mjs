#!/usr/bin/env node
/**
 * Task-tracking tests (design §17): the Claude Code–compatible TaskCreate /
 * TaskUpdate / TaskList / TaskGet semantics, offline.
 *
 * Two pure modules are imported STRAIGHT FROM THEIR .ts SOURCE (Node ≥ 22.6
 * strips types natively — both files are erasable-TS with no aliases and no
 * JSX, by design):
 *  - backend-b/src/tools/task-store.ts — the store the tools mutate on disk;
 *  - frontend/src/components/ai-elements/task-fold.ts — the fold the chat UI
 *    derives its pinned checklist from.
 *
 * Covers: sequential ids and no reuse after delete; the exact Claude Code
 * output shapes; delete scrubbing dependencies; two-sided addBlocks /
 * addBlockedBy; metadata merge with null-delete; updatedFields only on change;
 * TaskList hiding _internal and reporting open blockers only; parse
 * tolerance/rejection; the fold over a synthetic conversation (raw numeric
 * taskId, output-error and success:false skipped, TaskList as merge/prune,
 * TaskGet merge); and a PARITY check — folding the events the store itself
 * produced yields the store's own list, so backend and UI cannot drift.
 *
 *   node scripts/tasks.test.mjs        (also part of `pnpm test`)
 */
import {
  createTask,
  EMPTY_STORE,
  getTask,
  listTasks,
  parseStore,
  serializeStore,
  updateTask,
} from '../backend-b/src/tools/task-store.ts';
import { foldTasks, taskProgress, TASK_TOOL_NAMES } from '../frontend/src/components/ai-elements/task-fold.ts';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// task-store: create / get / list

let store = EMPTY_STORE;
let out;
({ store, output: out } = createTask(store, { subject: 'Write tests', description: 'Cover the store', activeForm: 'Writing tests' }));
check('TaskCreate #1 output shape', eq(out, { task: { id: '1', subject: 'Write tests' } }), JSON.stringify(out));
({ store, output: out } = createTask(store, { subject: 'Run tests', description: 'pnpm test' }));
({ store, output: out } = createTask(store, { subject: 'Ship it', description: 'deploy', metadata: { area: 'infra' } }));
check('ids are sequential strings', eq(store.tasks.map((t) => t.id), ['1', '2', '3']));
check('highwatermark follows the last id', store.highwatermark === 3);
check('new tasks are pending with empty deps', store.tasks.every((t) => t.status === 'pending' && t.blocks.length === 0 && t.blockedBy.length === 0));
check('metadata kept, activeForm kept, owner absent', store.tasks[2].metadata.area === 'infra' && store.tasks[0].activeForm === 'Writing tests' && !('owner' in store.tasks[0]));

check(
  'TaskGet full record shape',
  eq(getTask(store, '1'), { task: { id: '1', subject: 'Write tests', description: 'Cover the store', status: 'pending', blocks: [], blockedBy: [] } }),
);
check('TaskGet unknown → {task:null}', eq(getTask(store, '9'), { task: null }));
check(
  'TaskList summary shape',
  eq(listTasks(store), {
    tasks: [
      { id: '1', subject: 'Write tests', status: 'pending', blockedBy: [] },
      { id: '2', subject: 'Run tests', status: 'pending', blockedBy: [] },
      { id: '3', subject: 'Ship it', status: 'pending', blockedBy: [] },
    ],
  }),
  JSON.stringify(listTasks(store)),
);

// ---------------------------------------------------------------------------
// task-store: update semantics

({ store, output: out } = updateTask(store, { taskId: '1', status: 'in_progress' }));
check('status change → updatedFields + statusChange', eq(out, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } }), JSON.stringify(out));
const before = store;
({ store, output: out } = updateTask(store, { taskId: '1', status: 'in_progress', subject: 'Write tests' }));
check('no-op update → same store, empty updatedFields', store === before && eq(out, { success: true, taskId: '1', updatedFields: [] }));
({ store, output: out } = updateTask(store, { taskId: '9', status: 'completed' }));
check('unknown id → success:false Task not found', eq(out, { success: false, taskId: '9', updatedFields: [], error: 'Task not found' }));

({ store, output: out } = updateTask(store, { taskId: '2', addBlockedBy: ['1'], owner: 'me' }));
check('addBlockedBy → both sides linked', store.tasks[1].blockedBy.includes('1') && store.tasks[0].blocks.includes('2'));
check('updatedFields names owner + blockedBy', eq(out.updatedFields, ['owner', 'blockedBy']), JSON.stringify(out));
({ store, output: out } = updateTask(store, { taskId: '3', addBlockedBy: ['2', '77'] }));
check('unknown dependency id skipped', eq(store.tasks[2].blockedBy, ['2']) && eq(out.updatedFields, ['blockedBy']));
({ store, output: out } = updateTask(store, { taskId: '1', addBlocks: ['2'] }));
check('re-adding an existing link is a no-op', eq(out.updatedFields, []));
({ store, output: out } = updateTask(store, { taskId: '1', addBlocks: ['3'] }));
check('addBlocks → both sides linked', store.tasks[0].blocks.includes('3') && store.tasks[2].blockedBy.includes('1') && eq(out.updatedFields, ['blocks']));

check(
  'TaskList reports owner and OPEN blockers only',
  eq(listTasks(store).tasks[2], { id: '3', subject: 'Ship it', status: 'pending', blockedBy: ['2', '1'] }) &&
    eq(listTasks(store).tasks[1], { id: '2', subject: 'Run tests', status: 'pending', owner: 'me', blockedBy: ['1'] }),
  JSON.stringify(listTasks(store)),
);
({ store, output: out } = updateTask(store, { taskId: '1', status: 'completed' }));
check('completed blocker drops out of blockedBy in TaskList', eq(listTasks(store).tasks[1].blockedBy, []) && eq(listTasks(store).tasks[2].blockedBy, ['2']));
check('…but stays in the stored record (TaskGet)', eq(getTask(store, '2').task.blockedBy, ['1']));

({ store, output: out } = updateTask(store, { taskId: '3', metadata: { area: null, prio: 'high' } }));
check('metadata merge: null deletes, others set', eq(store.tasks[2].metadata, { prio: 'high' }) && eq(out.updatedFields, ['metadata']));
({ store, output: out } = updateTask(store, { taskId: '3', metadata: { _internal: true } }));
check('_internal tasks hidden from TaskList, still gettable', listTasks(store).tasks.length === 2 && getTask(store, '3').task !== null);

({ store, output: out } = updateTask(store, { taskId: '2', status: 'deleted' }));
check('delete → success, updatedFields [deleted], statusChange to deleted', eq(out, { success: true, taskId: '2', updatedFields: ['deleted'], statusChange: { from: 'pending', to: 'deleted' } }), JSON.stringify(out));
check('deleted task gone and scrubbed from others', !store.tasks.some((t) => t.id === '2') && !store.tasks[0].blocks.includes('2') && !store.tasks[1].blockedBy.includes('2'));
({ store, output: out } = createTask(store, { subject: 'After delete', description: '' }));
check('deleted ids are never reused', out.task.id === '4' && store.highwatermark === 4);
({ store, output: out } = updateTask(store, { taskId: '4', status: 'deleted' }));
check('deleting the newest keeps the watermark', store.highwatermark === 4);
({ store, output: out } = createTask(store, { subject: 'Next', description: '' }));
check('…so the next id is 5', out.task.id === '5');

// ---------------------------------------------------------------------------
// task-store: serialization

const roundTrip = parseStore(serializeStore(store));
check('serialize → parse round-trips', eq(roundTrip, store));
check('parseStore rejects non-JSON', parseStore('{"version":1,"tasks":[') === null);
check('parseStore rejects a foreign document', parseStore('{"hello":"world"}') === null && parseStore('[]') === null);
const tolerant = parseStore('{"version":1,"highwatermark":1,"tasks":[{"id":"1","subject":"ok","description":"","status":"pending","blocks":[],"blockedBy":[]},{"id":2,"broken":true}]}');
check('parseStore drops malformed entries, keeps the rest', tolerant !== null && tolerant.tasks.length === 1);
const lowWater = parseStore('{"version":1,"highwatermark":0,"tasks":[{"id":"7","subject":"ok","description":"","status":"pending","blocks":[],"blockedBy":[]}]}');
check('parseStore raises the watermark to the max id', lowWater.highwatermark === 7);

// ---------------------------------------------------------------------------
// task-fold: the UI's view of a synthetic conversation

const part = (toolName, input, output, state = 'output-available') => ({ type: 'dynamic-tool', toolName, toolCallId: `${toolName}-${Math.random()}`, state, input, output });
const msg = (...parts) => ({ id: 'm', role: 'assistant', parts });

check('TASK_TOOL_NAMES lists the four tools', eq(TASK_TOOL_NAMES, ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']));

let folded = foldTasks([
  msg(
    part('TaskCreate', { subject: 'Write tests', description: 'Cover the store', activeForm: 'Writing tests' }, { task: { id: '1', subject: 'Write tests' } }),
    part('TaskCreate', { subject: 'Run tests', description: 'pnpm test' }, { task: { id: '2', subject: 'Run tests' } }),
    part('TaskCreate', { subject: 'Ship it', description: 'deploy' }, { task: { id: '3', subject: 'Ship it' } }),
  ),
  msg(part('TaskUpdate', { taskId: 1, status: 'in_progress' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } })),
  msg(part('TaskUpdate', { taskId: '2', addBlockedBy: ['1'], owner: 'me' }, { success: true, taskId: '2', updatedFields: ['owner', 'blockedBy'] })),
]);
check('fold: three tasks, numeric taskId normalized, status applied', folded.length === 3 && folded[0].status === 'in_progress' && folded[0].activeForm === 'Writing tests');
check('fold: addBlockedBy links both sides, owner set', eq(folded[1].blockedBy, ['1']) && eq(folded[0].blocks, ['2']) && folded[1].owner === 'me');
check('fold: progress 0/3', eq(taskProgress(folded), { completed: 0, total: 3, percent: 0 }));

folded = foldTasks([
  msg(part('TaskCreate', { subject: 'A', description: '' }, { task: { id: '1', subject: 'A' } })),
  msg(part('TaskUpdate', { taskId: '1', status: 'completed' }, { success: false, taskId: '1', updatedFields: [], error: 'Task not found' })),
  msg(part('TaskUpdate', { taskId: '1', status: 'completed' }, undefined, 'output-error')),
  msg(part('TaskUpdate', { taskId: '1', status: 'completed' }, undefined, 'input-available')),
]);
check('fold: success:false / output-error / unsettled updates are ignored', folded.length === 1 && folded[0].status === 'pending');

folded = foldTasks([
  msg(part('TaskCreate', { subject: 'A', description: 'desc A' }, { task: { id: '1', subject: 'A' } })),
  msg(part('TaskCreate', { subject: 'B', description: 'desc B' }, { task: { id: '2', subject: 'B' } })),
  msg(part('TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true, taskId: '2', updatedFields: ['deleted'], statusChange: { from: 'pending', to: 'deleted' } })),
  // TaskList is the file's truth: a task the fold never saw created appears,
  // one it holds but the list lacks is pruned; description survives the merge.
  msg(part('TaskList', {}, { tasks: [{ id: '1', subject: 'A (renamed)', status: 'in_progress', blockedBy: [] }, { id: '5', subject: 'E', status: 'pending', owner: 'bot', blockedBy: ['1'] }] })),
]);
check('fold: delete removes; TaskList merges (keeps description), adds unseen, prunes absent', folded.length === 2 && folded[0].description === 'desc A' && folded[0].subject === 'A (renamed)' && folded[0].status === 'in_progress' && folded[1].id === '5' && folded[1].owner === 'bot' && eq(folded[1].blockedBy, ['1']));
folded = foldTasks([
  msg(part('TaskList', {}, { tasks: [{ id: '10', subject: 'J', status: 'pending', blockedBy: [] }, { id: '9', subject: 'I', status: 'completed', blockedBy: [] }] })),
  msg(part('TaskGet', { taskId: '10' }, { task: { id: '10', subject: 'J', description: 'full J', status: 'in_progress', blocks: [], blockedBy: ['9'] } })),
  msg(part('TaskGet', { taskId: '99' }, { task: null })),
]);
check('fold: numeric sort, TaskGet merges description/status/deps, {task:null} ignored', eq(folded.map((t) => t.id), ['9', '10']) && folded[1].description === 'full J' && folded[1].status === 'in_progress' && eq(folded[1].blockedBy, ['9']));
check('fold: progress 1/2 = 50%', eq(taskProgress(folded), { completed: 1, total: 2, percent: 50 }));
check('fold: empty conversation → no tasks', foldTasks([{ parts: [{ type: 'text', text: 'hi' }] }]).length === 0);

// ---------------------------------------------------------------------------
// Parity: drive the store, record the events the tools would emit, fold them.

{
  let s = EMPTY_STORE;
  const events = [];
  const run = (tool, input) => {
    let output;
    if (tool === 'TaskCreate') ({ store: s, output } = createTask(s, input));
    else if (tool === 'TaskUpdate') ({ store: s, output } = updateTask(s, input));
    else if (tool === 'TaskList') output = listTasks(s);
    else output = getTask(s, input.taskId);
    events.push(msg(part(tool, input, output)));
    return output;
  };
  run('TaskCreate', { subject: 'One', description: 'first', activeForm: 'Doing one' });
  run('TaskCreate', { subject: 'Two', description: 'second' });
  run('TaskCreate', { subject: 'Three', description: 'third' });
  run('TaskUpdate', { taskId: '2', addBlockedBy: ['1'] });
  run('TaskUpdate', { taskId: '3', addBlockedBy: ['2'], owner: 'me' });
  run('TaskUpdate', { taskId: '1', status: 'in_progress' });
  run('TaskUpdate', { taskId: '1', status: 'completed' });
  run('TaskUpdate', { taskId: '3', status: 'deleted' });
  run('TaskCreate', { subject: 'Four', description: 'fourth' });
  run('TaskUpdate', { taskId: '9', status: 'completed' }); // not found
  run('TaskGet', { taskId: '2' });
  run('TaskList', {});
  const view = foldTasks(events).map(({ id, subject, status, owner, blockedBy }) => ({ id, subject, status, ...(owner ? { owner } : {}), blockedBy }));
  const truth = listTasks(s).tasks;
  check('parity: fold of the emitted events == TaskList of the store', eq(view, truth), `${JSON.stringify(view)} vs ${JSON.stringify(truth)}`);
  const full = foldTasks(events);
  check('parity: fold keeps descriptions/activeForm the summaries lack', full[0].description === 'first' && full[0].activeForm === 'Doing one');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
