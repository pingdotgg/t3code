import { t } from "@palamedes/core/macro";
import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
import { type LucideIcon, LockIcon, PenLineIcon, ShieldOffIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    get label() {
      return t({ message: "Supervised" });
    },
    get description() {
      return t({ message: "Ask before commands and file changes." });
    },
    icon: LockIcon,
  },
  "auto-accept-edits": {
    get label() {
      return t({ message: "Auto-accept edits" });
    },
    get description() {
      return t({ message: "Auto-approve edits, ask before other actions." });
    },
    icon: PenLineIcon,
  },
  auto: {
    get label() {
      return t({ message: "Auto" });
    },
    get description() {
      return t({ message: "Supported providers approve routine actions; others still ask." });
    },
    icon: SparklesIcon,
  },
  "full-access": {
    get label() {
      return t({ message: "Full access" });
    },
    get description() {
      return t({ message: "Allow commands and edits without prompts." });
    },
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
) {
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    const disabledReason = managedRuntimeModeDenial(managedPolicy, mode);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
