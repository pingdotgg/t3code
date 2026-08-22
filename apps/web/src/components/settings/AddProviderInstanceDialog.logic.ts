import {
  defaultLaunchForFeaturedAgent,
  featuredAgentById,
  formatAcpLaunchArgs,
  ProviderDriverKind,
} from "@t3tools/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;
export const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");
export const ACP_PICKER_PREFIX = "acp:";

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

export function acpPickerValue(catalogId: string): string {
  return `${ACP_PICKER_PREFIX}${catalogId}`;
}

export function parseAddProviderPickerValue(value: string): {
  readonly driver: ProviderDriverKind;
  readonly catalogId: string | undefined;
} {
  if (value.startsWith(ACP_PICKER_PREFIX)) {
    return {
      driver: ACP_REGISTRY_DRIVER,
      catalogId: value.slice(ACP_PICKER_PREFIX.length),
    };
  }
  return { driver: ProviderDriverKind.make(value), catalogId: undefined };
}

export function configDraftForFeaturedAgent(catalogId: string): Record<string, unknown> {
  const agent = featuredAgentById(catalogId);
  if (!agent || agent.id === "custom") {
    return {};
  }
  const launch = defaultLaunchForFeaturedAgent(agent);
  return {
    catalogId: agent.id,
    ...(launch
      ? {
          command: launch.command,
          launchArgs: formatAcpLaunchArgs(launch.args),
        }
      : {}),
  };
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
