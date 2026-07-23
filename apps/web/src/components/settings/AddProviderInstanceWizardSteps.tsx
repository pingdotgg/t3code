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
    <ol
      className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-25 p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
      role="list"
    >
      {ADD_PROVIDER_WIZARD_STEPS.map((step, index) => (
        <li key={step} className="min-w-0">
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring max-sm:justify-center max-sm:px-2",
              index === currentStep &&
                "bg-card text-foreground shadow-xs ring-1 ring-black/5 hover:bg-card dark:shadow-none dark:ring-white/5",
            )}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries[index] ? `, ${summaries[index]}` : ""}`}
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
          </button>
        </li>
      ))}
    </ol>
  );
}
