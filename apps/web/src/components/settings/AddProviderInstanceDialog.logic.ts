import type { ProviderDriverKind } from "@t3tools/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;
const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

export function isOwnedHermesEnrollmentRetry(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
  readonly createdHermesInstanceId: string | null;
}): boolean {
  return (
    input.driver === "hermes" &&
    input.createdHermesInstanceId !== null &&
    input.createdHermesInstanceId === input.instanceId
  );
}

export function validateProviderInstanceIdForWizard(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
  readonly existingIds: ReadonlySet<string>;
  readonly createdHermesInstanceId: string | null;
}): string | null {
  if (input.instanceId.length === 0) return "Instance ID is required.";
  if (input.instanceId.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(input.instanceId)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (
    input.existingIds.has(input.instanceId) &&
    !isOwnedHermesEnrollmentRetry({
      driver: input.driver,
      instanceId: input.instanceId,
      createdHermesInstanceId: input.createdHermesInstanceId,
    })
  ) {
    return `An instance named '${input.instanceId}' already exists.`;
  }
  return null;
}

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}
