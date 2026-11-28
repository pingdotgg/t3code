import {
  managedRuntimeModeDenial,
  providerRuntimeModeLimitMessage,
} from "@t3tools/client-runtime/contract-labels";
import type {
  ManagedPolicySummary,
  ProviderRuntimeModeLimit,
  RuntimeMode,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: msg("Supervised"),
    description: msg("Ask before commands and file changes."),
  },
  {
    mode: "auto-accept-edits",
    label: msg("Auto-accept edits"),
    description: msg("Auto-approve edits, ask before other actions."),
  },
  {
    mode: "auto",
    label: msg("Auto"),
    description: msg("Supported providers approve routine actions; others still ask."),
  },
  {
    mode: "full-access",
    label: msg("Full access"),
    description: msg("Allow commands and edits without prompts."),
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export type RuntimeModeChoice = (typeof RUNTIME_MODE_CHOICES)[number] & {
  /** Set when a managed policy caps modes below this one, or the provider cannot run it here. */
  readonly disabledReason?: string;
};

/**
 * Marks modes above a managed runtime ceiling. A control acting on several environments is
 * managed when any of them is, so the first target that refuses a mode supplies its reason.
 */
export function withManagedRuntimeModeLimits(
  choices: ReadonlyArray<RuntimeModeChoice>,
  policies: ReadonlyArray<ManagedPolicySummary | undefined>,
  resolve: MessageResolver = m,
): ReadonlyArray<RuntimeModeChoice> {
  return choices.map((choice) => {
    const reason = policies
      .map((policy) => managedRuntimeModeDenial(policy, choice.mode, resolve))
      .find((denial) => denial !== undefined);
    return reason === undefined ? choice : { ...choice, disabledReason: reason };
  });
}

/**
 * Marks modes the provider cannot run in the thread's folder. They stay listed, and a thread
 * already in one keeps it, with the reason in place of the description.
 */
export function withProviderRuntimeModeLimits(
  choices: ReadonlyArray<RuntimeModeChoice>,
  limits: ReadonlyArray<ProviderRuntimeModeLimit> | undefined,
  resolve: MessageResolver = m,
): ReadonlyArray<RuntimeModeChoice> {
  if (limits === undefined || limits.length === 0) return choices;
  return choices.map((choice) => {
    if (choice.disabledReason !== undefined) return choice;
    const reason = providerRuntimeModeLimitMessage(limits, choice.mode, resolve);
    return reason === undefined ? choice : { ...choice, disabledReason: reason };
  });
}

/**
 * A new thread's mode: the draft's choice unless the managed ceiling refuses it, then the
 * default, which the server already reads back at or below the ceiling.
 */
export function resolveNewThreadRuntimeMode(
  draftMode: RuntimeMode | undefined,
  defaultMode: RuntimeMode,
  policy: ManagedPolicySummary | undefined,
): RuntimeMode {
  return draftMode !== undefined && managedRuntimeModeDenial(policy, draftMode) === undefined
    ? draftMode
    : defaultMode;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";
