import { managedRuntimeModeDenial } from "@t3tools/client-runtime/contract-labels";
import {
  CLASSIC_RUNTIME_MODES,
  compatibleRuntimeMode,
  type ClassicRuntimeMode,
  type ManagedPolicySummary,
  type RuntimeMode,
  type ServerProviderRuntimeMode,
  type ServerProviderRuntimeModeIcon,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import {
  type LucideIcon,
  EyeIcon,
  LockIcon,
  PenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";

type RuntimeModeDisplayEntry = {
  label: string;
  description: string;
  icon: LucideIcon;
};

const PROVIDER_RUNTIME_MODE_ICONS: Record<ServerProviderRuntimeModeIcon, LucideIcon> = {
  eye: EyeIcon,
  lock: LockIcon,
  edit: PenLineIcon,
  "shield-check": ShieldCheckIcon,
  "shield-off": ShieldOffIcon,
};

export const classicRuntimeModeConfig: Record<ClassicRuntimeMode, RuntimeModeDisplayEntry> = {
  "approval-required": {
    label: msg("Supervised", { $context: "permission mode, agent asks before acting" }),
    description: msg("Ask before commands and file changes."),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: msg("Auto-accept edits"),
    description: msg("Auto-approve edits, ask before other actions."),
    icon: PenLineIcon,
  },
  auto: {
    label: msg("Auto", { $context: "permission mode, provider approves routine actions" }),
    description: msg("Supported providers approve routine actions; others still ask."),
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: msg("Full access"),
    description: msg("Allow commands and edits without prompts."),
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeConfig: Record<RuntimeMode, RuntimeModeDisplayEntry> = {
  "read-only": {
    label: msg("Read only"),
    description: msg(
      "Allow read and search tools only; block edits, shell commands, and MCP calls.",
    ),
    icon: EyeIcon,
  },
  "workspace-write": {
    label: msg("Workspace write"),
    description: msg("Auto-approve workspace edits and shell; ask otherwise."),
    icon: ShieldCheckIcon,
  },
  ...classicRuntimeModeConfig,
};

export const runtimeModeOptions: RuntimeMode[] = [...CLASSIC_RUNTIME_MODES];

/** The modes a provider supports (all classic modes when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
  providerRuntimeModes?: ReadonlyArray<ServerProviderRuntimeMode> | undefined,
) {
  const modes =
    providerRuntimeModes && providerRuntimeModes.length > 0
      ? providerRuntimeModes.map((entry) => entry.mode)
      : supportedRuntimeModes && supportedRuntimeModes.length > 0
        ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
        : runtimeModeOptions;
  return { modes, mode: compatibleRuntimeMode(runtimeMode, modes) };
}

export function resolveRuntimeModeOption(
  mode: RuntimeMode,
  resolve: MessageResolver = m,
  providerRuntimeModes?: ReadonlyArray<ServerProviderRuntimeMode> | undefined,
): {
  mode: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
  disabledReason?: string;
} {
  const custom = providerRuntimeModes?.find((entry) => entry.mode === mode);
  const fallback = runtimeModeConfig[mode];
  const icon = custom?.icon ? PROVIDER_RUNTIME_MODE_ICONS[custom.icon] : fallback.icon;
  return {
    mode,
    icon,
    label: resolve(custom?.label ?? fallback.label),
    description: resolve(custom?.description ?? fallback.description),
  };
}

/** Why `mode` is unavailable under `managedPolicy`, or undefined when it is allowed. */
export function runtimeModeDenial(
  managedPolicy: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
  resolve: MessageResolver = m,
  providerRuntimeModes?: ReadonlyArray<ServerProviderRuntimeMode> | undefined,
) {
  const ceiling = managedPolicy?.limits?.maxRuntimeMode;
  if (ceiling === undefined || managedRuntimeModeDenial(managedPolicy, mode) === undefined) {
    return undefined;
  }
  const ceilingCustom = providerRuntimeModes?.find((entry) => entry.mode === ceiling);
  return resolve(
    msg("{organization} limits threads to {mode}.", {
      organization: managedPolicy!.organization,
      mode: resolve(ceilingCustom?.label ?? runtimeModeConfig[ceiling].label),
    }),
  );
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
  resolve: MessageResolver = m,
  providerRuntimeModes?: ReadonlyArray<ServerProviderRuntimeMode> | undefined,
) {
  return modes.map((mode) => {
    const option = resolveRuntimeModeOption(mode, resolve, providerRuntimeModes);
    const disabledReason = runtimeModeDenial(managedPolicy, mode, resolve, providerRuntimeModes);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
