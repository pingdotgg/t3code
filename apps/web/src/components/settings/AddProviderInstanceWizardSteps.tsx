import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";

interface AddProviderInstanceWizardStepsProps {
  readonly currentStep: number;
  readonly summaries: readonly (string | null)[];
  readonly instanceIdError: string | null;
  readonly onNavigation: (navigation: WizardNavigation) => void;
}

export function AddProviderInstanceWizardSteps({
  currentStep,
  summaries,
  instanceIdError,
  onNavigation,
}: AddProviderInstanceWizardStepsProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {ADD_PROVIDER_WIZARD_STEPS.map((step, index) => (
        <button
          key={step}
          type="button"
          className={cn(
            "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
            index === currentStep
              ? "border-primary bg-primary/10 ring-1 ring-primary/25"
              : index < currentStep
                ? "border-border bg-background"
                : "border-border bg-muted/40",
          )}
          aria-current={index === currentStep ? "step" : undefined}
          onClick={() =>
            onNavigation(
              resolveWizardNavigation(currentStep, index, ADD_PROVIDER_WIZARD_STEPS.length, {
                instanceIdError,
              }),
            )
          }
        >
          <span
            className={cn(
              "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
              index < currentStep
                ? "border-primary bg-primary text-primary-foreground"
                : index === currentStep
                  ? "border-primary bg-background"
                  : "border-muted-foreground/35 bg-background",
            )}
            aria-hidden
          >
            {index < currentStep ? <CheckIcon className="size-3" /> : null}
          </span>
          <span className="text-[10px] font-medium uppercase text-muted-foreground">
            Step {index + 1}
          </span>
          <span className="truncate text-xs font-semibold text-foreground">
            {step}
            {index < currentStep && summaries[index] ? `: ${summaries[index]}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
