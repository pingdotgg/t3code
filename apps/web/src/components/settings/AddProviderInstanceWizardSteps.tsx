import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { useT } from "../../hooks/useI18n";
import { WizardSteps } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";

const STEP_LABEL_KEYS: Record<string, MessageKey> = {
  Provider: "settings.providers.instance.wizard.provider",
  Identity: "settings.providers.instance.wizard.identity",
  Config: "settings.providers.instance.wizard.config",
  "Sign in": "settings.providers.instance.wizard.signIn",
};

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
  const t = useT();
  return (
    <WizardSteps
      steps={steps.map((step) => (STEP_LABEL_KEYS[step] ? t(STEP_LABEL_KEYS[step]) : step))}
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
