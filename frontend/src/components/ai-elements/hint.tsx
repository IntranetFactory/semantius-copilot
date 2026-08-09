"use client";

import { LightbulbIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Where "the user closed this tip" is remembered. The INTERFACE lives here (in
 * the app-agnostic folder); the IMPLEMENTATION is the host app's — see
 * `frontend/src/hint-dismissal.ts` for the localStorage one this app passes to
 * AgentChatContainer. Moving dismissals to a server-side API later means
 * writing another implementation of these two methods and nothing else.
 *
 * Deliberately synchronous: a server-backed store hydrates its set once (on
 * mount / at sign-in) and answers from memory, so the render path never awaits.
 *
 * Ids are opaque strings minted by AgentChatContainer as `<agentName>:<display>`
 * — the prompt's `display` is its required, user-visible identity, so no extra
 * config field and no hashing. Re-wording a display re-shows its tip once.
 */
export type HintStore = {
  isDismissed: (id: string) => boolean;
  dismiss: (id: string) => void;
};

export type HintTipProps = Omit<ComponentProps<"div">, "children"> & {
  /** The tip text (an agent.jsonc prompt `hint`). */
  children: string;
  /** Close (✕) — the host persists the dismissal via its HintStore. */
  onDismiss?: () => void;
};

/**
 * The dismissible tip shown above the composer when a welcome-card prompt with
 * a `hint` is clicked. Amber rather than a `--warning` theme token on purpose:
 * this folder must stay copy-pasteable into an app whose CSS only defines the
 * standard shadcn tokens, and amber ships with Tailwind.
 */
export const HintTip = ({ children, className, onDismiss, ...props }: HintTipProps) => (
  <div
    className={cn(
      "mb-2 flex items-start gap-2 rounded-lg border p-3 text-sm",
      "border-amber-300 bg-amber-50 text-amber-900",
      "dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100",
      className,
    )}
    role="status"
    {...props}
  >
    <LightbulbIcon className="mt-0.5 size-4 shrink-0" />
    <p className="min-w-0 flex-1 whitespace-pre-wrap">{children}</p>
    {onDismiss ? (
      <button
        className="-m-1 shrink-0 rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40"
        onClick={onDismiss}
        type="button"
      >
        <XIcon className="size-4" />
        <span className="sr-only">Dismiss tip</span>
      </button>
    ) : null}
  </div>
);
