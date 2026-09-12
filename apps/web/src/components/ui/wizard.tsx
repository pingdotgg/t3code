import { CheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";
import { DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./dialog";

/** Compose a wizard from its header, panel, and footer; flow logic stays with the caller. */
export function WizardPopup({
  children,
  ...props
}: Omit<ComponentProps<typeof DialogPopup>, "className" | "style">) {
  return (
    <DialogPopup {...props} className="max-w-xl overflow-x-hidden overflow-y-auto">
      <div className="flex min-h-0 flex-col">{children}</div>
    </DialogPopup>
  );
}

export function WizardHeader({
  title,
  description,
  identity,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Optional branding shown in place of the visible title. The title remains accessible. */
  readonly identity?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <DialogHeader>
      <DialogTitle className={identity ? "sr-only" : undefined}>{title}</DialogTitle>
      {identity}
      {description ? <DialogDescription>{description}</DialogDescription> : null}
      {children}
    </DialogHeader>
  );
}

export function WizardFooter({
  children,
  leading,
}: {
  readonly children: ReactNode;
  readonly leading?: ReactNode;
}) {
  return (
    <DialogFooter variant="bare" className={leading ? "sm:justify-between" : undefined}>
      {leading}
      {leading ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row">{children}</div>
      ) : (
        children
      )}
    </DialogFooter>
  );
}

export function WizardSteps({
  steps,
  currentStep,
  summaries,
  showSummaries = false,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly summaries?: readonly (string | null)[];
  readonly showSummaries?: boolean;
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
              {showSummaries && index < currentStep && summaries?.[index]
                ? `: ${summaries[index]}`
                : null}
            </span>
          </Step>
        </li>
      ))}
    </ol>
  );
}

export function WizardPanel({
  children,
  holdHeight = false,
}: {
  readonly children: ReactNode;
  readonly holdHeight?: boolean;
}) {
  return (
    <div
      data-slot="dialog-panel"
      className="min-w-0 space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
    >
      <AnimatedHeight holdHeight={holdHeight}>{children}</AnimatedHeight>
    </div>
  );
}
