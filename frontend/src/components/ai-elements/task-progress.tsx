"use client";

/**
 * TaskProgressPanel — the pinned checklist + progress bar for the backend's
 * Claude Code–compatible task tools (TaskCreate / TaskUpdate / TaskList /
 * TaskGet; design §17). Purely presentational: the host folds the
 * conversation's tool events with `foldTasks` (task-fold.ts) and passes
 * the resulting list in; nothing here is stateful beyond the open/closed
 * toggle, so a reload or the container's key-flip remount cannot lose it.
 * Rendered by AgentChat above the composer, next to the HintTip. Nothing to
 * render when the conversation has no tasks.
 *
 * Row semantics mirror Claude Code's TUI: an in_progress task shows its
 * `activeForm` ("Running tests") when it has one, otherwise the subject; a
 * completed task is struck through.
 * Markers are checkbox glyphs like Claude Code's ☐ / ☒ (pending square,
 * completed checked square); the in_progress marker is a static dotted square
 * and only becomes a spinner while the agent is actually running (`running`,
 * the host's busy signal). A task's status alone says nothing about activity:
 * the ledger pattern leaves a stage task and up to four question tasks
 * in_progress across a paused AskUserQuestion turn, and a spinner that keeps
 * turning while the agent waits for the user promises work that is not
 * happening.
 *
 * Rows are in `orderTasks` order (task-fold.ts): id order with each task's
 * blockers hoisted in front of it, so dependency-linked work reads top-down
 * even when it was created later. That order is the only dependency signal
 * shown: rows carry neither the `#id` nor a "(blocked by #n)" note. Ids are
 * the model's handle, not the user's, and once blockers are hoisted the
 * numbers read out of sequence (#1, #8, #4, #5 …) — noise that made the
 * panel look broken; the blocked-by note only restated what the position
 * already says. `openBlockers` (task-fold.ts) still derives the projection
 * for anything that needs it (tests, TaskList parity).
 */
import {
  ChevronDownIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  SquareCheckBigIcon,
  SquareDotIcon,
  SquareIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { orderTasks, taskProgress, type TrackedTask } from "./task-fold";

export type TaskProgressPanelProps = Omit<ComponentProps<"div">, "children"> & {
  /** The current list — `foldTasks(agent.messages)`. */
  tasks: readonly TrackedTask[];
  /** Initial open state (the user can toggle it). Default open. */
  defaultOpen?: boolean;
  /**
   * Whether the agent is running right now (the host's busy signal, the same
   * one that shows "Working…"). Only then do in_progress rows spin; while the
   * agent waits — for an AskUserQuestion answer or the next message — they
   * show a static "current" marker. Default false.
   */
  running?: boolean;
};

const statusIcon = (status: TrackedTask["status"], running: boolean) => {
  switch (status) {
    case "completed":
      return <SquareCheckBigIcon className="size-4 shrink-0 text-green-600" aria-label="completed" />;
    case "in_progress":
      return running ? (
        <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-primary" aria-label="in progress" />
      ) : (
        <SquareDotIcon className="size-4 shrink-0 text-primary" aria-label="in progress" />
      );
    default:
      return <SquareIcon className="size-4 shrink-0 text-muted-foreground" aria-label="pending" />;
  }
};

export const TaskProgressPanel = ({
  tasks,
  defaultOpen = true,
  running = false,
  className,
  ...props
}: TaskProgressPanelProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const ordered = useMemo(() => orderTasks(tasks), [tasks]);
  if (tasks.length === 0) return null;
  const { completed, total, percent } = taskProgress(tasks);
  const active = tasks.find((task) => task.status === "in_progress");
  const done = completed === total;

  return (
    <div className={cn("mb-2 rounded-lg border bg-muted/30 text-sm", className)} {...props}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
          <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">
            Tasks · {completed}/{total}
            {done ? " done" : ""}
          </span>
          {/* Progress bar: a plain div pair, so the folder needs no extra ui
              primitive (there is no shadcn Progress here). */}
          <span
            className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span
              className={cn("block h-full rounded-full transition-[width]", done ? "bg-green-600" : "bg-primary")}
              style={{ width: `${percent}%` }}
            />
          </span>
          {!open && active ? (
            <span className="min-w-0 truncate text-muted-foreground text-xs">{active.activeForm ?? active.subject}</span>
          ) : null}
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in">
          <ul className="max-h-48 space-y-1 overflow-y-auto border-t px-3 py-2">
            {ordered.map((task) => (
              <li
                key={task.id}
                className="flex min-w-0 items-start gap-2 leading-5"
                title={task.description || undefined}
              >
                <span className="mt-0.5">{statusIcon(task.status, running)}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 wrap-break-word",
                    task.status === "completed" && "text-muted-foreground line-through",
                    task.status === "in_progress" && "font-medium",
                  )}
                >
                  {task.status === "in_progress" ? (task.activeForm ?? task.subject) : task.subject}
                </span>
                {task.owner ? (
                  <Badge variant="secondary" className="shrink-0 font-normal text-xs">
                    {task.owner}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
