"use client";

import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { RunNotice } from "./run-outcome";

/**
 * The inline transcript line for a run that settled short of a reply
 * (run-outcome.ts derives WHICH runs and WHERE). Rendered by the host as a
 * transcript sibling right after its anchor message; `-mt-4` pulls it under
 * that message inside ConversationContent's `gap-8` column, so it reads as the
 * end of that turn rather than as a message of its own.
 *
 * Aborted (the user pressed stop) = a muted "Stopped." — flue folds an aborted
 * partial into the next turn on its own, so no action is offered. Failed = the
 * settlement's error, its details collapsed (flue's internal_error text asks
 * the user to quote the submission id, so that is in there too), and Retry
 * when the host passes `onRetry` — only at the tail of the transcript.
 */
export function RunOutcomeNotice({
  notice,
  onRetry,
  retryDisabled,
  className,
}: {
  notice: RunNotice;
  /** Present = show Retry (the host decides: failed + at the tail). */
  onRetry?: () => void;
  /** A send/run is in flight — the button stays visible but inert. */
  retryDisabled?: boolean;
  className?: string;
}) {
  if (notice.outcome === "aborted") {
    return (
      <p className={cn("-mt-4 text-muted-foreground text-xs", className)} role="status">
        Stopped.
      </p>
    );
  }
  const message = notice.error?.message ?? "the run ended without a reply";
  return (
    <div
      className={cn(
        "-mt-4 flex items-start gap-2 rounded-lg border border-destructive/50 bg-background p-3 text-sm",
        className,
      )}
      role="alert"
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="wrap-break-word text-destructive">run failed — {message}</p>
        {notice.error?.details ? (
          <details className="mt-1 text-muted-foreground text-xs">
            <summary className="cursor-pointer select-none">details</summary>
            <pre className="mt-1 whitespace-pre-wrap wrap-break-word font-mono">{notice.error.details}</pre>
            <p className="mt-1">submission {notice.submissionId}</p>
          </details>
        ) : null}
      </div>
      {onRetry ? (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry} disabled={retryDisabled}>
          <RotateCcwIcon /> Retry
        </Button>
      ) : null}
    </div>
  );
}
