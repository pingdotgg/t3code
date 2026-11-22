import { useMessages } from "gt-react";

import { WizardSteps } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";

interface AddProviderInstanceWizardStepsProps {
  readonly currentStep: number;
  readonly summaries: readonly (string | null)[];
  readonly instanceIdError: string | null;
  readonly steps?: readonly string[];
  readonly identityStep?: number;
  readonly prerequisite?: {
    readonly step: number;
    readonly error: string | null;
  };
  readonly onNavigation: (navigation: WizardNavigation) => void;
  readonly disabled?: boolean;
}

export function AddProviderInstanceWizardSteps({
  currentStep,
  summaries,
  instanceIdError,
  steps = ADD_PROVIDER_WIZARD_STEPS,
  identityStep,
  prerequisite,
  onNavigation,
  disabled = false,
}: AddProviderInstanceWizardStepsProps) {
  const m = useMessages();
  return (
    <WizardSteps
      steps={steps.map((step) => m(step))}
      currentStep={currentStep}
      summaries={summaries}
      isStepDisabled={() => disabled}
      onStepChange={(requestedStep) =>
        onNavigation(
          resolveWizardNavigation(currentStep, requestedStep, steps.length, {
            instanceIdError,
            ...(identityStep === undefined ? {} : { identityStep }),
            ...(prerequisite === undefined ? {} : { prerequisite }),
          }),
        )
      }
    />
  );
}
