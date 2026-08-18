/**
 * Run outcomes — the pure half of the chat's failed/stopped-run notices.
 *
 * Durable truth is the conversation's `settlements` (history + live), joined
 * to the VISIBLE transcript by `submissionId`: the user message that opened a
 * submission and the (partial) assistant reply it produced share one id. Two
 * facts make this derivation necessary rather than a nicety:
 *
 *  - Flue appends NO advisory message on the normal failure path (an LLM
 *    upstream error mid-stream, a context overflow, a tool crash): the
 *    conversation carries the user message, the partial assistant message,
 *    and one `failed` settlement — nothing else. Verified 2026-08-18 on a
 *    live session. Only the reconciliation/abort paths add a `diagnostic`
 *    advisory, which the visible filter drops anyway.
 *  - `useFlueAgent().status === 'error'` for a failed run applies only to
 *    submissions sent by THIS tab and is forgotten on the next hook send:
 *    after a reload a failed tail reads `idle`. So `agent.status`/`agent.error`
 *    are transient signals, not the record.
 *
 * Hence the notice is re-derived from history on every render, exactly like
 * the AskUserQuestion answer state and the task fold: reloads and the
 * container's key-flip remount get the same result.
 *
 * No React, no `@/` alias, no workspace imports: importable straight into
 * Node (`scripts/run-outcome.test.mjs`) and part of the copy-pasteable folder.
 */

export type RunError = { message: string; details?: string };

export type RunNotice = {
  /** Stable React key: the (host) submission id. */
  key: string;
  submissionId: string;
  outcome: "failed" | "aborted";
  /** The visible message the notice renders after; undefined = end of transcript. */
  anchorMessageId?: string;
  /** Nothing visible follows the turn — the only place a Retry makes sense. */
  atTail: boolean;
  /** The anchor is an assistant message: a partial reply exists to continue from. */
  hasPartialReply: boolean;
  /** Present for `failed` only. */
  error?: RunError;
};

/** The slices the derivation reads (structurally, so tests pass plain objects). */
type MessageLike = { id: string; role: string; submissionId?: string };
type SettlementLike = {
  submissionId: string;
  outcome: string;
  error?: unknown;
  answeredBySubmissionId?: string;
};

/**
 * flue's own fallback wording (`@flue/react` `settlementError`) — kept
 * identical on purpose: agent-chat.tsx compares `settlementErrorOf(...).message`
 * against `agent.error.message` to tell a failed settlement from a dropped
 * connection, and the reducer builds that Error from the same string.
 */
const FALLBACK_MESSAGE = "Agent submission failed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeJson = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
};

/** Normalize a settlement's `error` — the wire shape is `{name, message, type,
 * details, meta?}` (flue `serializeSubmissionError`), but it is typed `unknown`. */
export function settlementErrorOf(error: unknown): RunError {
  if (isRecord(error)) {
    const message = "message" in error ? String(error.message) : FALLBACK_MESSAGE;
    const raw = error.details;
    const details =
      typeof raw === "string" ? raw : raw !== undefined && raw !== null ? safeJson(raw) : undefined;
    return details ? { message, details } : { message };
  }
  if (typeof error === "string" && error) return { message: error };
  return { message: FALLBACK_MESSAGE };
}

/** First line of an error message, without flue's `direct(<sub>) failed:`
 * wrapper and trailing period, capped so a chat bubble stays short. */
export function summarizeError(message: string | undefined, max = 200): string {
  const first = (message ?? "").split(/\r?\n/, 1)[0] ?? "";
  const line = first
    .replace(/^direct\([^)]*\)\s+failed:\s*/, "")
    .trim()
    .replace(/\.$/, "");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * The visible user message the Retry button sends. Short, names the reason so
 * the model knows its last step was cut off (not rejected), and reads as a
 * chat bubble. With a partial reply in history the model continues from it;
 * without one it simply answers again.
 */
export function retryMessageFor(errorMessage: string | undefined, hasPartialReply: boolean): string {
  const reason = summarizeError(errorMessage);
  const because = reason ? `: ${reason}.` : ".";
  return hasPartialReply
    ? `Continue — your previous response was interrupted by an error${because} Pick up where you stopped; do not repeat work that already completed.`
    : `Try again — your previous response failed before producing anything${because}`;
}

/**
 * `messages` = the VISIBLE transcript in render order (pending echoes and
 * failed-optimistic bubbles included — they carry no submissionId).
 * `settlements` = the conversation's settlements in settle order.
 */
export function deriveRunNotices(
  messages: readonly MessageLike[],
  settlements: readonly SettlementLike[],
): RunNotice[] {
  const settledIds = new Set(settlements.map((s) => s.submissionId));
  // Last visible message per submission (user + assistant share it; the later one wins).
  const lastIndexBySubmission = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.submissionId) lastIndexBySubmission.set(m.submissionId, i);
  });

  // A delivery that joined a live response settles under its host
  // (`answeredBySubmissionId`): one turn, one notice, anchored on the last
  // visible message carrying ANY id of the group; outcome/error are the host's.
  const groups = new Map<string, { host?: SettlementLike; members: SettlementLike[] }>();
  for (const s of settlements) {
    const hostId = s.answeredBySubmissionId ?? s.submissionId;
    const group = groups.get(hostId) ?? { members: [] };
    if (s.submissionId === hostId) group.host = s;
    group.members.push(s);
    groups.set(hostId, group);
  }

  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  // "At rest": no send pending (an echo / failed bubble has no submissionId)
  // and the newest turn has settled — the only state in which an UNANCHORED
  // notice has a meaningful position (the end of the transcript).
  const atRest = !last || (!!last.submissionId && settledIds.has(last.submissionId));
  const newest = settlements[settlements.length - 1];
  const newestHostId = newest ? (newest.answeredBySubmissionId ?? newest.submissionId) : undefined;

  const notices: RunNotice[] = [];
  for (const [hostId, group] of groups) {
    const primary = group.host ?? group.members[0];
    const outcome = primary.outcome;
    if (outcome !== "failed" && outcome !== "aborted") continue; // completed: the reply is the marker
    let anchor = -1;
    for (const member of group.members) {
      anchor = Math.max(anchor, lastIndexBySubmission.get(member.submissionId) ?? -1);
    }
    const error = outcome === "failed" ? settlementErrorOf(primary.error) : undefined;
    if (anchor >= 0) {
      notices.push({
        key: hostId,
        submissionId: hostId,
        outcome,
        anchorMessageId: messages[anchor].id,
        atTail: anchor === lastIndex,
        hasPartialReply: messages[anchor].role === "assistant",
        ...(error ? { error } : {}),
      });
    } else if (hostId === newestHostId && atRest) {
      // No visible message carries the id: a signal-triggered run (its input
      // projects as diagnostic) that failed before any output. Only the
      // NEWEST such settlement, only at the tail.
      notices.push({
        key: hostId,
        submissionId: hostId,
        outcome,
        atTail: true,
        hasPartialReply: false,
        ...(error ? { error } : {}),
      });
    }
  }
  return notices; // group insertion order = settle order; the host looks notices up by anchor
}
