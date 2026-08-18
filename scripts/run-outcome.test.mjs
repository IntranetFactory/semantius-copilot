#!/usr/bin/env node
/**
 * Run-outcome tests: the chat UI's failed/stopped-run notices, offline.
 *
 * `frontend/src/components/ai-elements/run-outcome.ts` is imported STRAIGHT
 * FROM ITS .ts SOURCE (Node ≥ 22.6 strips types natively — the file is
 * erasable-TS with no aliases and no JSX, by design, like task-fold.ts).
 *
 * The fixture is the shape of a REAL failed session (2026-08-18,
 * tests-user3-01f28da3ae2c4450be9db37564b40dd5): the user message and the
 * partial assistant reply share one submissionId; the conversation carries
 * ONE `failed` settlement whose error is flue's `{name, message, type,
 * details, meta?}`; no advisory message exists. Covers: anchoring on the
 * last visible message of the turn (assistant partial, else user bubble),
 * Retry only at the tail, aborted vs failed vs completed, unanchored
 * (signal-triggered) failures only when newest and at rest, pending echoes,
 * joined submissions folding into their host, and the message helpers.
 *
 *   node scripts/run-outcome.test.mjs        (also part of `pnpm test`)
 */
import {
  deriveRunNotices,
  retryMessageFor,
  settlementErrorOf,
  summarizeError,
} from '../frontend/src/components/ai-elements/run-outcome.ts';

