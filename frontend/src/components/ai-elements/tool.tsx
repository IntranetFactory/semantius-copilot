"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useState } from "react";

import { CodeBlock, CodeBlockCopyButton } from "./code-block";

/**
 * Copy affordance for the JSON panels below. CodeBlock's container is
 * `relative`, so pinning the button to its top-right corner keeps it reachable
 * while a long payload scrolls — the same deal as the admin console's raw
 * blocks, and it copies the exact bytes rendered.
 */
const copyButton = (
  <CodeBlockCopyButton className="absolute top-1 right-1 z-10 size-7 bg-background/80 text-muted-foreground backdrop-blur-sm hover:bg-background" />
);

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json">
        {copyButton}
      </CodeBlock>
    </div>
  </div>
);

const isSettled = (state: ToolPart["state"]) =>
  state === "output-available" ||
  state === "output-error" ||
  state === "output-denied";

const toolName = (part: ToolPart) =>
  part.type === "dynamic-tool"
    ? part.toolName
    : part.type.split("-").slice(1).join("-");

/** The most informative one-liner in a call's input, so a collapsed row reads
 * as "edit entities/technician.json" rather than just "edit". Precedence:
 *
 * 1. `taskId` (TaskUpdate/TaskGet): "#3 → completed" / "#3 Run tests" beats
 *    the bare "3" the string rules would pick.
 * 2. `subject` (TaskCreate) — the title, never the long `description` body.
 * 3. `description` — the plain-language line the model sends ALONGSIDE a
 *    technical payload. Claude adds one to every `bash` call on its own
 *    ("Checking the workspace and downloading the blueprint" next to a
 *    600-char shell one-liner — the field Claude Code's Bash tool taught it;
 *    Flue's schema tolerates the extra key), so it is what the collapsed row
 *    should say. The command itself stays in the row's Parameters panel.
 * 4. The first non-empty string value (a file path, a pattern, a command when
 *    the model sent no description).
 *
 * The keys are looked up by name, not by position, so the summary does not
 * depend on the order the model happened to emit the arguments in — which
 * also matters mid-stream, when `input` is a partial object. */
const summarizeInput = (input: ToolPart["input"]): string | undefined => {
  const flatten = (text: string) => text.replace(/\s+/g, " ").trim();
  if (typeof input === "string") return flatten(input) || undefined;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? flatten(value) : undefined;
  const { taskId, status } = record;
  const subject = text(record.subject);
  if (typeof taskId === "string" || typeof taskId === "number") {
    const detail = typeof status === "string" ? ` → ${status}` : subject ? ` ${subject}` : "";
    return `#${taskId}${detail}`;
  }
  return (
    subject ??
    text(record.description) ??
    Object.values(record).map(text).find((value) => value !== undefined)
  );
};

export type ToolCallGroupProps = {
  /** The run's tool parts, in stream order. */
  parts: ToolPart[];
  /** True for the transcript's most recent group (the caller decides; see
   * agent-chat.tsx `latestToolGroupMessageId`). Once settled it names its
   * last call instead of a bare count — what the agent did LAST is the one
   * thing worth a glance without a click. */
  latest?: boolean;
  className?: string;
};

/**
 * A run of consecutive tool calls collapsed to ONE summary line ("Ran 7 tool
 * calls ✓") instead of a bordered card per call — long agent runs were filling
 * the viewport with ~65px of repeated chrome each. While the run is live the
 * line names the call in flight; the transcript's latest group keeps naming
 * its last call once settled ("Ran bash  Downloading the blueprint  and 3
 * more" — the live line with its tense flipped), older groups keep the count.
 * Expanding shows a slim row per call, and each row opens into the same
 * ToolInput/ToolOutput panels the per-call card used. Styled after
 * ReasoningTrigger so tool activity and "Thought for…" read as one family of
 * affordances.
 */
