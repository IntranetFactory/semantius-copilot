/**
 * AskUserQuestion — Claude Code-style structured clarifying questions.
 *
 * Turn-boundary flow (no human-in-the-loop primitive exists in flue): the tool
 * validates and echoes the questions, then ends the response with `terminate`.
 * The chat frontend renders an interactive card from this tool call's `input`
 * (already on the wire as the dynamic-tool part) and sends the user's
 * selections back as a `kind: 'signal'` delivery on the same conversation:
 *
 *   { kind: 'signal', type: ASK_USER_ANSWER_SIGNAL_TYPE,
 *     tagName: ASK_USER_ANSWER_TAG, attributes: { toolCallId },
 *     body: JSON.stringify({ toolCallId, cancelled, answers }) }
 *
 * A signal wakes an idle agent as its own submission and renders to the model
 * as a `<user_answers …>` XML block; its snapshot projection is
 * `display: 'diagnostic'`, so the raw JSON never shows as a chat bubble. The
 * projection carries only `tagName` + `attributes` (not `type`), which is why
 * the frontend matches on the tag name.
 *
 * Mounted for web/chat sessions only (main.ts) — GitHub-issue conversations
 * have no browser to answer, and an unmounted tool cannot be called.
 *
 * Batch caveat (why the description insists on "call it ALONE"): pi-agent-core
 * ends the loop only when EVERY call in the model's tool batch carries
 * `terminate` (`shouldTerminateToolBatch` — unanimity; flue mirrors the same
 * predicate durably in `isTerminalTrailingToolBatch`). A sibling call in the
 * same response (an `edit`, a `bash`, a hallucinated tool) cancels the pause:
 * the model is handed another step before the user has answered. Seen live on
 * 2026-08-17 (importer flow): `edit` + `AskUserQuestion` in one batch → loop
 * continued → the model "called" the `user_answers` XML tag as a tool → error →
 * "waiting…" text. Nothing was auto-submitted (the card derives its state from
 * the answer signal alone), but the run looked broken. flue exposes no seam to
 * fix this mechanically (`useModel` has no parallel-tool-calls knob; pi's
 * `beforeToolCall`/`afterToolCall` are not wired), so the defense is the tool
 * contract: the description forbids sibling calls and names `user_answers` as
 * an input block, and the output carries a stop directive the model reads if
 * the loop continues anyway. A stub `user_answers` tool was rejected — it would
 * advertise the very name to avoid, and a model calling it INSTEAD of this tool
 * would end the turn with no card shown.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/** Signal `type` the chat client sends the answers back with. */
export const ASK_USER_ANSWER_SIGNAL_TYPE = 'ask_user_question.answer';
/**
 * XML tag the answers render under in model context AND the projection key the
 * frontend matches on (`message.signal.tagName` — the delivered `type` is not
 * projected). The frontend duplicates this constant (ai-elements is
 * copy-pasteable and must not import backend code).
 */
export const ASK_USER_ANSWER_TAG = 'user_answers';

const Option = v.object({
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});

const Question = v.object({
  question: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  // Claude Code caps this at 12 for its fixed-width TUI tabs; our HTML chip
  // row wraps, so only a hygiene bound is needed.
  header: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  options: v.pipe(v.array(Option), v.minLength(2), v.maxLength(4)),
  multiSelect: v.optional(v.boolean(), false),
});

export const askUserQuestionInput = v.pipe(
  v.object({
    questions: v.pipe(v.array(Question), v.minLength(1), v.maxLength(4)),
  }),
  // Answers come back keyed by question text — duplicates would collide.
  v.check(
    (data) => new Set(data.questions.map((q) => q.question)).size === data.questions.length,
    'question texts must be unique',
  ),
);

export type AskUserQuestionInput = v.InferOutput<typeof askUserQuestionInput>;

export const askUserQuestion = defineTool({
  name: 'AskUserQuestion',
  description:
    'Ask the user 1-4 multiple-choice questions through an interactive form and end your ' +
    'response to wait for the answers. Use it when you need the user to pick between ' +
    'concrete options before you can proceed (choosing an approach, confirming a step, ' +
    'narrowing scope). Do NOT use it for open-ended questions — ask those in plain text ' +
    'instead. Each question needs a short header (a few words, shown as a tab label), ' +
    '2-4 options with a label and a one-line description, and multiSelect true/false. ' +
    'The form automatically adds an "Other" free-text option — never add your own ' +
    '"Other"/"None" option. Calling this tool ENDS your response, and it MUST be the ONLY ' +
    'tool call in that response: finish every edit, write, and command in an earlier step, ' +
    'then call AskUserQuestion alone. Never combine it with any other tool call — a sibling ' +
    'call cancels the pause and you will be handed another step before the user has ' +
    'answered. Do not repeat the questions in text and do not call this tool more than once ' +
    'per response. The answers arrive automatically as your next input, in a ' +
    '<user_answers type="ask_user_question.answer" toolCallId="..."> block. That is an ' +
    'input block, NOT a tool — there is no user_answers tool; never call one. Its JSON body ' +
    'has "answers" mapping each question text to the chosen label(s) (multi-select labels ' +
    'joined with ", "; a free-form "Other" answer appears verbatim), and "cancelled": true ' +
    'when the user dismissed the form — then continue without the answers and do not ' +
    'immediately re-ask. The user may also ignore the form and type a normal message ' +
    'instead; treat that message as superseding the questions. If, in this same response, ' +
    'you are handed another step before the user has replied (no <user_answers> block ' +
    'carrying THIS call\'s toolCallId and no new user message yet — earlier rounds\' ' +
    '<user_answers> blocks do not count): end the response immediately — no text, no tool ' +
    'calls, do not repeat or re-ask the questions. When the answer or a typed message ' +
    'arrives, respond normally.',
  input: askUserQuestionInput,
  run({ data }) {
    // The full question set is already in model context as the call arguments;
    // echo only the texts so the model can correlate the incoming answers.
    // `instruction` is what the model reads if a sibling call kept the loop
    // alive (see the batch caveat above); it is invisible to the frontend,
    // which renders the card from `input` and never reads this output.
    return {
      output: {
        status: 'awaiting_user_response',
        questions: data.questions.map((q) => q.question),
        instruction:
          'Response paused for the user. If you are handed another step in this same response ' +
          'before a <user_answers> block for THIS toolCallId (or a new user message) arrives, ' +
          'end it now with no text and no tool calls. user_answers is an input block, not a tool.',
      },
      terminate: true,
    };
  },
});
