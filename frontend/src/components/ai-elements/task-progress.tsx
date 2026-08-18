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
 * completed task is struck through; a blocked task names its open blockers.
 */
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  ListChecksIcon,
  LoaderCircleIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { taskProgress, type TrackedTask } from "./task-fold";

export type TaskProgressPanelProps = Omit<ComponentProps<"div">, "children"> & {
  /** The current list — `foldTasks(agent.messages)`. */
  tasks: readonly TrackedTask[];
  /** Initial open state (the user can toggle it). Default open. */
  defaultOpen?: boolean;
};

const statusIcon = (status: TrackedTask["status"]) => {
  switch (status) {
    case "completed":
      return <CheckCircle2Icon className="size-4 shrink-0 text-green-600" aria-label="completed" />;
    case "in_progress":
      return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-primary" aria-label="in progress" />;
    default:
      return <CircleIcon className="size-4 shrink-0 text-muted-foreground" aria-label="pending" />;
  }
};

export const TaskProgressPanel = ({ tasks, defaultOpen = true, className, ...props }: TaskProgressPanelProps) => {
  const [open, setOpen] = useState(defaultOpen);
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
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex min-w-0 items-start gap-2 leading-5"
                title={task.description || undefined}
              >
                <span className="mt-0.5">{statusIcon(task.status)}</span>
                <span className="shrink-0 text-muted-foreground text-xs leading-5">#{task.id}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    task.status === "completed" && "text-muted-foreground line-through",
                  )}
                >
                  {task.status === "in_progress" ? (task.activeForm ?? task.subject) : task.subject}
                  {task.blockedBy.length > 0 && task.status !== "completed" ? (
                    <span className="ml-1 text-muted-foreground text-xs">
                      (blocked by {task.blockedBy.map((id) => `#${id}`).join(", ")})
                    </span>
                  ) : null}
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