let failures = 0;
let total = 0;
function check(name, ok, extra = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const j = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// Fixture: the real failed session's shape

const INCEPTRON =
  'direct(sub_1) failed: Upstream error from Inceptron: EngineCore encountered an issue. See stack trace (above) for the root cause.';
const user1 = { id: 'msg_u1', role: 'user', display: 'visible', submissionId: 'sub_1', parts: [{ type: 'text', text: 'import hubspot-leads.csv' }] };
const asst1 = {
  id: 'msg_a1',
  role: 'assistant',
  display: 'visible',
  submissionId: 'sub_1',
  parts: [
    { type: 'reasoning', text: 'The user wants…', state: 'done' },
    { type: 'dynamic-tool', toolName: 'bash', state: 'output-available', input: {}, output: 'ok' },
  ],
};
const failed1 = {
  submissionId: 'sub_1',
  outcome: 'failed',
  error: { name: 'FlueError', message: INCEPTRON, type: 'operation_failed', details: '', meta: { operation: 'direct(sub_1)' } },
};
const user2 = { id: 'msg_u2', role: 'user', display: 'visible', submissionId: 'sub_2', parts: [] };
const asst2 = { id: 'msg_a2', role: 'assistant', display: 'visible', submissionId: 'sub_2', parts: [] };
const completed = (id) => ({ submissionId: id, outcome: 'completed' });
const failed = (id, message = `direct(${id}) failed: boom`) => ({ submissionId: id, outcome: 'failed', error: { name: 'FlueError', message, type: 'operation_failed', details: '' } });
const echo = { id: 'local:2', role: 'user', display: 'visible', parts: [] }; // pending / failed-optimistic: no submissionId

// ---------------------------------------------------------------------------
// deriveRunNotices

{
  const notices = deriveRunNotices([user1, asst1], [failed1]);
  check('real session: one notice under the partial assistant reply', notices.length === 1 && notices[0].anchorMessageId === 'msg_a1', j(notices));
  const [n] = notices;
  check('real session: failed, at tail, has partial reply, key = submission', n.outcome === 'failed' && n.atTail === true && n.hasPartialReply === true && n.key === 'sub_1' && n.submissionId === 'sub_1');
  check('real session: error message verbatim, empty details dropped', n.error?.message === INCEPTRON && !('details' in n.error), j(n.error));
}
{
  const [n] = deriveRunNotices([user1], [failed1]);
  check('failed before any output: anchored on the user bubble, no partial reply', n?.anchorMessageId === 'msg_u1' && n.atTail === true && n.hasPartialReply === false, j(n));
}
{
  const [n] = deriveRunNotices([user1, asst1], [{ submissionId: 'sub_1', outcome: 'aborted' }]);
  check('aborted: outcome aborted, anchored on the partial, no error', n?.outcome === 'aborted' && n.anchorMessageId === 'msg_a1' && !('error' in n), j(n));
}
check('completed: no notice (the reply is the marker)', eq(deriveRunNotices([user1, asst1], [completed('sub_1')]), []));
{
  const notices = deriveRunNotices([user1, asst1, user2, asst2], [failed1, completed('sub_2')]);
  check('older failed turn followed by a completed one: notice kept, NOT at tail', notices.length === 1 && notices[0].anchorMessageId === 'msg_a1' && notices[0].atTail === false, j(notices));
}
{
  const notices = deriveRunNotices([user1, asst1], [completed('sub_1'), failed('sub_sig')]);
  check('unanchored newest at rest: tail notice with no anchor', notices.length === 1 && notices[0].anchorMessageId === undefined && notices[0].atTail === true && notices[0].hasPartialReply === false, j(notices));
}
check('unanchored but not newest: dropped', eq(deriveRunNotices([user1, asst1, user2, asst2], [failed('sub_sig'), completed('sub_2')]), []));
check('unanchored newest, pending echo at the tail (not at rest): dropped', eq(deriveRunNotices([user1, asst1, echo], [completed('sub_1'), failed('sub_sig')]), []));
check('unanchored newest, last message unsettled (not at rest): dropped', eq(deriveRunNotices([user1, asst1, user2], [completed('sub_1'), failed('sub_sig')]), []));
{
  const [n] = deriveRunNotices([user1, asst1, echo], [failed1]);
  check('pending echo after a failed turn: anchored notice, no longer at tail', n?.anchorMessageId === 'msg_a1' && n.atTail === false, j(n));
}
{
  const notices = deriveRunNotices([user1, asst1, user2, asst2], [failed('sub_2'), failed1]);
  const byKey = Object.fromEntries(notices.map((n) => [n.key, n]));
  check('two failed turns: two notices, only the last at tail', notices.length === 2 && byKey.sub_1?.anchorMessageId === 'msg_a1' && byKey.sub_1.atTail === false && byKey.sub_2?.anchorMessageId === 'msg_a2' && byKey.sub_2.atTail === true, j(notices));
}
{
  const userH = { id: 'msg_uh', role: 'user', submissionId: 'sub_h' };
  const userJ = { id: 'msg_uj', role: 'user', submissionId: 'sub_j' };
  const asstH = { id: 'msg_ah', role: 'assistant', submissionId: 'sub_h' };
  const joined = { submissionId: 'sub_j', outcome: 'failed', answeredBySubmissionId: 'sub_h', error: { message: 'joined' } };
  const a = deriveRunNotices([userH, userJ, asstH], [failed('sub_h', 'host'), joined]);
  check('joined submission folds into its host: one notice, host error, anchored on the reply', a.length === 1 && a[0].key === 'sub_h' && a[0].error?.message === 'host' && a[0].anchorMessageId === 'msg_ah' && a[0].atTail === true, j(a));
  const b = deriveRunNotices([userH, asstH, userJ], [failed('sub_h', 'host'), joined]);
  check('joined submission: anchor is the last visible message of the group', b.length === 1 && b[0].anchorMessageId === 'msg_uj' && b[0].atTail === true && b[0].hasPartialReply === false, j(b));
}
check('empty transcript: nothing', eq(deriveRunNotices([], []), []));

// ---------------------------------------------------------------------------
// settlementErrorOf

check('settlementErrorOf: wire object → message + string details', eq(settlementErrorOf({ name: 'Error', message: 'm', type: 'internal_error', details: 'quote the id' }), { message: 'm', details: 'quote the id' }));
check('settlementErrorOf: non-string details are JSON', eq(settlementErrorOf({ message: 'm', details: { a: 1 } }), { message: 'm', details: '{\n  "a": 1\n}' }));
check('settlementErrorOf: empty details dropped', eq(settlementErrorOf({ message: 'm', details: '' }), { message: 'm' }));
check('settlementErrorOf: plain string', eq(settlementErrorOf('plain'), { message: 'plain' }));
check("settlementErrorOf: undefined → flue's fallback wording", eq(settlementErrorOf(undefined), { message: 'Agent submission failed' }));
check('settlementErrorOf: object without message → fallback, details kept', eq(settlementErrorOf({ details: 'd' }), { message: 'Agent submission failed', details: 'd' }));

// ---------------------------------------------------------------------------
// summarizeError / retryMessageFor

check('summarizeError: strips the direct(...) wrapper and the trailing period, first line only', summarizeError(`${INCEPTRON}\nsecond line`) === 'Upstream error from Inceptron: EngineCore encountered an issue. See stack trace (above) for the root cause');
check('summarizeError: undefined → empty', summarizeError(undefined) === '');
check('summarizeError: caps long lines with an ellipsis', summarizeError('x'.repeat(300)).length === 200 && summarizeError('x'.repeat(300)).endsWith('…'));
{
  const cont = retryMessageFor(INCEPTRON, true);
  check('retryMessageFor(partial): Continue wording with the summarized reason, no direct(', cont.startsWith('Continue — ') && cont.includes('Upstream error from Inceptron') && !cont.includes('direct(') && cont.includes('Pick up where you stopped'), cont);
  const again = retryMessageFor(INCEPTRON, false);
  check('retryMessageFor(no partial): Try again wording', again.startsWith('Try again — ') && again.includes('Upstream error from Inceptron') && !again.includes('Pick up'), again);
  check('retryMessageFor: no reason → generic sentence', retryMessageFor(undefined, true) === 'Continue — your previous response was interrupted by an error. Pick up where you stopped; do not repeat work that already completed.', retryMessageFor(undefined, true));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${total} checks)`);
process.exit(failures === 0 ? 0 : 1);