export const ToolCallGroup = ({ parts, latest, className }: ToolCallGroupProps) => {
  const active = parts.find((part) => !isSettled(part.state));
  const errorCount = parts.filter(
    (part) => part.state === "output-error"
  ).length;

  // A failure must be visible without a click, but it can land long after
  // mount (the group mounts on the run's FIRST call), so defaultOpen is too
  // early — pop open on the no-errors → errors edge instead.
  const [open, setOpen] = useState(errorCount > 0);
  const [sawError, setSawError] = useState(errorCount > 0);
  if (errorCount > 0 && !sawError) {
    setSawError(true);
    setOpen(true);
  }

  const single = parts.length === 1 ? parts[0] : undefined;
  // The settled latest group names its LAST call: "Running bash  Downloading
  // the blueprint" becomes "Ran bash  Downloading the blueprint  and 3 more"
  // the moment the run moves on, so the line still says where the agent got
  // to. The tool name stays in the line (as on the live line) because only
  // `bash` carries a plain-language description — a path, a `Q:` subject or
  // `#3 → completed` on its own would not read as a sentence. A failure keeps
  // the failure label below: the count + red icon must not be traded for a
  // summary.
  const latestSettled =
    latest && !active && errorCount === 0 ? parts.at(-1) : undefined;
  // The line names what is happening, not just which tool: while a call is
  // in flight it carries that call's summary ("Running bash  Checking the
  // workspace…" — read from the partial input as it streams), and a lone
  // settled call keeps its summary so the common one-call case stays
  // informative without a click.
  const summary = active
    ? summarizeInput(active.input)
    : latestSettled
      ? summarizeInput(latestSettled.input)
      : errorCount === 0 && single
        ? summarizeInput(single.input)
        : undefined;
  const label = active
    ? active.state === "approval-requested"
      ? `Awaiting approval · ${toolName(active)}`
      : `Running ${toolName(active)}${summary ? "" : "…"}`
    : errorCount > 0
      ? `${parts.length} tool call${parts.length === 1 ? "" : "s"} · ${errorCount} failed`
      : latestSettled
        ? `Ran ${toolName(latestSettled)}`
        : single
          ? toolName(single)
          : `Ran ${parts.length} tool calls`;
  // "…and 3 more" after the named call — its own span so the summary can
  // truncate without swallowing the count. No ellipsis: in this family the
  // trailing "…" means in flight, and this group is done.
  const trailer =
    latestSettled && parts.length > 1
      ? `and ${parts.length - 1} more`
      : undefined;
  const icon = active ? (
    <ClockIcon className="size-4 shrink-0 animate-pulse" />
  ) : errorCount > 0 ? (
    <XCircleIcon className="size-4 shrink-0 text-red-600" />
  ) : (
    <CheckCircleIcon className="size-4 shrink-0 text-green-600" />
  );

  return (
    <Collapsible
      className={cn("not-prose mb-4 w-full", className)}
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        {icon}
        <span className="shrink-0 font-medium">{label}</span>
        {summary ? (
          <span className="min-w-0 truncate text-xs">{summary}</span>
        ) : null}
        {trailer ? <span className="shrink-0 text-xs">{trailer}</span> : null}
        <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in">
        <div className="mt-2 divide-y rounded-md border">
          {parts.map((part) => (
            <ToolCallRow key={part.toolCallId} part={part} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const ToolCallRow = ({ part }: { part: ToolPart }) => {
  const summary = summarizeInput(part.input);

  return (
    <Collapsible defaultOpen={part.state === "output-error"}>
      <CollapsibleTrigger className="group/row flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/50">
        <span className="shrink-0">{statusIcons[part.state]}</span>
        <span className="shrink-0 font-medium">{toolName(part)}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {summary}
          </span>
        ) : null}
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/row:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-2.5 pt-1 pb-3">
        <ToolInput input={part.input} />
        <ToolOutput
          errorText={part.state === "output-error" ? part.errorText : undefined}
          output={part.state === "output-available" ? part.output : undefined}
        />
      </CollapsibleContent>
    </Collapsible>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json">
        {copyButton}
      </CodeBlock>
    );
  } else if (typeof output === "string") {
    Output = (
      <CodeBlock code={output} language="json">
        {copyButton}
      </CodeBlock>
    );
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
