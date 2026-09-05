import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export function WizardSteps<Step extends string>({
  steps,
  currentStep,
  disabled = false,
  onStepSelect,
}: {
  steps: readonly { id: Step; label: string; disabled?: boolean }[];
  currentStep: Step;
  disabled?: boolean;
  onStepSelect: (step: Step) => void;
}) {
  const currentIndex = steps.findIndex((step) => step.id === currentStep);
  return (
    <ol className="grid auto-cols-fr grid-flow-col gap-2" aria-label="Setup steps">
      {steps.map((step, index) => (
        <li key={step.id} className="min-w-0">
          <button
            type="button"
            disabled={disabled || step.disabled}
            aria-current={index === currentIndex ? "step" : undefined}
            className={cn(
              "grid w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              index === currentIndex
                ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                : index < currentIndex
                  ? "border-border bg-background"
                  : "border-border bg-muted/40",
            )}
            onClick={() => onStepSelect(step.id)}
          >
            <span
              className={cn(
                "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                index < currentIndex
                  ? "border-primary bg-primary text-primary-foreground"
                  : index === currentIndex
                    ? "border-primary bg-background"
                    : "border-muted-foreground/35 bg-background",
              )}
              aria-hidden
            >
              {index < currentIndex ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              Step {index + 1}
            </span>
            <span className="truncate text-xs font-semibold text-foreground">{step.label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
