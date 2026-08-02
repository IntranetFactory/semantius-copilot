"use client";

import { Button } from "@/components/ui/button";
import type { AgentWelcome, WelcomePrompt, WelcomeSection } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

export type WelcomeCardProps = ComponentProps<"div"> & {
  welcome: AgentWelcome;
  /** Send text as the user's message right away (prompt without `prefill`). */
  onSend: (text: string) => void;
  /** Put text into the composer for editing (prompt with `prefill: true`). */
  onPrefill: (text: string) => void;
};

/**
 * THE welcome card — the single component every chat surface renders while a
 * conversation is empty. All welcome semantics live here and nowhere else:
 * the section/prompt layout, the `prompt ?? display` rule, and the
 * prefill-vs-send routing. Consumers only supply the two primitive callbacks.
 */
export const WelcomeCard = ({
  className,
  welcome,
  onSend,
  onPrefill,
  ...props
}: WelcomeCardProps) => {
  const handleClick = (prompt: WelcomePrompt) => {
    const text = prompt.prompt ?? prompt.display;
    if (prompt.prefill) onPrefill(text);
    else onSend(text);
  };

  return (
    <div className={cn("flex w-full flex-col gap-6 p-4", className)} {...props}>
      <div className="space-y-1">
        <h3 className="font-semibold text-base">{welcome.title}</h3>
        {welcome.subtitle && (
          <p className="text-muted-foreground text-sm">{welcome.subtitle}</p>
        )}
      </div>
      {welcome.sections?.length ? (
        // 2 columns on sm+ (1 on narrow screens); sections flow into as many
        // rows as needed — nothing is ever truncated.
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {welcome.sections.map((section, index) => (
            <Section key={index} onPrompt={handleClick} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const Section = ({
  section,
  onPrompt,
}: {
  section: WelcomeSection;
  onPrompt: (prompt: WelcomePrompt) => void;
}) => (
  <div className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-4">
    <div className="space-y-1">
      <h4 className="font-medium text-sm">{section.title}</h4>
      {section.subtitle && (
        <p className="text-muted-foreground text-sm">{section.subtitle}</p>
      )}
    </div>
    <div className="flex flex-col gap-2">
      {section.prompts.map((prompt, index) => (
        <Button
          className="h-auto w-full justify-start whitespace-normal bg-background px-3 py-2 text-left font-normal text-sm"
          key={index}
          onClick={() => onPrompt(prompt)}
          type="button"
          variant="outline"
        >
          {prompt.display}
        </Button>
      ))}
    </div>
  </div>
);
