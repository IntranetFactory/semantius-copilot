"use client";

/**
 * AskUserQuestion — the interactive card for the backend's `AskUserQuestion`
 * tool (backend-b/src/tools/ask-user-question.ts). The tool ends the agent's
 * response (`terminate`); this card renders from the dynamic-tool part's
 * `input` and the host sends the selections back as a `kind: 'signal'`
 * delivery, which the model reads on its next turn.
 *
 * Claude Code-style layout: a tab bar of header chips when there are 2+
 * questions (answered tabs get a check), 2-4 option rows with label +
 * description, an auto-added "Other" free-text row, Submit + Dismiss.
 *
 * All durable state is derived by the HOST from conversation history (the
 * answer signal); this component keeps only ephemeral selection state, so the
 * container's key-flip remount can never strand an answer.
 */
import { CheckIcon, CircleIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** Tool name the chat renderer switches on (must match the backend tool). */
export const ASK_USER_TOOL_NAME = "AskUserQuestion";
/** Signal `type` of the answer delivery (must match the backend constant). */
export const ASK_USER_ANSWER_SIGNAL_TYPE = "ask_user_question.answer";
/** Signal `tagName` — the projection key answer messages are matched by
 * (`message.signal.tagName`; the delivered `type` is not projected). */
export const ASK_USER_ANSWER_TAG = "user_answers";

export type AskUserQuestionOption = { label: string; description: string };
export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

/** The JSON body of the answer signal (and of the projected signal message). */
export type AskUserAnswerPayload = {
  toolCallId: string;
  cancelled: boolean;
  /** question text → chosen label(s); multi-select joined with ", ",
   * an "Other" answer verbatim. Empty when cancelled. */
  answers: Record<string, string>;
};

export type AskUserQuestionStatus =
  | { kind: "pending" } // interactive
  | { kind: "submitting" } // answer sent, awaiting the signal echo / next turn
  | { kind: "answered"; answer: AskUserAnswerPayload }
  | { kind: "stale" }; // superseded (user typed instead / newer messages)

/** Defensive structural guard — the part's `input` is `unknown` on the wire.
 * The backend already validated; a mismatch means renderer/tool skew, and the
 * caller falls back to the generic tool card. */
export function parseQuestions(input: unknown): AskUserQuestionItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: AskUserQuestionItem[] = [];
  for (const q of questions) {
    if (typeof q !== "object" || q === null) return null;
    const { question, header, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== "string" || typeof header !== "string") return null;
    if (!Array.isArray(options) || options.length === 0) return null;
    const opts: AskUserQuestionOption[] = [];
    for (const o of options) {
      if (typeof o !== "object" || o === null) return null;
      const { label, description } = o as Record<string, unknown>;
      if (typeof label !== "string") return null;
      opts.push({ label, description: typeof description === "string" ? description : "" });
    }
    parsed.push({ question, header, options: opts, multiSelect: multiSelect === true });
  }
  return parsed;
}

/** Ephemeral per-question selection. */
type Selection = { selected: string[]; otherActive: boolean; otherText: string };

const EMPTY_SELECTION: Selection = { selected: [], otherActive: false, otherText: "" };

function isAnswered(selection: Selection | undefined): boolean {
  if (!selection) return false;
  return selection.selected.length > 0 || (selection.otherActive && selection.otherText.trim().length > 0);
}

/** question text → answer string, per the Claude Code encoding rules. */
function assembleAnswers(questions: AskUserQuestionItem[], selections: Record<number, Selection>): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, index) => {
    const sel = selections[index] ?? EMPTY_SELECTION;
    const other = sel.otherActive ? sel.otherText.trim() : "";
    if (q.multiSelect) {
      // Chosen labels in option order, the free-text answer last.
      const labels = q.options.map((o) => o.label).filter((label) => sel.selected.includes(label));
      if (other) labels.push(other);
      answers[q.question] = labels.join(", ");
    } else {
      answers[q.question] = other || sel.selected[0] || "";
    }
  });
  return answers;
}

