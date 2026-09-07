import { CheckIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";

export function WizardSteps({
  steps,
  currentStep,
  summaries,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly summaries?: readonly (string | null)[];
  readonly isStepDisabled?: (step: number) => boolean;
  readonly onStepChange?: (step: number) => void;
}) {
  const Step = onStepChange ? "button" : "div";
  return (
    <ol
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-zinc-25 p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
      role="list"
      aria-label="Setup progress"
    >
      {steps.map((step, index) => (
        <li key={step} className="min-w-0">
          <Step
            {...(onStepChange
              ? { type: "button" as const, disabled: isStepDisabled?.(index) }
              : {})}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:justify-center max-sm:px-2",
              onStepChange &&
                "cursor-pointer hover:bg-card disabled:cursor-default disabled:hover:bg-transparent",
              index === currentStep &&
                "bg-card text-foreground shadow-xs ring-1 ring-black/5 hover:bg-card dark:shadow-none dark:ring-white/5",
            )}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries?.[index] ? `, ${summaries?.[index]}` : ""}`}
            onClick={onStepChange ? () => onStepChange(index) : undefined}
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                index < currentStep
                  ? "bg-primary text-primary-foreground ring-primary"
                  : index === currentStep
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
              )}
              aria-hidden
            >
              {index < currentStep ? <CheckIcon className="size-4 shrink-0" /> : index + 1}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-sm font-medium max-sm:hidden",
                index === currentStep ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step}
            </span>
          </Step>
        </li>
      ))}
    </ol>
  );
}

export function WizardPanel({
  className,
  children,
  holdHeight = false,
  ...props
}: ComponentProps<"div"> & { readonly holdHeight?: boolean }) {
  return (
    <div
      data-slot="dialog-panel"
      className={cn(
        "space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
        className,
      )}
      {...props}
    >
      <AnimatedHeight holdHeight={holdHeight}>{children}</AnimatedHeight>
    </div>
  );
}
