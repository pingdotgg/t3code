import { CheckIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";
import { DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import { ScrollArea } from "./scroll-area";

export function WizardPopup({
  children,
  size = "default",
  ...props
}: Omit<ComponentProps<typeof DialogPopup>, "className" | "style"> & {
  readonly size?: "default" | "wide";
}) {
  return (
    <DialogPopup {...props} className={size === "wide" ? "max-w-3xl" : "max-w-xl"}>
      <ScrollArea className="*:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4">
        <div className="flex min-h-0 flex-col">{children}</div>
      </ScrollArea>
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
    <DialogFooter
      variant="bare"
      // The banded panel ends at its fill, so the footer brings its own top gap.
      className={cn("[[data-surface=default]+&]:pt-4", leading && "sm:justify-between")}
    >
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
  variant = "default",
}: {
  /** "pills" is the compact row that sits beside a header lockup. */
  readonly variant?: "default" | "pills";
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly summaries?: readonly (string | null)[];
  readonly showSummaries?: boolean;
  readonly isStepDisabled?: (step: number) => boolean;
  readonly onStepChange?: (step: number) => void;
}) {
  const Step = onStepChange ? "button" : "div";
  if (variant === "pills") {
    return (
      <ol className="flex shrink-0 items-center gap-1.5" aria-label="Setup progress">
        {steps.map((step, index) => (
          <li key={step}>
            <Step
              {...(onStepChange
                ? { type: "button" as const, disabled: isStepDisabled?.(index) }
                : {})}
              aria-current={index === currentStep ? "step" : undefined}
              aria-label={`${step}, step ${index + 1}`}
              onClick={onStepChange ? () => onStepChange(index) : undefined}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-full border border-transparent ps-1 pe-2.5 text-meta outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                index === currentStep
                  ? "surface-card border-border text-strong-foreground"
                  : "text-muted-foreground",
                onStepChange &&
                  index < currentStep &&
                  "cursor-pointer hover:text-foreground disabled:cursor-default",
              )}
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-full text-micro",
                  index < currentStep
                    ? "bg-success/15 text-success"
                    : index === currentStep
                      ? "bg-info/20 text-info-foreground"
                      : "bg-foreground/5",
                )}
                aria-hidden
              >
                {index < currentStep ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span className="max-sm:hidden">{step}</span>
            </Step>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-muted p-1 ring-1 ring-hairline"
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
              "flex w-full min-w-0 items-center gap-2 rounded-[var(--control-radius)] px-2.5 py-2 text-left outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring max-sm:justify-center max-sm:px-2",
              onStepChange &&
                "cursor-pointer hover:surface-ghost-hover disabled:cursor-default disabled:hover:bg-none",
              index === currentStep && "surface-selected text-strong-foreground",
            )}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries?.[index] ? `, ${summaries?.[index]}` : ""}`}
            onClick={onStepChange ? () => onStepChange(index) : undefined}
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-label ring-1",
                index < currentStep
                  ? "bg-primary text-primary-foreground ring-primary"
                  : index === currentStep
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "bg-card text-muted-foreground ring-border",
              )}
              aria-hidden
            >
              {index < currentStep ? <CheckIcon className="size-4 shrink-0" /> : index + 1}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-label max-sm:hidden",
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
  surface = "default",
  className,
}: {
  readonly children: ReactNode;
  readonly holdHeight?: boolean;
  readonly surface?: "default" | "bare";
  readonly className?: string;
}) {
  return (
    <div
      data-slot="dialog-panel"
      data-surface={surface}
      className={cn(
        "min-w-0 space-y-4 px-6 py-5",
        surface === "default" && "bg-muted ring-1 ring-hairline",
        className,
      )}
    >
      <AnimatedHeight holdHeight={holdHeight}>{children}</AnimatedHeight>
    </div>
  );
}
