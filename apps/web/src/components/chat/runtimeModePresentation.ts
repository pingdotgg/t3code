import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, type LucideIcon, PenLineIcon, ShieldIcon } from "lucide-react";

export interface RuntimeModePresentation {
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const BASE_RUNTIME_MODE_CONFIG: Record<RuntimeMode, RuntimeModePresentation> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "medium-access": {
    label: "Medium access",
    description: "Allow reversible commands, ask before riskier actions.",
    icon: ShieldIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const DROID_RUNTIME_MODE_CONFIG: Record<RuntimeMode, RuntimeModePresentation> = {
  "approval-required": {
    label: "Off",
    description: "Droid asks before every action.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Low",
    description: "Allow file edits and read-only commands.",
    icon: PenLineIcon,
  },
  "medium-access": {
    label: "Medium",
    description: "Allow reversible commands.",
    icon: ShieldIcon,
  },
  "full-access": {
    label: "High",
    description: "Allow all Droid actions without prompts.",
    icon: LockOpenIcon,
  },
};

const BASE_RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];
const DROID_RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "medium-access",
  "full-access",
];

export function getRuntimeModeConfig(
  provider: ProviderDriverKind,
): Record<RuntimeMode, RuntimeModePresentation> {
  return provider === ProviderDriverKind.make("droid")
    ? DROID_RUNTIME_MODE_CONFIG
    : BASE_RUNTIME_MODE_CONFIG;
}

export function getRuntimeModeOptions(provider: ProviderDriverKind): ReadonlyArray<RuntimeMode> {
  return provider === ProviderDriverKind.make("droid")
    ? DROID_RUNTIME_MODE_OPTIONS
    : BASE_RUNTIME_MODE_OPTIONS;
}

export function normalizeRuntimeModeForProvider(
  provider: ProviderDriverKind,
  runtimeMode: RuntimeMode,
): RuntimeMode {
  return getRuntimeModeOptions(provider).includes(runtimeMode) ? runtimeMode : "auto-accept-edits";
}