export function AskUserQuestionCard({
  input,
  status,
  onSubmit,
}: {
  /** The dynamic-tool part's `input` — guarded internally. */
  input: unknown;
  status: AskUserQuestionStatus;
  onSubmit?: (result: { answers: Record<string, string>; cancelled: boolean }) => void;
}) {
  const questions = parseQuestions(input);
  const [selections, setSelections] = useState<Record<number, Selection>>({});
  const [activeTab, setActiveTab] = useState(0);

  if (!questions) return null;

  if (status.kind === "answered") {
    return <AnsweredCard questions={questions} answer={status.answer} />;
  }

  const interactive = status.kind === "pending";
  const complete = questions.every((_, index) => isAnswered(selections[index]));
  const active = Math.min(activeTab, questions.length - 1);
  const question = questions[active];
  const selection = selections[active] ?? EMPTY_SELECTION;

  const update = (index: number, next: Selection) => setSelections((prev) => ({ ...prev, [index]: next }));

  /** After a single-select pick, jump to the next unanswered question. */
  const advanceFrom = (index: number, next: Record<number, Selection>) => {
    for (let step = 1; step < questions.length; step += 1) {
      const candidate = (index + step) % questions.length;
      if (!isAnswered(next[candidate])) {
        setActiveTab(candidate);
        return;
      }
    }
  };

  const pick = (label: string) => {
    if (!interactive) return;
    let next: Selection;
    if (question.multiSelect) {
      next = {
        ...selection,
        selected: selection.selected.includes(label)
          ? selection.selected.filter((l) => l !== label)
          : [...selection.selected, label],
      };
    } else {
      next = { selected: [label], otherActive: false, otherText: selection.otherText };
    }
    const all = { ...selections, [active]: next };
    update(active, next);
    if (!question.multiSelect) advanceFrom(active, all);
  };

  const pickOther = () => {
    if (!interactive) return;
    update(active, {
      selected: question.multiSelect ? selection.selected : [],
      otherActive: !selection.otherActive,
      otherText: selection.otherText,
    });
  };

  return (
    <div className="w-full max-w-xl rounded-md border bg-muted/30">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-medium text-sm">
          {questions.length > 1 ? "Questions from the agent" : "Question from the agent"}
        </span>
        {status.kind === "submitting" ? (
          <Badge variant="secondary" className="ml-auto gap-1">
            <Spinner className="size-3" /> Sending…
          </Badge>
        ) : status.kind === "stale" ? (
          <Badge variant="outline" className="ml-auto">
            Skipped
          </Badge>
        ) : null}
      </div>

      <div className={cn(!interactive && status.kind === "stale" && "pointer-events-none opacity-60")}>
        {questions.length > 1 ? (
          <div className="flex flex-wrap gap-1 px-3 pt-2" role="tablist">
            {questions.map((q, index) => (
              <button
                key={index}
                type="button"
                role="tab"
                aria-selected={index === active}
                onClick={() => setActiveTab(index)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
                  index === active
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted",
                )}
              >
                {isAnswered(selections[index]) ? <CheckIcon className="size-3" /> : null}
                {q.header}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-2 p-3">
          <p className="font-medium text-sm">{question.question}</p>
          {question.multiSelect ? (
            <p className="-mt-1 text-muted-foreground text-xs">Select all that apply.</p>
          ) : null}
          {question.options.map((option) => {
            const chosen = selection.selected.includes(option.label);
            const Unchecked = question.multiSelect ? SquareIcon : CircleIcon;
            return (
              <Button
                key={option.label}
                type="button"
                variant="outline"
                aria-pressed={chosen}
                disabled={!interactive}
                onClick={() => pick(option.label)}
                className={cn(
                  "h-auto w-full items-start justify-start gap-2 whitespace-normal bg-background px-3 py-2 text-left font-normal",
                  chosen && "border-primary bg-primary/10",
                )}
              >
                {chosen ? (
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : (
                  <Unchecked className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-sm">{option.label}</span>
                  {option.description ? (
                    <span className="text-muted-foreground text-xs">{option.description}</span>
                  ) : null}
                </span>
              </Button>
            );
          })}

          <Button
            type="button"
            variant="outline"
            aria-pressed={selection.otherActive}
            disabled={!interactive}
            onClick={pickOther}
            className={cn(
              "h-auto w-full items-start justify-start gap-2 whitespace-normal bg-background px-3 py-2 text-left font-normal",
              selection.otherActive && "border-primary bg-primary/10",
            )}
          >
            {selection.otherActive ? (
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : question.multiSelect ? (
              <SquareIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">Other</span>
              <span className="text-muted-foreground text-xs">Type your own answer</span>
            </span>
          </Button>
          {selection.otherActive ? (
            <Input
              autoFocus
              value={selection.otherText}
              maxLength={2000}
              placeholder="Your answer…"
              disabled={!interactive}
              onChange={(event) => update(active, { ...selection, otherText: event.currentTarget.value })}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-2 px-3 pb-3">
          <Button
            type="button"
            size="sm"
            disabled={!interactive || !complete}
            onClick={() => onSubmit?.({ answers: assembleAnswers(questions, selections), cancelled: false })}
          >
            {status.kind === "submitting" ? <Spinner className="size-3" /> : null}
            Submit {questions.length > 1 ? "answers" : "answer"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!interactive}
            onClick={() => onSubmit?.({ answers: {}, cancelled: true })}
            className="text-muted-foreground"
          >
            Dismiss
          </Button>
          <span className="ml-auto text-muted-foreground text-xs">or type a reply below</span>
        </div>
      </div>
    </div>
  );
}

/** Post-answer rendering: each question's header chip + the recorded choice. */
function AnsweredCard({ questions, answer }: { questions: AskUserQuestionItem[]; answer: AskUserAnswerPayload }) {
  return (
    <div className="w-full max-w-xl rounded-md border bg-muted/30">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-medium text-sm">
          {questions.length > 1 ? "Questions from the agent" : "Question from the agent"}
        </span>
        <Badge variant={answer.cancelled ? "outline" : "secondary"} className="ml-auto gap-1">
          {answer.cancelled ? null : <CheckIcon className="size-3" />}
          {answer.cancelled ? "Dismissed" : "Answered"}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {questions.map((q, index) => (
          <div key={index} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{q.header}</Badge>
              <span className="text-muted-foreground text-xs">{q.question}</span>
            </div>
            <p className={cn("text-sm", answer.cancelled ? "text-muted-foreground" : "font-medium")}>
              {answer.cancelled ? "—" : answer.answers[q.question] || "—"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
