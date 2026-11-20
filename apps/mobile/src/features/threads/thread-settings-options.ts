import { managedRuntimeModeDenial } from "@t3tools/client-runtime/contract-labels";
import {
  compatibleRuntimeMode,
  type ClassicRuntimeMode,
  type ManagedPolicySummary,
  type RuntimeMode,
  type ServerProviderRuntimeMode,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: ClassicRuntimeMode;
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

const EXTRA_RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "read-only",
    label: msg("Read only"),
    description: msg(
      "Allow read and search tools only; block edits, shell commands, and MCP calls.",
    ),
  },
  {
    mode: "workspace-write",
    label: msg("Workspace write"),
    description: msg("Auto-approve workspace edits and shell; ask otherwise."),
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
  providerRuntimeModes?: ReadonlyArray<ServerProviderRuntimeMode> | undefined,
): ReadonlyArray<RuntimeModeChoice> {
  const known = new Map<RuntimeMode, RuntimeModeChoice>(
    [...EXTRA_RUNTIME_MODE_CHOICES, ...RUNTIME_MODE_CHOICES].map((c) => [c.mode, c]),
  );
  if (providerRuntimeModes && providerRuntimeModes.length > 0) {
    return providerRuntimeModes.map((entry) => {
      const fallback = known.get(entry.mode);
      return {
        mode: entry.mode,
        label: entry.label ?? fallback?.label ?? entry.mode,
        description: entry.description ?? fallback?.description ?? "",
      };
    });
  }
  if (supportedRuntimeModes && supportedRuntimeModes.length > 0) {
    return supportedRuntimeModes.flatMap((mode) => {
      const choice = known.get(mode);
      return choice ? [choice] : [];
    });
  }
  return RUNTIME_MODE_CHOICES;
}

export type RuntimeModeChoice = {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
  /** Set when a target environment's managed policy caps runtime modes below this one. */
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
  return compatibleRuntimeMode(
    runtimeMode,
    choices.map((choice) => choice.mode),
  );
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";
