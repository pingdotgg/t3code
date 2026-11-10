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
  readonly size?: "default" | "wide" | "setup";
}) {
  return (
    <DialogPopup
      {...props}
      className={cn(
        size === "wide" ? "max-w-3xl" : "max-w-xl",
        size === "setup" && "rounded-[16px]",
      )}
    >
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
  layout = "stacked",
}: {
  readonly layout?: "stacked" | "inline";
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly identity?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <DialogHeader
      className={cn(
        layout === "inline" &&
          "flex-row flex-wrap items-center justify-between gap-3 pt-6 pr-14 pb-5 pl-6",
      )}
    >
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
    <ol className="flex shrink-0 items-center gap-1.5" aria-label="Setup progress">
      {steps.map((step, index) => (
        <li key={step}>
          <Step
            {...(onStepChange
              ? { type: "button" as const, disabled: isStepDisabled?.(index) }
              : {})}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries?.[index] ? `, ${summaries[index]}` : ""}`}
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
            <span className="max-sm:hidden">
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
  readonly surface?: "default" | "bare" | "setup";
  readonly className?: string;
}) {
  return (
    <div
      data-slot="dialog-panel"
      data-surface={surface}
      className={cn(
        "min-w-0 space-y-4 px-6 py-5",
        surface === "default" && "bg-muted ring-1 ring-hairline",
        surface === "setup" && "pt-0 pb-6",
        className,
      )}
    >
      <AnimatedHeight holdHeight={holdHeight}>{children}</AnimatedHeight>
    </div>
  );
}
